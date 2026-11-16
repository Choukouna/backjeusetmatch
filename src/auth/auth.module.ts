import { Inject } from '@nestjs/common';
import {
  Controller,
  Post,
  Module,
  Injectable,
  UnauthorizedException,
  ServiceUnavailableException,
  HttpCode,
  HttpException,
  Logger,
  Delete,
  Req,
  ForbiddenException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { z } from 'zod';
import { FieldValue } from 'firebase-admin/firestore';
import { FirebaseService } from '../firebase/firebase.module.js';
import { PlayersModule } from '../players/players.module.js';
import { PlayersRepository } from '../players/players.repository.js';
import {
  loginSchema,
  signupSchema,
  registrationSchema,
  type Registration,
} from '../players/players.schemas.js';
import { ApiInput, Input } from '../common/http.js';
import { CurrentUid, Public, type AuthenticatedRequest } from './auth.guard.js';

@Injectable()
export class AuthService {
  constructor(
    @Inject(FirebaseService) private readonly firebase: FirebaseService,
    @Inject(PlayersRepository) private readonly players: PlayersRepository,
    @Inject(ConfigService) private readonly config: ConfigService,
  ) {}
  private async identity(method: string, payload: Record<string, unknown>) {
    const emulator = this.config.get<string>('FIREBASE_AUTH_EMULATOR_HOST');
    const base = emulator
      ? `http://${emulator}/identitytoolkit.googleapis.com/v1`
      : 'https://identitytoolkit.googleapis.com/v1';
    try {
      const response = await fetch(
        `${base}/accounts:${method}?key=${encodeURIComponent(this.config.getOrThrow('FIREBASE_WEB_API_KEY'))}`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(payload),
          signal: AbortSignal.timeout(10000),
        },
      );
      if (!response.ok) {
        if (response.status >= 500 || response.status === 429)
          throw new ServiceUnavailableException();
        throw new UnauthorizedException({ code: 'INVALID_CREDENTIALS' });
      }
      return (await response.json()) as { localId: string };
    } catch (error) {
      if (
        error instanceof UnauthorizedException ||
        error instanceof ServiceUnavailableException
      )
        throw error;
      throw new ServiceUnavailableException();
    }
  }
  async login(body: z.infer<typeof loginSchema>) {
    const result = await this.firebase.db
      .collection('players')
      .where('pseudo', '==', body.pseudo)
      .limit(2)
      .get();
    if (result.size !== 1)
      throw new UnauthorizedException({ code: 'INVALID_CREDENTIALS' });
    const player = result.docs[0];
    const verified = await this.identity('signInWithPassword', {
      email: player.get('email'),
      password: body.password,
      returnSecureToken: true,
    });
    if (verified.localId !== player.id)
      throw new UnauthorizedException({ code: 'INVALID_CREDENTIALS' });
    return {
      customToken: await this.firebase.auth.createCustomToken(verified.localId),
    };
  }
  async signup(body: z.infer<typeof signupSchema>) {
    const { email, password, ...profile } = body;
    // Firebase Auth creation is followed by an idempotent profile completion step.
    // If profile completion fails, retain the account: the authenticated completion
    // endpoint permits safe recovery rather than deleting an account on ambiguity.
    const created = await this.identity('signUp', {
      email,
      password,
      returnSecureToken: true,
    });
    const customToken = await this.firebase.auth.createCustomToken(
      created.localId,
    );
    try {
      await this.players.register(created.localId, email, profile);
      return { customToken, profileComplete: true };
    } catch (error) {
      // The account exists. Return its session so the client can retry completion.
      const response =
        error instanceof HttpException ? error.getResponse() : undefined;
      const profileError =
        typeof response === 'object' && response && 'code' in response
          ? response.code
          : 'PROFILE_COMPLETION_REQUIRED';
      return { customToken, profileComplete: false, profileError };
    }
  }
  async complete(uid: string, body: Registration) {
    const user = await this.firebase.auth.getUser(uid);
    if (!user.email) throw new UnauthorizedException();
    return this.players.register(uid, user.email.toLowerCase(), body);
  }
  async deleteAccount(uid: string, authenticatedAt: number) {
    if (
      !Number.isFinite(authenticatedAt) ||
      Date.now() - authenticatedAt > 300000
    )
      throw new ForbiddenException({ code: 'RECENT_LOGIN_REQUIRED' });
    const db = this.firebase.db,
      ref = db.collection('players').doc(uid);
    await db.runTransaction(async (tx) => {
      const player = await tx.get(ref);
      if (!player.exists) return;
      const reservation = player.get('pseudo')
        ? db
            .collection('_pseudo_reservations')
            .doc(String(player.get('pseudo')))
        : undefined;
      const claim = reservation ? await tx.get(reservation) : undefined;
      if (reservation && claim?.get('uid') === uid) tx.delete(reservation);
      // Preserve legacy references and historical match results while anonymizing.
      tx.update(ref, {
        pseudo: '',
        name: 'JOUEUR',
        lastname: 'Anonyme',
        city: null,
        deptCode: null,
        email: FieldValue.delete(),
        fcmToken: [],
        updatedAt: FieldValue.serverTimestamp(),
        apiAccountState: 'DELETING',
      });
    });
    try {
      await this.firebase.auth.deleteUser(uid);
    } catch (error) {
      if (!(
        error &&
        typeof error === 'object' &&
        'code' in error &&
        error.code === 'auth/user-not-found'
      ))
        throw error;
    }
    return { deleted: true };
  }
  async reset(pseudo: string) {
    const result = await this.firebase.db
      .collection('players')
      .where('pseudo', '==', pseudo)
      .limit(2)
      .get();
    if (result.size === 1) {
      try {
        await this.identity('sendOobCode', {
          requestType: 'PASSWORD_RESET',
          email: result.docs[0].get('email'),
        });
      } catch {
        new Logger('Auth').warn(
          JSON.stringify({ event: 'password_reset_delivery_failed' }),
        );
      }
    }
    return { accepted: true };
  }
}
const resetSchema = z.object({ pseudo: loginSchema.shape.pseudo }).strict();
@ApiTags('auth')
@Controller('auth')
@Throttle({ default: { limit: 10, ttl: 60000 } })
class AuthController {
  constructor(@Inject(AuthService) private readonly auth: AuthService) {}
  @Public()
  @Post('login')
  @HttpCode(200)
  @ApiInput(loginSchema)
  login(@Input(loginSchema) body: z.infer<typeof loginSchema>) {
    return this.auth.login(body);
  }
  @Public()
  @Post('signup')
  @ApiInput(signupSchema)
  signup(@Input(signupSchema) body: z.infer<typeof signupSchema>) {
    return this.auth.signup(body);
  }
  @ApiBearerAuth()
  @Post('complete-profile')
  @ApiInput(registrationSchema)
  complete(
    @CurrentUid() uid: string,
    @Input(registrationSchema) body: Registration,
  ) {
    return this.auth.complete(uid, body);
  }
  @ApiBearerAuth()
  @Delete('account')
  deleteAccount(@Req() req: AuthenticatedRequest) {
    return this.auth.deleteAccount(req.uid, req.tokenAuthenticatedAt);
  }
  @Public()
  @Post('password-reset')
  @HttpCode(202)
  @ApiInput(resetSchema)
  reset(@Input(resetSchema) body: z.infer<typeof resetSchema>) {
    return this.auth.reset(body.pseudo);
  }
}
@Module({
  imports: [PlayersModule],
  controllers: [AuthController],
  providers: [AuthService],
})
export class AuthModule {}
