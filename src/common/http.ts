import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  Injectable,
  Logger,
  NestInterceptor,
  ExecutionContext,
  CallHandler,
  applyDecorators,
  Body,
  Param,
  Query,
} from '@nestjs/common';
import { ApiBody, ApiQuery } from '@nestjs/swagger';
import { randomUUID } from 'node:crypto';
import type { Request, Response } from 'express';
import { finalize } from 'rxjs';
import { z } from 'zod';

export const idSchema = z
  .string()
  .min(1)
  .max(128)
  .refine((v) => !v.includes('/') && v !== '.' && v !== '..');
export const operationIdSchema = z.string().uuid();
export const pageSchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(20),
  cursor: z.string().max(1024).optional(),
});
export type PageInput = z.infer<typeof pageSchema>;
export function ApiInput(schema: z.ZodType) {
  return applyDecorators(
    ApiBody({ schema: z.toJSONSchema(schema, { io: 'input' }) as never }),
  );
}
export function ApiQueries(schema: z.ZodObject) {
  const document = z.toJSONSchema(schema, { io: 'input' });
  return applyDecorators(
    ...Object.entries(document.properties ?? {}).map(([name, property]) =>
      ApiQuery({
        name,
        required: document.required?.includes(name) ?? false,
        schema: property as never,
      }),
    ),
  );
}
// Nest 12's native Standard Schema validation uses these schemas at the boundary.
export const Input = (schema: z.ZodType) => Body({ schema });
export const ResourceId = (name = 'id') => Param(name, { schema: idSchema });
export const Page = () => Query({ schema: pageSchema });

@Catch()
export class ApiExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger(ApiExceptionFilter.name);
  catch(error: unknown, host: ArgumentsHost) {
    const response = host.switchToHttp().getResponse<Response>();
    const status = error instanceof HttpException ? error.getStatus() : 500;
    const body =
      error instanceof HttpException ? error.getResponse() : undefined;
    const code =
      typeof body === 'object' && body && 'code' in body
        ? body.code
        : ((
            {
              400: 'VALIDATION_ERROR',
              401: 'UNAUTHENTICATED',
              403: 'FORBIDDEN',
              404: 'NOT_FOUND',
              409: 'CONFLICT',
              429: 'RATE_LIMITED',
            } as Record<number, string>
          )[status] ?? 'INTERNAL_ERROR');
    if (status >= 500)
      this.logger.error(
        JSON.stringify({
          event: 'request_failed',
          requestId: response.getHeader('x-request-id'),
          errorType: error instanceof Error ? error.name : 'Unknown',
          stackFrames:
            error instanceof Error
              ? error.stack?.split('\n').slice(1)
              : undefined,
        }),
      );
    if (response.headersSent) {
      response.end();
      return;
    }
    response.status(status).json({
      code,
      statusCode: status,
      requestId: response.getHeader('x-request-id'),
    });
  }
}
@Injectable()
export class RequestLoggingInterceptor implements NestInterceptor {
  private readonly logger = new Logger('HTTP');
  intercept(context: ExecutionContext, next: CallHandler) {
    const http = context.switchToHttp();
    const request = http.getRequest<Request>();
    const response = http.getResponse<Response>();
    const requestId = String(
      response.getHeader('x-request-id') ?? randomUUID(),
    );
    response.setHeader('x-request-id', requestId);
    const start = Date.now();
    return next.handle().pipe(
      finalize(() =>
        this.logger.log(
          JSON.stringify({
            requestId,
            method: request.method,
            route: request.route?.path,
            durationMs: Date.now() - start,
          }),
        ),
      ),
    );
  }
}
