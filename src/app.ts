import { ConsoleLogger, type INestApplication, ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import cookieParser from 'cookie-parser';
import { json, type Express, type Request, type Response } from 'express';
import { AppModule } from './app.module';
import { isAllowedCorsOrigin } from './common/http/cors-origin';
import { requestId } from './common/http/request-id.middleware';
import { loadEnv, type Env } from './config/env';

/** Shared by main.ts and the e2e tests so both run the exact same pipeline. */
export async function createApp(env: Env, options: { logger?: false } = {}): Promise<INestApplication> {
  const app = await NestFactory.create(AppModule.forRoot(env), {
    bodyParser: false,
    logger: options.logger === false ? false : new ConsoleLogger({ json: env.nodeEnv === 'production', logLevels: ['log', 'warn', 'error'] }),
  });
  app.use(requestId);
  app.use(json({ limit: '256kb' }));
  app.use(cookieParser());
  app.setGlobalPrefix('api/v1');
  app.enableCors({
    origin: (origin: string | undefined, callback: (err: Error | null, allow?: boolean) => void) => {
      callback(null, isAllowedCorsOrigin(origin, env.corsOrigins, env.nodeEnv));
    },
    credentials: true,
    allowedHeaders: ['Content-Type', 'Accept', 'X-Requested-With', 'Idempotency-Key', 'X-Request-Id'],
    exposedHeaders: ['X-Request-Id', 'X-Total-Count'],
  });
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true, stopAtFirstError: false }));
  app.enableShutdownHooks();

  if (env.nodeEnv !== 'production') {
    const doc = SwaggerModule.createDocument(app, new DocumentBuilder()
      .setTitle('Vedhaprem Mandi API').setVersion('1').addBearerAuth().addCookieAuth('vp_access').build());
    SwaggerModule.setup('api/docs', app, doc);
  }
  return app;
}

let starting: Promise<Express> | undefined;

function httpServer(): Promise<Express> {
  starting ??= createApp(loadEnv()).then((app) => app.getHttpAdapter().getInstance() as Express);
  return starting;
}

/** Vercel serves this file. The default export has to be the HTTP server. */
export default function handler(req: Request, res: Response): void {
  void httpServer()
    .then((server) => {
      server(req, res);
    })
    .catch((error: unknown) => {
      console.error(error instanceof Error ? error.name : 'API failed to start');
      if (res.headersSent) return;
      res.statusCode = 500;
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ statusCode: 500, error: 'Internal Server Error', message: 'API failed to start' }));
    });
}
