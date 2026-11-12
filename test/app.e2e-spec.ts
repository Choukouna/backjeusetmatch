import 'reflect-metadata';
import { ConfigService } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { AppModule } from '../src/app.module.js';
import { FirebaseService } from '../src/firebase/firebase.module.js';
import { configureApp } from '../src/bootstrap.js';
describe('API boundary', () => {
  let app: INestApplication;
  const verifyIdToken = vi.fn();
  beforeAll(async () => {
    const module = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(FirebaseService)
      .useValue({ auth: { verifyIdToken }, db: {} })
      .compile();
    module.get(ConfigService).set('ENABLE_SWAGGER', 'true');
    app = module.createNestApplication({ logger: false });
    configureApp(app);
    await app.init();
  });
  afterAll(async () => {
    await app.close();
  });
  it('has a public liveness endpoint', async () => {
    await request(app.getHttpServer())
      .get('/api/jeusetfun/v1/health/live')
      .expect(200, { status: 'ok' });
  });
  it('denies missing and invalid tokens', async () => {
    await request(app.getHttpServer())
      .get('/api/jeusetfun/v1/players/me')
      .expect(401)
      .expect(({ body }) => {
        expect(body.code).toBe('UNAUTHENTICATED');
        expect(body.requestId).toBeTypeOf('string');
      });
    verifyIdToken.mockRejectedValueOnce(new Error('expired'));
    await request(app.getHttpServer())
      .get('/api/jeusetfun/v1/players/me')
      .set('Authorization', 'Bearer invalid')
      .expect(401);
  });
  it('validates protected requests before database access', async () => {
    verifyIdToken.mockResolvedValue({
      uid: 'alice',
      exp: Math.floor(Date.now() / 1000) + 3600,
    });
    await request(app.getHttpServer())
      .patch('/api/jeusetfun/v1/players/me')
      .set('Authorization', 'Bearer valid')
      .send({ wins: 999 })
      .expect(400);
    expect(verifyIdToken).toHaveBeenCalledWith('valid', true);
  });
  it('publishes the versioned request contracts in OpenAPI', async () => {
    const response = await request(app.getHttpServer())
      .get('/api/docs-json')
      .expect(200);
    expect(
      response.body.paths['/api/jeusetfun/v1/auth/login'].post.requestBody.content[
        'application/json'
      ].schema.properties,
    ).toHaveProperty('pseudo');
    expect(response.body.paths).toHaveProperty('/api/jeusetfun/v1/chats/{id}/messages');
  });
  it('rejects unexpected login fields', async () => {
    await request(app.getHttpServer())
      .post('/api/jeusetfun/v1/auth/login')
      .send({ pseudo: 'alice01', password: 'secret', uid: 'victim' })
      .expect(400);
  });
});
