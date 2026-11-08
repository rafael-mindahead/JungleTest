import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import {
  activeTraceparent, flushTraces, parseTraceparent, startTraceSpan,
} from './otel-tracing.js';

describe('W3C trace context and OTLP JSON exporter', () => {
  let collector: Server;
  const requests: Record<string, unknown>[] = [];
  const env = {
    enabled: process.env.OTEL_TRACES_ENABLED,
    endpoint: process.env.OTEL_TRACES_ENDPOINT,
    sampleRate: process.env.OTEL_SAMPLE_RATE,
  };

  beforeAll(async () => {
    collector = createServer(async (req, res) => {
      if (req.method !== 'POST' || req.url !== '/v1/traces') {
        res.writeHead(404).end(); return;
      }
      let data = '';
      for await (const part of req) data += part.toString();
      requests.push(JSON.parse(data) as Record<string, unknown>);
      res.writeHead(200).end('{}');
    });
    await new Promise<void>(resolve => collector.listen(0, '127.0.0.1', resolve));
    process.env.OTEL_TRACES_ENABLED = '1';
    process.env.OTEL_SAMPLE_RATE = '1';
    process.env.OTEL_TRACES_ENDPOINT = 'http://127.0.0.1:' +
      (collector.address() as AddressInfo).port + '/v1/traces';
  });
  afterAll(async () => {
    if (env.enabled === undefined) delete process.env.OTEL_TRACES_ENABLED;
    else process.env.OTEL_TRACES_ENABLED = env.enabled;
    if (env.endpoint === undefined) delete process.env.OTEL_TRACES_ENDPOINT;
    else process.env.OTEL_TRACES_ENDPOINT = env.endpoint;
    if (env.sampleRate === undefined) delete process.env.OTEL_SAMPLE_RATE;
    else process.env.OTEL_SAMPLE_RATE = env.sampleRate;
    await new Promise<void>((resolve, reject) =>
      collector.close(error => error ? reject(error) : resolve()));
  });

  test('accepts only strict W3C traceparent and rejects invalid IDs', () => {
    const valid = '00-0123456789abcdef0123456789abcdef-0123456789abcdef-01';
    expect(parseTraceparent(valid)?.sampled).toBe(true);
    expect(parseTraceparent(valid)?.traceId).toBe('0123456789abcdef0123456789abcdef');
    expect(parseTraceparent('00-' + '0'.repeat(32) + '-0123456789abcdef-01')).toBeNull();
    expect(parseTraceparent('00-0123456789abcdef0123456789abcdef-' + '0'.repeat(16) + '-01')).toBeNull();
    expect(parseTraceparent('bad')).toBeNull();
  });

  test('exports nested parent-child spans with no financial or user identifiers', async () => {
    const root = startTraceSpan('HTTP POST', 'SERVER', { 'http.request.method': 'POST' });
    root.run(() => {
      const span = startTraceSpan('wager.submit', 'INTERNAL',
        { 'wager.kind': 'BET', 'wallet.id': 'should-not-emit' });
      span.run(() => expect(activeTraceparent()).toBe(span.traceparent));
      span.end('OK', { 'wager.status': 'PROCESSED' });
    });
    root.end();
    await flushTraces();
    expect(requests.length).toBeGreaterThan(0);
    const payload = JSON.stringify(requests);
    expect(payload).toContain('resourceSpans');
    expect(payload).toContain('jungle-wagering');
    expect(payload).toContain('wager.submit');
    expect(payload).toContain('parentSpanId');
    expect(payload).not.toContain('walletId');
    expect(payload).not.toContain('playerId');
  });
});
