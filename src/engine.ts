import { QTY_SCALE, USD_SCALE, parseFixed, proRata } from './decimal.ts';
import { LotBook } from './lots.ts';
import type {
  Disposal,
  EngineOptions,
  EngineResult,
  LedgerEvent,
  Lot,
  LotMethod,
  Wallet,
  WalletKind,
  Warning,
} from './types.ts';

/**
 * First date on which a digital asset acquired at a broker is a covered
 * security whose basis the broker must report. Reg. 1.6045-1.
 */
export const DEFAULT_COVERED_FROM = '2026-01-01';

const asQty = (v: string | number) => parseFixed(v, QTY_SCALE);
const asUsd = (v: string | number) => parseFixed(v, USD_SCALE);

function parseDate(value: string, eventId: string): Date {
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) {
    throw new Error(`event "${eventId}": unparseable date "${value}"`);
  }
  return d;
}

/**
 * Long-term requires holding for *more* than one year: counting starts the day
 * after acquisition, so an asset bought 1 Jan must be sold on 2 Jan of the
 * following year at the earliest to qualify.
 */
export function holdingTerm(acquiredAt: Date, disposedAt: Date): 'short' | 'long' {
  const anniversary = new Date(acquiredAt.getTime());
  anniversary.setUTCFullYear(anniversary.getUTCFullYear() + 1);
  return disposedAt.getTime() > anniversary.getTime() ? 'long' : 'short';
}

/**
 * Replay a ledger into per-wallet lots and the disposals they produce.
 *
 * Events are processed in date order; ties keep their input order, so a buy
 * and a sell stamped with the same date resolve the way the source system
 * listed them.
 */
