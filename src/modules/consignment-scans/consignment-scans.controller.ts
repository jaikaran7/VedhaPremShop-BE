import { Body, Controller, Delete, Get, Headers, HttpCode, Param, ParseUUIDPipe, Patch, Post, Query, Res, UploadedFiles, UseInterceptors } from '@nestjs/common';
import { FilesInterceptor } from '@nestjs/platform-express';
import { ApiBody, ApiConsumes, ApiHeader, ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';
import { type Actor, CurrentActor, Public, Roles } from '../../common/auth/actor';
import { ListQueryDto } from '../../common/http/list-query.dto';
import { ApiEndpoint, ApiStandardErrors } from '../../common/http/swagger';
import { ConsignmentScanConfirmService } from './consignment-scan-confirm.service';
import { ConsignmentScanProcessingService } from './consignment-scan-processing.service';
import { ConfirmScanDto, DOCUMENT_KINDS, FileLinkQueryDto, SaveScanDraftDto, UploadDocumentsDto } from './consignment-scans.dto';
import { ConsignmentScansService, type UploadedScanFile } from './consignment-scans.service';
import { MAX_FILE_BYTES, MAX_FILES_PER_SCAN } from './file-validation';

/**
 * AI consignment scanner. Staff (any role) upload, read and correct; only the Owner confirms, which posts the purchase
 * and the stock. Documents are served only through short-lived signed links.
 */
@ApiTags('consignment-scans')
@ApiStandardErrors()
@Controller('consignment-scans')
export class ConsignmentScansController {
  constructor(
    private readonly scans: ConsignmentScansService,
    private readonly processing: ConsignmentScanProcessingService,
    private readonly confirmation: ConsignmentScanConfirmService,
  ) {}

  @ApiEndpoint('List consignment scans', 'Newest first, with status and the purchase each confirmed scan created.')
  @Get() list(@CurrentActor() a: Actor, @Query() q: ListQueryDto) { return this.scans.list(a, q.limit, q.offset); }

  @ApiEndpoint('Start a consignment scan', 'Creates an empty scan to upload the vendor bill and the mark sheet into.', 201)
  @Post() create(@CurrentActor() a: Actor) { return this.scans.create(a); }

  @ApiEndpoint('Get a consignment scan', 'Documents (with signed links valid for 10 minutes), AI runs and their stage, the draft with each value’s source and confidence, and the reconciliation.')
  @Get(':id') get(@CurrentActor() a: Actor, @Param('id', ParseUUIDPipe) id: string) { return this.scans.get(a, id); }

  @ApiEndpoint('Draft history', 'Every saved version of the draft: who, why and the full state.')
  @Get(':id/versions') versions(@CurrentActor() a: Actor, @Param('id', ParseUUIDPipe) id: string) { return this.scans.versions(a, id); }

  @ApiEndpoint('Upload documents', `Photos (JPG, PNG, WEBP, HEIC), PDF, DOCX or XLSX; at most ${MAX_FILE_BYTES / 1024 / 1024} MB each and ${MAX_FILES_PER_SCAN} per scan. Checked by content, not by name.`, 201)
  @ApiConsumes('multipart/form-data')
  @ApiBody({ schema: { type: 'object', required: ['kind', 'files'], properties: { kind: { type: 'string', enum: [...DOCUMENT_KINDS] }, files: { type: 'array', items: { type: 'string', format: 'binary' } } } } })
  @Post(':id/documents')
  @UseInterceptors(FilesInterceptor('files', MAX_FILES_PER_SCAN, { limits: { fileSize: MAX_FILE_BYTES, files: MAX_FILES_PER_SCAN, fields: 4, parts: MAX_FILES_PER_SCAN + 4 } }))
  upload(@CurrentActor() a: Actor, @Param('id', ParseUUIDPipe) id: string, @Body() dto: UploadDocumentsDto, @UploadedFiles() files: UploadedScanFile[]) {
    return this.scans.upload(a, id, dto.kind, files);
  }

  @ApiEndpoint('Remove a document', 'Only before the scan is confirmed.')
  @Delete(':id/documents/:documentId')
  removeDocument(@CurrentActor() a: Actor, @Param('id', ParseUUIDPipe) id: string, @Param('documentId', ParseUUIDPipe) documentId: string) {
    return this.scans.removeDocument(a, id, documentId);
  }

  @ApiEndpoint('Read the documents with AI', 'Reads the vendor bill and the mark sheet in parallel, replaces the AI-read rows and reconciles. Returns when done; progress is visible on GET meanwhile.')
  @Post(':id/process')
  @HttpCode(200)
  async process(@CurrentActor() a: Actor, @Param('id', ParseUUIDPipe) id: string) {
    await this.processing.process(a, id);
    return this.scans.get(a, id);
  }

  @ApiEndpoint('Save the reviewed draft', 'Saves corrections and recalculates the reconciliation. Send the version you read; a newer one returns 409.')
  @Patch(':id') save(@CurrentActor() a: Actor, @Param('id', ParseUUIDPipe) id: string, @Body() dto: SaveScanDraftDto) { return this.scans.saveDraft(a, id, dto); }

  @ApiEndpoint('Confirm and post the purchase', 'Owner only. Blocks while any critical issue is open. Creates the vendor bill, receives the lot and posts stock in one transaction. Repeating returns the same purchase.')
  @ApiHeader({ name: 'Idempotency-Key', required: true, description: 'One key per confirmation attempt' })
  @Roles('OWNER')
  @Post(':id/confirm')
  @HttpCode(200)
  async confirm(@CurrentActor() a: Actor, @Param('id', ParseUUIDPipe) id: string, @Body() dto: ConfirmScanDto, @Headers('idempotency-key') key: string | undefined) {
    const { purchaseId, replayed } = await this.confirmation.confirm(a, id, dto.version, key);
    return { purchaseId, replayed, scan: await this.scans.get(a, id) };
  }

  @ApiEndpoint('Open a document', 'Signed short-lived link from GET /consignment-scans/:id; no session needed.')
  @Public()
  @Get('files/:documentId')
  async file(@Param('documentId', ParseUUIDPipe) documentId: string, @Query() q: FileLinkQueryDto, @Res() res: Response) {
    const file = await this.scans.file(documentId, q.exp, q.sig);
    res.set({
      'Content-Type': file.mimeType,
      'Content-Length': String(file.content.length),
      'Content-Disposition': `inline; filename="${file.fileName.replace(/[^\w.() -]/g, '_')}"`,
      'Cache-Control': 'private, max-age=300',
      'X-Content-Type-Options': 'nosniff',
      'Content-Security-Policy': "default-src 'none'; sandbox",
      'Cross-Origin-Resource-Policy': 'cross-origin',
    });
    res.end(file.content);
  }
}
