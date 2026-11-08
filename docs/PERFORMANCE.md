# Performance financeira — evidência e limites

A Jungle Gaming considera carga **um diferencial opcional**, sem RPS mínimo nem meta de 100 mil/200 mil usuários. Não faremos mais escalada de carga como objetivo do desafio.

## Evidência histórica, antes da autenticação JWT

[GitHub Actions 100-VU baseline](https://github.com/rafael-mindahead/JungleTest/actions/runs/42503672224), sobre a branch pré-JWT:
- **100 usuários virtuais** no máximo, **5 minutos sustentados** com 1 minuto de rampa em cada ponta (7 min total).
- **279.431 requisições HTTP**, cerca de **665,01 req/s** ao longo de 420 segundos.
- `http_req_duration`: **p95 54,45 ms**, **p99 69,78 ms**; `financial_technical_error_rate`: **0,00%**.
- Reconciliação posterior de wallet e ledger **aprovada** no job.
- As requisições exercitaram BET, WIN, LOSS, REFUND, ROLLBACK e replays idempotentes contra PostgreSQL real. SQS/Outbox foram verificados em testes separados, **não medidos sob este throughput**.

**Qualificações:** resultado de um runner GitHub, não de infraestrutura dedicada; usuários virtuais são geradores de carga, não contas simultâneas distintas. A exportação do resumo `k6-baseline.json` falhou por permissão de volume (e o workflow não falhou por isso); os números acima foram extraídos dos logs e a reconciliação aconteceu. A configuração futura define o UID do container e exige o JSON, mas **não foi reexecutada**, conforme decisão de encerrar performance.

## Como reproduzir de forma segura, apenas se necessário

Requer uma API com JWT RS256 validado por IdP externo e um `*_test` DB isolado. A montagem é feita fora de produção:

```bash
docker compose up -d
DB_NAME=jungle_wagering_test bun run db:migrate
# Inicie a API dedicada com DB_NAME=jungle_wagering_test e OIDC_* configurados.
export ADMIN_TOKEN="<token-admin-curta-duracao>"
export PROVIDER_TOKEN="<token-jungle-provider>"
export BENCH_PROVIDER_ID=bench-provider
DB_NAME=jungle_wagering_test bun scripts/bench/seed-financial.ts
PROFILE=smoke PROVIDER_TOKEN="$PROVIDER_TOKEN" k6 run scripts/bench/financial.js
DB_NAME=jungle_wagering_test bun scripts/bench/reconcile-financial.ts
```

A claim `provider_id` do `PROVIDER_TOKEN` deve ser igual ao `BENCH_PROVIDER_ID`. O seed usa `ADMIN_TOKEN` para abertura de carteiras; a reconciliação também exige admin. O arquivo fixture `artifacts/bench/wallets.json` é gerado e não pode apontar para dados reais. Não inclua tokens em commits, relatórios, logs ou screenshots.

Perfis disponíveis em `scripts/bench/financial.js`: smoke, pilot, baseline, ramp, peak100k, peak200k, mas **100k/200k nunca foram validados** e não fazem parte da entrega. Os últimos perfis exigem opt-in explícito e geradores dimensionados. O workflow `.github/workflows/financial-baseline.yml` é **somente manual** e exige IdP acessível e credenciais efêmeras via vars/secrets do Actions; não é gate do PR.

## Critérios internos (não são requisitos oficiais)

Para qualquer futura execução, registre VUs, RPS, distribuição p50/p95/p99, erro técnico, rejeições de negócio, saturação do banco, CPU/RSS/FD e a reconciliação final. Os limites internos existentes no script são p95 < 500ms, p99 < 1000ms e erro técnico < 1%; a correção do ledger tem precedência. Nenhuma nova promessa de capacidade de usuários é feita.
