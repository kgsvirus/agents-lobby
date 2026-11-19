// Global error handling: maps every failure to the shared error envelope.
// Zod errors → 400 validation_error; AppError → its own status/code; Fastify
// body-limit/JSON/media-type errors → 413/400/415; any other Fastify client
// error keeps its 4xx with a generic message; anything else → opaque 500
// (internals logged, never sent to the client).
import { ZodError } from 'zod';
import type { FastifyInstance } from 'fastify';
import { AppError, errorEnvelope } from '../../shared/errors/index.js';

export function registerErrorHandler(app: FastifyInstance): void {
  app.setErrorHandler((error, request, reply) => {
    if (error instanceof ZodError) {
      return reply.status(400).send(
        errorEnvelope('validation_error', 'Invalid input',
          error.issues.map((issue) => ({ path: issue.path.join('.'), message: issue.message }))),
      );
    }
    if (error instanceof AppError) {
      return reply.status(error.statusCode).send(errorEnvelope(error.code, error.message, error.details));
    }
    const code = (error as { code?: string }).code;
    if (code === 'FST_ERR_CTP_BODY_TOO_LARGE') {
      return reply.status(413).send(errorEnvelope('payload_too_large', 'Request body exceeds the configured size limit'));
    }
    if (code === 'FST_ERR_CTP_INVALID_JSON_BODY' || code === 'FST_ERR_CTP_EMPTY_JSON_BODY') {
      return reply.status(400).send(errorEnvelope('invalid_json', 'Request body is not valid JSON'));
    }
    if (code === 'FST_ERR_CTP_INVALID_MEDIA_TYPE') {
      return reply.status(415).send(
        errorEnvelope('unsupported_media_type', 'Send a JSON body (Content-Type: application/json)'),
      );
    }
    // Any other Fastify client error keeps its 4xx status - a malformed request
    // is the caller's mistake, not a server fault - with a generic message so no
    // internal text leaks.
    if (typeof code === 'string' && code.startsWith('FST_ERR_')) {
      const status = (error as { statusCode?: number }).statusCode;
      if (typeof status === 'number' && status >= 400 && status < 500) {
        return reply.status(status).send(errorEnvelope('invalid_request', 'Invalid request'));
      }
    }
    request.log.error(error);
    return reply.status(500).send(errorEnvelope('internal_error', 'Internal server error'));
  });

  app.setNotFoundHandler((_request, reply) => {
    return reply.status(404).send(errorEnvelope('not_found', 'Route not found'));
  });
}
