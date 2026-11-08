import http from 'k6/http';
import { check, sleep } from 'k6';

// A health endpoint is a transport baseline, NOT a financial throughput benchmark.
// Replace the read-only target with a dedicated financial workload only after
// authenticated API endpoints and correctness assertions exist.
const profile = __ENV.PROFILE || 'smoke';
const profiles = {
  smoke: [
    { duration: '10s', target: 5 },
    { duration: '30s', target: 5 },
    { duration: '10s', target: 0 },
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

if (!Object.hasOwn(profiles, profile)) {
  throw new Error('Unknown PROFILE: ' + profile);
}
if (profile.startsWith('peak') && __ENV.CONFIRM_PEAK !== 'yes') {
  throw new Error('Peak tests need CONFIRM_PEAK=yes and a capacity-reviewed load generator');
}
const baseUrl = (__ENV.BASE_URL || 'http://127.0.0.1:3000').replace(/\/$/, '');
const target = __ENV.TARGET_PATH || '/health/live';
if (target !== '/health/live') {
  throw new Error('This script measures only /health/live; write a business workload separately');
}

export const options = {
  scenarios: {
    health: {
      executor: 'ramping-vus',
      startVUs: 0,
      stages: profiles[profile],
      gracefulRampDown: '30s',
    },
  },
  thresholds: {
    http_req_duration: ['p(95)<500', 'p(99)<1000'],
    http_req_failed: ['rate<0.01'],
    checks: ['rate>0.99'],
  },
  tags: { benchmark: 'transport-health', profile },
};

export default function () {
  const response = http.get(baseUrl + target, {
    tags: { operation: 'health' },
    timeout: '10s',
  });
  check(response, { 'HTTP 200': (r) => r.status === 200 });
  sleep(Number(__ENV.THINK_SECONDS || 5));
}
