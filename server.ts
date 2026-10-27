import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import type { Express, Request, Response } from 'express';
import { createApp } from './src/app';
import { loadEnv } from './src/config/env';

// Vercel picks the first entry that imports Nest. src/app.ts only exports createApp, so the
// runtime rejects it. This file is the HTTP server, and the named export keeps the Nest import live.
export const nestFramework = NestFactory;

let starting: Promise<Express> | undefined;

function httpServer(): Promise<Express> {
  starting ??= createApp(loadEnv()).then((app) => app.getHttpAdapter().getInstance() as Express);
  return starting;
}

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
