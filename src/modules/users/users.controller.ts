import { Body, Controller, Get, Param, ParseUUIDPipe, Patch, Post } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { type Actor, CurrentActor, Management, Roles } from '../../common/auth/actor';
import { CreateUserDto, UpdateUserDto } from './users.dto';
import { UsersService } from './users.service';
import { ApiEndpoint, ApiStandardErrors } from '../../common/http/swagger';

@ApiTags('users')
@ApiStandardErrors()
@Controller('users')
export class UsersController {
  constructor(private readonly users: UsersService) {}

  @ApiEndpoint('List users', 'Owner and Manager.')
  @Management()
  @Get()
  list(@CurrentActor() actor: Actor) {
    return this.users.list(actor);
  }

  @ApiEndpoint('Create a user', 'Owner only. Role is OWNER, MANAGER or SALESPERSON.', 201)
  @Roles('OWNER')
  @Post()
  create(@CurrentActor() actor: Actor, @Body() dto: CreateUserDto) {
    return this.users.create(actor, dto);
  }

  @ApiEndpoint('Update a user', 'Owner only. Cannot deactivate or demote yourself or the last active owner; sessions are revoked on role, password or deactivation changes.')
  @Roles('OWNER')
  @Patch(':id')
  update(@CurrentActor() actor: Actor, @Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdateUserDto) {
    return this.users.update(actor, id, dto);
  }
}
