/**
 * Prometheus 0.0.4 text exposition. No extra runtime dependency or financial data.
 * Process counters are local. PostgreSQL-derived values are GAUGES because they
 * are shared by all application replicas; NEVER sum them across replicas.
 */
export interface PrometheusFinancialSnapshot {
  transactionsByStatus: Record<string, number>;
  inboxMessages: number;
  pendingReferenceRetries: number;
  outbox: { pending: number; oldestPendingSeconds: number; retryAttemptsPending: number };
  deadLetterQueue: { available: boolean; visible: number | null; inFlight: number | null };
  local: {
    submissions: number; statusCounts: Record<string, number>;
    duplicateReplays: number; lockConflicts: number;
    processingLatencyMilliseconds: {
      count: number; sum: number; buckets: Record<string, number>;
    };
  };
}

type HttpKey = string;
const httpCounts = new Map<HttpKey, number>();
const HTTP_BUCKETS = [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5];
const httpDurationBuckets = HTTP_BUCKETS.map(() => 0);
let httpTotal = 0;
let httpDurationSum = 0;

function finite(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}
function quote(value: string): string {
  return '"' + value.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n') + '"';
}
function labels(record: Record<string, string>): string {
  return '{' + Object.entries(record).map(([name, value]) => name + '=' + quote(value)).join(',') + '}';
}
function family(lines: string[], name: string, type: 'counter' | 'gauge' | 'histogram', help: string): void {
  lines.push('# HELP ' + name + ' ' + help);
  lines.push('# TYPE ' + name + ' ' + type);
}
function line(lines: string[], name: string, value: number, labelSet?: Record<string, string>): void {
  lines.push(name + (labelSet ? labels(labelSet) : '') + ' ' + finite(value));
}

/** Labels are bounded: route is an Express template, never a request URL. */
export function recordHttpRequest(method: string, route: string, statusCode: number, durationMs: number): void {
  const safeMethod = /^(GET|POST|PUT|DELETE|PATCH|HEAD|OPTIONS)$/.test(method) ? method : 'OTHER';
  // Only registered ROUTE TEMPLATES: never let a request URL, ID, or token
  // become a Prometheus label (high-cardinality and privacy risk).
  const templates = new Set([
    '/health/live', '/health/ready',
    '/wallets', '/wallets/:walletId', '/wallets/:walletId/ledger',
    '/wallets/:walletId/reconciliation',
    '/:walletId', '/:walletId/ledger', '/:walletId/reconciliation',
    '/wagering/transactions', '/wagering/transactions/:transactionId',
    '/providers/:providerId/wagering/transactions/:externalTransactionId',
    '/internal/metrics', '/internal/prometheus', '/metrics', '/prometheus',
  ]);
  const safeRoute = templates.has(route) ? route : 'unmatched';
  const status = Number.isInteger(statusCode) && statusCode >= 100 && statusCode < 600
    ? String(statusCode) : 'unknown';
  const key = JSON.stringify([safeMethod, safeRoute, status]);
  httpCounts.set(key, (httpCounts.get(key) ?? 0) + 1);
  const duration = Math.max(0, finite(durationMs) / 1000);
  httpTotal++;
  httpDurationSum += duration;
  for (let i = 0; i < HTTP_BUCKETS.length; i++) {
    if (duration <= HTTP_BUCKETS[i]) httpDurationBuckets[i]++;
  }
}

