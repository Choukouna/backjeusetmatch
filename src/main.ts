import { NestFactory } from '@nestjs/core';
import { ConfigService } from '@nestjs/config';
import { AppModule } from './app.module.js';
import { configureApp } from './bootstrap.js';
const app = await NestFactory.create(AppModule);
configureApp(app);
await app.listen(app.get(ConfigService).getOrThrow<number>('PORT'), '0.0.0.0');
