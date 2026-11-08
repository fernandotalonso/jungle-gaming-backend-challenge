#!/usr/bin/env bash
# Teste manual do endpoint de wallets via curl.
#
# Uso:  bash scripts/curl-wallets.sh
# Requer: docker compose up -d + bun run start:dev
# Sem dependência de jq (extração de token via sed).

set -uo pipefail

# porta da API lida do .env (default 3000)
APP_PORT=$(grep -E '^APP_PORT=' .env 2>/dev/null | cut -d= -f2 | tr -d '[:space:]')
APP_PORT=${APP_PORT:-3000}
BASE="http://localhost:${APP_PORT}"
REALM="http://localhost:8080/realms/jungle"
CLIENT_ID="wagering-api"
CLIENT_SECRET="local-dev-api-secret"
RUN_ID="$(date +%s)"                 # único por execução: evita 409 de wallet duplicada e conflito de idempotência
PLAYER_ID="player-curl-$RUN_ID"

step() { echo; echo "==================================================="; echo "== $1"; echo "==================================================="; }

step "0. Health checks (públicos, sem token)"
curl -s "$BASE/health/live";  echo
curl -s "$BASE/health/ready"; echo

step "1. Obter access token do Keycloak (client credentials)"
TOKEN=$(curl -s -X POST "$REALM/protocol/openid-connect/token" \
  -d grant_type=client_credentials \
  -d client_id="$CLIENT_ID" \
  -d client_secret="$CLIENT_SECRET" \
  | sed -n 's/.*"access_token":"\([^"]*\)".*/\1/p')
if [ -z "$TOKEN" ]; then echo "FALHOU: não foi possível obter o token (Keycloak no ar?)"; exit 1; fi
echo "token obtido (${#TOKEN} caracteres)"

AUTH="authorization: Bearer $TOKEN"
CT="content-type: application/json"

step "2. POST /wallets — cria wallet com saldo inicial 1000.00 BRL (201)"
CREATE_RESPONSE=$(curl -s -w '\n%{http_code}' -X POST "$BASE/wallets" \
  -H "$AUTH" -H "$CT" \
  -d "{\"playerId\":\"$PLAYER_ID\",\"initialBalance\":{\"amount\":\"1000.00\",\"currency\":\"BRL\"}}")
CREATE_STATUS=$(echo "$CREATE_RESPONSE" | tail -1)
CREATE_BODY=$(echo "$CREATE_RESPONSE" | sed '$d')
echo "$CREATE_BODY"
echo "status: $CREATE_STATUS"
if [ "$CREATE_STATUS" != "201" ]; then echo "FALHOU: esperado 201"; exit 1; fi

WALLET_ID=$(echo "$CREATE_BODY" | sed -n 's/.*"id":"\([^"]*\)".*/\1/p')
echo "walletId: $WALLET_ID"

step "3. POST /wallets — mesma carteira novamente -> 409 conflito"
DUP_STATUS=$(curl -s -o /dev/null -w '%{http_code}' -X POST "$BASE/wallets" \
  -H "$AUTH" -H "$CT" \
  -d "{\"playerId\":\"$PLAYER_ID\",\"initialBalance\":{\"amount\":\"1000.00\",\"currency\":\"BRL\"}}")
echo "status: $DUP_STATUS (esperado 409)"

step "4. GET /wallets/:walletId — consulta a wallet (200)"
curl -s "$BASE/wallets/$WALLET_ID" -H "$AUTH"; echo

step "5. POST /wagering/transactions — BET de 25.00 (200, saldo 975.00)"
BET_STATUS=$(curl -s -o /tmp/curl-wallets-bet.json -w '%{http_code}' -X POST "$BASE/wagering/transactions" \
  -H "$AUTH" -H "$CT" \
  -H "Idempotency-Key: provider-a:curl-tx-$RUN_ID" \
  -d "{\"providerId\":\"provider-a\",\"externalTransactionId\":\"curl-tx-$RUN_ID\",\"playerId\":\"$PLAYER_ID\",\"walletId\":\"$WALLET_ID\",\"roundId\":\"round-1\",\"gameId\":\"fortune-chimp\",\"kind\":\"BET\",\"money\":{\"amount\":\"25.00\",\"currency\":\"BRL\"}}")
cat /tmp/curl-wallets-bet.json; echo
echo "status: $BET_STATUS (esperado 200)"

step "6. Mesma Idempotency-Key, payload diferente -> 409 conflito"
CONFLICT_STATUS=$(curl -s -o /dev/null -w '%{http_code}' -X POST "$BASE/wagering/transactions" \
  -H "$AUTH" -H "$CT" \
  -H "Idempotency-Key: provider-a:curl-tx-$RUN_ID" \
  -d "{\"providerId\":\"provider-a\",\"externalTransactionId\":\"curl-tx-$RUN_ID\",\"playerId\":\"$PLAYER_ID\",\"walletId\":\"$WALLET_ID\",\"roundId\":\"round-1\",\"gameId\":\"fortune-chimp\",\"kind\":\"BET\",\"money\":{\"amount\":\"99.00\",\"currency\":\"BRL\"}}")
echo "status: $CONFLICT_STATUS (esperado 409)"

step "7. GET /wallets/:walletId/ledger — lançamentos (opening + bet)"
curl -s "$BASE/wallets/$WALLET_ID/ledger?limit=10" -H "$AUTH"; echo

step "8. POST /wallets/:walletId/reconciliation — saldo == ledger (consistent: true)"
curl -s -X POST "$BASE/wallets/$WALLET_ID/reconciliation" -H "$AUTH"; echo

step "9. GET /wagering/transactions/:id — consulta a transação do BET"
TX_ID=$(sed -n 's/.*"transactionId":"\([^"]*\)".*/\1/p' /tmp/curl-wallets-bet.json)
curl -s "$BASE/wagering/transactions/$TX_ID" -H "$AUTH"; echo

echo
echo "Resumo: walletId=$WALLET_ID transactionId=$TX_ID"
echo "Fluxo concluído."
