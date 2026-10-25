/** The short code after the date on a lot number, for example "JK" from "26102026 JK". */
export function lotCodeFromNumber(lotNumber: string): string {
  const match = lotNumber.trim().toUpperCase().match(/^\d{8}\s+([A-Z0-9]+)$/);
  return match?.[1] ?? '';
}

/**
 * The same letter can arrive on another lot at another price.
 * Lot JK and quality A are stored as JKA. Lot KJ and quality A are stored as KJA.
 * A code that already starts with the lot code is left as typed.
 */
export function composeMarkCode(lotCode: string, quality: string): string {
  const lot = lotCode.trim().toUpperCase().replace(/[^A-Z0-9]/g, '');
  const mark = quality.trim().toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (!mark) return '';
  if (!lot || mark.startsWith(lot)) return mark;
  return `${lot}${mark}`;
}
