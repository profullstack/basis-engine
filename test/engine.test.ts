import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { holdingTerm, runBasisEngine } from '../src/engine.ts';
import type { LedgerEvent, Wallet } from '../src/types.ts';

const WALLETS: Wallet[] = [
  { id: 'exchange', kind: 'broker', name: 'Broker account' },
  { id: 'cold', kind: 'self', name: 'Self custody' },
  { id: 'hot', kind: 'self' },
];

const USD = (n: bigint) => n * 1_000_000n;
const QTY = (n: bigint) => n * 10n ** 18n;

describe('holdingTerm', () => {
  it('needs more than one year, not exactly one year', () => {
    const acquired = new Date('2025-01-01T00:00:00Z');
    assert.equal(holdingTerm(acquired, new Date('2026-01-01T00:00:00Z')), 'short');
    assert.equal(holdingTerm(acquired, new Date('2026-01-02T00:00:00Z')), 'long');
  });

  it('treats a same-day flip as short-term', () => {
    const acquired = new Date('2026-03-04T09:00:00Z');
    assert.equal(holdingTerm(acquired, new Date('2026-03-04T17:00:00Z')), 'short');
  });
});

describe('runBasisEngine', () => {
  it('computes a plain FIFO gain', () => {
    const events: LedgerEvent[] = [
      { type: 'acquire', id: 'a1', at: '2026-01-05', wallet: 'exchange', asset: 'ETH', qty: '1', costUsd: '2000' },
      { type: 'dispose', id: 'd1', at: '2026-06-05', wallet: 'exchange', asset: 'ETH', qty: '1', proceedsUsd: '3000' },
    ];
    const { disposals } = runBasisEngine(events, { wallets: WALLETS });

    assert.equal(disposals.length, 1);
    assert.equal(disposals[0]!.basis, USD(2000n));
    assert.equal(disposals[0]!.proceeds, USD(3000n));
    assert.equal(disposals[0]!.gain, USD(1000n));
    assert.equal(disposals[0]!.term, 'short');
  });

  it('consumes lots FIFO across several acquisitions', () => {
    const events: LedgerEvent[] = [
      { type: 'acquire', id: 'a1', at: '2026-01-01', wallet: 'exchange', asset: 'BTC', qty: '1', costUsd: '10000' },
      { type: 'acquire', id: 'a2', at: '2026-02-01', wallet: 'exchange', asset: 'BTC', qty: '1', costUsd: '20000' },
      { type: 'dispose', id: 'd1', at: '2026-03-01', wallet: 'exchange', asset: 'BTC', qty: '1.5', proceedsUsd: '30000' },
    ];
    const { disposals } = runBasisEngine(events, { wallets: WALLETS });

    assert.equal(disposals.length, 2);
    assert.equal(disposals[0]!.lotId, 'a1');
    assert.equal(disposals[0]!.basis, USD(10000n));
    assert.equal(disposals[1]!.lotId, 'a2');
    // Half of the second lot: half its basis.
    assert.equal(disposals[1]!.basis, USD(10000n));
  });

  it('picks the highest-basis lot under HIFO', () => {
    const events: LedgerEvent[] = [
      { type: 'acquire', id: 'cheap', at: '2026-01-01', wallet: 'exchange', asset: 'BTC', qty: '1', costUsd: '10000' },
      { type: 'acquire', id: 'dear', at: '2026-02-01', wallet: 'exchange', asset: 'BTC', qty: '1', costUsd: '50000' },
      { type: 'dispose', id: 'd1', at: '2026-03-01', wallet: 'exchange', asset: 'BTC', qty: '1', proceedsUsd: '40000' },
    ];
    const { disposals } = runBasisEngine(events, { wallets: WALLETS, method: 'hifo' });

    assert.equal(disposals[0]!.lotId, 'dear');
    assert.equal(disposals[0]!.gain, USD(-10000n));
  });

  it('honours an explicit lot identification', () => {
    const events: LedgerEvent[] = [
      { type: 'acquire', id: 'first', at: '2026-01-01', wallet: 'exchange', asset: 'BTC', qty: '1', costUsd: '10000' },
      { type: 'acquire', id: 'second', at: '2026-02-01', wallet: 'exchange', asset: 'BTC', qty: '1', costUsd: '20000' },
      {
        type: 'dispose', id: 'd1', at: '2026-03-01', wallet: 'exchange', asset: 'BTC',
        qty: '1', proceedsUsd: '30000', method: 'spec-id', lotIds: ['second'],
      },
    ];
    const { disposals } = runBasisEngine(events, { wallets: WALLETS });
    assert.equal(disposals[0]!.lotId, 'second');
  });

  // Rev. Proc. 2024-28: this is the rule the whole engine exists to enforce.
  it('will not reach into another wallet for basis', () => {
    const events: LedgerEvent[] = [
      { type: 'acquire', id: 'a1', at: '2026-01-01', wallet: 'exchange', asset: 'ETH', qty: '10', costUsd: '20000' },
      { type: 'dispose', id: 'd1', at: '2026-06-01', wallet: 'cold', asset: 'ETH', qty: '1', proceedsUsd: '3000' },
    ];
    const { disposals, warnings, openLots } = runBasisEngine(events, { wallets: WALLETS });

    assert.ok(warnings.some((w) => w.code === 'quantity-shortfall'));
    assert.equal(disposals[0]!.basis, 0n);
    assert.equal(disposals[0]!.basisUnknown, true);
    // The exchange lot is untouched.
    assert.equal(openLots.find((l) => l.id === 'a1')!.qty, QTY(10n));
  });

  it('throws on a shortfall in strict mode', () => {
    const events: LedgerEvent[] = [
      { type: 'dispose', id: 'd1', at: '2026-06-01', wallet: 'cold', asset: 'ETH', qty: '1', proceedsUsd: '3000' },
    ];
    assert.throws(
      () => runBasisEngine(events, { wallets: WALLETS, strict: true }),
      /holds too little/,
    );
  });

  it('moves basis and acquisition date across a transfer without a taxable event', () => {
    const events: LedgerEvent[] = [
      { type: 'acquire', id: 'a1', at: '2025-01-01', wallet: 'exchange', asset: 'ETH', qty: '2', costUsd: '4000' },
      { type: 'transfer', id: 't1', at: '2026-02-01', asset: 'ETH', from: 'exchange', to: 'cold', qty: '2' },
      { type: 'dispose', id: 'd1', at: '2026-03-01', wallet: 'cold', asset: 'ETH', qty: '2', proceedsUsd: '9000' },
    ];
    const { disposals } = runBasisEngine(events, { wallets: WALLETS });

    // One disposal only: the transfer itself is not a disposition.
    assert.equal(disposals.length, 1);
    assert.equal(disposals[0]!.basis, USD(4000n));
    // Holding period runs from the original purchase, so this is long-term.
    assert.equal(disposals[0]!.term, 'long');
    assert.equal(disposals[0]!.acquiredAt.toISOString(), '2025-01-01T00:00:00.000Z');
  });

  it('treats a network fee paid in the asset as a disposal', () => {
    const events: LedgerEvent[] = [
      { type: 'acquire', id: 'a1', at: '2026-01-01', wallet: 'exchange', asset: 'ETH', qty: '2', costUsd: '4000' },
      {
        type: 'transfer', id: 't1', at: '2026-02-01', asset: 'ETH',
        from: 'exchange', to: 'cold', qty: '1', feeQty: '0.01', feeUsd: '25',
      },
    ];
    const { disposals } = runBasisEngine(events, { wallets: WALLETS });

    assert.equal(disposals.length, 1);
    assert.equal(disposals[0]!.proceeds, USD(25n));
    // 0.01 of a 2 ETH lot that cost 4000: basis 20.
    assert.equal(disposals[0]!.basis, USD(20n));
  });

  it('splits a lot across a partial transfer without leaking basis', () => {
    const events: LedgerEvent[] = [
      { type: 'acquire', id: 'a1', at: '2026-01-01', wallet: 'exchange', asset: 'ETH', qty: '3', costUsd: '3000' },
      { type: 'transfer', id: 't1', at: '2026-02-01', asset: 'ETH', from: 'exchange', to: 'cold', qty: '1' },
    ];
    const { openLots } = runBasisEngine(events, { wallets: WALLETS });

    const total = openLots.reduce((sum, lot) => sum + lot.basis, 0n);
    assert.equal(total, USD(3000n));
    assert.equal(openLots.find((l) => l.wallet === 'cold')!.basis, USD(1000n));
    assert.equal(openLots.find((l) => l.wallet === 'exchange')!.basis, USD(2000n));
  });

  it('conserves basis exactly across repeated partial disposals', () => {
    const events: LedgerEvent[] = [
      { type: 'acquire', id: 'a1', at: '2026-01-01', wallet: 'exchange', asset: 'ETH', qty: '1', costUsd: '300' },
      { type: 'dispose', id: 'd1', at: '2026-02-01', wallet: 'exchange', asset: 'ETH', qty: '0.3', proceedsUsd: '100' },
      { type: 'dispose', id: 'd2', at: '2026-03-01', wallet: 'exchange', asset: 'ETH', qty: '0.3', proceedsUsd: '100' },
      { type: 'dispose', id: 'd3', at: '2026-04-01', wallet: 'exchange', asset: 'ETH', qty: '0.4', proceedsUsd: '100' },
    ];
    const { disposals, openLots } = runBasisEngine(events, { wallets: WALLETS });

    const allocated = disposals.reduce((sum, d) => sum + d.basis, 0n);
    assert.equal(allocated, USD(300n));
    assert.equal(openLots.length, 0);
  });

  it('allocates proceeds across lots with no rounding drift', () => {
    const events: LedgerEvent[] = [
      { type: 'acquire', id: 'a1', at: '2026-01-01', wallet: 'exchange', asset: 'ETH', qty: '1', costUsd: '100' },
      { type: 'acquire', id: 'a2', at: '2026-01-02', wallet: 'exchange', asset: 'ETH', qty: '1', costUsd: '100' },
      { type: 'acquire', id: 'a3', at: '2026-01-03', wallet: 'exchange', asset: 'ETH', qty: '1', costUsd: '100' },
      { type: 'dispose', id: 'd1', at: '2026-06-01', wallet: 'exchange', asset: 'ETH', qty: '3', proceedsUsd: '1000' },
    ];
    const { disposals } = runBasisEngine(events, { wallets: WALLETS });

    const total = disposals.reduce((sum, d) => sum + d.proceeds, 0n);
    assert.equal(total, USD(1000n));
  });

  it('orders events by date regardless of input order', () => {
    const events: LedgerEvent[] = [
      { type: 'dispose', id: 'd1', at: '2026-06-01', wallet: 'exchange', asset: 'ETH', qty: '1', proceedsUsd: '3000' },
      { type: 'acquire', id: 'a1', at: '2026-01-01', wallet: 'exchange', asset: 'ETH', qty: '1', costUsd: '2000' },
    ];
    const { disposals, warnings } = runBasisEngine(events, { wallets: WALLETS });

    assert.equal(warnings.filter((w) => w.code === 'quantity-shortfall').length, 0);
    assert.equal(disposals[0]!.basis, USD(2000n));
  });

  it('warns once about an undeclared wallet and assumes self-custody', () => {
    const events: LedgerEvent[] = [
      { type: 'acquire', id: 'a1', at: '2026-01-01', wallet: 'mystery', asset: 'ETH', qty: '1', costUsd: '100' },
      { type: 'dispose', id: 'd1', at: '2026-02-01', wallet: 'mystery', asset: 'ETH', qty: '1', proceedsUsd: '200' },
    ];
    const { disposals, warnings } = runBasisEngine(events, { wallets: WALLETS });

    assert.equal(warnings.filter((w) => w.code === 'unknown-wallet').length, 1);
    assert.equal(disposals[0]!.reported, false);
  });
});

