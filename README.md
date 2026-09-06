# @profullstack/basis-engine

Wallet-by-wallet cost basis tracking for digital assets, producing Form 8949 rows
and Schedule D totals.

Deterministic, dependency-free, and auditable: the same ledger always yields the
same schedules, and every row names the event and lot it came from.

## Why this exists

Form 1099-DA closed less of the gap than people assume. Brokers report gross
proceeds for transactions from 1 January 2025, but they only report *basis* for
**covered securities** — digital assets acquired on or after 1 January 2026 and
held continuously in that broker's account. Anything bought earlier, or
transferred in from self-custody or another platform, is **noncovered**, and the
broker reports no basis at all.

So for most of what a crypto-native business holds today, the taxpayer still has
to establish basis themselves. Meanwhile Rev. Proc. 2024-28 ended universal
basis pooling and requires allocation **wallet by wallet**, which is the wrong
shape for almost every historical record anyone kept.

This library does that computation.

## Install

```sh
pnpm add @profullstack/basis-engine
```

## Use

```ts
import { prepare } from '@profullstack/basis-engine';

const { form8949, scheduleD, warnings } = prepare(
  [
    { type: 'acquire', id: 'buy-1', at: '2026-01-05', wallet: 'exchange',
      asset: 'ETH', qty: '2', costUsd: '4000' },
    { type: 'transfer', id: 'move-1', at: '2026-03-01', asset: 'ETH',
      from: 'exchange', to: 'cold', qty: '1', feeQty: '0.002', feeUsd: '5' },
    { type: 'dispose', id: 'sell-1', at: '2026-09-01', wallet: 'cold',
      asset: 'ETH', qty: '1', proceedsUsd: '3200' },
  ],
  {
    wallets: [
      { id: 'exchange', kind: 'broker' },
      { id: 'cold', kind: 'self' },
    ],
    method: 'fifo',
    taxYear: 2026,
  },
);
```

`form8949` is grouped into the six boxes with per-box totals; `scheduleD` carries
those totals onto their Schedule D lines. `warnings` lists everything a human
needs to look at before signing.

## What it encodes

**Wallet-scoped lots.** A disposal in one wallet may only consume lots sitting in
that wallet, however much of the asset is held elsewhere. This is the rule the
library exists to enforce.

**Covered-security determination.** A lot is covered only when all three hold: it
was acquired at a `broker` wallet, on or after `coveredFrom` (default
2026-01-01), and it has never been transferred. Moving a lot out of a broker
account clears the flag, because no broker knows its basis any more.

**Box classification.** Term, whether a 1099 is expected, and covered status
select the box:

| | Basis reported | 1099, no basis | No 1099 |
|---|---|---|---|
| Short-term | A | B | C |
| Long-term | D | E | F |

**Holding period.** Long-term requires holding for *more* than one year: an asset
bought 1 January must be sold on 2 January of the following year at the earliest.

**Transfers are not dispositions.** Moving an asset between your own wallets
preserves basis and the original acquisition date. A network fee paid *in* the
transferred asset is a separate disposal, and is treated as one.

**Missing basis is surfaced, not invented.** Disposing more than a wallet holds
produces a zero-basis, short-term lot — the conservative position — flagged with
`basisUnknown`, a `quantity-shortfall` warning, and `UNKNOWN` in the
date-acquired column. Pass `strict: true` to throw instead.

**Exact arithmetic.** Quantities and money are scaled bigints (18 and 6 decimals),
never floats. A fully consumed lot hands over every remaining micro-dollar, so
splitting lots cannot create or destroy basis. Rows round to cents individually
and totals sum the rounded rows, so a printed page always adds up.

## Lot selection

`fifo` (default), `lifo`, `hifo`, or `spec-id` with explicit `lotIds`. Set it per
run via `method`, or per disposal on the event.

## Warnings

| Code | Meaning |
|---|---|
| `quantity-shortfall` | Disposed or transferred more than the wallet holds; basis defaulted to zero. |
| `unknown-wallet` | A wallet was not declared, so it was treated as self-custody. |
| `zero-proceeds` | A disposal with no proceeds; confirm it is worthless or gifted. |
| `negative-basis` | Acquisition cost was negative; basis clamped to zero. |

## Deliberately not included

- **Wash sales.** Section 1091 applies to stock and securities. Treating digital
  assets as in scope would change reported gains, so this library does not.
- **Income recognition.** Staking, mining, airdrops and hard forks are ordinary
  income events. Feed them in as `acquire` events with the basis you recognised.
- **Price lookup.** Every event carries its own USD figures. Sourcing fair market
  value is a separate concern with separate evidence requirements.

## Development

Requires Node 22.18+ (the test suite runs TypeScript directly via native type
stripping). The published package is compiled JavaScript and runs on Node 20+.

```sh
pnpm install
pnpm test
pnpm run typecheck
pnpm run build
```

## Not tax advice

This is a computation library. It does not file anything, it is not a substitute
for a credentialed preparer, and the positions it takes on unknown basis are
conservative defaults you should review.

## License

MIT
