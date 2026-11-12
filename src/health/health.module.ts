import { Inject } from '@nestjs/common';
import {
  Controller,
  Get,
  Module,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { FirebaseService } from '../firebase/firebase.module.js';
import { Public } from '../auth/auth.guard.js';
@ApiTags('health')
@Public()
@Controller('health')
class HealthController {
  constructor(
    @Inject(FirebaseService) private readonly firebase: FirebaseService,
  ) {}
  @Get('live') live() {
    return { status: 'ok' };
  }
  @Get('ready') async ready() {
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        this.firebase.db.collection('_health').doc('ready').get(),
        new Promise((_, reject) => {
          timeout = setTimeout(() => reject(new Error('timeout')), 3000);
        }),
      ]);
      return { status: 'ok' };
    } catch {
      throw new ServiceUnavailableException({ code: 'FIREBASE_UNAVAILABLE' });
    } finally {
      if (timeout) clearTimeout(timeout);
    }
  }
}
@Module({ controllers: [HealthController] })
export class HealthModule {}
