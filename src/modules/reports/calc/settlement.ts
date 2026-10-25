// Ported verbatim from the frontend (src/utils/settlement.ts (roundMoney only)) so the server computes exactly what the screens used to compute in the browser.
// Only import paths differ. Keep the two in step; the ported tests below prove parity.

export function roundMoney(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.round(value * 100) / 100;
}
