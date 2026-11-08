import { randomUUID } from 'node:crypto';
import { spawn, type ChildProcess } from 'node:child_process';
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';

const integrationDescribe = process.env.RUN_MULTIPROCESS_TESTS === '1' ? describe : describe.skip;
const host = 'http://127.0.0.1';
const pause = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

interface Scope {
  id: string;
  playerId: string;
}
interface TransactionResponse {
  transactionId: string;
  status: 'PROCESSED' | 'REJECTED';
  idempotentReplay: boolean;
  balance: { amount: string; currency: string };
}

integrationDescribe('Three independent Bun/NestJS processes sharing PostgreSQL', () => {
  const processes: ChildProcess[] = [];
  let urls: string[] = [];

  async function waitForHealth(url: string): Promise<void> {
    const until = Date.now() + 20000;
    while (Date.now() < until) {
      try {
        const response = await fetch(url + '/health/live', {
          signal: AbortSignal.timeout(1200),
        });
        if (response.status === 200) return;
      } catch {
        // Application is still booting.
      }
      await pause(200);
    }
    throw new Error('Nested process failed to become ready on ' + url);
  }

  beforeAll(async () => {
    if (!process.env.DB_NAME?.endsWith('_test')) {
      throw new Error('Multi-process concurrency tests require a disposable *_test database');
    }
    const firstPort = 34000 + Math.floor(Math.random() * 25000);
    urls = Array.from({ length: 3 }, (_, index) => host + ':' + (firstPort + index));
    for (let index = 0; index < 3; index++) {
      const child = spawn(process.execPath, ['run', 'src/main.ts'], {
        cwd: process.cwd(),
        env: {
          ...process.env,
          PORT: String(firstPort + index),
          SQS_WORKER_ENABLED: '0',
          OUTBOX_PUBLISHER_ENABLED: '0',
          REFERENCE_WORKER_ENABLED: '0',
        },
        stdio: 'ignore',
      });
      processes.push(child);
    }
    await Promise.all(urls.map(waitForHealth));
    expect(processes).toHaveLength(3);
    expect(processes.every(child => child.exitCode === null)).toBe(true);
  }, 60000);

  afterAll(() => {
    for (const child of processes) {
      if (child.exitCode === null) child.kill('SIGTERM');
    }
  });

  async function api<T>(url: string, method: string, path: string, data?: unknown, key?: string) {
    const response = await fetch(url + path, {
      method,
      headers: {
        ...(data === undefined ? {} : { 'Content-Type': 'application/json' }),
        ...(key ? { 'Idempotency-Key': key } : {}),
      },
      body: data === undefined ? undefined : JSON.stringify(data),
      signal: AbortSignal.timeout(25000),
    });
    return { status: response.status, body: await response.json() as T };
  }

  async function wallet(initialBalance = '100.00'): Promise<Scope> {
    const playerId = randomUUID();
    const response = await api<{ id: string }>(urls[0], 'POST', '/wallets', {
      playerId,
      initialBalance: { amount: initialBalance, currency: 'BRL' },
    });
    expect(response.status).toBe(201);
    return { playerId, id: response.body.id };
  }

  function bet(scope: Scope, amount: string, externalTransactionId = randomUUID()) {
    return {
      providerId: 'multinode-' + scope.id,
      externalTransactionId,
      playerId: scope.playerId,
      walletId: scope.id,
      roundId: 'parallel-round',
      gameId: 'parallel-game',
      kind: 'BET',
      money: { amount, currency: 'BRL' },
    };
  }

  async function balance(scope: Scope): Promise<string> {
    const response = await api<{ balance: { amount: string } }>(
      urls[2], 'GET', '/wallets/' + scope.id,
    );
    expect(response.status).toBe(200);
    return response.body.balance.amount;
  }

  test('50 identical BETs across three real processes commit a single debit', async () => {
    const scope = await wallet();
    const transaction = bet(scope, '80.00');
    const key = randomUUID();
    const results = await Promise.all(
      Array.from({ length: 50 }, (_, i) =>
        api<TransactionResponse>(
          urls[i % 3], 'POST', '/wagering/transactions', transaction, key,
        ),
      ),
    );
    expect(results.every(result => result.status === 200)).toBe(true);
    expect(results.every(result => result.body.status === 'PROCESSED')).toBe(true);
    expect(new Set(results.map(result => result.body.transactionId)).size).toBe(1);
    expect(results.filter(result => result.body.idempotentReplay === false)).toHaveLength(1);
    expect(await balance(scope)).toBe('20.00');
    const ledger = await api<{ entries: Array<{ direction: string }> }>(
      urls[1], 'GET', '/wallets/' + scope.id + '/ledger',
    );
    expect(ledger.status).toBe(200);
    expect(ledger.body.entries.filter(entry => entry.direction === 'DEBIT')).toHaveLength(1);
    expect(ledger.body.entries).toHaveLength(2); // Opening + one BET.
    const reconciliation = await api<{ consistent: boolean }>(
      urls[0], 'POST', '/wallets/' + scope.id + '/reconciliation',
    );
    expect(reconciliation.body.consistent).toBe(true);
  }, 60000);

  test('distinct BETs competing for the same 100 BRL serialize across processes', async () => {
    const scope = await wallet();
    const results = await Promise.all([
      api<TransactionResponse>(urls[0], 'POST', '/wagering/transactions', bet(scope, '80.00'), randomUUID()),
      api<TransactionResponse>(urls[2], 'POST', '/wagering/transactions', bet(scope, '80.00'), randomUUID()),
    ]);
    expect(results.map(r => r.status).sort()).toEqual([200, 422]);
    expect(results.map(r => r.body.status).sort()).toEqual(['PROCESSED', 'REJECTED']);
    expect(await balance(scope)).toBe('20.00');
  }, 30000);

  test('independent wallets progress across all three processes', async () => {
    const scopes = await Promise.all([wallet(), wallet(), wallet()]);
    const amounts = ['11.00', '12.00', '13.00'];
    const results = await Promise.all(scopes.map((scope, i) =>
      api<TransactionResponse>(urls[i], 'POST', '/wagering/transactions', bet(scope, amounts[i]), randomUUID()),
    ));
    expect(results.map(r => r.status)).toEqual([200, 200, 200]);
    expect(await Promise.all(scopes.map(balance))).toEqual(['89.00', '88.00', '87.00']);
    for (const scope of scopes) {
      const r = await api<{ consistent: boolean }>(
        urls[1], 'POST', '/wallets/' + scope.id + '/reconciliation',
      );
      expect(r.status).toBe(201);
      expect(r.body.consistent).toBe(true);
    }
  }, 30000);
});
