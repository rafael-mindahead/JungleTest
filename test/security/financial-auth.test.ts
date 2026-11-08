import { generateKeyPairSync, randomUUID, sign } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { AppModule } from '../../src/app.module.js';

const integrationDescribe = process.env.RUN_DB_TESTS === '1' ? describe : describe.skip;
const issuer = 'https://issuer.example.test/realms/jungle';
const audience = 'jungle-financial-api';
const kid = 'jungle-ci-rs256';
const pair = generateKeyPairSync('rsa', { modulusLength: 2048 });

type Claims = Record<string, unknown>;
function makeToken(claims: Claims, privateKey = pair.privateKey): string {
  const now = Math.floor(Date.now() / 1000);
  const header = Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT', kid }))
    .toString('base64url');
  const payload = Buffer.from(JSON.stringify({
    iss: issuer, aud: audience, sub: 'test-subject', iat: now, nbf: now - 1,
    exp: now + 300, ...claims,
  })).toString('base64url');
  const signature = sign('RSA-SHA256', Buffer.from(header + '.' + payload), privateKey)
    .toString('base64url');
  return header + '.' + payload + '.' + signature;
}
const adminToken = () => makeToken({ realm_access: { roles: ['jungle-admin'] } });
const providerToken = (providerId: string) => makeToken({
  realm_access: { roles: ['jungle-provider'] }, provider_id: providerId,
});

integrationDescribe('External-OIDC HTTP authorization with real RS256 JWT and local JWKS', () => {
  let app: INestApplication;
  let jwks: Server;

  beforeAll(async () => {
    if (!process.env.DB_NAME?.endsWith('_test')) {
      throw new Error('Auth tests require an isolated *_test database');
    }
    process.env.NODE_ENV = 'test';
    process.env.ALLOW_INSECURE_TEST_AUTH = '0'; // test the actual guard, never the CI bypass
    process.env.SQS_WORKER_ENABLED = '0';
    process.env.OUTBOX_PUBLISHER_ENABLED = '0';
    process.env.REFERENCE_WORKER_ENABLED = '0';
    process.env.OIDC_ISSUER = issuer;
    process.env.OIDC_AUDIENCE = audience;
    const publicJwk = pair.publicKey.export({ format: 'jwk' });
    jwks = createServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ keys: [{ ...publicJwk, alg: 'RS256', use: 'sig', kid }] }));
    });
    await new Promise<void>(resolve => jwks.listen(0, '127.0.0.1', resolve));
    const address = jwks.address() as AddressInfo;
    process.env.OIDC_JWKS_URI = 'http://127.0.0.1:' + address.port + '/jwks';
    const testing = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = testing.createNestApplication();
    await app.init();
  });

  afterAll(async () => {
    if (app) await app.close();
    if (jwks) await new Promise<void>((resolve, reject) =>
      jwks.close(error => error ? reject(error) : resolve()));
  });

  test('health remains open, wallet funding and wagers reject missing token', async () => {
    await request(app.getHttpServer()).get('/health/live').expect(200);
    await request(app.getHttpServer()).post('/wallets').send({
      playerId: randomUUID(), initialBalance: { amount: '100.00', currency: 'BRL' },
    }).expect(401);
    await request(app.getHttpServer()).post('/wagering/transactions')
      .send({}).expect(401);
  });

  test('rejects expired, incorrect issuer/audience, tampered and wrongly signed tokens', async () => {
    const badTokens = [
      makeToken({ exp: Math.floor(Date.now() / 1000) - 120 }),
      makeToken({ iss: 'https://different.example.test' }),
      makeToken({ aud: 'other-api' }),
      makeToken({ realm_access: { roles: ['jungle-admin'] } }) + 'broken',
      makeToken({}, generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey),
    ];
    for (const token of badTokens) {
      await request(app.getHttpServer()).post('/wallets')
        .set('Authorization', 'Bearer ' + token).send({
          playerId: randomUUID(), initialBalance: { amount: '1.00', currency: 'BRL' },
        }).expect(401);
    }
  });

  test('only administrator can fund/read wallets and only owning provider can wager', async () => {
    const playerId = randomUUID();
    const walletInput = { playerId, initialBalance: { amount: '100.00', currency: 'BRL' } };
    await request(app.getHttpServer()).post('/wallets')
      .set('Authorization', 'Bearer ' + providerToken('provider-a'))
      .send(walletInput).expect(403);
    const created = await request(app.getHttpServer()).post('/wallets')
      .set('Authorization', 'Bearer ' + adminToken())
      .send(walletInput).expect(201);
    const walletId = created.body.id as string;
    await request(app.getHttpServer()).get('/wallets/' + walletId)
      .set('Authorization', 'Bearer ' + providerToken('provider-a')).expect(403);
    const transaction = {
      providerId: 'provider-a', externalTransactionId: randomUUID(),
      playerId, walletId, roundId: 'auth-round', gameId: 'auth-game', kind: 'BET',
      money: { amount: '10.00', currency: 'BRL' },
    };
    const key = randomUUID();
    await request(app.getHttpServer()).post('/wagering/transactions')
      .set('Authorization', 'Bearer ' + providerToken('provider-b'))
      .set('Idempotency-Key', key).send(transaction).expect(403);
    await request(app.getHttpServer()).post('/wagering/transactions')
      .set('Authorization', 'Bearer ' + adminToken())
      .set('Idempotency-Key', key).send(transaction).expect(403);
    const applied = await request(app.getHttpServer()).post('/wagering/transactions')
      .set('Authorization', 'Bearer ' + providerToken('provider-a'))
      .set('Idempotency-Key', key).send(transaction).expect(200);
    expect(applied.body.status).toBe('PROCESSED');
    await request(app.getHttpServer())
      .get('/providers/provider-a/wagering/transactions/' + transaction.externalTransactionId)
      .set('Authorization', 'Bearer ' + providerToken('provider-b')).expect(403);
    await request(app.getHttpServer())
      .get('/providers/provider-a/wagering/transactions/' + transaction.externalTransactionId)
      .set('Authorization', 'Bearer ' + providerToken('provider-a')).expect(200);
    await request(app.getHttpServer())
      .get('/wagering/transactions/' + applied.body.transactionId)
      .set('Authorization', 'Bearer ' + providerToken('provider-a')).expect(403);
    await request(app.getHttpServer())
      .get('/wagering/transactions/' + applied.body.transactionId)
      .set('Authorization', 'Bearer ' + adminToken()).expect(200);
    const reconciled = await request(app.getHttpServer())
      .post('/wallets/' + walletId + '/reconciliation')
      .set('Authorization', 'Bearer ' + adminToken()).expect(201);
    expect(reconciled.body.consistent).toBe(true);
    expect(reconciled.body.storedBalance.amount).toBe('90.00');
  });
});
