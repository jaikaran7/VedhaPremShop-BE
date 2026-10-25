import { ApiProperty } from '@nestjs/swagger';
import { IsString, Length, MaxLength } from 'class-validator';

export class LoginDto {
  @ApiProperty() @IsString() @Length(1, 64) username!: string;
  @ApiProperty() @IsString() @Length(1, 128) password!: string;
}

export class ChangePasswordDto {
  @ApiProperty() @IsString() @MaxLength(128) currentPassword!: string;
  @ApiProperty({ minLength: 8 }) @IsString() @Length(8, 128) newPassword!: string;
}
