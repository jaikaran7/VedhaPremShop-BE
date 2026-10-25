/** Integer arithmetic for authoritative amounts: paise (₹/100) and grams (kg/1000). */
export const toPaise = (rupees: number): number => Math.round(rupees * 100);
export const fromPaise = (paise: number): number => paise / 100;
export const toGrams = (kg: number): number => Math.round(kg * 1000);
export const fromGrams = (grams: number): number => grams / 1000;

/** round(kg × ₹/kg) to the whole rupee, half up — same rule as the frontend's saleLineAmount. Returns paise. */
export function lineAmountPaise(grams: number, ratePaise: number): number {
  const scaled = grams * ratePaise; // units of ₹1e-5; inputs are bounded by DTO limits so this stays a safe integer
  if (!Number.isSafeInteger(scaled)) throw new Error('Line amount out of range');
  return Math.floor((scaled + 50_000) / 100_000) * 100;
}

export function hasAtMostDecimals(value: number, decimals: number): boolean {
  const scaled = value * 10 ** decimals;
  return Math.abs(scaled - Math.round(scaled)) < 1e-6;
}
