import { AsyncLocalStorage } from 'node:async_hooks';
import { randomBytes } from 'node:crypto';
import { Injectable, OnApplicationShutdown } from '@nestjs/common';

/**
 * Minimal standards-compliant OTLP/HTTP JSON exporter, not the full OTel SDK.
 * Exports distributed spans to any OpenTelemetry Collector; opt-in and fail-open.
 * No payloads, identities, amounts, authentication headers, or URLs are exported.
 */
export interface TraceParent { traceId: string; spanId: string; sampled: boolean }
type SpanKind = 'SERVER' | 'INTERNAL' | 'PRODUCER' | 'CONSUMER';
type AttrValue = string | number | boolean;
type Attributes = Record<string, AttrValue>;
const contextStorage = new AsyncLocalStorage<TraceParent>();
const traces: Record<string, unknown>[] = [];
const MAX_QUEUE = 512;
let timer: ReturnType<typeof setInterval> | undefined;
let flushing: Promise<void> | null = null;

export function parseTraceparent(value: unknown): TraceParent | null {
  if (typeof value !== 'string') return null;
  const match = /^00-([a-f0-9]{32})-([a-f0-9]{16})-([a-f0-9]{2})$/.exec(value);
  if (!match || /^0+$/.test(match[1]) || /^0+$/.test(match[2])) return null;
  return { traceId: match[1], spanId: match[2], sampled: (parseInt(match[3], 16) & 1) !== 0 };
}

export function activeTraceparent(): string | undefined {
  const ctx = contextStorage.getStore();
  return ctx ? '00-' + ctx.traceId + '-' + ctx.spanId + '-' + (ctx.sampled ? '01' : '00') : undefined;
}
function configured(): boolean {
  return process.env.OTEL_TRACES_ENABLED === '1';
}
function shouldSample(): boolean {
  const raw = Number(process.env.OTEL_SAMPLE_RATE ?? '0.1');
  const rate = Number.isFinite(raw) ? Math.min(1, Math.max(0, raw)) : 0.1;
  return Math.random() < rate;
}
function encodeAttributes(source: Attributes): Array<{ key: string; value: Record<string, string | number | boolean> }> {
  const result: Array<{ key: string; value: Record<string, string | number | boolean> }> = [];
  // Strict allowlist: no player/provider/wallet IDs, monetary values, URLs or tokens.
  const safeKeys = new Set([
    'http.request.method', 'http.response.status_code',
    'messaging.system', 'messaging.operation.type',
    'wager.kind', 'wager.status', 'wager.replayed', 'event.type', 'error.type',
  ]);
  for (const [key, value] of Object.entries(source)) {
    if (!safeKeys.has(key)) continue;
    if (typeof value === 'string') {
      result.push({ key, value: { stringValue: value.slice(0, 100) } });
    } else if (typeof value === 'boolean') {
      result.push({ key, value: { boolValue: value } });
    } else if (Number.isFinite(value)) {
      result.push({ key, value: { doubleValue: value } });
    }
  }
  return result.slice(0, 16);
}

function queueSpan(span: Record<string, unknown>): void {
  if (traces.length >= MAX_QUEUE) return; // drop telemetry, never financial work
  traces.push(span);
  if (!timer) {
    timer = setInterval(() => { void flushTraces(); }, 2000);
    timer.unref?.();
  }
}

/** Force exporter flush, principally for graceful SIGTERM and tests. */
export async function flushTraces(): Promise<void> {
  if (flushing) return flushing;
  const send = async () => {
    const endpoint = process.env.OTEL_TRACES_ENDPOINT ?? 'http://127.0.0.1:4318/v1/traces';
    if (!configured()) { traces.length = 0; return; }
    try {
      const url = new URL(endpoint);
      const local = url.hostname === 'localhost' || url.hostname === '127.0.0.1' ||
        url.hostname === 'otel-collector';
      if (url.protocol !== 'https:' && !(url.protocol === 'http:' && local)) {
        traces.length = 0; // refuse exporting sensitive service telemetry over remote plaintext
        return;
      }
    } catch { traces.length = 0; return; }
    for (let batchNo = 0; batchNo < 8 && traces.length; batchNo++) {
      const batch = traces.splice(0, 64);
      const body = {
        resourceSpans: [{
          resource: { attributes: [
            { key: 'service.name', value: { stringValue: 'jungle-wagering' } },
            { key: 'service.version', value: { stringValue: '0.0.1' } },
          ] },
          scopeSpans: [{
            scope: { name: 'jungle.native-otlp', version: '1' },
            spans: batch,
          }],
        }],
      };
      try {
        const response = await fetch(endpoint, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(1200),
        });
        if (!response.ok) throw new Error('Collector returned non-2xx');
      } catch {
        // Fire-and-forget, bounded, never retry against the critical financial path.
        // Missing collector must never cause a payment rejection.
      }
    }
  };
  flushing = send();
  try { await flushing; } finally { flushing = null; }
}

export interface TraceSpan {
  readonly traceparent?: string;
  run<T>(callback: () => T): T;
  end(outcome?: 'OK' | 'ERROR', extra?: Attributes): void;
}

export function startTraceSpan(
  name: string,
  kind: SpanKind,
  attributes: Attributes = {},
  remoteParent?: unknown,
): TraceSpan {
  if (!configured()) return { run: callback => callback(), end: () => {} };
  const parent = parseTraceparent(remoteParent) ?? contextStorage.getStore();
  const sampled = parent ? parent.sampled : shouldSample();
  const child: TraceParent = {
    traceId: parent?.traceId ?? randomBytes(16).toString('hex'),
    spanId: randomBytes(8).toString('hex'),
    sampled,
  };
  const traceparent = '00-' + child.traceId + '-' + child.spanId + '-' + (sampled ? '01' : '00');
  const start = BigInt(Date.now()) * 1_000_000n;
  const clock = process.hrtime.bigint();
  let ended = false;
  return {
    traceparent,
    run: callback => contextStorage.run(child, callback),
    end: (outcome = 'OK', extra = {}) => {
      if (ended) return;
      ended = true;
      if (!sampled) return;
      const end = start + (process.hrtime.bigint() - clock);
      queueSpan({
        traceId: child.traceId, spanId: child.spanId,
        ...(parent ? { parentSpanId: parent.spanId } : {}),
        name: name.slice(0, 100),
        kind: { INTERNAL: 1, SERVER: 2, PRODUCER: 4, CONSUMER: 5 }[kind],
        startTimeUnixNano: String(start), endTimeUnixNano: String(end),
        attributes: encodeAttributes({ ...attributes, ...extra }),
        status: { code: outcome === 'ERROR' ? 2 : 1 },
      });
    },
  };
}

@Injectable()
export class TelemetryShutdown implements OnApplicationShutdown {
  async onApplicationShutdown(): Promise<void> {
    if (timer) { clearInterval(timer); timer = undefined; }
    await flushTraces();
  }
}
