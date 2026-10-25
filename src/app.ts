import { ConsoleLogger, type INestApplication, ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import cookieParser from 'cookie-parser';
import { json } from 'express';
import { AppModule } from './app.module';
import { requestId } from './common/http/request-id.middleware';
import type { Env } from './config/env';

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
    origin: env.corsOrigins,
    credentials: true,
    allowedHeaders: ['Content-Type', 'Accept', 'X-Requested-With', 'Idempotency-Key', 'X-Request-Id'],
    exposedHeaders: ['X-Request-Id'],
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
