import { Body, Controller, Get, Param, ParseUUIDPipe, Patch, Post } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { type Actor, CurrentActor, Management, Roles } from '../../common/auth/actor';
import { CreateUserDto, UpdateUserDto } from './users.dto';
import { UsersService } from './users.service';

@ApiTags('users')
@Controller('users')
export class UsersController {
  constructor(private readonly users: UsersService) {}

  @Management()
  @Get()
  list(@CurrentActor() actor: Actor) {
    return this.users.list(actor);
  }

  @Roles('OWNER')
  @Post()
  create(@CurrentActor() actor: Actor, @Body() dto: CreateUserDto) {
    return this.users.create(actor, dto);
  }

  @Roles('OWNER')
  @Patch(':id')
  update(@CurrentActor() actor: Actor, @Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdateUserDto) {
    return this.users.update(actor, id, dto);
  }
}
