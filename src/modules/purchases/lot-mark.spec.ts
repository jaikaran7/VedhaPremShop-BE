import { composeMarkCode, lotCodeFromNumber } from './lot-mark';

describe('lot mark names', () => {
  it('reads the consignment code from the dated lot number', () => {
    expect(lotCodeFromNumber('26102026 JK')).toBe('JK');
    expect(lotCodeFromNumber('LOT NEW')).toBe('');
  });

  it('prefixes the quality with the lot so the same letter stays a different price', () => {
    expect(composeMarkCode('JK', 'A')).toBe('JKA');
    expect(composeMarkCode('KJ', 'A')).toBe('KJA');
    expect(composeMarkCode('JK', 'JKA')).toBe('JKA');
  });
});
