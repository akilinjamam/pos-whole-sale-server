import { randomUUID } from 'node:crypto';

import compression from 'compression';
import cookieParser from 'cookie-parser';
import cors from 'cors';
import express, { type Express } from 'express';
import rateLimit from 'express-rate-limit';
import helmet from 'helmet';
import { pinoHttp } from 'pino-http';

import { config } from './config/env.js';
import { logger } from './config/logger.js';
import { errorHandler, notFoundHandler } from './middleware/errorHandler.js';
import { allRoutes } from './routes/index.js';

export function createApp(): Express {
  const app = express();

  // Behind nginx in production, so req.ip and rate limiting see the real client address.
  app.set('trust proxy', 1);
  app.disable('x-powered-by');

  app.use(
    pinoHttp({
      logger,
      genReqId: (req, res) => {
        const id = (req.headers['x-request-id'] as string) || randomUUID();
        res.setHeader('x-request-id', id);
        return id;
      },
      // Health polls every few seconds from the client Home page; do not flood the log.
      autoLogging: { ignore: (req) => req.url?.startsWith('/api/v1/health') ?? false },
    }),
  );

  app.use(helmet());
  app.use(
    cors({
      origin: config.http.corsOrigins,
      credentials: true,
    }),
  );
  app.use(compression());
  app.use(express.json({ limit: '5mb' }));
  app.use(express.urlencoded({ extended: true }));
  app.use(cookieParser());

  app.use(
    '/api/v1',
    rateLimit({
      windowMs: config.http.rateLimitWindowMs,
      max: config.http.rateLimitMax,
      standardHeaders: true,
      legacyHeaders: false,
      skip: (req) => req.path.startsWith('/health'),
    }),
  );

  // From Day 2, a blanket `authenticate` guard mounts here with `publicPaths` exempted, so a
  // route that forgets its own guard is still protected.

  for (const { path, route } of allRoutes) {
    app.use(`/api/v1/${path}`, route);
  }

  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}
