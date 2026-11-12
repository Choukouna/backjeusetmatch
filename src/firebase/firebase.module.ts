import {
  Inject,
  Global,
  Injectable,
  Module,
  OnModuleDestroy,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  initializeApp,
  applicationDefault,
  cert,
  deleteApp,
  type App,
} from 'firebase-admin/app';
import { generateKeyPairSync } from 'node:crypto';
import { getAuth } from 'firebase-admin/auth';
import { getFirestore } from 'firebase-admin/firestore';

@Injectable()
export class FirebaseService implements OnModuleDestroy {
  readonly app: App;
  readonly auth;
  readonly db;
  constructor(@Inject(ConfigService) config: ConfigService) {
    this.app = initializeApp(
      {
        projectId: config.getOrThrow<string>('FIREBASE_PROJECT_ID'),
        ...(config.get('FIRESTORE_EMULATOR_HOST') &&
        config.get('FIREBASE_AUTH_EMULATOR_HOST')
          ? {
              credential: cert({
                projectId: config.getOrThrow<string>('FIREBASE_PROJECT_ID'),
                clientEmail: 'emulator@example.test',
                privateKey: generateKeyPairSync('rsa', {
                  modulusLength: 2048,
                  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
                  publicKeyEncoding: { type: 'spki', format: 'pem' },
                }).privateKey,
              }),
            }
          : { credential: applicationDefault() }),
      },
      `jeusetfun-${crypto.randomUUID()}`,
    );
    this.auth = getAuth(this.app);
    this.db = getFirestore(this.app);
  }
  async onModuleDestroy() {
    await this.db.terminate();
    await deleteApp(this.app);
  }
}
@Global()
@Module({ providers: [FirebaseService], exports: [FirebaseService] })
export class FirebaseModule {}
