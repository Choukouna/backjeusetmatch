import {
  StandardSchemaValidationPipe,
  type INestApplication,
} from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type { Request, Response, NextFunction } from 'express';
import { ConfigService } from '@nestjs/config';
import { SwaggerModule, DocumentBuilder } from '@nestjs/swagger';
export function configureApp(app: INestApplication) {
  const config = app.get(ConfigService);
  app.use((_request: Request, response: Response, next: NextFunction) => {
    response.setHeader('x-request-id', randomUUID());
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('Cache-Control', 'no-store');
    next();
  });
  app.setGlobalPrefix('api/jeusetfun/v1');
  app.useGlobalPipes(new StandardSchemaValidationPipe());
  const origins = config
    .getOrThrow<string>('CORS_ORIGINS')
    .split(',')
    .map((v) => v.trim())
    .filter(Boolean);
  if (origins.length)
    app.enableCors({
      origin: origins,
      allowedHeaders: ['Authorization', 'Content-Type'],
      exposedHeaders: ['x-request-id'],
      methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'],
    });
  if (config.get('ENABLE_SWAGGER') === 'true') {
    const document = new DocumentBuilder()
      .setTitle('JeuSetFun API')
      .setDescription(
        'Firebase-authenticated backend for the JeuSetFun Flutter application. Times are ISO 8601; errors contain a stable code.',
      )
      .setVersion('1.0.0')
      .addBearerAuth()
      .build();
    SwaggerModule.setup('api/docs', app, () =>
      SwaggerModule.createDocument(app, document),
    );
  }
  app.enableShutdownHooks();
}
