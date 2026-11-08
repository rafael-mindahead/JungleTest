import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { AppModule } from '../../src/app.module.js';

const dbDescribe = process.env.RUN_DB_TESTS === '1' ? describe : describe.skip;
dbDescribe('Finance operations metrics endpoint', () => {
  let app: INestApplication;
  const token = 'financial-metrics-ci-token';
  beforeAll(async () => {
    if (!process.env.DB_NAME?.endsWith('_test')) {
      throw new Error('Refusing metrics test outside disposable DB');
    }
    process.env.METRICS_TOKEN = token;
    process.env.SQS_WORKER_ENABLED = '0';
    process.env.OUTBOX_PUBLISHER_ENABLED = '0';
    process.env.REFERENCE_WORKER_ENABLED = '0';
    const module = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = module.createNestApplication();
    await app.init();
  });
  afterAll(async () => {
    if (app) await app.close();
  });

  test('requires ops token, exposes aggregate counters without player identifiers', async () => {
    await request(app.getHttpServer()).get('/internal/metrics').expect(401);
    const playerId = randomUUID();
    const wallet = await request(app.getHttpServer()).post('/wallets').send({
      playerId,
      initialBalance: { amount: '100.00', currency: 'BRL' },
    }).expect(201);
    const body = {
      providerId: 'metric-test-' + wallet.body.id,
      externalTransactionId: randomUUID(),
      playerId,
      walletId: wallet.body.id as string,
      roundId: 'metrics-round',
      gameId: 'metrics-game',
      kind: 'BET',
      money: { amount: '1.00', currency: 'BRL' },
    };
    const key = randomUUID();
    await request(app.getHttpServer())
      .post('/wagering/transactions')
      .set('Idempotency-Key', key)
      .send(body).expect(200);
    await request(app.getHttpServer())
      .post('/wagering/transactions')
      .set('Idempotency-Key', key)
      .send(body).expect(200);
    const metrics = await request(app.getHttpServer())
      .get('/internal/metrics')
      .set('X-Metrics-Token', token)
      .expect(200);
    expect(metrics.body.transactionsByStatus.PROCESSED).toBeGreaterThanOrEqual(1);
    expect(metrics.body.local.duplicateReplays).toBeGreaterThanOrEqual(1);
    expect(metrics.body.local.processingLatencyMilliseconds.count).toBeGreaterThanOrEqual(2);
    expect(metrics.body.outbox.pending).toBeGreaterThanOrEqual(2);
    expect(metrics.body.deadLetterQueue.available).toBe(false); // MiniStack starts after DB test.
    expect(JSON.stringify(metrics.body)).not.toContain(playerId);
    expect(JSON.stringify(metrics.body)).not.toContain(wallet.body.id);
    await request(app.getHttpServer()).get('/internal/prometheus').expect(401);
    const scrape = await request(app.getHttpServer())
      .get('/internal/prometheus')
      .set('Authorization', 'Bearer ' + token)
      .expect(200);
    expect(scrape.headers['content-type']).toContain('text/plain');
    expect(scrape.text).toContain('# TYPE jungle_wagering_result_total counter');
    expect(scrape.text).toContain('jungle_wagering_duplicates_total');
    expect(scrape.text).toContain('jungle_outbox_pending');
    expect(scrape.text).not.toContain(playerId);
    expect(scrape.text).not.toContain(wallet.body.id);
  }, 20000);
});