describe('covered security determination', () => {
  it('is covered only at a broker, only from 2026, and only until it moves', () => {
    const base = { asset: 'ETH', qty: '1', costUsd: '1000' } as const;
    const events: LedgerEvent[] = [
      { type: 'acquire', id: 'pre', at: '2025-06-01', wallet: 'exchange', ...base },
      { type: 'acquire', id: 'post', at: '2026-06-01', wallet: 'exchange', ...base },
      { type: 'acquire', id: 'selfheld', at: '2026-06-01', wallet: 'cold', ...base },
    ];
    const { openLots } = runBasisEngine(events, { wallets: WALLETS });

    assert.equal(openLots.find((l) => l.id === 'pre')!.covered, false);
    assert.equal(openLots.find((l) => l.id === 'post')!.covered, true);
    assert.equal(openLots.find((l) => l.id === 'selfheld')!.covered, false);
  });

  it('stops being covered once transferred out of the broker', () => {
    const events: LedgerEvent[] = [
      { type: 'acquire', id: 'a1', at: '2026-06-01', wallet: 'exchange', asset: 'ETH', qty: '1', costUsd: '1000' },
      { type: 'transfer', id: 't1', at: '2026-07-01', asset: 'ETH', from: 'exchange', to: 'cold', qty: '1' },
    ];
    const { openLots } = runBasisEngine(events, { wallets: WALLETS });

    assert.equal(openLots[0]!.wallet, 'cold');
    assert.equal(openLots[0]!.covered, false);
  });
});
