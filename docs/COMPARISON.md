# JungleTest versus backend-challenge / financial_service

**Projetos examinados em 08/11/2026:**

- [Nossa implementação](https://github.com/rafael-mindahead/JungleTest/tree/feat/wallet-ledger-performance), PR [#1](https://github.com/rafael-mindahead/JungleTest/pull/1).
- [Implementação de manoelasz](https://github.com/manoelasz/backend-challenge/tree/financial_service), commit `c3ff68c0414fb059f551e1df60136a802876ef29`.
- [Rubrica oficial](https://github.com/junglegaming/backend-challenge/blob/main/README.md).

**Método:** inspeção de arquivos das duas branches e logs verificáveis do GitHub Actions do JungleTest. **Não** executei o código da concorrente nem verifiquei um CI dela; presença de testes no repositório **não comprova** que passaram.

| Tópico | JungleTest (nosso) | Concorrente | Veredito |
|---|---|---|---|
| Invariantes monetárias | Money + wallet/ledger, constraints, snapshot de reconciliação | Money decimal.js, Wallet/Ledger, `REPEATABLE READ` | Próximos; nosso snapshot corrigido |
| Concorrência real | 3 processos/50 duplicadas, concorrência e deadlock corrigido, CI verde anterior | 3 instâncias Compose + testes escritos de múltiplas instâncias | Nossa evidência de CI mais forte; implementação concorrente mais demonstrável via Compose |
| Falhas SQS | MiniStack real, post-commit-crash, DLQ, 2 publishers, jobs verdes | Testes escritos para crash, outbox e SQS | Nosso CI fornece comprovação pública; não presumir falha da concorrente |
| Segurança HTTP | Guard JWT RS256/JWKS, roles e `provider_id` com testes reais | `AutenticacaoGuard` retorna `true` e explica no-op no README | **Ganho nosso**, embora auth valha 0 pontos |
| Modelagem/organização | Agregado de estado WagerTransaction integrado e Money/Wallet, mas SQL segue no service | Aggregate WagerTransaction, `LiquidacaoDeAposta`, repositórios, `UnidadeDeTrabalho` | Concorrente ainda vence na separação de persistência |
| Entrada e erros | Contrato de entrada separado e compartilhado HTTP/SQS, filtro global com códigos estáveis | DTO Zod e filtro global | **Empate funcional parcial**; concorrente tem schema declarativo |
| Observabilidade | Log JSON por rota, correlação, erros protegidos e endpoint ops | Pino JSON, prom-client `/metrics`, correlationId no middleware | Logs nivelados; concorrente ainda leva vantagem no Prometheus |
| Docker | Compose básico + novo Dockerfile/overlay de três processos (pendente teste com IdP externo) | Dockerfile + Compose que sobe 3 apps e faz migrations | Concorrente foi mais completa inicialmente; novo overlay reduz diferença |
| Testes e automatização | GitHub Actions com Postgres/SQS/RS256 e reversão de migration | Diretórios unit/integration/concurrency, sem workflow na branch analisada | Ganho nosso em evidência verificável |
| Performance opcional | Benchmark pré-JWT 100 VUs, 279.431 requisições, 665 RPS, reconciliação | Nenhum benchmark publicado na branch examinada | Ganho nosso, **não** é prova de 200 mil usuários |

## Melhorias adicionadas após a comparação

1. **Correção financeira:** leitura da wallet e ledger sob a mesma transação `REPEATABLE READ`, com regressão concorrente.
2. **Execução local:** Dockerfile e overlay opcional para três instâncias independentes, workers e inicialização ordenada; exige IdP externo para autenticação real.
3. **Confiabilidade de entrega:** CI agora checa descida/subida das migrations em DB descartável e configuração Compose.
4. **Benchmarks honestos:** clientes de carga exigem credenciais, e a baseline de 100 VUs é manual-only; a exportação JSON deixa de ser aceita silenciosamente quando ausente.
5. **Documentação:** atualização de README, arquitetura, rubrica oficial, evidências de desempenho e lacunas remanescentes.

## Refinamento adicional de 08/11/2026

6. **Agregado com regra executável:** `WagerTransaction` define transições válidas e referências admitidas, e a liquidação usa o agregado antes de gravar o estado SQL; testes de estados terminais garantem ausência de transições indevidas.
7. **Contrato de entrada:** extração da validação de aposta para `wager-input.ts`, reutilizada no fluxo HTTP/SQS; casos adversariais de autorreferência, OPENING externo e moeda inválida são testados.
8. **Erros e correlação:** filtro de erro global, JSON estruturado de acesso por template de rota e IDs de correlação seguros, com integração testada.
9. **Escopo conscientemente preservado:** não introduzimos dependência de Zod, Pino ou Prometheus só por paridade; a infraestrutura atual mantém os invariantes já provados, e nenhum novo benchmark de massa foi executado.

## O que NÃO copiamos apenas por competir

Reescrever integralmente a aplicação para DDD, adotar Prometheus e introduzir mais componentes sem validar a migração causaria risco e custo de prazo. Para um desafio com 100 pontos concentrados em correção (20), concorrência (20), idempotência (15) e mensageria (15), os testes verificados têm mais valor imediato. A máquina de estados foi extraída e integrada; a dívida restante é a persistência SQL que ainda reside no `WageringService` e a falta de métricas Prometheus.

## Conclusão

Há ganhos técnicos nossos em autenticação, automação e evidência de falhas sob PostgreSQL/SQS reais. A concorrente ainda tem separação de persistência e Prometheus mais completos; nossa API agora tem contratos padronizados, validação isolada e logs estruturados. **Não é possível afirmar quem recebeu ou receberá nota superior sem a avaliação da Jungle e execução equivalente das duas suites.**
