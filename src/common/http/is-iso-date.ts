import { buildMessage, ValidateBy, type ValidationOptions } from 'class-validator';

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/** True for a real calendar date written YYYY-MM-DD ("2026-02-30" is rejected, not rolled into March). */
export function isIsoDate(value: unknown): boolean {
  if (typeof value !== 'string' || !ISO_DATE.test(value)) return false;
  const date = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().startsWith(value);
}

export const IsIsoDate = (options?: ValidationOptions): PropertyDecorator =>
  ValidateBy(
    { name: 'isIsoDate', validator: { validate: isIsoDate, defaultMessage: buildMessage((each) => `${each}$property must be a valid date in YYYY-MM-DD format`, options) } },
    options,
  );
