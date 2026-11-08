import http from 'k6/http';
import { check, sleep } from 'k6';
import { SharedArray } from 'k6/data';
import { Counter, Rate } from 'k6/metrics';

// IMPORTANT: This is real financial traffic, not a liveness benchmark.
// Run only against a disposable test database and an isolated API instance.
const profile = __ENV.PROFILE || 'smoke';
const profiles = {
  smoke: [
    { duration: '5s', target: 3 },
    { duration: '15s', target: 3 },
    { duration: '5s', target: 0 },
  ],
  baseline: [
    { duration: '1m', target: 100 },
    { duration: '5m', target: 100 },
    { duration: '1m', target: 0 },
  ],
  ramp: [
    { duration: '1m', target: 100 },
    { duration: '2m', target: 1000 },
    { duration: '5m', target: 1000 },
    { duration: '1m', target: 0 },
  ],
  peak100k: [
    { duration: '5m', target: 100000 },
    { duration: '5m', target: 100000 },
    { duration: '2m', target: 0 },
  ],
  peak200k: [
    { duration: '8m', target: 200000 },
    { duration: '5m', target: 200000 },
    { duration: '2m', target: 0 },
  ],
};
if (!Object.hasOwn(profiles, profile)) throw new Error('Unknown PROFILE: ' + profile);
if (profile.startsWith('peak') && __ENV.CONFIRM_PEAK !== 'yes') {
  throw new Error('Peak load needs CONFIRM_PEAK=yes, dedicated hardware and distributed k6');
}
const baseUrl = (__ENV.BASE_URL || 'http://127.0.0.1:3000').replace(/\/$/, '');
if (!/^http:\/\/(127\.0\.0\.1|localhost):\d+$/.test(baseUrl) &&
    __ENV.ALLOW_REMOTE_TARGET !== 'yes') {
  throw new Error('Remote load tests require ALLOW_REMOTE_TARGET=yes and explicit authorization');
}
const wallets = new SharedArray('financial-seeded-wallets', function () {
  return JSON.parse(open(__ENV.FIXTURE_PATH || '../../artifacts/bench/wallets.json'));
});
if (!wallets.length) throw new Error('Seed financial wallets before the benchmark');
const runId = __ENV.RUN_ID || String(Date.now());
const technicalErrors = new Rate('financial_technical_error_rate');
const businessRejections = new Counter('financial_business_rejections');
const processed = new Counter('financial_processed_operations');

// 422 is a legitimate, measurable business refusal and not a transport failure.
http.setResponseCallback(http.expectedStatuses({ min: 200, max: 299 }, 422));
export const options = {
  scenarios: {
    wagering: {
      executor: 'ramping-vus',
      startVUs: 0,
      stages: profiles[profile],
      gracefulRampDown: '30s',
    },
  },
  thresholds: {
    financial_technical_error_rate: ['rate<0.01'],
    http_req_duration: ['p(95)<500', 'p(99)<1000'],
    checks: ['rate>0.99'],
  },
  tags: { benchmark: 'financial-wagering', profile },
};

function submit(wallet, kind, amount, identity, referenceExternalTransactionId) {
  const externalTransactionId = identity + '-' + kind.toLowerCase();
  const body = {
    providerId: wallet.providerId,
    externalTransactionId,
    playerId: wallet.playerId,
    walletId: wallet.walletId,
    roundId: identity,
    gameId: 'financial-k6',
    kind,
    money: { amount, currency: 'BRL' },
    ...(referenceExternalTransactionId ? { referenceExternalTransactionId } : {}),
  };
  const key = wallet.providerId + ':' + externalTransactionId;
  const request = () => http.post(
    baseUrl + '/wagering/transactions',
    JSON.stringify(body),
    {
      headers: { 'Content-Type': 'application/json', 'Idempotency-Key': key },
      tags: { operation: kind },
      timeout: '10s',
    },
  );
  const response = request();
  let parsed = {};
  try { parsed = response.json(); } catch (_) { /* malformed response is counted */ }
  const techError = response.status === 0 ||
    response.status >= 500 || response.status === 409 ||
    response.status === 401 || response.status === 403 || response.status === 400;
  technicalErrors.add(techError);
  if (response.status === 422) businessRejections.add(1);
  const okay = response.status === 200 && parsed.status === 'PROCESSED';
  check(response, { 'wager processed': () => okay });
  if (okay) processed.add(1);
  return { okay, request, body, key };
}

export default function () {
  const wallet = wallets[(__VU - 1) % wallets.length];
  const identity = runId + '-' + __VU + '-' + __ITER;
  const bet = submit(wallet, 'BET', '0.01', identity);
  if (!bet.okay) {
    sleep(0.2);
    return;
  }
  switch (__ITER % 4) {
    case 0:
      submit(wallet, 'WIN', '0.01', identity);
      break;
    case 1:
      submit(wallet, 'LOSS', '0.01', identity);
      break;
    case 2:
      submit(wallet, 'REFUND', '0.01', identity, bet.body.externalTransactionId);
      break;
    default:
      submit(wallet, 'ROLLBACK', '0.01', identity, bet.body.externalTransactionId);
      break;
  }
  if (__ITER % 10 === 0) {
    // Same canonical payload and idempotency key must never debit twice.
    const replay = bet.request();
    let data = {};
    try { data = replay.json(); } catch (_) { /* counted as failed replay */ }
    const okay = replay.status === 200 && data.idempotentReplay === true;
    technicalErrors.add(!okay);
    check(replay, { 'idempotent replay': () => okay });
  }
  sleep(Number(__ENV.THINK_SECONDS ?? '0.2'));
}
