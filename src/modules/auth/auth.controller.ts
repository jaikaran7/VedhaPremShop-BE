import { Body, Controller, Get, HttpCode, Inject, Post, Req, Res } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import type { CookieOptions, Response } from 'express';
import { type Actor, type AuthedRequest, CurrentActor, Public } from '../../common/auth/actor';
import { ACCESS_COOKIE, REFRESH_COOKIE } from '../../common/auth/cookies';
import { ENV, type Env } from '../../config/env';
import { AuthService, type IssuedSession } from './auth.service';
import { ChangePasswordDto, LoginDto } from './auth.dto';
import { ApiEndpoint, ApiStandardErrors } from '../../common/http/swagger';

const REFRESH_PATH = '/api/v1/auth';

@ApiTags('auth')
@ApiStandardErrors()
@Controller('auth')
export class AuthController {
  constructor(
    private readonly auth: AuthService,
    @Inject(ENV) private readonly env: Env,
  ) {}

  @ApiEndpoint('Sign in', 'Sets httpOnly access and refresh cookies and also returns the access token for non-browser clients. Limited to 10 attempts a minute.')
  @Public()
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @Post('login')
  @HttpCode(200)
  async login(@Body() dto: LoginDto, @Res({ passthrough: true }) res: Response) {
    return this.respond(res, await this.auth.login(dto.username, dto.password));
  }

  @ApiEndpoint('Refresh the session', 'Uses the refresh cookie to issue a new access token and rotate the refresh token.')
  @Public()
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  @Post('refresh')
  @HttpCode(200)
  async refresh(@Req() req: AuthedRequest, @Res({ passthrough: true }) res: Response) {
    return this.respond(res, await this.auth.refresh(req.cookies?.[REFRESH_COOKIE]));
  }

  @ApiEndpoint('Sign out', 'Revokes the refresh token and clears both cookies.', 204)
  @Public()
  @Post('logout')
  @HttpCode(204)
  async logout(@Req() req: AuthedRequest, @Res({ passthrough: true }) res: Response): Promise<void> {
    await this.auth.logout(req.cookies?.[REFRESH_COOKIE]);
    res.clearCookie(ACCESS_COOKIE, this.cookie('/'));
    res.clearCookie(REFRESH_COOKIE, this.cookie(REFRESH_PATH));
  }

  @ApiEndpoint('Current user', 'The signed-in user and role.')
  @Get('me')
  me(@CurrentActor() actor: Actor) {
    return this.auth.me(actor);
  }

  @ApiEndpoint('Change own password', 'Needs the current password and a new password of at least 8 characters.', 204)
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
