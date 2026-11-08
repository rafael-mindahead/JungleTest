import { Injectable } from '@nestjs/common';

/**
 * Local process diagnostics only. Never use counters for idempotency, state
 * transitions or financial correctness: those remain durable in PostgreSQL.
 */
@Injectable()
export class FinancialMetrics {
  private readonly statuses: Record<string, number> = Object.create(null) as Record<string, number>;
  private readonly durationBuckets = [10, 25, 50, 100, 250, 500, 1000, 2500, 5000];
  private readonly cumulative = this.durationBuckets.map(() => 0);
  private total = 0;
  private totalMilliseconds = 0;
  private duplicates = 0;
  private lockConflicts = 0;

  recordResult(status: string, replay: boolean, durationMs: number): void {
    this.statuses[status] = (this.statuses[status] ?? 0) + 1;
    if (replay) this.duplicates++;
    this.total++;
    this.totalMilliseconds += durationMs;
    for (let i = 0; i < this.durationBuckets.length; i++) {
      if (durationMs <= this.durationBuckets[i]) this.cumulative[i]++;
    }
  }

  recordLockConflict(): void {
    this.lockConflicts++;
  }

  snapshot() {
    return {
      scope: 'single-process-volatile',
      submissions: this.total,
      statusCounts: { ...this.statuses },
      duplicateReplays: this.duplicates,
      lockConflicts: this.lockConflicts,
      processingLatencyMilliseconds: {
        count: this.total,
        sum: Math.round(this.totalMilliseconds * 100) / 100,
        buckets: Object.fromEntries(this.durationBuckets.map(
          (upper, i) => [String(upper), this.cumulative[i]],
        )),
      },
    };
  }
}
