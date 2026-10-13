import type { Context } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';

const REASONS: Record<number, string> = {
  400: 'Bad Request',
  401: 'Unauthorized',
  403: 'Forbidden',
  404: 'Not Found',
  409: 'Conflict',
  413: 'Payload Too Large',
  429: 'Too Many Requests',
  500: 'Internal Server Error',
  501: 'Not Implemented',
};

export class ImmichError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

export function correlationId(c: Context): string {
  return c.req.header('cf-ray') ?? crypto.randomUUID();
}

export function errorBody(status: number, message: string, id: string) {
  return { message, error: REASONS[status] ?? 'Error', statusCode: status, correlationId: id };
}

export function onError(err: Error, c: Context) {
  if (err instanceof ImmichError) {
    return c.json(errorBody(err.status, err.message, correlationId(c)), err.status as ContentfulStatusCode);
  }
  console.error(err);
  return c.json(errorBody(500, 'Internal server error', correlationId(c)), 500);
}

export function notFound(c: Context) {
  return c.json(errorBody(404, 'Not found', correlationId(c)), 404);
}
