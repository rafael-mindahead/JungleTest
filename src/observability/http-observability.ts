import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { ArgumentsHost, Catch, ExceptionFilter, HttpException, HttpStatus } from '@nestjs/common';
import type { NextFunction, Request, Response } from 'express';

interface TraceContext { readonly correlationId: string }
const traceStorage = new AsyncLocalStorage<TraceContext>();
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,99}$/;

/** Untrusted correlation IDs never become arbitrary log text or headers. */
export function normalizedCorrelationId(value: unknown): string {
  return typeof value === 'string' && SAFE_ID.test(value) ? value : randomUUID();
}
export function currentCorrelationId(): string | undefined {
  return traceStorage.getStore()?.correlationId;
}
export function correlationMiddleware(req: Request, res: Response, next: NextFunction): void {
  const correlationId = normalizedCorrelationId(req.header('x-correlation-id'));
  res.setHeader('X-Correlation-Id', correlationId);
  const started = performance.now();
  res.once('finish', () => {
    if (process.env.HTTP_ACCESS_LOGS === '0') return;
    // Route template only: no player IDs, tokens, query strings or monetary payloads.
    const route = typeof req.route?.path === 'string' ? req.route.path : 'unmatched';
    const record = {
      timestamp: new Date().toISOString(),
      level: 'info',
      event: 'http_request',
      correlationId,
      method: req.method,
      route,
      status: res.statusCode,
      durationMs: Math.round((performance.now() - started) * 100) / 100,
    };
    console.info(JSON.stringify(record));
  });
  traceStorage.run({ correlationId }, next);
}

export function httpErrorCode(status: number): string {
  switch (status) {
    case 400: return 'VALIDATION_ERROR';
    case 401: return 'UNAUTHORIZED';
    case 403: return 'FORBIDDEN';
    case 404: return 'NOT_FOUND';
    case 409: return 'CONFLICT';
    case 422: return 'UNPROCESSABLE_ENTITY';
    case 429: return 'RATE_LIMITED';
    case 503: return 'SERVICE_UNAVAILABLE';
    default: return status >= 500 ? 'INTERNAL_ERROR' : 'HTTP_ERROR';
  }
}

function publicHttpMessage(error: HttpException): string {
  const response = error.getResponse();
  if (typeof response === 'string') return response;
  if (response && typeof response === 'object' && 'message' in response) {
    const message = response.message;
    if (typeof message === 'string') return message;
    if (Array.isArray(message) && message.every(part => typeof part === 'string')) {
      return message.join('; ');
    }
  }
  return error.message;
}

/** Stable errors, with no raw SQL exceptions, stacks or financial data exposed. */
@Catch()
export class FinancialHttpErrorFilter implements ExceptionFilter {
  catch(error: unknown, host: ArgumentsHost): void {
    const res = host.switchToHttp().getResponse<Response>();
    const status = error instanceof HttpException ? error.getStatus() : HttpStatus.INTERNAL_SERVER_ERROR;
    const correlationId = currentCorrelationId() ??
      (res.getHeader('X-Correlation-Id')?.toString() || randomUUID());
    if (status >= 500) {
      console.error(JSON.stringify({
        timestamp: new Date().toISOString(),
        level: 'error',
        event: 'request_failed',
        correlationId,
        errorType: error instanceof Error ? error.name : 'UnknownError',
        status,
      }));
    }
    res.status(status).json({
      error: {
        code: httpErrorCode(status),
        message: error instanceof HttpException ? publicHttpMessage(error) : 'Internal server error',
        correlationId,
      },
    });
  }
}