export function runBasisEngine(
  events: LedgerEvent[],
  options: EngineOptions = {},
): EngineResult {
  const defaultMethod: LotMethod = options.method ?? 'fifo';
  const coveredFrom = new Date(options.coveredFrom ?? DEFAULT_COVERED_FROM);
  const strict = options.strict ?? false;

  const wallets = new Map<string, Wallet>((options.wallets ?? []).map((w) => [w.id, w]));
  const warnings: Warning[] = [];
  const seenUnknown = new Set<string>();

  const kindOf = (id: string, eventId: string): WalletKind => {
    const declared = wallets.get(id);
    if (declared) return declared.kind;
    if (!seenUnknown.has(id)) {
      seenUnknown.add(id);
      warnings.push({
        code: 'unknown-wallet',
        eventId,
        wallet: id,
        message:
          `Wallet "${id}" was not declared, so it is treated as self-custody: its ` +
          `disposals report in box C or F with no Form 1099-DA.`,
      });
    }
    return 'self';
  };

  const indexed = events.map((event, index) => ({ event, index }));
  indexed.sort((a, b) => {
    const ta = new Date(a.event.at).getTime();
    const tb = new Date(b.event.at).getTime();
    return ta - tb || a.index - b.index;
  });

  const book = new LotBook();
  const disposals: Disposal[] = [];
  let syntheticCount = 0;

  const syntheticLot = (
    eventId: string,
    wallet: string,
    asset: string,
    amount: bigint,
    at: Date,
  ): Lot => ({
    id: `synthetic-${++syntheticCount}`,
    asset,
    wallet,
    acquiredAt: at,
    qty: amount,
    basis: 0n,
    covered: false,
    sourceEventId: eventId,
    synthetic: true,
  });

  /** Consume `amount` from a wallet, allocating `proceeds` across the lots hit. */
  const dispose = (
    eventId: string,
    wallet: string,
    asset: string,
    amount: bigint,
    proceeds: bigint,
    at: Date,
    method: LotMethod,
    lotIds?: string[],
  ): void => {
    if (amount <= 0n) return;

    const { plan, shortfall } = book.select(wallet, asset, amount, method, lotIds);

    if (shortfall > 0n) {
      if (strict) {
        throw new Error(
          `event "${eventId}": wallet "${wallet}" holds too little ${asset} for this disposal`,
        );
      }
      const lot = syntheticLot(eventId, wallet, asset, shortfall, at);
      book.add(lot);
      plan.push({ lot, take: shortfall });
      warnings.push({
        code: 'quantity-shortfall',
        eventId,
        asset,
        wallet,
        message:
          `Disposed more ${asset} than wallet "${wallet}" holds. The uncovered quantity was ` +
          `given zero basis and a short-term holding period, which is the conservative ` +
          `position; supply the missing acquisition to replace it.`,
      });
    }

    const reported = kindOf(wallet, eventId) === 'broker';
    let proceedsLeft = proceeds;

    plan.forEach(({ lot, take }, i) => {
      const isLast = i === plan.length - 1;
      const allocProceeds = isLast ? proceedsLeft : proRata(proceeds, take, amount);
      proceedsLeft -= allocProceeds;

      // A fully consumed lot hands over every micro-dollar it has left, so
      // splitting a lot can never create or destroy basis.
      const allocBasis = take === lot.qty ? lot.basis : proRata(lot.basis, take, lot.qty);

      lot.qty -= take;
      lot.basis -= allocBasis;

      disposals.push({
        eventId,
        asset,
        wallet,
        lotId: lot.id,
        acquiredAt: lot.acquiredAt,
        disposedAt: at,
        qty: take,
        proceeds: allocProceeds,
        basis: allocBasis,
        gain: allocProceeds - allocBasis,
        term: holdingTerm(lot.acquiredAt, at),
        covered: lot.covered,
        reported,
        basisUnknown: lot.synthetic,
      });
    });

    book.compact();
  };

  for (const { event } of indexed) {
    const at = parseDate(event.at, event.id);

    if (event.type === 'acquire') {
      const cost = asUsd(event.costUsd);
      if (cost < 0n) {
        warnings.push({
          code: 'negative-basis',
          eventId: event.id,
          asset: event.asset,
          wallet: event.wallet,
          message: 'Acquisition cost is negative; basis clamped to zero.',
        });
      }
      const kind = kindOf(event.wallet, event.id);
      book.add({
        id: event.id,
        asset: event.asset,
        wallet: event.wallet,
        acquiredAt: at,
        qty: asQty(event.qty),
        basis: cost < 0n ? 0n : cost,
        covered: kind === 'broker' && at.getTime() >= coveredFrom.getTime(),
        sourceEventId: event.id,
        synthetic: false,
      });
      continue;
    }

    if (event.type === 'dispose') {
      const proceeds = asUsd(event.proceedsUsd);
      if (proceeds === 0n) {
        warnings.push({
          code: 'zero-proceeds',
          eventId: event.id,
          asset: event.asset,
          wallet: event.wallet,
          message:
            'Disposal has zero proceeds; confirm this is a worthless or gifted disposition.',
        });
      }
      dispose(
        event.id,
        event.wallet,
        event.asset,
        asQty(event.qty),
        proceeds,
        at,
        event.method ?? defaultMethod,
        event.lotIds,
      );
      continue;
    }

    // Transfer between the taxpayer's own wallets. Moving an asset is not a
    // disposition, but a network fee paid in that asset is.
    const method = event.method ?? defaultMethod;

    if (event.feeQty !== undefined) {
      dispose(
        event.id,
        event.from,
        event.asset,
        asQty(event.feeQty),
        asUsd(event.feeUsd ?? 0),
        at,
        method,
      );
    }

    const amount = asQty(event.qty);
    const { plan, shortfall } = book.select(event.from, event.asset, amount, method);

    if (shortfall > 0n) {
      if (strict) {
        throw new Error(
          `event "${event.id}": wallet "${event.from}" holds too little ${event.asset} to transfer`,
        );
      }
      const lot = syntheticLot(event.id, event.from, event.asset, shortfall, at);
      book.add(lot);
      plan.push({ lot, take: shortfall });
      warnings.push({
        code: 'quantity-shortfall',
        eventId: event.id,
        asset: event.asset,
        wallet: event.from,
        message:
          `Transferred more ${event.asset} than wallet "${event.from}" holds. The uncovered ` +
          `quantity moved with zero basis; supply the missing acquisition to replace it.`,
      });
    }

    kindOf(event.to, event.id);

    for (const { lot, take } of plan) {
      if (take === lot.qty) {
        // The whole lot moves. Once it leaves the broker that sold it, no
        // broker knows its basis any more, so it stops being covered.
        book.reassign(lot, event.to);
        lot.covered = false;
      } else {
        const movedBasis = proRata(lot.basis, take, lot.qty);
        lot.qty -= take;
        lot.basis -= movedBasis;
        book.add({
          id: `${lot.id}:${event.id}`,
          asset: lot.asset,
          wallet: event.to,
          acquiredAt: lot.acquiredAt,
          qty: take,
          basis: movedBasis,
          covered: false,
          sourceEventId: event.id,
          synthetic: lot.synthetic,
        });
      }
    }

    book.compact();
  }

  return { disposals, warnings, openLots: book.all() };
}
