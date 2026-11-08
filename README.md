# JungleTest — Distributed Wagering Processor

Implementação do [desafio financeiro oficial da Jungle Gaming](https://github.com/junglegaming/backend-challenge) com foco em integridade monetária e concorrência distribuída. **Protótipo de avaliação, não serviço financeiro pronto para internet pública.**

**Stack:** Bun 1.4.4 · NestJS 12 · TypeScript strict · MikroORM 7 · PostgreSQL 17 · SQS FIFO via MiniStack · Docker Compose.

## O que foi construído

- `Money` decimal imutável, `Wallet`, ledger append-only, constraints e reconciliação em snapshot `REPEATABLE READ`.
- `BET`, `WIN`, `LOSS`, `REFUND`, `ROLLBACK`, rejeições auditáveis e referências `PENDING_REFERENCE` com retry/backoff.
- Idempotência persistente no PostgreSQL, hash canônico, Inbox, Outbox transacional, ACK pós-commit, DLQ e recuperação.
- API HTTP protegida por JWT RS256 de **IdP externo**: administrador gerencia carteiras; provedores só submetem/consultam suas operações.
- Testes reais de concorrência entre **três processos**, crash após commit, dois publishers, MiniStack SQS e regressões HTTP.
- Métricas operacionais JSON protegidas e testes k6 opcionais. Não existe exigência oficial de 100 mil/200 mil usuários.

## Evidências verificadas

[Último CI de correção](https://github.com/rafael-mindahead/JungleTest/actions) executa typecheck, migrations PostgreSQL e reversão, integração HTTP/DB, autorização RS256, três processos e fila MiniStack. A suite anterior à atualização de reconciliação tinha **39 testes unitários, 19 de integração DB/HTTP, 3 de auth, 3 multi-processo, 1 SQS E2E e 3 de recuperação/DLQ**, todos aprovados. A nova regressão de reconciliação aumenta a suite DB/HTTP para 20 quando o CI mais recente concluir.

No [benchmark pré-autenticação com 100 VUs](https://github.com/rafael-mindahead/JungleTest/actions/runs/42503672224), foram registradas **279.431 requisições em 7 minutos (rampas incluídas)**, média **665,01 RPS**, **p95 54,45 ms**, **p99 69,78 ms** e **0% de erros técnicos**, com reconciliação final aprovada. **Não é evidência de escala em produção nem de throughput após JWT**. A exportação do resumo JSON falhou por permissão do container; os números citados estão nos logs, e o workflow agora exige o arquivo em futuras execuções. Não serão feitos novos testes de carga automaticamente.

## Rodando dependências e testes

Requisitos: Bun 1.x e Docker Compose.

```bash
bun install --frozen-lockfile
docker compose up -d
bun run sqs:setup
bun run db:migrate
bun run typecheck
bun run test:domain
```

Para integração, use **exclusivamente** um banco descartável cujo nome termine em `_test`:

```bash
docker compose exec -T postgres psql -U jungle -d postgres -c "CREATE DATABASE jungle_wagering_test"
DB_NAME=jungle_wagering_test bun run db:migrate
DB_NAME=jungle_wagering_test NODE_ENV=test ALLOW_INSECURE_TEST_AUTH=1 bun run test:integration
DB_NAME=jungle_wagering_test NODE_ENV=test RUN_DB_TESTS=1 ALLOW_INSECURE_TEST_AUTH=0 bun test test/security/financial-auth.test.ts
```

O bypass existe **apenas** para testes com `NODE_ENV=test` e banco `*_test`; ele não libera endpoints em desenvolvimento/produção. O CI realiza os testes SQS com MiniStack isolado.

## HTTP e identidade

Configure `OIDC_ISSUER`, `OIDC_AUDIENCE` e `OIDC_JWKS_URI` para um **IdP externo** com HTTPS e tokens RS256. Os claims esperados são `realm_access.roles` com `jungle-admin` ou `jungle-provider`; para provedores, também `provider_id`. Sem IdP configurado, as rotas protegidas recusam acesso.

| Rota | Papel |
|---|---|
| `GET /health/live`, `GET /health/ready` | pública |
| `POST /wallets`, `GET /wallets/:walletId` | admin |
| `GET /wallets/:walletId/ledger`, `POST /wallets/:walletId/reconciliation` | admin |
| `POST /wagering/transactions` | provedor proprietário, com `Idempotency-Key` |
| `GET /providers/:providerId/wagering/transactions/:externalTransactionId` | mesmo provedor ou admin |
| `GET /wagering/transactions/:transactionId` | admin |
| `GET /internal/metrics` | `X-Metrics-Token` configurado |

Worker loops são opt-in com `SQS_WORKER_ENABLED=1`, `OUTBOX_PUBLISHER_ENABLED=1` e `REFERENCE_WORKER_ENABLED=1`.

## Docker Compose de três instâncias

O Compose base sobe PostgreSQL e MiniStack. Para demonstrar **três instâncias** com migrations e filas inicializadas, configure primeiro um IdP externo acessível pelos containers e rode:

```bash
export OIDC_ISSUER="https://seu-idp.example/realms/jungle"
export OIDC_AUDIENCE="jungle-financial-api"
export OIDC_JWKS_URI="https://seu-idp.example/realms/jungle/protocol/openid-connect/certs"
docker compose -f docker-compose.yml -f docker-compose.cluster.yml up -d --build
```

A API estará nas portas locais 3001, 3002 e 3003. Os valores `jungle_dev` e `test` do Compose são **somente para laboratório**; não use esses segredos em produção. O Compose não sobe Keycloak automaticamente e não substitui testes de integração com um IdP real.

## Encerramento do desafio

- [Auditoria item a item e faixa de nota estimada](docs/REQUIREMENTS_AUDIT.md)
- [Versus com a concorrente, ganhos e perdas](docs/COMPARISON.md)
- [Arquitetura, escolhas e limitações](ARCHITECTURE.md)
- [Relatório e metodologia de performance opcional](docs/PERFORMANCE.md)
- [Invariantes transacionais](docs/TRANSACTIONAL-INVARIANTS.md)

**O PR permanece em rascunho até a última verificação do CI e revisão humana.** Não faremos merge automático na `main`.
