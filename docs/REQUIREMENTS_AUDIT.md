# Auditoria de conformidade — Jungle Gaming

**Fonte:** [enunciado oficial, seções 4–14](https://github.com/junglegaming/backend-challenge/blob/main/README.md). **Escopo:** branch `feat/wallet-ledger-performance` em 08/11/2026. Comparação de código e logs; não substitui avaliação da Jungle nem certifica produção.

| Critério (peso) | Evidência concreta | Limite / risco residual |
|---|---|---|
| Correção financeira (20) | `Money` decimal, wallet, ledger imutável por trigger, constraints, Opening e BET/WIN/LOSS/REFUND/ROLLBACK, rejeições e reconciliação `REPEATABLE READ` | Agregado com transições já existe, porém a persistência segue no serviço SQL |
| Concorrência (20) | `FOR NO KEY UPDATE`, versionamento, 50 apostas iguais em 3 processos e 2 apostas de 80 para saldo 100, wallets independentes | Não é benchmark de throughput de três containers |
| Idempotência (15) | hash canônico, unicidade no DB, replay sem movimentação duplicada, chave conflitante e Inbox em transação | `idempotency_key` global, não escopo por provedor |
| Mensageria e falhas (15) | MiniStack FIFO, Inbox, Outbox pós-commit, DLQ, morte pós-COMMIT/pré-ACK, recuperação com 2 publishers | Falta matriz completa de `SIGTERM` e prova contra AWS SQS gerenciado |
| Modelagem e arquitetura (10) | Money/Wallet/Ledger e WagerTransaction com máquina de estados, eventos tipados, validação desacoplada, MikroORM e decisões de locks | `WageringService` concentra regras e SQL; menor separação que a concorrente |
| Testes (10) | CI com Postgres 17 real, SQS MiniStack, typecheck, transações, locks, falhas e JWT; migrations reversíveis testadas a partir do novo CI | Sem garantia contra todos os cenários de produção; sem suíte real do IdP externo |
| Observabilidade (5) | live/ready, Prometheus, OTLP/HTTP, correlação HTTP/SQS, métricas e logs JSON | Prometheus e W3C traceparent/OTLP implementados opcionalmente; faltam instrumentação automática e ambiente monitorado de produção |
| Documentação (5) | README, arquitetura, invariantes, comparativo, limitações, dados da carga e links do CI | Validação de Compose multinó exige IdP externo |

## Resultado dos últimos testes

A [execução prévia com sucesso](https://github.com/rafael-mindahead/JungleTest/actions/runs/42504466932) aprovou: 39 unitários; 19 testes PostgreSQL/HTTP (outros arquivos da pasta ficam `skip` sem MiniStack); 3 RS256/autorização; 3 de processos independentes; 1 end-to-end MiniStack; 3 casos de crash, DLQ e publishers, sem falhas. A regressão de snapshot e o teste de erro HTTP aumentam a cobertura; o novo gate de contrato e os testes de agregados/observabilidade se somam às suites existentes. Consultar última execução verde para contagens. Os scripts de carga não são rodados em cada commit.

A execução [100 VUs pré-JWT](https://github.com/rafael-mindahead/JungleTest/actions/runs/42503672224) registrou **279.431 requests / 665,01 RPS / p95 54,45 ms / p99 69,78 ms / 0% erros técnicos** e reconciliação final verde. A exportação do arquivo JSON não ocorreu por permissão; os valores constam no log do job. Após JWT, `ADMIN_TOKEN` e `PROVIDER_TOKEN` são exigidos pelos scripts, e o workflow de baseline só pode ser acionado manualmente. 200 mil usuários **não** foram testados.

## Faixa de pontuação — apenas estimativa

Os pesos oficiais somam **100**, mas a nota exata só a Jungle atribui. Na inspeção atual, uma faixa de **84 a 90/100** é plausível se o novo CI permanecer verde: correção/concorrência/idempotência fortes; perdas residuais mais prováveis em fronteiras de persistência do agregado `WagerTransaction`, ausência do SDK completo OpenTelemetry e aspectos operacionais. Essa estimativa **não** significa aprovação oficial, superioridade definitiva sobre outras submissões ou ausência de critérios eliminatórios inéditos.

A própria Jungle declara **0 pontos para autenticação** e carga **opcional**, sem limite de RPS ou de usuários virtuais. Prioridade é correção, não perseguir 200 mil VUs.

## Gates de entrega

1. Workflow de correção verde no último commit (incluindo reversão de migrations, concorrência e MiniStack).
2. Resultado das suites e limitações coerentes com README e arquitetura.
3. Revisão de segurança humana e PR antes de promover à `main`.
4. Deploy com IdP externo, tracing entre serviços/Prometheus e testes da AWS gerenciada permanecem **fora da evidência entregue**; não declarar produção pronta.
