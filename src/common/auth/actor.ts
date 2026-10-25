import { createParamDecorator, type ExecutionContext, SetMetadata } from '@nestjs/common';
import type { Request } from 'express';

export type UserRole = 'OWNER' | 'MANAGER' | 'SALESPERSON';

/** The authenticated caller. organizationId comes only from the verified token, never from the request body. */
export interface Actor {
  userId: string;
  organizationId: string;
  role: UserRole;
  name: string;
}

export type AuthedRequest = Request & { actor?: Actor };

export const IS_PUBLIC = 'isPublic';
export const ROLES = 'roles';
export const Public = () => SetMetadata(IS_PUBLIC, true);
export const Roles = (...roles: UserRole[]) => SetMetadata(ROLES, roles);
/** Owner and Manager: the frontend's `accessManagement` permission. */
export const Management = () => Roles('OWNER', 'MANAGER');

export const CurrentActor = createParamDecorator((_: unknown, ctx: ExecutionContext): Actor => {
  const actor = ctx.switchToHttp().getRequest<AuthedRequest>().actor;
  if (!actor) throw new Error('CurrentActor used on a public route');
  return actor;
});

export const isManagement = (actor: Actor): boolean => actor.role === 'OWNER' || actor.role === 'MANAGER';

export const isOwner = (actor: Actor): boolean => actor.role === 'OWNER';
