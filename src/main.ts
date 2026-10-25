import 'reflect-metadata';
import { Logger } from '@nestjs/common';
import { createApp } from './app';
import { loadEnv } from './config/env';

async function bootstrap() {
  const env = loadEnv();
  const app = await createApp(env);
  await app.listen(env.port, '0.0.0.0');
  Logger.log(`API listening on :${env.port}/api/v1`, 'Bootstrap');
}

void bootstrap();
