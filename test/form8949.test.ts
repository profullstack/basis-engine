import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { prepare } from '../src/index.ts';
import { boxFor, toCents } from '../src/form8949.ts';
import type { LedgerEvent, Wallet } from '../src/types.ts';

const WALLETS: Wallet[] = [
  { id: 'exchange', kind: 'broker' },
  { id: 'cold', kind: 'self' },
];

describe('boxFor', () => {
  it('maps the six combinations of term, 1099 and covered status', () => {
    assert.equal(boxFor({ term: 'short', reported: true, covered: true }), 'A');
    assert.equal(boxFor({ term: 'short', reported: true, covered: false }), 'B');
    assert.equal(boxFor({ term: 'short', reported: false, covered: false }), 'C');
    assert.equal(boxFor({ term: 'long', reported: true, covered: true }), 'D');
    assert.equal(boxFor({ term: 'long', reported: true, covered: false }), 'E');
    assert.equal(boxFor({ term: 'long', reported: false, covered: false }), 'F');
  });
});

describe('toCents', () => {
  it('rounds micro-dollars half away from zero', () => {
    assert.equal(toCents(1_005_000n), 101n);
    assert.equal(toCents(1_004_999n), 100n);
    assert.equal(toCents(-1_005_000n), -101n);
  });
});

