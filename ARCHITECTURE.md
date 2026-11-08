# Architecture — Distributed Wagering Processor

Decisões técnicas, trade-offs e interpretações de regras do desafio
([`CHALLENGE.md`](./CHALLENGE.md)). Setup e comandos no
[`README.md`](./README.md).

---

## 1. Visão geral

```
            ┌────────────┐        ┌──────────────────────────┐
 provedores ├─► HTTP API ├───────►│  SubmitWagerTransaction  │──┐
            └────────────┘        │        UseCase           │  │
            ┌────────────┐        └───────────┬──────────────┘  │
 provedores ├─► SQS fifo │                    │                 │
            └────────────┘         ┌───────────▼──────────────┐  │
                                   │ 1 transação SQL          │  │
                                   │  inbox + wallet + ledger │  │
                                   │  + tx + outbox           │  │
                                   └───────────┬──────────────┘  │
                                               │ commit          │
                   ack (delete) ◄──────────────┤                 │
                                   ┌───────────▼──────────────┐  │
                                   │ Outbox publisher         │◄─┘
                                   │ FOR UPDATE SKIP LOCKED   │
                                   └───────────┬──────────────┘
                                               ▼
                                     wager-events.fifo (dedup por eventId)
```

Camadas (por módulo, em `src/modules/<módulo>/`):

- **domain** — TypeScript puro: agregados, value objects, erros, máquina de
  estados. Sem decorators Nest, sem tipos do ORM.
- **application** — use cases e **ports** (interfaces dos repositórios, `UnitOfWork`).
- **infrastructure** — adapters MikroORM, controllers HTTP, consumer/publisher SQS.

O shared kernel (`src/shared/`) carrega `Money`, erros de domínio,
`LedgerDirection`, ids UUIDv7, JSON canônico + hash e o codec de cursor.

---

## 2. Decisões e justificativas

### 2.1 ORM — MikroORM

Preferencial do enunciado. `EntityManager.transactional()` dá a unidade de
trabalho por use case; `LockMode.PESSIMISTIC_WRITE` cobre o locking; migrations
do Migrator são versionadas e reversíveis. Entidades de persistência são
classes separadas do domínio, registradas explicitamente em
`src/database/entities.ts` (sem glob scanning) — o mapeamento usa
`rehydrate` do domínio, que nunca revalida regras.

Trade-off assumido: os **ports** recebem o `EntityManager` da transação
(`Db`), ou seja, são ports de nível de repositório, não de storage engine.
Trocar de ORM reescreve adapters, não use cases; testes de unidade substituem
os ports por fakes.

### 2.2 Runtime — Bun

Stack obrigatória. Pontos práticos documentados:

- `experimentalDecorators` + `emitDecoratorMetadata` precisam estar
  **literais** no `tsconfig.json` (herança via `extends` de pacote é ignorada
  pelo transpiler do Bun);
- o Bun resolve dependências de forma estrita — peers transitivos usados
  diretamente (`ajv`) viram dependência declarada;
- o CLI do MikroORM roda com `bunx --bun` para ler o config em TypeScript;
- `bun test` roda todos os arquivos **em um único processo**: o pool do banco
  é compartilhado entre as suítes (`PG_POOL_MAX`, default 40) e nenhum
  `afterAll` fecha o ORM compartilhado.

### 2.3 Concorrência — pessimistic locking por wallet

A **unidade de concorrência é a `walletId`** (README 8). Todo processamento
faz `SELECT ... FOR UPDATE` da wallet dentro da transação; a operação só
aplica depois de possuir o lock. Alternativas consideradas:

- *optimistic locking com retry* (`version`): rejeita menos sob disputa, mas
  exige loop de retry com backoff — mais complexidade de latência para o
  provedor, sem ganho de garantia;
- *update atômico condicionado* (`UPDATE ... WHERE balance >= x`): rápido,
  mas espalha as regras de negócio em SQL e dificulta produzir o lançamento
  de ledger consistente (o saldo "antes/depois" viraria leitura adicional).

