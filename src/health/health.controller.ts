import { Controller, Get, ServiceUnavailableException } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { SkipThrottle } from '@nestjs/throttler';
import { Public } from '../common/auth/actor';
import { PrismaService } from '../database/prisma.service';
import { ApiEndpoint, ApiStandardErrors } from '../common/http/swagger';

@ApiTags('health')
@ApiStandardErrors()
@Public()
@SkipThrottle()
@Controller('health')
export class HealthController {
  constructor(private readonly db: PrismaService) {}

  /** Liveness: the process is up. */
  @ApiEndpoint('Liveness', 'The process is up.')
  @Get() live() { return { status: 'ok' }; }

  /** Readiness: the database answers. */
  @ApiEndpoint('Readiness', 'The database answers; 503 otherwise.')
  @Get('ready')
  async ready() {
    try {
      await this.db.$queryRaw`SELECT 1`;
      return { status: 'ok', database: 'ok' };
    } catch {
      throw new ServiceUnavailableException('Database unavailable');
    }
  }
}
