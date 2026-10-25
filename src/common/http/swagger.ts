import { applyDecorators, HttpStatus } from '@nestjs/common';
import {
  ApiBadRequestResponse, ApiConflictResponse, ApiCreatedResponse, ApiForbiddenResponse, ApiInternalServerErrorResponse, ApiNoContentResponse,
  ApiNotFoundResponse, ApiOkResponse, ApiOperation, ApiProperty, ApiUnauthorizedResponse, ApiUnprocessableEntityResponse,
} from '@nestjs/swagger';

/** The one error shape every failure uses (see AllExceptionsFilter). */
export class ErrorResponse {
  @ApiProperty({ example: 400 }) statusCode!: number;
  @ApiProperty({ example: 'BAD_REQUEST' }) error!: string;
  @ApiProperty({ example: ['date must be a valid date in YYYY-MM-DD format'], description: 'A message, or the list of validation messages' }) message!: string | string[];
  @ApiProperty({ example: '6f1c0c52-5d4b-4a53-9a55-2d6b1c1f2b10', description: 'Quote this when reporting a problem' }) requestId!: string;
}

/** The error responses every endpoint can return. Put on the controller class. */
export const ApiStandardErrors = (): ClassDecorator & MethodDecorator => applyDecorators(
  ApiBadRequestResponse({ type: ErrorResponse, description: 'Validation failed: a field is missing, malformed or out of range' }),
  ApiUnauthorizedResponse({ type: ErrorResponse, description: 'Not signed in, or the session expired' }),
  ApiForbiddenResponse({ type: ErrorResponse, description: 'The signed-in role may not do this' }),
  ApiNotFoundResponse({ type: ErrorResponse, description: 'The record does not exist in this business' }),
  ApiConflictResponse({ type: ErrorResponse, description: 'Duplicate, or the data changed since it was read' }),
  ApiUnprocessableEntityResponse({ type: ErrorResponse, description: 'A business rule rejected the request' }),
  ApiInternalServerErrorResponse({ type: ErrorResponse, description: 'Unexpected failure; the details are in the server log under the request id' }),
);

const SUCCESS = { [HttpStatus.OK]: ApiOkResponse, [HttpStatus.CREATED]: ApiCreatedResponse, [HttpStatus.NO_CONTENT]: ApiNoContentResponse } as const;

/** Summary, description and the success response of one endpoint. */
export function ApiEndpoint(summary: string, description: string, status: keyof typeof SUCCESS = HttpStatus.OK): MethodDecorator {
  return applyDecorators(ApiOperation({ summary, description }), SUCCESS[status]({ description: 'Success' }));
}