O `version` continua sendo mantido e exposto (evolução do agregado), mas a
garantia é o row lock. Corretude independe do número de instâncias — testado
com 3 processos reais (`test/concurrency/multi-instance.test.ts`).

### 2.4 Dinheiro

- `Money` imutável sobre `decimal.js`, escala fixa 2, serialização sempre com
  2 casas; zero sinalizado é normalizado (`"0.00"`).
- Persistência em colunas separadas `numeric(14,2)` + `varchar(3)` — exata,
  reidratada como `Money`. **Nunca `number`/`float`/`double`**.
- Negativos são aceitos pelo value object (deltas de reversão, diferença de
  reconciliação), porém **rejeitados na porta** (DTO/DTO-equivalente da fila)
  e por toda factory que recebe valores de entrada (`Wallet`/`WagerTransaction`
  exigem positivos).

### 2.5 Idempotência — o banco é a fonte da verdade

- `UNIQUE (idempotency_key)` em `wager_transactions` é a garantia final.
- A checagem prévia por `findByIdempotencyKey` é **otimização**; corridas são
  resolvidas pela violação de unique: o perdedor recarrega o vencedor e
  responde replay ou conflito — nunca duplica o efeito.
- Mesma key + payload diferente = **conflito** (`IdempotencyConflictError`,
  HTTP 409). `payloadHash` = SHA-256 de JSON canônico (chaves ordenadas
  recursivamente, `undefined` omitido) do subconjunto de negócio; header e
  metadados de transporte ficam de fora. O algoritmo está em
  `src/shared/canonical-json.ts`.
- **Regra 7.7 (interpretada):** o replay retorna o resultado **original**,
  incluindo o saldo observado naquele momento. O saldo é **reconstruído do
  ledger**, sem snapshot denormalizado: transações que movem saldo respondem
  `balanceAfter` do lançamento; LOSS/REJECTED respondem o `balanceBefore` da
  próxima entrada cronológica da wallet (ou o saldo atual, se não houver).
  Totalmente auditável e testado (`use-cases-wagering`, cenário de replay).
- Queue dedup (inbox): PK composta `(consumer_name, message_id)` com o id de
  mensagem do SQS; o registro nasce já processado e é commitado na mesma
  transação do efeito. Nada de cache em memória.

### 2.6 Regra 7.4 — uma reversão por referência (interpretada)

O enunciado diz que "uma referência não pode ser revertida duas vezes pelo
**mesmo tipo** de operação". Implementamos a garantia mais forte e segura:

> uma referência `PROCESSED` só pode ser revertida **uma única vez**,
> independente do tipo (`REFUND` ou `ROLLBACK`).

Motivação: `REFUND(BET)` seguido de `ROLLBACK(BET)` devolveria o valor duas
vezes (dobra o crédito — violação de invariantes financeiras). Cadeias
legítimas continuam possíveis: `ROLLBACK(REFUND)` reverte a própria reversão
(net zero), pois a referência passa a ser o `REFUND`. Testado em
`use-cases-wagering` (segundo refund → `REFERENCE_ALREADY_REVERSED`).

### 2.7 Referências fora de ordem (7.1/7.8)

Referência ausente ou ainda não `PROCESSED` → transação persiste como
`PENDING_REFERENCE`, com política do worker:

- backoff exponencial: `1s → 2s → 4s … cap 60s` (`scheduleReferenceCheck`);
- `MAX_REFERENCE_ATTEMPTS = 10` (~17 minutos de janela total);
- esgotado o limite: `REJECTED` com `REFERENCE_NOT_FOUND` + evento
  `WagerTransactionRejected` publicado.

Referência existente porém `REJECTED`/`FAILED` (nunca será aplicada) →
rejeição imediata com `REFERENCE_KIND_MISMATCH` ("referência não aplicável").

