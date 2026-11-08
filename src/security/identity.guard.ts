import { createPublicKey, verify as verifySignature, type KeyObject, type JsonWebKey } from 'node:crypto';
import {
  CanActivate, ExecutionContext, ForbiddenException, Injectable,
  ServiceUnavailableException, SetMetadata, UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';

export type RouteAccess = 'admin' | 'provider' | 'admin-or-provider';
export const Access = (access: RouteAccess) => SetMetadata('jungle:access', access);

interface JwtHeader { alg?: unknown; typ?: unknown; kid?: unknown }
interface JwtClaims {
  iss?: unknown; aud?: unknown; sub?: unknown; exp?: unknown; iat?: unknown;
  nbf?: unknown; roles?: unknown; realm_access?: unknown; provider_id?: unknown;
}
interface JwksResponse { keys?: unknown }
interface PublicJwk extends JsonWebKey { kid?: string; use?: string; alg?: string; kty?: string }

export interface VerifiedIdentity {
  subject: string;
  roles: string[];
  providerId?: string;
}

function decodePart(part: string): Record<string, unknown> {
  if (!part || part.length > 16384 || !/^[A-Za-z0-9_-]+$/.test(part)) {
    throw new UnauthorizedException('Invalid bearer token');
  }
  try {
    const value: unknown = JSON.parse(Buffer.from(part, 'base64url').toString('utf8'));
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Not an object');
    return value as Record<string, unknown>;
  } catch {
    throw new UnauthorizedException('Invalid bearer token');
  }
}

@Injectable()
export class OidcTokenVerifier {
  private cachedKeys = new Map<string, KeyObject>();
  private cachedUntil = 0;

  private async keyFor(kid: string): Promise<KeyObject> {
    if (Date.now() >= this.cachedUntil || !this.cachedKeys.has(kid)) {
      const configured = process.env.OIDC_JWKS_URI;
      if (!configured) throw new ServiceUnavailableException('OIDC JWKS is not configured');
      let url: URL;
      try { url = new URL(configured); } catch {
        throw new ServiceUnavailableException('OIDC JWKS URI is invalid');
      }
      const local = (url.hostname === '127.0.0.1' || url.hostname === 'localhost') &&
        process.env.NODE_ENV === 'test';
      if ((url.protocol !== 'https:' && !(local && url.protocol === 'http:')) ||
          url.username || url.password || url.hash) {
        throw new ServiceUnavailableException('OIDC JWKS must use HTTPS');
      }
      try {
        const response = await fetch(url, {
          signal: AbortSignal.timeout(3000),
          redirect: 'error',
          headers: { Accept: 'application/json' },
        });
        if (!response.ok) throw new Error('JWKS unavailable');
        // Avoid accepting an arbitrary unbounded JWKS response.
        const size = Number(response.headers.get('content-length') ?? 0);
        if (size > 100000) throw new Error('JWKS too large');
        const parsed = await response.json() as JwksResponse;
        if (!Array.isArray(parsed.keys) || parsed.keys.length > 30) throw new Error('Invalid JWKS');
        const keys = new Map<string, KeyObject>();
        for (const entry of parsed.keys) {
          if (!entry || typeof entry !== 'object') continue;
          const jwk = entry as PublicJwk;
          if (jwk.kty !== 'RSA' || !jwk.kid || (jwk.use && jwk.use !== 'sig') ||
              (jwk.alg && jwk.alg !== 'RS256') || typeof jwk.n !== 'string' ||
              typeof jwk.e !== 'string') continue;
          try {
            const publicKey = createPublicKey({ key: jwk, format: 'jwk' });
            if (publicKey.asymmetricKeyType !== 'rsa' ||
                (publicKey.asymmetricKeyDetails?.modulusLength ?? 0) < 2048) continue;
            keys.set(jwk.kid, publicKey);
          } catch { /* skip unsupported or malformed key */ }
        }
        this.cachedKeys = keys;
        this.cachedUntil = Date.now() + 60_000;
      } catch {
        throw new ServiceUnavailableException('OIDC key service unavailable');
      }
    }
    const key = this.cachedKeys.get(kid);
    if (!key) throw new UnauthorizedException('Unknown signing key');
    return key;
  }

  async verify(token: string): Promise<VerifiedIdentity> {
    const issuer = process.env.OIDC_ISSUER;
    const audience = process.env.OIDC_AUDIENCE;
    if (!issuer || !audience || !process.env.OIDC_JWKS_URI) {
      throw new ServiceUnavailableException('OIDC issuer, audience and JWKS must be configured');
    }
    if (token.length > 20000) throw new UnauthorizedException('Invalid bearer token');
    const segments = token.split('.');
    if (segments.length !== 3) throw new UnauthorizedException('Invalid bearer token');
    const [encodedHeader, encodedPayload, encodedSignature] = segments as [string, string, string];
    const header = decodePart(encodedHeader) as JwtHeader;
    const claims = decodePart(encodedPayload) as JwtClaims;
    if (header.alg !== 'RS256' || typeof header.kid !== 'string' ||
        !header.kid || header.kid.length > 256 ||
        (header.typ !== undefined && header.typ !== 'JWT' && header.typ !== 'at+jwt') ||
        !encodedSignature || !/^[A-Za-z0-9_-]+$/.test(encodedSignature)) {
      throw new UnauthorizedException('Unsupported bearer token');
    }
    const key = await this.keyFor(header.kid);
    const isValid = verifySignature(
      'RSA-SHA256', Buffer.from(encodedHeader + '.' + encodedPayload),
      key, Buffer.from(encodedSignature, 'base64url'),
    );
    if (!isValid) throw new UnauthorizedException('Invalid bearer token signature');

    const now = Math.floor(Date.now() / 1000);
    const aud = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
    if (claims.iss !== issuer || !aud.includes(audience) ||
        typeof claims.sub !== 'string' || !claims.sub ||
        typeof claims.exp !== 'number' || !Number.isFinite(claims.exp) ||
        claims.exp <= now - 30 ||
        (claims.nbf !== undefined && (typeof claims.nbf !== 'number' ||
          !Number.isFinite(claims.nbf) || claims.nbf > now + 30)) ||
        (claims.iat !== undefined && (typeof claims.iat !== 'number' ||
          !Number.isFinite(claims.iat) || claims.iat > now + 30))) {
      throw new UnauthorizedException('Invalid bearer token claims');
    }
    const realm = claims.realm_access && typeof claims.realm_access === 'object'
      ? (claims.realm_access as { roles?: unknown }).roles : undefined;
    const rawRoles = Array.isArray(realm) ? realm : claims.roles;
    const roles = Array.isArray(rawRoles) ? rawRoles.filter(
      (role): role is string => typeof role === 'string',
    ) : [];
    const providerId = typeof claims.provider_id === 'string' &&
      claims.provider_id.length > 0 && claims.provider_id.length <= 128
      ? claims.provider_id : undefined;
    return { subject: claims.sub, roles, providerId };
  }
}

@Injectable()
export class IdentityGuard implements CanActivate {
  constructor(
    private readonly verifier: OidcTokenVerifier,
    private readonly reflector: Reflector,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    // Compatibility for explicitly isolated CI tests ONLY. It can never be
    // activated on production databases or in a production deployment.
    if (process.env.ALLOW_INSECURE_TEST_AUTH === '1' &&
        process.env.NODE_ENV === 'test' &&
        process.env.DB_NAME?.endsWith('_test')) return true;

    const req = context.switchToHttp().getRequest<Request>();
    const raw = req.headers.authorization;
    if (typeof raw !== 'string' || !/^Bearer [A-Za-z0-9._-]+$/.test(raw)) {
      throw new UnauthorizedException('Bearer access token required');
    }
    const principal = await this.verifier.verify(raw.slice(7));
    const access = this.reflector.getAllAndOverride<RouteAccess>('jungle:access', [
      context.getHandler(), context.getClass(),
    ]);
    // Default-deny endpoints with missing access policy.
    if (!access) throw new ForbiddenException('Missing access policy');
    const admin = principal.roles.includes('jungle-admin');
    if (access === 'admin') {
      if (!admin) throw new ForbiddenException('Administrator role required');
    } else if (access === 'provider' || access === 'admin-or-provider') {
      if (!admin || access === 'provider') {
        if (!principal.roles.includes('jungle-provider') || !principal.providerId) {
          throw new ForbiddenException('Provider role and provider_id required');
        }
        const scoped = req.method === 'POST'
          ? (req.body as { providerId?: unknown } | undefined)?.providerId
          : req.params.providerId;
        if (scoped !== principal.providerId) {
          throw new ForbiddenException('Provider identity does not match request');
        }
      }
    }
    return true;
  }
}
