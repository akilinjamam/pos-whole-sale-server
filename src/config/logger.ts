import { pino } from 'pino';

import { config } from './env.js';

/**
 * Application logger. Pretty-printed in development, JSON lines in production so a log
 * shipper can parse it.
 *
 * **Do not delete the `redact` list because it looks unused.** The HTTP logger in `app.ts`
 * now runs custom serializers that keep only `id`/`method`/`url`/`remoteAddress` and
 * `statusCode`, so request logging never reaches a header or a body and these paths no longer
 * match anything on that route.
 *
 * They remain the backstop for **direct** logging calls — any `logger.info({ req })`,
 * `logger.error({ err, req })` or similar written later, where the full object goes in
 * unfiltered. Without them the first such call writes a bearer token or a plaintext password
 * into the log, and that is not a mistake anyone notices until it is already on disk.
 */
export const logger = pino({
  level: config.logLevel,
  redact: {
    paths: [
      'req.headers.authorization',
      'req.headers.cookie',
      'req.body.password',
      'req.body.currentPassword',
      'req.body.newPassword',
      'res.headers["set-cookie"]',
    ],
    censor: '[redacted]',
  },
  ...(config.isProduction
    ? {}
    : {
        transport: {
          target: 'pino-pretty',
          options: {
            colorize: true,
            translateTime: 'HH:MM:ss',
            ignore: 'pid,hostname',
          },
        },
      }),
});
