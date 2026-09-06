import { QTY_SCALE, proRata } from './decimal.ts';
import type { Lot, LotMethod } from './types.ts';

const QTY_ONE = 10n ** BigInt(QTY_SCALE);

/** One lot, and how much of it a disposal or transfer consumes. */
export interface Consumption {
  lot: Lot;
  take: bigint;
}

/** Wallet ids and asset symbols are user data, so the key must not be ambiguous. */
const key = (wallet: string, asset: string) => JSON.stringify([wallet, asset]);

/**
 * Open lots, pooled per wallet and asset.
 *
 * The per-wallet pooling is the whole point: Rev. Proc. 2024-28 ended
 * universal basis pooling, so a disposal in one wallet may only consume lots
 * sitting in that same wallet, however much of the asset is held elsewhere.
 */
export class LotBook {
  private pools = new Map<string, Lot[]>();
  private sequence = 0;
  private order = new WeakMap<Lot, number>();

  add(lot: Lot): void {
    const k = key(lot.wallet, lot.asset);
    const pool = this.pools.get(k) ?? [];
    this.order.set(lot, this.sequence++);
    pool.push(lot);
    this.pools.set(k, pool);
  }

  pool(wallet: string, asset: string): Lot[] {
    return this.pools.get(key(wallet, asset)) ?? [];
  }

  /** Total open quantity for a wallet and asset. */
  balance(wallet: string, asset: string): bigint {
    return this.pool(wallet, asset).reduce((sum, lot) => sum + lot.qty, 0n);
  }

  /** Every open lot, in creation order. */
  all(): Lot[] {
    const lots: Lot[] = [];
    for (const pool of this.pools.values()) lots.push(...pool);
    return lots.sort((a, b) => (this.order.get(a) ?? 0) - (this.order.get(b) ?? 0));
  }

  /**
   * Choose lots to satisfy `amount` from one wallet's pool. Returns the plan
   * and whatever quantity could not be covered; the caller decides whether a
   * shortfall is an error or a zero-basis lot.
   */
  select(
    wallet: string,
    asset: string,
    amount: bigint,
    method: LotMethod,
    lotIds?: string[],
  ): { plan: Consumption[]; shortfall: bigint } {
    const pool = this.pool(wallet, asset).filter((lot) => lot.qty > 0n);
    const ordered = this.sequenceFor(pool, method, lotIds);

    const plan: Consumption[] = [];
    let remaining = amount;

    for (const lot of ordered) {
      if (remaining <= 0n) break;
      const take = lot.qty < remaining ? lot.qty : remaining;
      if (take <= 0n) continue;
      plan.push({ lot, take });
      remaining -= take;
    }

    return { plan, shortfall: remaining };
  }

  /** Drop fully consumed lots so later selections stay cheap. */
  compact(): void {
    for (const [k, pool] of this.pools) {
      const open = pool.filter((lot) => lot.qty > 0n);
      if (open.length === 0) this.pools.delete(k);
      else this.pools.set(k, open);
    }
  }

  /** Move a lot between wallet pools, preserving its identity and order. */
  reassign(lot: Lot, toWallet: string): void {
    const from = this.pools.get(key(lot.wallet, lot.asset));
    if (from) {
      const i = from.indexOf(lot);
      if (i !== -1) from.splice(i, 1);
    }
    lot.wallet = toWallet;
    const k = key(toWallet, lot.asset);
    const pool = this.pools.get(k) ?? [];
    pool.push(lot);
    this.pools.set(k, pool);
  }

  private sequenceFor(pool: Lot[], method: LotMethod, lotIds?: string[]): Lot[] {
    if (method === 'spec-id') {
      if (!lotIds?.length) {
        throw new Error('spec-id lot selection requires lotIds');
      }
      const byId = new Map(pool.map((lot) => [lot.id, lot]));
      return lotIds.map((id) => {
        const lot = byId.get(id);
        if (!lot) {
          throw new Error(`spec-id lot selection: no open lot "${id}" in this wallet`);
        }
        return lot;
      });
    }

    const seq = (lot: Lot) => this.order.get(lot) ?? 0;
    const sorted = [...pool];

    switch (method) {
      case 'fifo':
        sorted.sort(
          (a, b) => a.acquiredAt.getTime() - b.acquiredAt.getTime() || seq(a) - seq(b),
        );
        break;
      case 'lifo':
        sorted.sort(
          (a, b) => b.acquiredAt.getTime() - a.acquiredAt.getTime() || seq(b) - seq(a),
        );
        break;
      case 'hifo':
        sorted.sort((a, b) => {
          const unitA = proRata(a.basis, QTY_ONE, a.qty);
          const unitB = proRata(b.basis, QTY_ONE, b.qty);
          if (unitA === unitB) return seq(a) - seq(b);
          return unitB > unitA ? 1 : -1;
        });
        break;
    }

    return sorted;
  }
}
