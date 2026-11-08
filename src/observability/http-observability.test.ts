import { describe, expect, test } from 'bun:test';
import { httpErrorCode, normalizedCorrelationId } from './http-observability.js';

describe('API observability contracts', () => {
  test('accepts a safe client correlation ID', () => {
    expect(normalizedCorrelationId('request-123.valid')).toBe('request-123.valid');
  });
  test('replaces injection attempts with a generated UUID', () => {
    expect(normalizedCorrelationId('bad\nrequest')).toMatch(/^[a-f0-9-]{36}$/);
    expect(normalizedCorrelationId('x'.repeat(101))).toMatch(/^[a-f0-9-]{36}$/);
    expect(normalizedCorrelationId({})).toMatch(/^[a-f0-9-]{36}$/);
  });
  test('returns stable machine readable error codes', () => {
    expect(httpErrorCode(400)).toBe('VALIDATION_ERROR');
    expect(httpErrorCode(401)).toBe('UNAUTHORIZED');
    expect(httpErrorCode(409)).toBe('CONFLICT');
    expect(httpErrorCode(503)).toBe('SERVICE_UNAVAILABLE');
    expect(httpErrorCode(500)).toBe('INTERNAL_ERROR');
  });
});
