# Jungle Gaming — Distributed Wagering Processor

Serviço financeiro distribuído que processa transações de apostas recebidas de
múltiplos provedores de jogos: idempotência persistente, ledger imutável,
processamento assíncrono via SQS e consistência garantida no banco — com
múltiplas instâncias.

> O enunciado original do desafio está em [`CHALLENGE.md`](./CHALLENGE.md).
> Decisões técnicas, trade-offs e interpretações das regras estão em
> [`ARCHITECTURE.md`](./ARCHITECTURE.md).

---

## Stack

| Item | Escolha |
|---|---|
| Runtime / package manager / test runner | **Bun 1.4+** |
| Linguagem | TypeScript (modo estrito) |
| Framework | **NestJS 11** |
| Banco | **PostgreSQL 18** |
| ORM | **MikroORM 6** |
| Mensageria | **AWS SQS** via **LocalStack** (FIFO) |
| Autenticação | **Keycloak 26** (OIDC/JWT) |
| Orquestração local | Docker Compose |
| Migrations | Versionadas e reversíveis (MikroORM Migrator, SQL escrito à mão) |

---

## Requisitos

- [Bun](https://bun.sh) 1.4+
- Docker + Docker Compose
- Usuário no grupo `docker` (ou permissão equivalente no socket)

---

## Modos de execução

Há duas topologias — escolha **uma** por vez:

### Modo A — infra no Docker, API no host (desenvolvimento)

```bash
cp .env.example .env          # defaults locais (senhas de dev)
docker compose up -d          # SOMENTE infra: PostgreSQL 18, LocalStack, Keycloak
bun install
bun run migration:up          # cria o schema (constraints no banco)
bun run start:dev             # API + consumer SQS + outbox publisher (porta do .env)
```

Multi-instância no host (portas 4000/4001/4002):

```bash
bash scripts/instances.sh start 3   # sobe as instâncias
bash scripts/instances.sh status    # health em cada porta
bash scripts/instances.sh stop      # para todas
```

### Modo B — tudo containerizado (3 réplicas + proxy reverso)

```bash
cp .env.compose .env 2>/dev/null || true
docker compose -f docker-compose-proxy.yml up -d --build
bun run migration:up          # migrations rodam do host contra o PG do compose
```

- **3 réplicas** da API atrás do **Caddy** na porta **3000** (round-robin via
  DNS dinâmico do Docker — veja `Caddyfile`).
- Mesmos workers SQS ativos em todas as réplicas (seguro: lock por wallet +
  inbox persistente + SKIP LOCKED).
- Verificação: `curl http://localhost:3000/health/ready`.

> Regra para rodar `bun test`: pare o dev server, as instâncias
> (`scripts/instances.sh stop`) e o serviço `api`/`proxy` do compose — eles
> disputam as mesmas filas com as suítes de mensageria.

O realm `jungle` é importado automaticamente pelo Keycloak
(`docker/keycloak/realm-jungle.json`) e as filas
(`wager-transactions.fifo`, DLQ e `wager-events.fifo`) são criadas por hook
do LocalStack (`docker/localstack/init/`).

---

## Serviços e portas

| Serviço | Porta | Credenciais de dev |
|---|---|---|
| API (NestJS) | 3000 (host, modo A — segue `APP_PORT`) ou via Caddy :3000 (modo B) | — |
| Caddy (proxy, modo B) | 3000 | — |
| PostgreSQL 18 | 5432 | `jungle` / `jungle` / db `jungle_wagering` |
| LocalStack (SQS) | 4566 | chave AWS dummy (`test`/`test`) |
| Keycloak | 8080 | admin `admin`/`admin`; client `wagering-api` secret `local-dev-api-secret` |

---

## Autenticação

Todos os endpoints (exceto `/health/*` e `/metrics`) exigem JWT do realm
`jungle`. Token de máquina (client credentials):

```bash
curl -X POST http://localhost:8080/realms/jungle/protocol/openid-connect/token \
  -d grant_type=client_credentials \
  -d client_id=wagering-api \
  -d client_secret=local-dev-api-secret
```

Use o `access_token` no header `Authorization: Bearer <token>`.

---

## Comandos

| Comando | Descrição |
|---|---|
| `bun run start:dev` | API + consumer SQS + outbox publisher (watch) |
| `bun run start` | build + executa o `dist/` |
| `bun run build` | compila para `dist/` |
| `bun run typecheck` | `tsc --noEmit` |
| `bun run lint` | ESLint |
| `bun run format` | Prettier |
| `bun test` | **todas** as suítes (unit + integration + e2e + concurrency) |
| `bun test test/unit` | suíte de unidade (sem infraestrutura) |
| `bun test test/integration` | integração: PostgreSQL + LocalStack reais |
| `bun test test/e2e` | e2e: HTTP real + token real do Keycloak |
| `bun test test/concurrency` | concorrência pesada (50× paralelo, 3 processos, SIGKILL) |
| `bun run migration:create` | gera migration (diff das entities) |
| `bun run migration:up` / `migration:down` | aplica/reverte migrations |
| `bun run migration:list` | lista migrations aplicadas |

### Scripts auxiliares (`scripts/`)

| Script | Descrição |
|---|---|
| `curl-wallets.sh` | fluxo manual em curl: token → wallet → BET → ledger → reconciliação |
| `curl-scorecard.sh` | **scorecard de aceitação via API** espelhando a pontuação do CHALLENGE (seção 14): financeira 20, concorrência 20, idempotência 15, mensageria 15, observabilidade 5 + checagens eliminatórias |
| `test-challenge.sh` | suíte manual estendida do provedor (multi-instância via `INSTANCES`, checagens SQL via `PSQL_CMD`, filas via `ENABLE_SQS=1`; usa `jq`) |
| `instances.sh` | sobe/para/status de N instâncias no host (portas 4000..N) |

Exemplos:

```bash
bash scripts/curl-scorecard.sh                                   # API na porta do .env
BASE=http://localhost:3000 INSTANCES="http://localhost:4000 http://localhost:4001 http://localhost:4002" bash scripts/test-challenge.sh
```

> As suítes `integration`, `e2e` e `concurrency` exigem o
> `docker compose up -d` ativo e o **`bun run start:dev` PARADO** — o dev
> server consome as mesmas filas do SQS e disputa as mensagens dos testes.
> `bun test` roda tudo em um processo — o pool do banco é compartilhado
> (ajustável por `PG_POOL_MAX`).

---

## API

| Método | Rota | Descrição |
|---|---|---|
| POST | `/wallets` | cria wallet (201); saldo inicial > 0 gera transação `OPENING` no mesmo commit |
| GET | `/wallets/:walletId` | estado da wallet |
| GET | `/wallets/:walletId/ledger?cursor&limit` | lançamentos, cursor opaco (limit 1–200, default 50) |
| POST | `/wallets/:walletId/reconciliation` | recalcula o saldo pelo ledger; divergência é reportada, nunca corrigida |
| POST | `/wagering/transactions` | submete `BET/WIN/LOSS/REFUND/ROLLBACK` (header `Idempotency-Key` obrigatório) |
| GET | `/wagering/transactions/:id` | transação por id interno |
| GET | `/providers/:providerId/wagering/transactions/:externalTransactionId` | transação por id do provedor |
| GET | `/health/live` · `/health/ready` | liveness / readiness (públicos) |
| GET | `/metrics` | Prometheus (público) |

\* todos com `Authorization: Bearer <token>`, exceto health e metrics.

### Mapa de status HTTP (consistente em toda a API)

| Situação | Status |
|---|---|
| Payload inválido / cursor inválido | `400` |
| Wallet ou transação não encontrada | `404` |
| Wallet duplicada / conflito de idempotência | `409` |
| Transação aplicada (ou replay idempotente) | `200` |
| Aceita, aguardando referência (`PENDING_REFERENCE`) | `202` |
| Rejeição por regra de negócio (body traz `failureCode`) | `422` |
| Dependência temporariamente indisponível | `503` |

Exemplo:

```bash
TOKEN=...  # token do Keycloak
curl -X POST http://localhost:3000/wallets \
  -H "authorization: Bearer $TOKEN" \
  -H 'content-type: application/json' \
  -d '{"playerId":"player-1","initialBalance":{"amount":"1000.00","currency":"BRL"}}'

curl -X POST http://localhost:3000/wagering/transactions \
  -H "authorization: Bearer $TOKEN" \
  -H 'content-type: application/json' \
  -H 'Idempotency-Key: provider-a:tx-123' \
  -d '{"providerId":"provider-a","externalTransactionId":"tx-123","playerId":"player-1",
       "walletId":"<wallet-id>","roundId":"round-1","gameId":"fortune-chimp",
       "kind":"BET","money":{"amount":"25.00","currency":"BRL"}}'
```

---

## Workers (SQS)

| Worker | Fila | Comportamento |
|---|---|---|
| Consumer | `wager-transactions.fifo` | inbox persistente `(consumerName, messageId)` no mesmo commit do efeito; ack só após o commit; rejeições de negócio ackadas; envelopes inválidos e conflitos → DLQ direto; falhas transitórias → backoff exponencial (visibility timeout) e DLQ pela redrive policy (`maxReceiveCount=5`) |
| Outbox publisher | `outbox_messages` → `wager-events.fifo` | claim com `FOR UPDATE SKIP LOCKED` (múltiplas instâncias); `MessageDeduplicationId = eventId` colapsa republicações; retry com backoff; eventos nunca descartados |

Ambos respeitam SIGTERM: param de receber, drenam o batch em andamento e
encerram — mensagens não processadas permanecem na fila e redeliveram.

Flags: `CONSUMER_ENABLED`, `PUBLISHER_ENABLED` (default `true`).

---

## Variáveis de ambiente

Ver [`.env.example`](./.env.example). Principais: `DATABASE_URL`,
`SQS_ENDPOINT`, `SQS_WAGER_TRANSACTIONS_QUEUE_URL`,
`SQS_WAGER_TRANSACTIONS_DLQ_URL`, `SQS_EVENTS_QUEUE_URL`,
`KEYCLOAK_ISSUER`, `APP_PORT`, `CONSUMER_ENABLED`, `PUBLISHER_ENABLED`,
`PG_POOL_MAX`.

---

## Estrutura

```
src/
  shared/                  # shared kernel: Money, erros, ids (UUIDv7), cursor, canonical JSON
  database/                # config MikroORM, entidades (registro explícito), PersistenceModule
  http/                    # cross-cutting HTTP: guard Keycloak, filtro de erros, DTOs comuns
  observability/           # logs JSON (ALS), métricas Prometheus, interceptor
  health/                  # liveness/readiness (públicos)
  modules/
    wallets/               # Wallet, WalletLedgerEntry (domain) + ports/adapters/http
    wagering/              # WagerTransaction, FailureCode + use cases (submit, worker, applier)
    messaging/             # Inbox, Outbox, IntegrationEvent + consumer/publisher SQS
    auth/                  # (reservado)
migrations/                # migrations versionadas e reversíveis (SQL escrito à mão)
docker/                    # init hooks LocalStack, realm Keycloak
test/
  unit/                    # domínio e observabilidade (sem infraestrutura)
  integration/             # PostgreSQL + LocalStack reais
  e2e/                     # HTTP real + token real do Keycloak
  concurrency/             # 50× paralelo, hot wallet, 3 processos, SIGKILL/restart
```

Princípios: o **domínio é puro** (sem decorators Nest nem tipos do ORM), as
**invariantes vivem no schema** (CHECKs, UNIQUEs, trigger append-only no
ledger), e **um único use case** atende HTTP e SQS.

---

## Documentação adicional

- [`ARCHITECTURE.md`](./ARCHITECTURE.md) — decisões, trade-offs, taxonomia de
  failure codes, máquina de estados, interpretações documentadas das regras e
  limitações.
- [`CHALLENGE.md`](./CHALLENGE.md) — enunciado original do desafio.