/** Stable Prometheus exposition including HELP/TYPE and cumulative histogram buckets. */
export function formatPrometheus(snapshot: PrometheusFinancialSnapshot): string {
  const lines: string[] = [];
  family(lines, 'jungle_http_requests_total', 'counter', 'HTTP requests by route template, method and status');
  for (const [key, count] of Array.from(httpCounts.entries()).sort()) {
    const [method, route, status] = JSON.parse(key) as [string, string, string];
    line(lines, 'jungle_http_requests_total', count, { method, route, status });
  }
  family(lines, 'jungle_http_request_duration_seconds', 'histogram', 'HTTP latency in seconds');
  HTTP_BUCKETS.forEach((bucket, i) => line(lines, 'jungle_http_request_duration_seconds_bucket',
    httpDurationBuckets[i], { le: String(bucket) }));
  line(lines, 'jungle_http_request_duration_seconds_bucket', httpTotal, { le: '+Inf' });
  line(lines, 'jungle_http_request_duration_seconds_sum', httpDurationSum);
  line(lines, 'jungle_http_request_duration_seconds_count', httpTotal);

  family(lines, 'jungle_wagering_submissions_total', 'counter', 'Wagering submissions observed by this process');
  line(lines, 'jungle_wagering_submissions_total', snapshot.local.submissions);
  family(lines, 'jungle_wagering_result_total', 'counter', 'Wagering results by status, process local');
  for (const status of ['PENDING', 'PENDING_REFERENCE', 'PROCESSED', 'REJECTED', 'FAILED']) {
    line(lines, 'jungle_wagering_result_total', snapshot.local.statusCounts[status] ?? 0, { status });
  }
  family(lines, 'jungle_wagering_duplicates_total', 'counter', 'Idempotent replay responses');
  line(lines, 'jungle_wagering_duplicates_total', snapshot.local.duplicateReplays);
  family(lines, 'jungle_wagering_lock_conflicts_total', 'counter', 'PostgreSQL lock conflicts');
  line(lines, 'jungle_wagering_lock_conflicts_total', snapshot.local.lockConflicts);

  family(lines, 'jungle_wagering_processing_duration_seconds', 'histogram', 'Wagering service processing time');
  const latency = snapshot.local.processingLatencyMilliseconds;
  for (const [milliseconds, count] of Object.entries(latency.buckets)) {
    line(lines, 'jungle_wagering_processing_duration_seconds_bucket', count,
      { le: String(Number(milliseconds) / 1000) });
  }
  line(lines, 'jungle_wagering_processing_duration_seconds_bucket', latency.count, { le: '+Inf' });
  line(lines, 'jungle_wagering_processing_duration_seconds_sum', latency.sum / 1000);
  line(lines, 'jungle_wagering_processing_duration_seconds_count', latency.count);

  family(lines, 'jungle_wagering_transactions', 'gauge', 'Durable PostgreSQL wagering transactions by status, shared across replicas');
  for (const status of ['PENDING', 'PENDING_REFERENCE', 'PROCESSED', 'REJECTED', 'FAILED']) {
    line(lines, 'jungle_wagering_transactions', snapshot.transactionsByStatus[status] ?? 0, { status });
  }
  family(lines, 'jungle_inbox_messages', 'gauge', 'Durable inbox message count, shared database');
  line(lines, 'jungle_inbox_messages', snapshot.inboxMessages);
  family(lines, 'jungle_reference_retry_attempts', 'gauge', 'Durable reference retry attempts');
  line(lines, 'jungle_reference_retry_attempts', snapshot.pendingReferenceRetries);
  family(lines, 'jungle_outbox_pending', 'gauge', 'Durable unpublished outbox entries');
  line(lines, 'jungle_outbox_pending', snapshot.outbox.pending);
  family(lines, 'jungle_outbox_oldest_pending_seconds', 'gauge', 'Age of oldest unpublished event');
  line(lines, 'jungle_outbox_oldest_pending_seconds', snapshot.outbox.oldestPendingSeconds);
  family(lines, 'jungle_outbox_retry_attempts', 'gauge', 'Retry attempts of unpublished outbox entries');
  line(lines, 'jungle_outbox_retry_attempts', snapshot.outbox.retryAttemptsPending);
  family(lines, 'jungle_sqs_dlq_available', 'gauge', '1 if SQS DLQ attributes could be queried');
  line(lines, 'jungle_sqs_dlq_available', snapshot.deadLetterQueue.available ? 1 : 0);
  family(lines, 'jungle_sqs_dlq_visible_messages', 'gauge', 'Approximate number of visible DLQ messages');
  if (snapshot.deadLetterQueue.visible !== null) {
    line(lines, 'jungle_sqs_dlq_visible_messages', snapshot.deadLetterQueue.visible);
  }
  family(lines, 'jungle_process_resident_memory_bytes', 'gauge', 'Resident memory used by this process');
  line(lines, 'jungle_process_resident_memory_bytes', process.memoryUsage().rss);
  family(lines, 'jungle_process_cpu_seconds_total', 'counter', 'Total process CPU time');
  const cpu = process.cpuUsage();
  line(lines, 'jungle_process_cpu_seconds_total', (cpu.user + cpu.system) / 1_000_000);
  return lines.join('\n') + '\n';
}
