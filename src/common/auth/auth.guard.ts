import { CanActivate, ExecutionContext, ForbiddenException, Inject, Injectable, UnauthorizedException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { JwtService } from '@nestjs/jwt';
import { ENV, type Env } from '../../config/env';
import { ACCESS_COOKIE } from './cookies';
import { type Actor, type AuthedRequest, IS_PUBLIC, ROLES, type UserRole } from './actor';

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

interface AccessClaims {
  sub: string;
  org: string;
  role: UserRole;
  name: string;
}

/**
 * Global guard: verifies the access JWT (cookie or Bearer), then the route's @Roles.
 * Cookie-authenticated writes must carry X-Requested-With: a cross-site form cannot set it, and setting it
 * from another origin forces a CORS preflight that our allowlist rejects (CSRF defence).
 */
@Injectable()
export class AuthGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly jwt: JwtService,
    @Inject(ENV) private readonly env: Env,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<AuthedRequest>();
    const cookies = (request.cookies ?? {}) as Record<string, string | undefined>;
    const usesCookies = Object.keys(cookies).some((name) => name.startsWith('vp_'));
    if (usesCookies && !SAFE_METHODS.has(request.method) && !request.headers['x-requested-with']) {
      throw new ForbiddenException('Missing X-Requested-With header');
    }

    const targets = [context.getHandler(), context.getClass()];
    if (this.reflector.getAllAndOverride<boolean>(IS_PUBLIC, targets)) return true;

    const bearer = request.headers.authorization?.match(/^Bearer (.+)$/)?.[1];
    const token = bearer ?? cookies[ACCESS_COOKIE];
    if (!token) throw new UnauthorizedException('Sign in required');
    let claims: AccessClaims;
    try {
      claims = await this.jwt.verifyAsync<AccessClaims>(token, { secret: this.env.jwtAccessSecret, algorithms: ['HS256'] });
    } catch {
      throw new UnauthorizedException('Session expired');
    }
    const actor: Actor = { userId: claims.sub, organizationId: claims.org, role: claims.role, name: claims.name };
    request.actor = actor;

    const roles = this.reflector.getAllAndOverride<UserRole[] | undefined>(ROLES, targets);
    if (roles && !roles.includes(actor.role)) throw new ForbiddenException('Your role cannot do this');
    return true;
  }
}
