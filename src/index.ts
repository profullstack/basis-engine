export * from './types.ts';
export * from './decimal.ts';
export * from './lots.ts';
export * from './engine.ts';
export * from './form8949.ts';
export * from './scheduleD.ts';

import { runBasisEngine } from './engine.ts';
import { toForm8949 } from './form8949.ts';
import { toScheduleD } from './scheduleD.ts';
import type { Form8949Group } from './form8949.ts';
import type { ScheduleD } from './scheduleD.ts';
import type { Disposal, EngineOptions, LedgerEvent, Lot, Warning } from './types.ts';

export interface PrepareOptions extends EngineOptions {
  /** Report only disposals settled in this calendar year. */
  taxYear?: number;
}

export interface PreparedReturn {
  form8949: Form8949Group[];
  scheduleD: ScheduleD;
  disposals: Disposal[];
  warnings: Warning[];
  openLots: Lot[];
}

/**
 * Ledger in, capital-gains schedules out.
 *
 * Everything here is deterministic: the same events always produce the same
 * schedules, and every row on them names the event and lot it came from.
 */
export function prepare(events: LedgerEvent[], options: PrepareOptions = {}): PreparedReturn {
  const { disposals, warnings, openLots } = runBasisEngine(events, options);
  const form8949 = toForm8949(disposals, { taxYear: options.taxYear });
  return { form8949, scheduleD: toScheduleD(form8949), disposals, warnings, openLots };
}
