import { formatFixed } from './decimal.ts';
import type { Form8949Box, Form8949Group } from './form8949.ts';

export interface ScheduleDLine {
  /** The line as printed on Schedule D. */
  line: string;
  box: Form8949Box;
  proceeds: string;
  cost: string;
  gainLoss: string;
  cents: { proceeds: bigint; cost: bigint; gainLoss: bigint };
}

export interface ScheduleD {
  shortTerm: ScheduleDLine[];
  longTerm: ScheduleDLine[];
  /** Line 7: net short-term capital gain or loss. */
  netShortTerm: string;
  /** Line 15: net long-term capital gain or loss. */
  netLongTerm: string;
  /** Line 16: the two combined. */
  net: string;
  cents: { netShortTerm: bigint; netLongTerm: bigint; net: bigint };
}

/** Which Schedule D line each Form 8949 box totals into. */
const LINE_FOR: Record<Form8949Box, string> = {
  A: '1b',
  B: '2',
  C: '3',
  D: '8b',
  E: '9',
  F: '10',
};

const money = (cents: bigint) => formatFixed(cents, 2, 2);

/**
 * Carry the Form 8949 box totals onto Schedule D.
 *
 * Totals are summed from the already-rounded box totals so every figure
 * reconciles to the printed 8949 pages.
 */
export function toScheduleD(groups: Form8949Group[]): ScheduleD {
  const lineFor = (box: Form8949Box): ScheduleDLine | undefined => {
    const group = groups.find((g) => g.box === box);
    if (!group) return undefined;
    return {
      line: LINE_FOR[box],
      box,
      proceeds: group.totals.proceeds,
      cost: group.totals.cost,
      gainLoss: group.totals.gainLoss,
      cents: group.totalCents,
    };
  };

  const shortTerm = (['A', 'B', 'C'] as const)
    .map(lineFor)
    .filter((l): l is ScheduleDLine => l !== undefined);
  const longTerm = (['D', 'E', 'F'] as const)
    .map(lineFor)
    .filter((l): l is ScheduleDLine => l !== undefined);

  const sum = (lines: ScheduleDLine[]) =>
    lines.reduce((acc, l) => acc + l.cents.gainLoss, 0n);

  const netShortTerm = sum(shortTerm);
  const netLongTerm = sum(longTerm);
  const net = netShortTerm + netLongTerm;

  return {
    shortTerm,
    longTerm,
    netShortTerm: money(netShortTerm),
    netLongTerm: money(netLongTerm),
    net: money(net),
    cents: { netShortTerm, netLongTerm, net },
  };
}
