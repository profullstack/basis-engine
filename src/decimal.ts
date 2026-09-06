/**
 * Fixed-point arithmetic on bigint. Money and asset quantities never touch
 * IEEE floats here: a tenth of a cent lost per lot becomes a real basis error
 * once a wallet has fifty thousand transfers in it.
 */

/** Asset quantities are tracked at 18 decimals (wei resolution). */
export const QTY_SCALE = 18;

/** USD is tracked at 6 decimals (micro-dollars) and rounded only on output. */
export const USD_SCALE = 6;

const DECIMAL_RE = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)$/;

/**
 * Parse a decimal string into a scaled bigint, rounding half-up on the
 * magnitude if the input carries more precision than the scale allows.
 */
export function parseFixed(value: string | number, scale: number): bigint {
  const raw = typeof value === 'number' ? String(value) : value.trim();
  if (raw === '') throw new Error('parseFixed: empty value');
  if (/[eE]/.test(raw)) {
    throw new Error(`parseFixed: exponent notation is not accepted ("${raw}") - pass a plain decimal string`);
  }
  if (!DECIMAL_RE.test(raw)) throw new Error(`parseFixed: not a decimal number ("${raw}")`);

  const negative = raw.startsWith('-');
  const body = raw.replace(/^[+-]/, '');
  const dot = body.indexOf('.');
  const intPart = (dot === -1 ? body : body.slice(0, dot)) || '0';
  const fracPart = dot === -1 ? '' : body.slice(dot + 1);

  const kept = (fracPart + '0'.repeat(scale)).slice(0, scale);
  let n = BigInt(intPart + kept);

  const nextDigit = fracPart[scale];
  if (nextDigit !== undefined && Number(nextDigit) >= 5) n += 1n;

  return negative ? -n : n;
}

/**
 * Render a scaled bigint as a decimal string at `places` decimals,
 * rounding half away from zero.
 */
export function formatFixed(value: bigint, scale: number, places = scale): string {
  const negative = value < 0n;
  const magnitude = negative ? -value : value;

  let scaled: bigint;
  if (places >= scale) {
    scaled = magnitude * 10n ** BigInt(places - scale);
  } else {
    const divisor = 10n ** BigInt(scale - places);
    scaled = (magnitude + divisor / 2n) / divisor;
  }

  const digits = scaled.toString().padStart(places + 1, '0');
  const cut = digits.length - places;
  const whole = digits.slice(0, cut);
  const frac = places > 0 ? `.${digits.slice(cut)}` : '';
  const rendered = `${whole}${frac}`;

  // Do not emit "-0.00" for a value that rounds away to nothing.
  if (negative && /[1-9]/.test(digits)) return `-${rendered}`;
  return rendered;
}

/** Drop trailing fractional zeros, keeping at least `min` decimals. */
export function trimZeros(decimal: string, min = 0): string {
  if (!decimal.includes('.')) return decimal;
  let out = decimal.replace(/0+$/, '');
  const [, frac = ''] = out.split('.');
  if (frac.length < min) out += '0'.repeat(min - frac.length);
  if (out.endsWith('.')) out = out.slice(0, -1);
  return out;
}

/**
 * Allocate `part / whole` of `total` without leaking value. Callers must pass
 * the *remaining* lot quantity as `whole`; when the lot is fully consumed the
 * caller uses the untouched remainder instead of this result.
 */
export function proRata(total: bigint, part: bigint, whole: bigint): bigint {
  if (whole === 0n) return 0n;
  return (total * part) / whole;
}
