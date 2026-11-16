import { Inject } from '@nestjs/common';
import {
  CanActivate,
  ExecutionContext,
  Injectable,
  SetMetadata,
  UnauthorizedException,
  createParamDecorator,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';
import { FirebaseService } from '../firebase/firebase.module.js';
export const Public = () => SetMetadata('public', true);
export type AuthenticatedRequest = Request & {
  uid: string;
  tokenExpiresAt: number;
  tokenAuthenticatedAt: number;
};
export const CurrentUid = createParamDecorator(
  (_data: unknown, context: ExecutionContext) =>
    context.switchToHttp().getRequest<AuthenticatedRequest>().uid,
);
@Injectable()
export class FirebaseAuthGuard implements CanActivate {
  constructor(
    @Inject(FirebaseService) private readonly firebase: FirebaseService,
    @Inject(Reflector) private readonly reflector: Reflector,
  ) {}
  async canActivate(context: ExecutionContext) {
    if (
      this.reflector.getAllAndOverride<boolean>('public', [
        context.getHandler(),
        context.getClass(),
      ])
    )
      return true;
    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    const match = /^Bearer ([^ ]+)$/i.exec(request.headers.authorization ?? '');
    if (!match) throw new UnauthorizedException();
    try {
      const token = await this.firebase.auth.verifyIdToken(match[1], true);
      request.uid = token.uid;
      request.tokenExpiresAt = token.exp * 1000;
      request.tokenAuthenticatedAt = token.auth_time * 1000;
      return true;
    } catch {
      throw new UnauthorizedException();
    }
  }
}