O worker (`ReprocessPendingReferencesUseCase`) reivindica as pendências com
`FOR UPDATE SKIP LOCKED` — seguro com múltiplas instâncias.

### 2.8 Máquina de estados — `WagerTransaction`

```
PENDING           ─► PROCESSED          (markProcessed, terminal)
PENDING           ─► PENDING_REFERENCE  (markPendingReference)
PENDING           ─► REJECTED           (reject, + failureCode, terminal)
PENDING           ─► FAILED             (fail,   + failureCode, terminal)
PENDING_REFERENCE ─► PROCESSED | REJECTED | FAILED
```

`PROCESSED`, `REJECTED` e `FAILED` são **terminais**: qualquer tentativa de
transição a partir deles lança `InvalidTransactionStateError` — erro de
programação, não caminho de negócio. `OPENING` é interno e não pode ser
submetido por API nem fila (`create` rejeita; existe `createOpening` para o
caso de uso de criação de wallet). `LOSS` não gera lançamento
(`ledgerDirectionFor` retorna `null`); `ROLLBACK` inverte a direção da
referência.

### 2.9 Taxonomia de `FailureCode` (README 7.2)

| Código | Situação | Ação do provedor |
|---|---|---|
| `INSUFFICIENT_FUNDS` | BET sem saldo | corrigir saldo e reenviar |
| `INSUFFICIENT_FUNDS_FOR_REVERSAL` | reversão tornaria o saldo negativo (7.9) | não reenviar; revisar fluxo |
| `REFERENCE_NOT_FOUND` | referência não chegou (TTL esgotado) | reenviar a referência antes |
| `REFERENCE_ALREADY_REVERSED` | referência já revertida | não reenviar |
| `REFERENCE_KIND_MISMATCH` | reversão aponta para kind/status não reversível | corrigir payload |
| `REFERENCE_CONTEXT_MISMATCH` | referência de outro player/wallet/rodada/moeda | corrigir payload |
| `AMOUNT_MISMATCH` | valor da reversão ≠ referência | corrigir payload |
| `CURRENCY_MISMATCH` | moeda da transação ≠ wallet | corrigir payload |
| `WALLET_NOT_FOUND` | wallet inexistente (ainda) | reenviar após criação |
| `INVALID_AMOUNT` | valor não é positivo válido | corrigir payload |
| `REFERENCE_LOOKUP_FAILED` | erro de infra ao resolver referência | reenviar |

Distinct-by-design: `INSUFFICIENT_FUNDS_FOR_REVERSAL` ≠ `INSUFFICIENT_FUNDS`
(7.9 — situações operacionalmente diferentes).

### 2.10 Mapa de status HTTP

| Situação | HTTP |
|---|---|
| payload inválido (DTO, money, cursor) | `400` |
| wallet/transação inexistente (GET) | `404` |
| wallet duplicada | `409` |
| conflito de idempotência | `409` |
| transação aplicada / replay idempotente | `200` |
| aceite com referência pendente | `202` |
| rejeição por regra de negócio (`failureCode` no body) | `422` |
| dependência temporariamente indisponível | `503` |
| erro inesperado (logado, sem internals) | `500` |

Um único filtro (`DomainExceptionFilter`) aplica esse vocabulário em toda a
API; o corpo de erro tem sempre `{ error, message }` + campos relevantes.

### 2.11 Transacional outbox + publisher

- inbox, wallet, ledger, transação e **outbox** em uma única transação SQL
  (nunca publicar antes do commit).
- Publisher usa `FOR UPDATE SKIP LOCKED` — N instâncias sem sobrepasso.
- Envio para `wager-events.fifo` com `MessageGroupId = aggregateId`
  (ordenação por wallet) e `MessageDeduplicationId = eventId`: se o envio
  succeeds e o commit falha, a republicação posterior é **colapsada pelo
  SQS** — idempotente para o consumidor dos eventos (11.5).
