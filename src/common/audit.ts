import type { Actor } from './auth/actor';
import type { Db } from '../database/prisma.service';
import type { Prisma } from '../generated/prisma/client';

export interface AuditEvent {
  action: string;
  entity: string;
  entityId: string;
  details: string;
  approver?: string;
  metadata?: Prisma.InputJsonValue;
}

/** Write inside the business transaction so the audit row exists if and only if the change committed. Never pass secrets. */
export async function audit(db: Db, actor: Actor, event: AuditEvent): Promise<void> {
  await db.auditLog.create({
    data: {
      organizationId: actor.organizationId,
      userId: actor.userId,
      userName: actor.name,
      userRole: actor.role,
      ...event,
    },
  });
}
