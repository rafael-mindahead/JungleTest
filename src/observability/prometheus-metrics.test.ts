import { describe, expect, test } from 'bun:test';
import { formatPrometheus, recordHttpRequest, type PrometheusFinancialSnapshot } from './prometheus-metrics.js';

const snapshot: PrometheusFinancialSnapshot = {
  transactionsByStatus: { PROCESSED: 3, REJECTED: 1 },
  inboxMessages: 5,
  pendingReferenceRetries: 2,
  outbox: { pending: 1, oldestPendingSeconds: 2.25, retryAttemptsPending: 4 },
  deadLetterQueue: { available: false, visible: null, inFlight: null },
  local: {
    submissions: 7, statusCounts: { PROCESSED: 5, REJECTED: 2 },
    duplicateReplays: 1, lockConflicts: 2,
    processingLatencyMilliseconds: { count: 7, sum: 70,
      buckets: { '10': 4, '25': 6, '50': 7 } },
  },
};
describe('Prometheus exposition', () => {
  test('uses valid 0.0.4 HELP TYPE labels and cumulative histogram buckets', () => {
    recordHttpRequest('POST', '/wagering/transactions', 200, 25);
    recordHttpRequest('POST', '/wagering/transactions', 200, 30);
    const metrics = formatPrometheus(snapshot);
    expect(metrics).toContain('# TYPE jungle_wagering_submissions_total counter');
    expect(metrics).toContain('jungle_wagering_submissions_total 7');
    expect(metrics).toContain('jungle_wagering_result_total{status="PROCESSED"} 5');
    expect(metrics).toContain('jungle_wagering_processing_duration_seconds_bucket{le="+Inf"} 7');
    expect(metrics).toContain('jungle_outbox_oldest_pending_seconds 2.25');
    expect(metrics).toContain('jungle_http_requests_total{method="POST",route="/wagering/transactions",status="200"} 2');
    expect(metrics).toContain('# TYPE jungle_http_request_duration_seconds histogram');
    expect(metrics.endsWith('\n')).toBe(true);
  });
  test('never exposes identifiers or wallet amounts, even from route arguments', () => {
    recordHttpRequest('GET', '/wallets/f8ab4b11-a0a4-4b74-8a67-69d7e83a7bcc', 200, 10);
    const metrics = formatPrometheus(snapshot);
    expect(metrics).not.toContain('f8ab4b11-a0a4-4b74-8a67-69d7e83a7bcc');
    expect(metrics).not.toContain('token');
    expect(metrics).toContain('jungle_outbox_pending 1');
    expect(metrics).not.toContain('NaN');
  });
});
