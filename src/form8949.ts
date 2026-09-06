import { QTY_SCALE, USD_SCALE, formatFixed, trimZeros } from './decimal.ts';
import type { Disposal } from './types.ts';

/**
 * Form 8949 box codes.
 *
 * Short-term: A basis reported to the IRS, B a 1099 arrived but without basis,
 * C no 1099 at all. Long-term: D, E and F in the same order.
 */
export type Form8949Box = 'A' | 'B' | 'C' | 'D' | 'E' | 'F';

export const BOX_LABELS: Record<Form8949Box, string> = {
  A: 'Short-term, basis reported to the IRS',
  B: 'Short-term, basis not reported to the IRS',
  C: 'Short-term, no Form 1099 received',
  D: 'Long-term, basis reported to the IRS',
  E: 'Long-term, basis not reported to the IRS',
  F: 'Long-term, no Form 1099 received',
};

export interface Form8949Row {
  /** Column (a). */
  description: string;
  /** Column (b), MM/DD/YYYY. */
  dateAcquired: string;
  /** Column (c), MM/DD/YYYY. */
  dateSold: string;
  /** Column (d), dollars and cents. */
  proceeds: string;
  /** Column (e), dollars and cents. */
  cost: string;
  /** Column (h), dollars and cents. */
  gainLoss: string;
  box: Form8949Box;
  term: 'short' | 'long';
  /** True when basis could not be established and defaulted to zero. */
  basisUnknown: boolean;
  /** Exact values in cents, for reconciliation against the source ledger. */
  cents: { proceeds: bigint; cost: bigint; gainLoss: bigint };
  /** The ledger events this row came from. */
  source: { eventId: string; lotId: string; asset: string; wallet: string };
}

export interface Form8949Group {
  box: Form8949Box;
  label: string;
  rows: Form8949Row[];
  totals: { proceeds: string; cost: string; gainLoss: string };
  /** Totals in cents, summed from the rounded rows so the page adds up. */
  totalCents: { proceeds: bigint; cost: bigint; gainLoss: bigint };
}

/** Round micro-dollars to cents, half away from zero. */
export function toCents(micro: bigint): bigint {
  const divisor = 10n ** BigInt(USD_SCALE - 2);
  const negative = micro < 0n;
  const magnitude = negative ? -micro : micro;
  const cents = (magnitude + divisor / 2n) / divisor;
  return negative ? -cents : cents;
}

const money = (cents: bigint) => formatFixed(cents, 2, 2);

/** Form 8949 wants US date order. */
export function formatDate(d: Date): string {
  const mm = String(d.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(d.getUTCDate()).padStart(2, '0');
  return `${mm}/${dd}/${d.getUTCFullYear()}`;
}

export function boxFor(disposal: Pick<Disposal, 'term' | 'covered' | 'reported'>): Form8949Box {
  if (disposal.term === 'short') {
    if (!disposal.reported) return 'C';
    return disposal.covered ? 'A' : 'B';
  }
  if (!disposal.reported) return 'F';
  return disposal.covered ? 'D' : 'E';
}

export interface Form8949Options {
  /** Keep only disposals settled in this calendar year (UTC). */
  taxYear?: number;
}

/** Turn disposals into Form 8949 rows, one per lot consumed. */
export function toForm8949Rows(
  disposals: Disposal[],
  options: Form8949Options = {},
): Form8949Row[] {
  const inYear =
    options.taxYear === undefined
      ? disposals
      : disposals.filter((d) => d.disposedAt.getUTCFullYear() === options.taxYear);

  return inYear.map((d) => {
    const proceeds = toCents(d.proceeds);
    const cost = toCents(d.basis);
    // Column (h) is computed from the rounded columns so the printed row
    // reconciles; carrying the unrounded gain here would be off by a cent.
    const gainLoss = proceeds - cost;

    return {
      description: `${trimZeros(formatFixed(d.qty, QTY_SCALE, 8))} ${d.asset}`,
      dateAcquired: d.basisUnknown ? 'UNKNOWN' : formatDate(d.acquiredAt),
      dateSold: formatDate(d.disposedAt),
      proceeds: money(proceeds),
      cost: money(cost),
      gainLoss: money(gainLoss),
      box: boxFor(d),
      term: d.term,
      basisUnknown: d.basisUnknown,
      cents: { proceeds, cost, gainLoss },
      source: { eventId: d.eventId, lotId: d.lotId, asset: d.asset, wallet: d.wallet },
    };
  });
}

const BOX_ORDER: Form8949Box[] = ['A', 'B', 'C', 'D', 'E', 'F'];

/** Group rows into the six Form 8949 boxes, each with its own totals. */
export function groupForm8949(rows: Form8949Row[]): Form8949Group[] {
  return BOX_ORDER.map((box) => {
    const boxRows = rows.filter((r) => r.box === box);
    const totalCents = boxRows.reduce(
      (acc, r) => ({
        proceeds: acc.proceeds + r.cents.proceeds,
        cost: acc.cost + r.cents.cost,
        gainLoss: acc.gainLoss + r.cents.gainLoss,
      }),
      { proceeds: 0n, cost: 0n, gainLoss: 0n },
    );

    return {
      box,
      label: BOX_LABELS[box],
      rows: boxRows,
      totalCents,
      totals: {
        proceeds: money(totalCents.proceeds),
        cost: money(totalCents.cost),
        gainLoss: money(totalCents.gainLoss),
      },
    };
  }).filter((group) => group.rows.length > 0);
}

export function toForm8949(
  disposals: Disposal[],
  options: Form8949Options = {},
): Form8949Group[] {
  return groupForm8949(toForm8949Rows(disposals, options));
}
