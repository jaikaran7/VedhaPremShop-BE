import type { Tx } from '../database/prisma.service';

export type SequenceKind = 'INVOICE' | 'RECEIPT' | 'CUSTOMER' | 'VENDOR';

/** Next gap-free number. The row lock is held until the caller's transaction ends, so numbers never repeat. */
export async function nextSequence(tx: Tx, organizationId: string, kind: SequenceKind): Promise<number> {
  const rows = await tx.$queryRaw<{ value: number }[]>`
    INSERT INTO document_sequences (organization_id, kind, next_value) VALUES (${organizationId}::uuid, ${kind}, 2)
    ON CONFLICT (organization_id, kind) DO UPDATE SET next_value = document_sequences.next_value + 1
    RETURNING next_value - 1 AS value`;
  const value = rows[0]?.value;
  if (value === undefined) throw new Error('Sequence allocation failed');
  return Number(value);
}

export const partyCode = (prefix: 'CUST' | 'VEN', n: number): string => `${prefix}-${String(n).padStart(3, '0')}`;