- Falha de envio → `scheduleRetry` (backoff 1s→cap 60s) na mesma transação;
  eventos **nunca são descartados**; após `MAX_ATTEMPTS_BEFORE_ALERT=20`
  falhas, log ruidoso + métrica de retry continua.
- Outbox lag: gauge amostrado por ciclo = idade do evento pendente mais antigo.

### 2.12 Consumer SQS

- Reutiliza o `SubmitWagerTransactionUseCase` **via `executeInTransaction`** —
  inbox + efeito financeiro no mesmo commit (6.5).
- Ack (delete) **somente após o commit**. Crashes entre commit e ack são
  absorvidos pela inbox (redelivery → `duplicate` → ack, zero efeitos).
- Classificação de erros:
  - **negócio** (outcomes do use case, inclusive `REJECTED`) → ack;
  - **permanentes** (envelope inválido, tipo desconhecido, conflito de
    idempotência) → DLQ direto (envio à DLQ + delete);
  - **transitórios** → visibility timeout com backoff exponencial
    (1s→cap 60s) e DLQ pela redrive policy (`maxReceiveCount=5`).
- Envelope inválido (JSON, tipo desconhecido, campos) é permanente — não há
  o que retratar.
- SIGTERM: para de receber (abort do long poll), drena o batch em andamento,
  encerra; deadline de 3s para nunca travar o shutdown (mensagens em voo
  redeliveram).

### 2.13 Schema — invariantes no banco (README 5.9)

- `wallets`: `CHECK balance >= 0`, `CHECK version >= 1`,
  `UNIQUE (player_id, currency)`.
- `wager_transactions`: `UNIQUE (idempotency_key)`,
  `UNIQUE (provider_id, external_transaction_id)`, CHECKs de kind/status/amount,
  `failure_code` obrigatório em `REJECTED`/`FAILED`, reversão `PROCESSED`
  exige `reference_transaction_id`, índices para lookup de referência e para
  o worker de pendências (parcial).
- `wallet_ledger_entries`: `UNIQUE (transaction_id, wallet_id)` (máx. 1
  lançamento por wallet), **CHECK de aritmética** (`before ± amount = after`),
  **trigger append-only** (bloqueia `UPDATE`/`DELETE` inclusive do owner —
  `TRUNCATE` só em limpeza de teste), FKs para wallet e transação,
  índice de cursor.
- `inbox_messages`: PK composta `(consumer_name, message_id)`.
- `outbox_messages`: índice parcial para pendentes.
- **Migration 002 remove a FK `wager_transactions.wallet_id`**: rejeições por
  wallet inexistente precisam permanecer auditáveis (apontam para um id que
  nunca existiu). A integridade dos movimentos **aplicados** é garantida pelo
  lock/validação no use case e pelas FKs do ledger (nenhum lançamento sem
  transação, nenhuma transação aplicada sem wallet existente no momento do
  lock).

### 2.14 Criação de wallet — transição única

`POST /wallets` é **um** evento de criação: a wallet nasce com o saldo inicial
(`version = 1`, exatamente como no exemplo do README 9) e a transação interna
`OPENING` realiza esse saldo no ledger (`0 → inicial`) no mesmo commit. O
duplicado `(player_id, currency)` falha na unique como conflito (HTTP 409).

### 2.15 Autenticação

Keycloak 26 com import de realm no compose. O guard valida **assinatura
RS256 via JWKS + issuer + expiração** (`jose`). O `aud` não é estrito:
tokens client-credentials do Keycloak não carregam audience customizada sem
mapper; assinatura + issuer já provam que o token veio do nosso realm.
Trade-off documentado; ponto de extensão claro (`KeycloakAuthGuard` +
`@Public()`).

### 2.16 Observabilidade

- Logs JSON com `AsyncLocalStorage` propagando `correlationId`
  (aceito/gerado por request, novo por mensagem), `messageId`,
  `transactionId`, `walletId`, `providerId`; **nenhum payload financeiro**.
