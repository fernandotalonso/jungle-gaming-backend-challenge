import type { INestApplication } from '@nestjs/common';
import { bootstrap } from '../../src/main';
import { MikroORM } from '@mikro-orm/core';
import { getTestOrm, truncateAll } from './db';

export const TEST_PORT = 3101;
const BASE = `http://localhost:${TEST_PORT}`;

let appPromise: Promise<INestApplication> | null = null;

/** Boots the real HTTP app once for the whole e2e suite. */
export function getTestApp(): Promise<INestApplication> {
  if (!appPromise) {
    process.env.APP_PORT = String(TEST_PORT);
    // the messaging integration tests drive the consumer/publisher manually;
    // a live app instance would steal their queue messages (parallel workers)
    process.env.CONSUMER_ENABLED = 'false';
    process.env.PUBLISHER_ENABLED = 'false';
    appPromise = bootstrap();
  }
  return appPromise;
}

export function api(): string {
  return BASE;
}

export async function resetDb(): Promise<void> {
  const orm: MikroORM = await getTestOrm();
  await truncateAll(orm);
}

/** Client-credentials token from the local Keycloak (retry while it boots). */
export async function getKeycloakToken(): Promise<string> {
  const issuer = process.env.KEYCLOAK_ISSUER ?? 'http://localhost:8080/realms/jungle';
  const deadline = Date.now() + 30_000;
  let lastError: unknown = null;

  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${issuer}/protocol/openid-connect/token`, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type: 'client_credentials',
          client_id: 'wagering-api',
          client_secret: 'local-dev-api-secret',
        }),
      });
      if (!response.ok) {
        throw new Error(`token endpoint returned ${response.status}`);
      }
      const body = (await response.json()) as { access_token: string };
      return body.access_token;
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
  }
  throw new Error(`could not obtain a Keycloak token: ${String(lastError)}`);
}
