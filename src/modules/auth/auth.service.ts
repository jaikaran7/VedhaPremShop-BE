import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { Inject, Injectable, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { audit } from '../../common/audit';
import type { Actor, UserRole } from '../../common/auth/actor';
import { ENV, type Env } from '../../config/env';
import { PrismaService } from '../../database/prisma.service';
import type { User } from '../../generated/prisma/client';
import { toUserView, type UserView } from '../users/user.view';
import { DUMMY_HASH, hashPassword, verifyPassword } from './passwords';

export interface IssuedSession {
  user: UserView;
  accessToken: string;
  refreshToken: string;
  accessTtlSeconds: number;
  refreshTtlSeconds: number;
}

const INVALID_LOGIN = 'Invalid username or password';
const sha256 = (value: string) => createHash('sha256').update(value).digest('hex');

@Injectable()
export class AuthService {
  constructor(
    private readonly db: PrismaService,
    @Inject(ENV) private readonly env: Env,
    private readonly jwt: JwtService,
  ) {}

  async login(username: string, password: string): Promise<IssuedSession> {
    const user = await this.db.user.findUnique({ where: { username: username.trim().toLowerCase() } });
    const valid = await verifyPassword(password, user?.passwordHash ?? DUMMY_HASH);
    if (!user || !valid || !user.active) throw new UnauthorizedException(INVALID_LOGIN);
    const membership = await this.membershipFor(user.id);
    if (!membership) throw new UnauthorizedException(INVALID_LOGIN);

    const session = await this.issue(user, membership.organizationId, membership.role, randomUUID());
    await audit(this.db, { userId: user.id, organizationId: membership.organizationId, role: membership.role, name: user.name }, {
      action: 'LOGIN', entity: 'USER', entityId: user.id, details: `${user.name} signed in`,
    });
    return session;
  }

  /**
   * Rotation: each refresh token works once. Presenting a revoked token means it was stolen or replayed,
   * so the whole family (every token descended from that login) is revoked.
   */
  async refresh(rawToken: string | undefined): Promise<IssuedSession> {
    if (!rawToken) throw new UnauthorizedException('Sign in required');
    const stored = await this.db.refreshToken.findUnique({ where: { tokenHash: sha256(rawToken) } });
    if (!stored) throw new UnauthorizedException('Sign in required');
    if (stored.revokedAt) {
      await this.revokeFamily(stored.familyId);
      throw new UnauthorizedException('Session revoked. Sign in again.');
    }
    if (stored.expiresAt.getTime() <= Date.now()) throw new UnauthorizedException('Session expired');

    // Conditional update: only one concurrent refresh can claim this token.
    const claimed = await this.db.refreshToken.updateMany({ where: { id: stored.id, revokedAt: null }, data: { revokedAt: new Date() } });
    if (claimed.count === 0) {
      await this.revokeFamily(stored.familyId);
      throw new UnauthorizedException('Session revoked. Sign in again.');
    }

    const user = await this.db.user.findUnique({ where: { id: stored.userId } });
    const membership = user?.active ? await this.membershipFor(user.id, stored.organizationId) : null;
    if (!user || !membership) throw new UnauthorizedException('Sign in required');
    return this.issue(user, membership.organizationId, membership.role, stored.familyId);
  }

  async logout(rawToken: string | undefined): Promise<void> {
    if (!rawToken) return;
    const stored = await this.db.refreshToken.findUnique({ where: { tokenHash: sha256(rawToken) } });
    if (stored) await this.revokeFamily(stored.familyId);
  }

  async me(actor: Actor): Promise<UserView> {
    const user = await this.db.user.findUnique({ where: { id: actor.userId } });
    if (!user || !user.active) throw new UnauthorizedException('Sign in required');
    return toUserView(user, actor.role);
  }

  async changePassword(actor: Actor, currentPassword: string, newPassword: string): Promise<void> {
    const user = await this.db.user.findUnique({ where: { id: actor.userId } });
    if (!user || !(await verifyPassword(currentPassword, user.passwordHash))) {
      throw new UnauthorizedException('Current password is incorrect');
    }
    const passwordHash = await hashPassword(newPassword);
    await this.db.$transaction([
      this.db.user.update({ where: { id: user.id }, data: { passwordHash } }),
      this.db.refreshToken.updateMany({ where: { userId: user.id, revokedAt: null }, data: { revokedAt: new Date() } }),
      this.db.auditLog.create({ data: {
        organizationId: actor.organizationId, userId: actor.userId, userName: actor.name, userRole: actor.role,
        action: 'CHANGE_PASSWORD', entity: 'USER', entityId: user.id, details: 'Password changed; other sessions signed out',
      } }),
    ]);
  }

  private async issue(user: User, organizationId: string, role: UserRole, familyId: string): Promise<IssuedSession> {
    const accessToken = await this.jwt.signAsync(
      { sub: user.id, org: organizationId, role, name: user.name },
      { secret: this.env.jwtAccessSecret, expiresIn: this.env.accessTokenTtlSeconds, algorithm: 'HS256' },
    );
    const refreshToken = randomBytes(32).toString('base64url');
    const refreshTtlSeconds = this.env.refreshTokenTtlDays * 86_400;
    await this.db.refreshToken.create({ data: {
      userId: user.id,
      organizationId,
      tokenHash: sha256(refreshToken),
      familyId,
      expiresAt: new Date(Date.now() + refreshTtlSeconds * 1000),
    } });
    return { user: toUserView(user, role), accessToken, refreshToken, accessTtlSeconds: this.env.accessTokenTtlSeconds, refreshTtlSeconds };
  }

  private membershipFor(userId: string, organizationId?: string) {
    return this.db.membership.findFirst({ where: { userId, ...(organizationId && { organizationId }) }, orderBy: { createdAt: 'asc' } });
  }

  private async revokeFamily(familyId: string): Promise<void> {
    await this.db.refreshToken.updateMany({ where: { familyId, revokedAt: null }, data: { revokedAt: new Date() } });
  }
}
