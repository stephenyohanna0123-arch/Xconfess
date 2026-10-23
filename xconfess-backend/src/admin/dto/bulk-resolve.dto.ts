import {
  ArrayMaxSize,
  IsArray,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
} from 'class-validator';

export class BulkResolveDto {
  /**
   * Issue #181: the number of reports resolved in one call is bounded so a
   * single request cannot queue an unbounded amount of nested work.
   */
  @IsArray()
  @ArrayMaxSize(100, { message: 'Maximum 100 report IDs allowed per request' })
  @IsUUID('4', { each: true })
  reportIds: string[];

  @IsOptional()
  @IsString()
  @MaxLength(1000)
  notes?: string;
}
