import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';

const baseUrl = (process.env.BASE_URL ?? 'http://127.0.0.1:3000').replace(/\/$/, '');
const adminToken = process.env.ADMIN_TOKEN;
if (!adminToken) throw new Error('ADMIN_TOKEN is required to seed wallets via authenticated API');
const providerId = process.env.BENCH_PROVIDER_ID ?? 'bench-provider';
if (!/^[A-Za-z0-9_-]{1,80}$/.test(providerId)) throw new Error('Invalid BENCH_PROVIDER_ID');
const count = Number(process.env.BENCH_WALLETS ?? '12');
const output = process.env.BENCH_FIXTURE_FILE ?? 'artifacts/bench/wallets.json';
if (!process.env.DB_NAME?.endsWith('_test')) {
  throw new Error('Refusing to seed benchmark outside a disposable *_test DB');
}
if (!/^http:\/\/(127\.0\.0\.1|localhost):\d+$/.test(baseUrl)) {
  throw new Error('Seed target must be localhost (disposable test API only)');
}
if (!Number.isInteger(count) || count < 1 || count > 5000) {
  throw new Error('BENCH_WALLETS must be an integer between 1 and 5000');
}

interface Fixture { walletId: string; playerId: string; providerId: string }
const fixtures: Fixture[] = [];
const workerCount = Math.min(12, count);
await Promise.all(Array.from({ length: workerCount }, async (_, workerIndex) => {
  for (let i = workerIndex; i < count; i += workerCount) {
    const playerId = randomUUID();
    const response = await fetch(baseUrl + '/wallets', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + adminToken },
      body: JSON.stringify({
        playerId,
        initialBalance: { amount: '1000.00', currency: 'BRL' },
      }),
      signal: AbortSignal.timeout(10000),
    });
    if (response.status !== 201) {
      throw new Error('Failed to seed wallet ' + i + ': HTTP ' + response.status);
    }
    const created = await response.json() as { id: string };
    if (!created.id) throw new Error('Seed returned no wallet id');
    fixtures.push({
      walletId: created.id,
      playerId,
      providerId,
    });
  }
}));
await mkdir(output.slice(0, output.lastIndexOf('/')) || '.', { recursive: true });
await writeFile(output, JSON.stringify(fixtures, null, 2));
console.log(JSON.stringify({ event: 'financial-benchmark-seeded', wallets: fixtures.length, output }));