- Prometheus (`/metrics`, público — superfície interna de infra): transações
  por status, replays, conflitos de idempotência, duplicatas da inbox,
  retries (consumer/publisher), DLQ (contador + gauge), espera de lock +
  conflitos, outbox lag, latência de processamento (http/sqs), latência HTTP.
- Health separados: `/health/live` (processo) e `/health/ready` (PG + SQS).
- Não implementado (opcionais do enunciado): OpenTelemetry/tracing e
  dashboards.

---

## 3. Cobertura de testes → arquivos

| Cenário (README 13 / seção) | Onde |
|---|---|
| Unidade: Money, invariantes, regras por kind, conflito de moeda, key/payload divergente | `test/unit/*` |
| Migrations + constraints (CHECK/UNIQUE/trigger/FK) | `test/integration/schema-constraints.test.ts` |
| Atomicidade wallet+ledger+inbox+outbox (all-or-nothing) | `test/integration/repositories.test.ts` |
| Inbox dedup + redelivery | idem + `sqs-consumer.test.ts` |
| Publishers concorrentes sobre a mesma outbox | `test/integration/outbox-publisher.test.ts` |
| Retry e DLQ | idem + `sqs-consumer.test.ts` |
| Worker morto depois do commit e antes do ack | `sqs-consumer.test.ts` (delete falha → redelivery → dedup) |
| ROLLBACK/REFUND entregues antes da referência | `use-cases-wagering.test.ts` + worker |
| Mesma aposta 50× em paralelo → um único débito | `test/concurrency/hot-wallet.test.ts` |
| Hot wallet disputada (cenário da seção 8, 50×) | idem |
| Wallets distintas em paralelo | idem + `multi-instance.test.ts` |
| ≥ 3 processos/instâncias simultâneos | `test/concurrency/multi-instance.test.ts` (processos reais via spawn) |
| Reinício com consistência final | idem (SIGKILL mid-batch + restart) |
| Recuperação após reinicialização (commit → kill → outra instância publica) | `outbox-publisher.test.ts` (crash-recovery) |
| Invariante final `balance == ledger` | `test/concurrency/invariants.ts` (aplicada em todo teste de concorrência) + reconciliação |

Contagem atual: **197 testes** (unit + integration + e2e + concurrency), todos
contra PostgreSQL e LocalStack reais onde há infraestrutura envolvida —
nenhuma suíte substitui banco ou fila por mocks.

---

## 4. Limitações e não-escopo

- **Moeda operacional única (BRL)**, conforme permitido pelo enunciado: o
  modelo é multi-moeda (`Money` multi-moeda, unique por moeda, conflito de
  moeda testado), mas não há conversão cambial.
- **Reconciliação reporta, não corrige** — correção manual/dreriffe fica fora
  do escopo e sinalizada via log/métrica + resposta.
- **Idempotência do consumidor de eventos** (`wager-events.fifo`) é
  responsabilidade do sistema consumidor; garantimos dedup de republicação
  pelo `eventId` (janela SQS de 5 min) e ordenação por agregado.
- **Teste de carga** (diferencial opcional) não implementado.
- **OpenTelemetry/tracing** não implementado (opcional).
- Auditoria de eventos usa envelope JSON versionado (v1) — evolução de schema
  de eventos exigiria versamento adicional por evento.

---

## 5. Pontos de extensão

- `KeycloakAuthGuard` / `@Public()` — troca ou desativação do mecanismo de auth.
- Ports (`WalletRepository`, `LedgerRepository`, `WagerTransactionRepository`,
  `InboxRepository`, `OutboxRepository`, `UnitOfWork`) — implementações
  alternativas sem tocar use cases.
- `metrics` (`src/observability/metrics.ts`) — facade único; trocar prom-client
  por outro exporter não toca o domínio.
- `ReconcileWalletUseCase.onDivergence` — hook para alertas externos.