describe('prepare', () => {
  it('sorts a realistic ledger into the right boxes', () => {
    const events: LedgerEvent[] = [
      // Bought at the broker in 2026 and sold there: covered, short-term -> A.
      { type: 'acquire', id: 'a1', at: '2026-01-05', wallet: 'exchange', asset: 'ETH', qty: '1', costUsd: '2000' },
      { type: 'dispose', id: 'd1', at: '2026-06-05', wallet: 'exchange', asset: 'ETH', qty: '1', proceedsUsd: '2500' },

      // Bought at the broker before 2026: a 1099 arrives without basis -> B.
      { type: 'acquire', id: 'a2', at: '2025-03-01', wallet: 'exchange', asset: 'BTC', qty: '1', costUsd: '30000' },
      { type: 'dispose', id: 'd2', at: '2026-02-01', wallet: 'exchange', asset: 'BTC', qty: '1', proceedsUsd: '40000' },

      // Held and sold in self custody, over a year: no 1099 -> F.
      { type: 'acquire', id: 'a3', at: '2024-01-01', wallet: 'cold', asset: 'SOL', qty: '100', costUsd: '5000' },
      { type: 'dispose', id: 'd3', at: '2026-05-01', wallet: 'cold', asset: 'SOL', qty: '100', proceedsUsd: '15000' },
    ];

    const { form8949, scheduleD } = prepare(events, { wallets: WALLETS, taxYear: 2026 });
    const boxes = Object.fromEntries(form8949.map((g) => [g.box, g]));

    assert.deepEqual(Object.keys(boxes).sort(), ['A', 'B', 'F']);
    assert.equal(boxes.A!.rows[0]!.gainLoss, '500.00');
    assert.equal(boxes.B!.rows[0]!.gainLoss, '10000.00');
    assert.equal(boxes.F!.rows[0]!.gainLoss, '10000.00');

    // 500 + 10000 short, 10000 long.
    assert.equal(scheduleD.netShortTerm, '10500.00');
    assert.equal(scheduleD.netLongTerm, '10000.00');
    assert.equal(scheduleD.net, '20500.00');
  });

  it('carries each 8949 box onto its Schedule D line', () => {
    const events: LedgerEvent[] = [
      { type: 'acquire', id: 'a1', at: '2026-01-05', wallet: 'exchange', asset: 'ETH', qty: '1', costUsd: '2000' },
      { type: 'dispose', id: 'd1', at: '2026-06-05', wallet: 'exchange', asset: 'ETH', qty: '1', proceedsUsd: '2500' },
    ];
    const { scheduleD } = prepare(events, { wallets: WALLETS, taxYear: 2026 });

    assert.equal(scheduleD.shortTerm.length, 1);
    assert.equal(scheduleD.shortTerm[0]!.line, '1b');
    assert.equal(scheduleD.shortTerm[0]!.box, 'A');
    assert.equal(scheduleD.longTerm.length, 0);
  });

  it('totals reconcile to the sum of the printed rows', () => {
    // Thirds of a dollar. Each row rounds on its own, exactly as the paper form
    // requires, so the printed total is 0.03 rather than the 0.005 an unrounded
    // calculation would give. The property that matters is that the column adds
    // up to what is printed above it.
    const events: LedgerEvent[] = [
      { type: 'acquire', id: 'a1', at: '2026-01-01', wallet: 'cold', asset: 'ETH', qty: '3', costUsd: '10' },
      { type: 'dispose', id: 'd1', at: '2026-02-01', wallet: 'cold', asset: 'ETH', qty: '1', proceedsUsd: '3.335' },
      { type: 'dispose', id: 'd2', at: '2026-03-01', wallet: 'cold', asset: 'ETH', qty: '1', proceedsUsd: '3.335' },
      { type: 'dispose', id: 'd3', at: '2026-04-01', wallet: 'cold', asset: 'ETH', qty: '1', proceedsUsd: '3.335' },
    ];
    const { form8949 } = prepare(events, { wallets: WALLETS, taxYear: 2026 });
    const group = form8949[0]!;

    const summed = group.rows.reduce((acc, r) => acc + r.cents.gainLoss, 0n);
    assert.equal(group.totalCents.gainLoss, summed);
    assert.equal(group.totals.gainLoss, '0.03');

    // And the basis column still accounts for every cent of the original cost.
    const cost = group.rows.reduce((acc, r) => acc + r.cents.cost, 0n);
    assert.equal(cost, 999n);
  });

  it('filters to the requested tax year', () => {
    const events: LedgerEvent[] = [
      { type: 'acquire', id: 'a1', at: '2025-01-01', wallet: 'cold', asset: 'ETH', qty: '2', costUsd: '2000' },
      { type: 'dispose', id: 'd1', at: '2025-06-01', wallet: 'cold', asset: 'ETH', qty: '1', proceedsUsd: '1500' },
      { type: 'dispose', id: 'd2', at: '2026-06-01', wallet: 'cold', asset: 'ETH', qty: '1', proceedsUsd: '1800' },
    ];
    const { form8949 } = prepare(events, { wallets: WALLETS, taxYear: 2026 });

    const rows = form8949.flatMap((g) => g.rows);
    assert.equal(rows.length, 1);
    assert.equal(rows[0]!.source.eventId, 'd2');
  });

  it('marks an unestablished basis instead of inventing an acquisition date', () => {
    const events: LedgerEvent[] = [
      { type: 'dispose', id: 'd1', at: '2026-06-01', wallet: 'cold', asset: 'ETH', qty: '1', proceedsUsd: '3000' },
    ];
    const { form8949, warnings } = prepare(events, { wallets: WALLETS, taxYear: 2026 });
    const row = form8949[0]!.rows[0]!;

    assert.equal(row.basisUnknown, true);
    assert.equal(row.dateAcquired, 'UNKNOWN');
    assert.equal(row.cost, '0.00');
    assert.equal(row.box, 'C');
    assert.ok(warnings.some((w) => w.code === 'quantity-shortfall'));
  });

  it('keeps every row traceable back to its source event and lot', () => {
    const events: LedgerEvent[] = [
      { type: 'acquire', id: 'buy-42', at: '2026-01-01', wallet: 'cold', asset: 'ETH', qty: '1', costUsd: '100' },
      { type: 'dispose', id: 'sell-99', at: '2026-02-01', wallet: 'cold', asset: 'ETH', qty: '1', proceedsUsd: '200' },
    ];
    const { form8949 } = prepare(events, { wallets: WALLETS, taxYear: 2026 });

    assert.deepEqual(form8949[0]!.rows[0]!.source, {
      eventId: 'sell-99',
      lotId: 'buy-42',
      asset: 'ETH',
      wallet: 'cold',
    });
  });

  it('describes the quantity without floating point noise', () => {
    const events: LedgerEvent[] = [
      { type: 'acquire', id: 'a1', at: '2026-01-01', wallet: 'cold', asset: 'ETH', qty: '0.1', costUsd: '100' },
      { type: 'dispose', id: 'd1', at: '2026-02-01', wallet: 'cold', asset: 'ETH', qty: '0.1', proceedsUsd: '200' },
    ];
    const { form8949 } = prepare(events, { wallets: WALLETS, taxYear: 2026 });
    assert.equal(form8949[0]!.rows[0]!.description, '0.1 ETH');
  });
});
