/**
 * Structured logging.
 *
 * Business failures are codes, not sentences (DESIGN.md §10.1), and the same
 * discipline applies to logs: one JSON object per event, with the fields an
 * operator would filter on. Never log a bearer token, a recovery code, or any
 * other credential — see the redaction list below.
 */

import pino from 'pino'

export function createLogger({ LOG_LEVEL, isProduction }) {
  return pino({
    level: LOG_LEVEL,
    // Pretty output is a development convenience; production emits JSON for
    // whatever collects it.
    transport: isProduction
      ? undefined
      : { target: 'pino-pretty', options: { translateTime: 'HH:MM:ss', ignore: 'pid,hostname' } },
    redact: {
      // Scoped deliberately: business error codes are logged as `code` and must
      // stay readable, so only credential-bearing request fields are censored.
      paths: [
        'req.headers.authorization',
        'req.headers.cookie',
        'body.code',
        'body.device_id',
        'body.token',
        'token',
        'recovery_code',
      ],
      censor: '[redacted]',
    },
    base: undefined,
  })
}
