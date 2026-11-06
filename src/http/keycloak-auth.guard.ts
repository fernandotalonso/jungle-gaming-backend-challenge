import { Injectable, CanActivate, ExecutionContext, UnauthorizedException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { createRemoteJWKSet, jwtVerify, type JWTPayload } from 'jose';
import { IS_PUBLIC_KEY } from './public.decorator';

const JWKS_CACHE_SECONDS = 600;

/**
 * Validates Keycloak-issued JWTs (RS256) against the realm JWKS: signature,
 * issuer and expiry. Audience is not strictly enforced — Keycloak does not
 * emit a custom `aud` for client-credentials tokens without an audience
 * mapper; the signature + issuer already prove the token was minted by OUR
 * realm (documented in ARCHITECTURE.md).
 *
 * Health endpoints are @Public() (README 2/9). Queue messages never pass
 * through HTTP — the queue is treated as a trusted internal channel.
 */
@Injectable()
export class KeycloakAuthGuard implements CanActivate {
  private static jwks = createRemoteJWKSet(new URL(`${process.env.KEYCLOAK_ISSUER}/protocol/openid-connect/certs`), {
    cooldownDuration: JWKS_CACHE_SECONDS * 1000,
  });

  constructor(private readonly reflector: Reflector) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) {
      return true;
    }

    const request = context.switchToHttp().getRequest<{ headers: Record<string, string | undefined> }>();
    const authorization = request.headers['authorization'];
    if (typeof authorization !== 'string' || !authorization.startsWith('Bearer ')) {
      throw new UnauthorizedException('missing bearer token');
    }
    const token = authorization.slice('Bearer '.length).trim();
    if (token.length === 0) {
      throw new UnauthorizedException('missing bearer token');
    }

    const issuer = process.env.KEYCLOAK_ISSUER;
    if (!issuer) {
      throw new UnauthorizedException('authentication is not configured');
    }

    try {
      const { payload } = await jwtVerify(token, KeycloakAuthGuard.jwks, { issuer });
      (request as { auth?: JWTPayload }).auth = payload;
      return true;
    } catch {
      throw new UnauthorizedException('invalid or expired token');
    }
  }
}
