import pino from 'pino';
import { env } from '../env.js';

/**
 * Structured JSON logs with a redaction list so credentials never reach a log sink
 * (11_API_KEYS KEY-5, 02_TRD §2.12).
 */
export const logger = pino({
  level: env.LOG_LEVEL,
  redact: {
    paths: [
      'req.headers.authorization',
      'req.headers.cookie',
      '*.client_secret',
      '*.password',
      '*.token',
      '*.api_key',
      '*.apiKey',
      '*.access_token',
      '*.refresh_token',
      '*.JWT_ACCESS_SECRET',
      '*.JWT_REFRESH_SECRET',
    ],
    censor: '[redacted]',
  },
  transport:
    env.NODE_ENV === 'development'
      ? { target: 'pino-pretty', options: { colorize: true, translateTime: 'SYS:standard' } }
      : undefined,
});
