import { Body, Controller, Get, HttpCode, Inject, Post, Req, Res } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import type { CookieOptions, Response } from 'express';
import { type Actor, type AuthedRequest, CurrentActor, Public } from '../../common/auth/actor';
import { ACCESS_COOKIE, REFRESH_COOKIE } from '../../common/auth/cookies';
import { ENV, type Env } from '../../config/env';
import { AuthService, type IssuedSession } from './auth.service';
import { ChangePasswordDto, LoginDto } from './auth.dto';

const REFRESH_PATH = '/api/v1/auth';

@ApiTags('auth')
@Controller('auth')
export class AuthController {
  constructor(
    private readonly auth: AuthService,
    @Inject(ENV) private readonly env: Env,
  ) {}

  @Public()
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @Post('login')
  @HttpCode(200)
  async login(@Body() dto: LoginDto, @Res({ passthrough: true }) res: Response) {
    return this.respond(res, await this.auth.login(dto.username, dto.password));
  }

  @Public()
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  @Post('refresh')
  @HttpCode(200)
  async refresh(@Req() req: AuthedRequest, @Res({ passthrough: true }) res: Response) {
    return this.respond(res, await this.auth.refresh(req.cookies?.[REFRESH_COOKIE]));
  }

  @Public()
  @Post('logout')
  @HttpCode(204)
  async logout(@Req() req: AuthedRequest, @Res({ passthrough: true }) res: Response): Promise<void> {
    await this.auth.logout(req.cookies?.[REFRESH_COOKIE]);
    res.clearCookie(ACCESS_COOKIE, this.cookie('/'));
    res.clearCookie(REFRESH_COOKIE, this.cookie(REFRESH_PATH));
  }

  @Get('me')
  me(@CurrentActor() actor: Actor) {
    return this.auth.me(actor);
  }

  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  @Post('change-password')
  @HttpCode(204)
  async changePassword(@CurrentActor() actor: Actor, @Body() dto: ChangePasswordDto): Promise<void> {
    await this.auth.changePassword(actor, dto.currentPassword, dto.newPassword);
  }

  private respond(res: Response, session: IssuedSession) {
    res.cookie(ACCESS_COOKIE, session.accessToken, { ...this.cookie('/'), maxAge: session.accessTtlSeconds * 1000 });
    res.cookie(REFRESH_COOKIE, session.refreshToken, { ...this.cookie(REFRESH_PATH), maxAge: session.refreshTtlSeconds * 1000 });
    // The refresh token stays cookie-only. The access token is also returned for non-browser API clients.
    return { user: session.user, accessToken: session.accessToken, expiresIn: session.accessTtlSeconds };
  }

  private cookie(path: string): CookieOptions {
    const crossSite = this.env.cookieCrossSite;
    return { httpOnly: true, secure: crossSite || this.env.nodeEnv === 'production', sameSite: crossSite ? 'none' : 'lax', path };
  }
}
