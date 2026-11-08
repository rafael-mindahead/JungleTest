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
| Modelagem/organização | Money/Wallet, eventos tipados, `WageringService` concentra SQL e regra | Aggregate WagerTransaction explícito, `LiquidacaoDeAposta`, repositórios, `UnidadeDeTrabalho` | **Perda nossa** em DDD/separação |
| Entrada e erros | Validação manual e códigos HTTP por endpoint | Zod DTO, filtro global, contratos de erros consistentes | **Perda nossa** em contratos/coerência |
| Observabilidade | Endpoint JSON ops protegido com status, lag, DLQ + health | Pino JSON, prom-client `/metrics`, correlationId no middleware | **Perda nossa** nos logs e interoperabilidade |
| Docker | Compose básico + novo Dockerfile/overlay de três processos (pendente teste com IdP externo) | Dockerfile + Compose que sobe 3 apps e faz migrations | Concorrente foi mais completa inicialmente; novo overlay reduz diferença |
| Testes e automatização | GitHub Actions com Postgres/SQS/RS256 e reversão de migration | Diretórios unit/integration/concurrency, sem workflow na branch analisada | Ganho nosso em evidência verificável |
| Performance opcional | Benchmark pré-JWT 100 VUs, 279.431 requisições, 665 RPS, reconciliação | Nenhum benchmark publicado na branch examinada | Ganho nosso, **não** é prova de 200 mil usuários |

## Melhorias adicionadas após a comparação

1. **Correção financeira:** leitura da wallet e ledger sob a mesma transação `REPEATABLE READ`, com regressão concorrente.
2. **Execução local:** Dockerfile e overlay opcional para três instâncias independentes, workers e inicialização ordenada; exige IdP externo para autenticação real.
3. **Confiabilidade de entrega:** CI agora checa descida/subida das migrations em DB descartável e configuração Compose.
4. **Benchmarks honestos:** clientes de carga exigem credenciais, e a baseline de 100 VUs é manual-only; a exportação JSON deixa de ser aceita silenciosamente quando ausente.
5. **Documentação:** atualização de README, arquitetura, rubrica oficial, evidências de desempenho e lacunas remanescentes.

## O que NÃO copiamos apenas por competir

Reescrever integralmente a aplicação para DDD, adotar Prometheus e introduzir mais componentes sem validar a migração causaria risco e custo de prazo. Para um desafio com 100 pontos concentrados em correção (20), concorrência (20), idempotência (15) e mensageria (15), os testes verificados têm mais valor imediato. A maior dívida técnica reconhecida é a máquina de estados WagerTransaction em `WageringService`; deve ser discutida como trade-off, não ocultada.

## Conclusão

Há ganhos técnicos nossos em autenticação, automação e evidência de falhas sob PostgreSQL/SQS reais. A concorrente tem melhor fronteira de domínio, contratos de API e logs estruturados. **Não é possível afirmar quem recebeu ou receberá nota superior sem a avaliação da Jungle e execução equivalente das duas suites.**
