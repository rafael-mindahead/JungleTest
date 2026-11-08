# Observability: Prometheus + OpenTelemetry

This is an optional monitoring overlay. The financial application remains
functional without it. No third-party npm package was added.

## Prometheus

GET /internal/prometheus serves valid Prometheus text format (version 0.0.4).
It accepts Authorization: Bearer <METRICS_TOKEN> or X-Metrics-Token.
METRICS_TOKEN must be at least 12 characters; missing credentials fail closed.

Metrics include:
- HTTP requests by low-cardinality route template, method and status;
- HTTP request latency histogram;
- wagering result counters, replay counters, lock conflicts and latency histogram;
- PostgreSQL transaction status, Inbox, Outbox count and lag, retry attempts;
- approximate DLQ size/availability and process RSS/CPU time.

CRITICAL: Process-local counters can be summed over instances. Durable
PostgreSQL gauges are repeated on all three replicas: do NOT sum those gauges.
Never add player IDs, wallet IDs, monetary amounts or raw URLs as metric labels.

The original authenticated JSON diagnostics at /internal/metrics remains available.

## OpenTelemetry traces

src/observability/otel-tracing.ts uses W3C traceparent and the standard
OTLP/HTTP JSON protocol, exporting spans to an OpenTelemetry Collector's
/v1/traces endpoint. This is a lightweight, standards-compliant custom
exporter, NOT the full OpenTelemetry JS SDK or automatic instrumentation.

- Incoming HTTP traceparent establishes the remote parent of the HTTP span.
- A nested span tracks financial settlement without recording player information.
- When an Outbox event is committed, its W3C trace context is persisted in
  the event payload and later passed as an SQS traceparent message attribute.
- The SQS worker creates a consumer span from the incoming traceparent.
- Attribute names are strictly whitelisted: no financial data, tokens, UUIDs
  or request bodies can appear in spans.
- Disabled by default. Sampling defaults to 10% when enabled, queued export
  is bounded, and failures silently drop telemetry (not the financial event).
- Graceful application shutdown attempts to flush pending spans.

This is not a production-grade observability SDK and is not a promise of
100% span delivery. Missing collectors never reject financial transactions.

## Starting the local monitoring stack

Requires an external OIDC provider reachable from the three API containers,
as explained in the main README. For a disposable local lab, choose a unique
METRICS_TOKEN and create a secret file for the Prometheus container:

    export METRICS_TOKEN="$(openssl rand -hex 24)"
    mkdir -p observability/secrets
    printf '%s' "$METRICS_TOKEN" > observability/secrets/metrics-token
    chmod 644 observability/secrets/metrics-token
    docker compose -f docker-compose.yml -f docker-compose.cluster.yml \
      -f docker-compose.observability.yml up -d --build

The secret file is gitignored. It is accessible to the Prometheus container.
Do not reuse this secret outside the local lab. Published ports bind only
to loopback.

Prometheus: http://127.0.0.1:9090
Queries: jungle_outbox_pending, jungle_wagering_result_total,
jungle_http_request_duration_seconds_bucket.

OTLP/HTTP collector: http://127.0.0.1:4318/v1/traces

This example collector uses a debug exporter rather than a remote Jaeger/
Tempo backend, so inspect received traces with:

    docker compose -f docker-compose.yml -f docker-compose.cluster.yml \
      -f docker-compose.observability.yml logs -f otel-collector

The Docker overlay is optional and does not add tracing to unrelated services.

## Validation

GitHub Actions checks the optional Compose overlay and runs a local stub
OTLP collector test to inspect exported parent-child spans. The financial
metrics integration test validates Prometheus bearer authentication and
checks that no player or wallet IDs leak into the exposition.

The historical k6 benchmark was run before these additions. We have not
measured overhead at 100 VUs after enabling tracing, and the original
performance result should not be presented as a new monitoring benchmark.
