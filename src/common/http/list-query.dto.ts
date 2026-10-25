import { ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsInt, IsOptional, Max, Min } from 'class-validator';

/**
 * Bounded lists. The frontend fetches whole collections and filters in the browser, so the default is high;
 * the hard cap keeps one request from reading an unbounded table.
 */
export class ListQueryDto {
  @ApiPropertyOptional({ default: 1000, maximum: 5000 }) @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(5000) limit: number = 1000;
  @ApiPropertyOptional({ default: 0 }) @IsOptional() @Type(() => Number) @IsInt() @Min(0) offset: number = 0;
}
