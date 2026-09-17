import { pino } from 'pino';

import { config } from './env.js';

/**
 * Application logger. Pretty-printed in development, JSON lines in production so a log
 * shipper can parse it.
 *
 * `redact` is not optional here: request logging would otherwise write bearer tokens and
 * password fields straight into the log file.
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
