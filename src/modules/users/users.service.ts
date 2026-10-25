import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { audit } from '../../common/audit';
import type { Actor } from '../../common/auth/actor';
import { PrismaService, TX_OPTIONS } from '../../database/prisma.service';
import { hashPassword } from '../auth/passwords';
import type { CreateUserDto, UpdateUserDto } from './users.dto';
import { toUserView, type UserView } from './user.view';

@Injectable()
export class UsersService {
  constructor(private readonly db: PrismaService) {}

  async list(actor: Actor): Promise<UserView[]> {
    const rows = await this.db.membership.findMany({
      where: { organizationId: actor.organizationId },
      include: { user: true },
      orderBy: { createdAt: 'asc' },
    });
    return rows.map((row) => toUserView(row.user, row.role));
  }

  async create(actor: Actor, dto: CreateUserDto): Promise<UserView> {
    const passwordHash = await hashPassword(dto.password);
    const username = dto.username.toLowerCase();
    return this.db.$transaction(async (tx) => {
      if (await tx.user.findUnique({ where: { username } })) throw new ConflictException('Username is already taken');
      const user = await tx.user.create({ data: { username, name: dto.name.trim(), email: dto.email ?? '', phone: dto.phone ?? '', passwordHash } });
      await tx.membership.create({ data: { userId: user.id, organizationId: actor.organizationId, role: dto.role } });
      await audit(tx, actor, { action: 'CREATE_USER', entity: 'USER', entityId: user.id, details: `Added ${dto.role} ${user.name}` });
      return toUserView(user, dto.role);
    }, TX_OPTIONS);
  }

  async update(actor: Actor, userId: string, dto: UpdateUserDto): Promise<UserView> {
    const passwordHash = dto.password ? await hashPassword(dto.password) : undefined;
    return this.db.$transaction(async (tx) => {
      const locked = await tx.$queryRaw<{ role: string }[]>`
        SELECT role FROM memberships WHERE user_id = ${userId}::uuid AND organization_id = ${actor.organizationId}::uuid FOR UPDATE`;
      const membership = locked[0];
      if (!membership) throw new NotFoundException('User not found');
      if (userId === actor.userId && (dto.active === false || (dto.role && dto.role !== membership.role))) {
        throw new BadRequestException('You cannot deactivate yourself or change your own role');
      }
      if (membership.role === 'OWNER' && ((dto.role && dto.role !== 'OWNER') || dto.active === false)) {
        const others = await tx.membership.count({
          where: { organizationId: actor.organizationId, role: 'OWNER', userId: { not: userId }, user: { active: true } },
        });
        if (others === 0) throw new BadRequestException('The organization needs at least one active owner');
      }

      const user = await tx.user.update({
        where: { id: userId },
        data: {
          ...(dto.name !== undefined && { name: dto.name.trim() }),
          ...(dto.email !== undefined && { email: dto.email }),
          ...(dto.phone !== undefined && { phone: dto.phone }),
          ...(dto.active !== undefined && { active: dto.active }),
          ...(passwordHash && { passwordHash }),
        },
      });
      const role = dto.role ?? (membership.role as UserView['role']);
      if (dto.role) {
        await tx.membership.update({ where: { userId_organizationId: { userId, organizationId: actor.organizationId } }, data: { role } });
      }
      if (dto.active === false || passwordHash || dto.role) {
        await tx.refreshToken.updateMany({ where: { userId, revokedAt: null }, data: { revokedAt: new Date() } });
      }
      const changed = Object.keys(dto).filter((key) => key !== 'password').concat(passwordHash ? ['password reset'] : []);
      await audit(tx, actor, { action: 'UPDATE_USER', entity: 'USER', entityId: userId, details: `Updated ${user.name}: ${changed.join(', ')}` });
      return toUserView(user, role);
    }, TX_OPTIONS);
  }
}
