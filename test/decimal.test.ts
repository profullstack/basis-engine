import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { USD_SCALE, formatFixed, parseFixed, proRata, trimZeros } from '../src/decimal.ts';

describe('parseFixed', () => {
  it('scales a plain decimal', () => {
    assert.equal(parseFixed('1.5', 6), 1_500_000n);
    assert.equal(parseFixed('0.000001', 6), 1n);
    assert.equal(parseFixed('300', 6), 300_000_000n);
  });

  it('handles signs and bare fractions', () => {
    assert.equal(parseFixed('-2.25', 2), -225n);
    assert.equal(parseFixed('+2.25', 2), 225n);
    assert.equal(parseFixed('.5', 2), 50n);
  });

  it('rounds half-up past the scale rather than truncating', () => {
    assert.equal(parseFixed('0.005', 2), 1n);
    assert.equal(parseFixed('0.004', 2), 0n);
    assert.equal(parseFixed('-0.005', 2), -1n);
  });

  it('refuses exponent notation instead of silently mis-scaling it', () => {
    assert.throws(() => parseFixed('1e18', 6), /exponent/);
  });

  it('refuses junk', () => {
    assert.throws(() => parseFixed('abc', 6));
    assert.throws(() => parseFixed('', 6));
    assert.throws(() => parseFixed('1.2.3', 6));
  });
});

describe('formatFixed', () => {
  it('renders at the requested precision', () => {
    assert.equal(formatFixed(1_500_000n, 6, 2), '1.50');
    assert.equal(formatFixed(1_505_000n, 6, 2), '1.51');
    assert.equal(formatFixed(0n, 6, 2), '0.00');
  });

  it('rounds half away from zero', () => {
    assert.equal(formatFixed(125n, 3, 2), '0.13');
    assert.equal(formatFixed(-125n, 3, 2), '-0.13');
  });

  it('never prints negative zero', () => {
    assert.equal(formatFixed(-1n, 6, 2), '0.00');
  });

  it('round-trips through parseFixed', () => {
    for (const value of ['0', '1', '1234.56', '0.000001', '-98.7654']) {
      assert.equal(
        formatFixed(parseFixed(value, USD_SCALE), USD_SCALE, 6),
        Number(value).toFixed(6),
      );
    }
  });
});

describe('trimZeros', () => {
  it('drops trailing zeros but keeps the minimum', () => {
    assert.equal(trimZeros('0.50000000'), '0.5');
    assert.equal(trimZeros('1.00000000'), '1');
    assert.equal(trimZeros('1.00', 2), '1.00');
  });
});

describe('proRata', () => {
  it('allocates by share and guards a zero denominator', () => {
    assert.equal(proRata(100n, 1n, 4n), 25n);
    assert.equal(proRata(100n, 1n, 3n), 33n);
    assert.equal(proRata(100n, 1n, 0n), 0n);
  });
});
