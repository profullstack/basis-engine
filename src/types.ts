/** How a wallet or account reports to the IRS. */
export type WalletKind = 'broker' | 'self';

export interface Wallet {
  /** Stable identifier used by events. */
  id: string;
  /**
   * `broker` accounts issue a Form 1099-DA for disposals; `self` custody
   * wallets issue nothing, which puts their disposals in box C or F.
   */
  kind: WalletKind;
  name?: string;
}

export type LotMethod = 'fifo' | 'lifo' | 'hifo' | 'spec-id';

export interface AcquireEvent {
  type: 'acquire';
  id: string;
  /** ISO 8601 date or date-time. */
  at: string;
  wallet: string;
  asset: string;
  /** Decimal string, e.g. "0.5". */
  qty: string | number;
  /** Total USD cost including acquisition fees. */
  costUsd: string | number;
}

export interface DisposeEvent {
  type: 'dispose';
  id: string;
  at: string;
  wallet: string;
  asset: string;
  qty: string | number;
  /** Gross USD proceeds, net of disposal fees. */
  proceedsUsd: string | number;
  /** Override the run-level lot selection method. */
  method?: LotMethod;
  /** Lot ids to consume, in order. Required when method is `spec-id`. */
  lotIds?: string[];
}

export interface TransferEvent {
  type: 'transfer';
  id: string;
  at: string;
  asset: string;
  from: string;
  to: string;
  qty: string | number;
  /** Network fee paid in the transferred asset. This is itself a disposal. */
  feeQty?: string | number;
  /** Fair market value of that fee in USD. */
  feeUsd?: string | number;
  method?: LotMethod;
}

export type LedgerEvent = AcquireEvent | DisposeEvent | TransferEvent;

export interface Lot {
  id: string;
  asset: string;
  wallet: string;
  /** Acquisition date, preserved across transfers. */
  acquiredAt: Date;
  /** Remaining quantity, scaled by QTY_SCALE. */
  qty: bigint;
  /** Remaining basis in micro-USD. */
  basis: bigint;
  /**
   * True only while the broker holding this lot knows its basis: acquired at a
   * broker account, on or after the covered-security date, and never moved.
   */
  covered: boolean;
  /** Event id that created the lot. */
  sourceEventId: string;
  /** True when the lot was synthesised to cover a quantity shortfall. */
  synthetic: boolean;
}

export interface Disposal {
  eventId: string;
  asset: string;
  wallet: string;
  lotId: string;
  acquiredAt: Date;
  disposedAt: Date;
  /** Quantity disposed, scaled by QTY_SCALE. */
  qty: bigint;
  /** Allocated proceeds in micro-USD. */
  proceeds: bigint;
  /** Allocated basis in micro-USD. */
  basis: bigint;
  /** proceeds - basis, in micro-USD. */
  gain: bigint;
  term: 'short' | 'long';
  /** Whether the disposing account reports basis to the IRS for this lot. */
  covered: boolean;
  /** Whether a Form 1099-DA is expected for this disposal. */
  reported: boolean;
  /** Set when basis is unknown because the lot was synthesised. */
  basisUnknown: boolean;
}

export type WarningCode =
  | 'quantity-shortfall'
  | 'unknown-wallet'
  | 'zero-proceeds'
  | 'negative-basis';

export interface Warning {
  code: WarningCode;
  eventId: string;
  message: string;
  asset?: string;
  wallet?: string;
}

export interface EngineOptions {
  /** Declared wallets. Anything not listed is treated as self-custody. */
  wallets?: Wallet[];
  /** Default lot selection method. Defaults to `fifo`. */
  method?: LotMethod;
  /**
   * Throw on a quantity shortfall instead of synthesising a zero-basis lot.
   * Defaults to false, which is what real wallet history needs.
   */
  strict?: boolean;
  /**
   * First date on which a digital asset acquired at a broker counts as a
   * covered security. Defaults to 2026-01-01 per Reg. section 1.6045-1.
   */
  coveredFrom?: string;
}

export interface EngineResult {
  disposals: Disposal[];
  warnings: Warning[];
  /** Lots still open at the end of the event stream. */
  openLots: Lot[];
}
