import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsBoolean, IsEmail, IsIn, IsOptional, IsString, Length, Matches, MaxLength, ValidateIf } from 'class-validator';
import type { UserRole } from '../../common/auth/actor';

const ROLES: UserRole[] = ['OWNER', 'MANAGER', 'SALESPERSON'];

export class CreateUserDto {
  @ApiProperty() @IsString() @Matches(/^[a-zA-Z0-9._-]{3,32}$/, { message: 'username: 3-32 letters, digits, . _ -' }) username!: string;
  @ApiProperty() @IsString() @Length(1, 120) name!: string;
  @ApiProperty({ enum: ROLES }) @IsIn(ROLES) role!: UserRole;
  @ApiProperty({ minLength: 8 }) @IsString() @Length(8, 128) password!: string;
  @ApiPropertyOptional() @IsOptional() @ValidateIf((_, v) => v !== '') @IsEmail() email?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(32) phone?: string;
}

export class UpdateUserDto {
  @ApiPropertyOptional() @IsOptional() @IsString() @Length(1, 120) name?: string;
  @ApiPropertyOptional({ enum: ROLES }) @IsOptional() @IsIn(ROLES) role?: UserRole;
  @ApiPropertyOptional() @IsOptional() @IsBoolean() active?: boolean;
  @ApiPropertyOptional({ description: 'Owner reset; signs the user out everywhere' }) @IsOptional() @IsString() @Length(8, 128) password?: string;
  @ApiPropertyOptional() @IsOptional() @ValidateIf((_, v) => v !== '') @IsEmail() email?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(32) phone?: string;
}
