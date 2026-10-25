import { Controller, Get, Query } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { type Actor, CurrentActor, Management } from '../../common/auth/actor';
import { ListQueryDto } from '../../common/http/list-query.dto';
import { PrismaService } from '../../database/prisma.service';

@ApiTags('audit')
@Controller('audit')
export class AuditController {
  constructor(private readonly db: PrismaService) {}

  @Management()
  @Get()
  async list(@CurrentActor() actor: Actor, @Query() query: ListQueryDto) {
    const rows = await this.db.auditLog.findMany({
      where: { organizationId: actor.organizationId },
      orderBy: { occurredAt: 'desc' },
      take: query.limit,
      skip: query.offset,
    });
    return rows.map((row) => ({
      id: row.id,
      timestamp: row.occurredAt.toISOString(),
      userId: row.userId ?? '',
      userName: row.userName,
      userRole: row.userRole,
      action: row.action,
      entity: row.entity,
      entityId: row.entityId,
      details: row.details,
      ...(row.approver && { approver: row.approver }),
    }));
  }
}
