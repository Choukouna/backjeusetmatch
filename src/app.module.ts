import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { APP_GUARD, APP_FILTER, APP_INTERCEPTOR } from '@nestjs/core';
import { ThrottlerModule, ThrottlerGuard } from '@nestjs/throttler';
import { validateEnvironment } from './config/environment.js';
import { ApiExceptionFilter, RequestLoggingInterceptor } from './common/http.js';
import { FirebaseModule } from './firebase/firebase.module.js';
import { FirebaseAuthGuard } from './auth/auth.guard.js';
import { AuthModule } from './auth/auth.module.js';
import { PlayersModule } from './players/players.module.js';
import { NotificationsModule } from './notifications/notifications.module.js';
import { FriendshipsModule } from './friendships/friendships.module.js';
import { MatchesModule } from './matches/matches.module.js';
import { AvailabilityModule } from './availability/availability.module.js';
import { ChatModule } from './chat/chat.module.js';
import { GroupsModule } from './groups/groups.module.js';
import { LeaguesModule } from './leagues/leagues.module.js';
import { FeedbackModule } from './feedback/feedback.module.js';
import { HealthModule } from './health/health.module.js';
@Module({
  imports: [ConfigModule.forRoot({ isGlobal: true, validate: validateEnvironment }), ThrottlerModule.forRoot([{ ttl: 60000, limit: 120 }]), FirebaseModule, NotificationsModule, AuthModule, PlayersModule, FriendshipsModule, MatchesModule, AvailabilityModule, ChatModule, GroupsModule, LeaguesModule, FeedbackModule, HealthModule],
  providers: [
    { provide: APP_GUARD, useClass: ThrottlerGuard },
    { provide: APP_GUARD, useClass: FirebaseAuthGuard },
    { provide: APP_FILTER, useClass: ApiExceptionFilter },
    { provide: APP_INTERCEPTOR, useClass: RequestLoggingInterceptor },
  ],
})
export class AppModule {}
