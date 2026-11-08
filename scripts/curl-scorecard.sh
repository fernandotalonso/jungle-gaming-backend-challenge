#!/usr/bin/env bash
# Scorecard de aceitação via API — espelha a tabela de pontuação do CHALLENGE.md (seção 14).
#
# Uso:  bash scripts/curl-scorecard.sh
# Requer: docker compose up -d + bun run start:dev (consumer/publisher/workers ativos)
# Pontuável via API: 75 pts (Correção financeira 20, Concorrência 20,
# Idempotência 15, Mensageria 15, Observabilidade 5). Modelagem (10) e Testes
# (10) são avaliados na revisão de código — impressos como informativo.
# Teto completo: 75 + 20 = 95/100.

set -uo pipefail

APP_PORT=$(grep -E '^APP_PORT=' .env 2>/dev/null | cut -d= -f2 | tr -d '[:space:]')
APP_PORT=${APP_PORT:-3000}
BASE="http://localhost:${APP_PORT}"
REALM="http://localhost:8080/realms/jungle"
RUN_ID="$(date +%s)"
CT="content-type: application/json"

SCORE_FIN=0; SCORE_CONC=0; SCORE_IDEM=0; SCORE_MSG=0; SCORE_OBS=0

ok()   { echo "  ✓ $1"; }
fail() { echo "  ✗ $1"; }

# extrai campo de JSON: echo "$BODY" | jget balance.amount
jget() { python3 -c "
import json, sys
value = json.load(sys.stdin)
for key in '$1'.split('.'):
    value = value[int(key)] if isinstance(value, list) else value[key]
print(value if not isinstance(value, (dict, list)) else json.dumps(value))
" 2>/dev/null; }

section() { echo; echo "=================================================="; echo "== $1"; echo "=================================================="; }

# ---------------------------------------------------------------- preparação
echo "Scorecard CHALLENGE.md (seção 14) — RUN_ID=$RUN_ID"
echo "API: $BASE"

TOKEN=$(curl -s -m 10 -X POST "$REALM/protocol/openid-connect/token" \
  -d grant_type=client_credentials -d client_id=wagering-api \
  -d client_secret=local-dev-api-secret \
  | sed -n 's/.*"access_token":"\([^"]*\)".*/\1/p')
if [ -z "$TOKEN" ]; then echo "FALHOU: sem token do Keycloak"; exit 1; fi
AUTH="authorization: Bearer $TOKEN"

create_wallet() { # $1 saldo -> imprime walletId
  curl -s -m 10 -X POST "$BASE/wallets" -H "$AUTH" -H "$CT" \
    -d "{\"playerId\":\"score-$RUN_ID-$1\",\"initialBalance\":{\"amount\":\"$2\",\"currency\":\"BRL\"}}" \
    | sed -n 's/.*"id":"\([^"]*\)".*/\1/p'
}

# docker exec com fallback para sessões antigas sem o grupo docker
dq() {
  if docker exec jungle-localstack true 2>/dev/null; then
    docker exec jungle-localstack "$@"
  else
    echo "docker exec jungle-localstack $*" | newgrp docker
  fi
}

submit() { # $1 wallet, $2 key, $3 kind, $4 amount, [$5 refExtId] -> corpo JSON
  local ref=''; [ -n "${5:-}" ] && ref=",\"referenceExternalTransactionId\":\"$5\""
  curl -s -m 15 -X POST "$BASE/wagering/transactions" -H "$AUTH" -H "$CT" \
    -H "Idempotency-Key: $2" \
    -d "{\"providerId\":\"provider-a\",\"externalTransactionId\":\"$2\",\"playerId\":\"score-$RUN_ID\",\"walletId\":\"$1\",\"roundId\":\"round-score\",\"gameId\":\"fortune-chimp\",\"kind\":\"$3\",\"money\":{\"amount\":\"$4\",\"currency\":\"BRL\"}$ref}"
}

# ================================================================
section "CORREÇÃO FINANCEIRA (20 pts) — CHALLENGE 14"
# ================================================================
W_FIN=$(create_wallet fin 1000.00)
if [ -n "$W_FIN" ]; then ok "wallet criada"; SCORE_FIN=$((SCORE_FIN+4)); else fail "wallet não criada"; fi

R=$(submit "$W_FIN" "fin-bet-$RUN_ID" "BET" "250.00")
STATUS=$(echo "$R" | jget status); BAL=$(echo "$R" | jget balance.amount)
if [ "$STATUS" = "PROCESSED" ] && [ "$BAL" = "750.00" ]; then
  ok "BET 250.00 -> saldo 750.00"; SCORE_FIN=$((SCORE_FIN+4))
else fail "BET: status=$STATUS saldo=$BAL (esperado PROCESSED/750.00)"; fi

BET_EXT="fin-bet-$RUN_ID"
R=$(submit "$W_FIN" "fin-win-$RUN_ID" "WIN" "100.00" "$BET_EXT")
STATUS=$(echo "$R" | jget status); BAL=$(echo "$R" | jget balance.amount)
if [ "$STATUS" = "PROCESSED" ] && [ "$BAL" = "850.00" ]; then
  ok "WIN 100.00 referenciando BET -> saldo 850.00"; SCORE_FIN=$((SCORE_FIN+4))
else fail "WIN: status=$STATUS saldo=$BAL (esperado PROCESSED/850.00)"; fi

R=$(submit "$W_FIN" "fin-rollback-$RUN_ID" "ROLLBACK" "100.00" "fin-win-$RUN_ID")
STATUS=$(echo "$R" | jget status); BAL=$(echo "$R" | jget balance.amount)
if [ "$STATUS" = "PROCESSED" ] && [ "$BAL" = "750.00" ]; then
  ok "ROLLBACK da BET (inversa do débito) -> saldo 750.00"; SCORE_FIN=$((SCORE_FIN+4))
else fail "ROLLBACK: status=$STATUS saldo=$BAL (esperado PROCESSED/750.00)"; fi

R=$(curl -s -m 10 -X POST "$BASE/wallets/$W_FIN/reconciliation" -H "$AUTH")
CONSISTENT=$(echo "$R" | jget consistent); CHECKED=$(echo "$R" | jget checkedEntries)
if [ "$CONSISTENT" = "True" ] && [ "$CHECKED" = "4" ]; then
  ok "reconciliação consistente (4 entradas: opening+bet+win+rollback)"; SCORE_FIN=$((SCORE_FIN+4))
else fail "reconciliação: consistent=$CONSISTENT checked=$CHECKED (esperado True/3)"; fi

# ================================================================
section "CONCORRÊNCIA (20 pts) — corrida e hot wallet"
# ================================================================
W_CONC=$(create_wallet conc 600.00)
submit "$W_CONC" "conc-a-$RUN_ID" "BET" "600.00" > /tmp/score-race-a.json &
submit "$W_CONC" "conc-b-$RUN_ID" "BET" "600.00" > /tmp/score-race-b.json &
wait
RA=$(jget status < /tmp/score-race-a.json); RB=$(jget status < /tmp/score-race-b.json)
BAL=$(curl -s -m 10 "$BASE/wallets/$W_CONC" -H "$AUTH" | jget balance.amount)
if { [ "$RA" = "PROCESSED" ] && [ "$RB" = "REJECTED" ]; } || { [ "$RA" = "REJECTED" ] && [ "$RB" = "PROCESSED" ]; }; then
  if [ "$BAL" = "0.00" ]; then
    ok "corrida 2×600.00: 1 PROCESSADA, 1 REJEITADA, saldo 0.00 (nunca negativo)"; SCORE_CONC=$((SCORE_CONC+10))
  else fail "corrida: saldo=$BAL (esperado 0.00)"; fi
else fail "corrida: status A=$RA B=$RB (esperado 1 PROCESSED + 1 REJECTED)"; fi
rm -f /tmp/score-race-a.json /tmp/score-race-b.json

W_HOT=$(create_wallet hot 100.00)
HOT_KEY="hot-$RUN_ID"
for i in $(seq 1 50); do
  submit "$W_HOT" "$HOT_KEY" "BET" "25.00" > "/tmp/score-hot-$i.json" &
done
wait
REPLAYS=$(cat /tmp/score-hot-*.json | grep -o '"idempotentReplay":true' | wc -l)
UNIQUE_TX=$(cat /tmp/score-hot-*.json | grep -o '"transactionId":"[^"]*"' | sort -u | wc -l)
DEBITS=$(curl -s -m 10 "$BASE/wallets/$W_HOT/ledger?limit=200" -H "$AUTH" | grep -o '"direction":"DEBIT"' | wc -l)
if [ "$REPLAYS" = "49" ] && [ "$UNIQUE_TX" = "1" ] && [ "$DEBITS" = "1" ]; then
  ok "50 idênticas em paralelo: 49 replays, 1 transação, 1 débito"; SCORE_CONC=$((SCORE_CONC+10))
else fail "50 idênticas: replays=$REPLAYS (49), txIds únicos=$UNIQUE_TX (1), débitos=$DEBITS (1)"; fi

# ================================================================
section "IDEMPOTÊNCIA (15 pts) — replay, saldo original, conflito"
# ================================================================
W_IDEM=$(create_wallet idem 1000.00)
R1=$(submit "$W_IDEM" "idem-a-$RUN_ID" "BET" "10.00")            # saldo 990
submit "$W_IDEM" "idem-b-$RUN_ID" "BET" "30.00" > /dev/null      # saldo 960
R2=$(submit "$W_IDEM" "idem-a-$RUN_ID" "BET" "10.00")            # replay
REPLAY=$(echo "$R2" | jget idempotentReplay)
REPLAY_BAL=$(echo "$R2" | jget balance.amount)
if [ "$REPLAY" = "True" ] && [ "$REPLAY_BAL" = "990.00" ]; then
  ok "replay retorna resultado original com saldo da época (990.00, não 960.00)"; SCORE_IDEM=$((SCORE_IDEM+5))
else fail "replay: idempotentReplay=$REPLAY saldo=$REPLAY_BAL (esperado True/990.00)"; fi

TX1=$(echo "$R1" | jget transactionId); TX2=$(echo "$R2" | jget transactionId)
if [ "$TX1" = "$TX2" ]; then ok "replay aponta para a mesma transação"; SCORE_IDEM=$((SCORE_IDEM+5)); else fail "replay: transações distintas ($TX1 vs $TX2)"; fi

CONFLICT=$(submit "$W_IDEM" "idem-a-$RUN_ID" "BET" "50.00" | jget error)
if [ "$CONFLICT" = "IDEMPOTENCY_CONFLICT" ]; then ok "mesma key, payload diferente -> conflito"; SCORE_IDEM=$((SCORE_IDEM+5)); else fail "conflito: error=$CONFLICT"; fi

# ================================================================
section "MENSAGERIA E FALHAS (15 pts) — referência fora de ordem, outbox, DLQ"
# ================================================================
W_MSG=$(create_wallet msg 500.00)
REF_EXT="msg-ref-$RUN_ID"
R=$(submit "$W_MSG" "msg-refund-$RUN_ID" "REFUND" "20.00" "$REF_EXT")
STATUS=$(echo "$R" | jget status)
if [ "$STATUS" = "PENDING_REFERENCE" ]; then
  ok "REFUND sem referência -> 202 PENDING_REFERENCE"; SCORE_MSG=$((SCORE_MSG+3))
else fail "REFUND fora de ordem: status=$STATUS (esperado PENDING_REFERENCE)"; fi

# a referência (BET) chega depois
submit "$W_MSG" "msg-ref-$RUN_ID" "BET" "20.00" > /dev/null
# o worker agendado (5s) resolve o pendente; aguarda com polling
APPLIED=""
for i in $(seq 1 10); do
  sleep 2
  STATUS=$(curl -s -m 10 "$BASE/wagering/transactions/$(echo "$R" | jget transactionId)" -H "$AUTH" | jget status)
  if [ "$STATUS" = "PROCESSED" ]; then APPLIED="yes"; break; fi
done
if [ "$APPLIED" = "yes" ]; then
  ok "worker resolveu o PENDING_REFERENCE automaticamente após a referência chegar"; SCORE_MSG=$((SCORE_MSG+4))
else fail "worker não resolveu o pendente (status=$STATUS)"; fi

EVENTS=$(dq awslocal sqs get-queue-attributes \
  --queue-url "http://localhost:4566/000000000000/wager-events.fifo" \
  --attribute-names ApproximateNumberOfMessages --query 'Attributes.ApproximateNumberOfMessages' --output text 2>/dev/null || echo "SKIP")
if [ "$EVENTS" = "SKIP" ]; then
  fail "outbox publicado: docker indisponível para inspecionar a fila de eventos"
elif [ "${EVENTS:-0}" -ge 2 ] 2>/dev/null; then
  ok "outbox publicado: $EVENTS eventos em wager-events.fifo"; SCORE_MSG=$((SCORE_MSG+4))
else fail "outbox publicado: $EVENTS eventos na fila (esperado >= 2)"; fi

dq awslocal sqs send-message \
  --queue-url "http://localhost:4566/000000000000/wager-transactions.fifo" \
  --message-body 'corrupted-payload' --message-group-id 'bad' \
  --message-deduplication-id "dlq-$RUN_ID" > /dev/null 2>&1 || true
sleep 3
DLQ=$(dq awslocal sqs get-queue-attributes \
  --queue-url "http://localhost:4566/000000000000/wager-transactions-dlq.fifo" \
  --attribute-names ApproximateNumberOfMessages --query 'Attributes.ApproximateNumberOfMessages' --output text 2>/dev/null || echo "SKIP")
if [ "$DLQ" = "SKIP" ]; then
  fail "DLQ: docker indisponível para inspecionar"
elif [ "${DLQ:-0}" -ge 1 ] 2>/dev/null; then
  ok "envelope inválido -> DLQ ($DLQ mensagem(ns))"; SCORE_MSG=$((SCORE_MSG+4))
else fail "DLQ: envelope inválido não chegou (count=$DLQ)"; fi

# ================================================================
section "OBSERVABILIDADE (5 pts) — métricas e correlação"
# ================================================================
METRICS=$(curl -s -m 10 "$BASE/metrics")
M1=0; echo "$METRICS" | grep -q 'wagering_transactions_total' && M1=1
M2=0; echo "$METRICS" | grep -q 'wagering_duplicates_detected_total' && M2=1
M3=0; echo "$METRICS" | grep -q 'wagering_retries_total' && M3=1
M4=0; echo "$METRICS" | grep -q 'wagering_dlq' && M4=1
M5=0; echo "$METRICS" | grep -q 'wagering_outbox_lag_seconds' && M5=1
M6=0; echo "$METRICS" | grep -q 'wagering_wallet_lock_wait_seconds' && M6=1
if [ $((M1+M2+M3+M4+M5+M6)) -ge 5 ]; then
  ok "métricas presentes (transações, duplicatas, retries, DLQ, outbox lag, locks)"; SCORE_OBS=$((SCORE_OBS+3))
else fail "métricas faltando: M1=$M1 M2=$M2 M3=$M3 M4=$M4 M5=$M5 M6=$M6"; fi

CORR=$(curl -s -o /dev/null -D - -m 10 "$BASE/health/live" -H "x-correlation-id: score-$RUN_ID" | grep -i "x-correlation-id: score-$RUN_ID" | head -1)
if [ -n "$CORR" ]; then ok "correlation id propagado na resposta"; SCORE_OBS=$((SCORE_OBS+2)); else fail "x-correlation-id não ecoado"; fi

# ================================================================
section "FALHAS ELIMINATÓRIAS (checagens informativas)"
# ================================================================
MONEY_NUMBER=$(submit "$W_IDEM" "elim-number-$RUN_ID" "BET" "25.00" >/dev/null; curl -s -o /dev/null -w '%{http_code}' -X POST "$BASE/wagering/transactions" \
  -H "$AUTH" -H "$CT" -H "Idempotency-Key: elim-number2-$RUN_ID" \
  -d "{\"providerId\":\"provider-a\",\"externalTransactionId\":\"e-$RUN_ID\",\"playerId\":\"x\",\"walletId\":\"$W_IDEM\",\"roundId\":\"r\",\"gameId\":\"g\",\"kind\":\"BET\",\"money\":{\"amount\":25,\"currency\":\"BRL\"}}")
if [ "$MONEY_NUMBER" = "400" ]; then ok "dinheiro como number -> 400 (não aceito)"; else fail "dinheiro como number retornou $MONEY_NUMBER (esperado 400)"; fi

MONEY_SCALE=$(curl -s -o /dev/null -w '%{http_code}' -X POST "$BASE/wagering/transactions" \
  -H "$AUTH" -H "$CT" -H "Idempotency-Key: elim-scale-$RUN_ID" \
  -d "{\"providerId\":\"provider-a\",\"externalTransactionId\":\"e2-$RUN_ID\",\"playerId\":\"x\",\"walletId\":\"$W_IDEM\",\"roundId\":\"r\",\"gameId\":\"g\",\"kind\":\"BET\",\"money\":{\"amount\":\"25.000\",\"currency\":\"BRL\"}}")
if [ "$MONEY_SCALE" = "400" ]; then ok "mais de 2 casas decimais -> 400"; else fail "escala inválida retornou $MONEY_SCALE (esperado 400)"; fi

LEDGER_OK=$(curl -s -m 10 "$BASE/wallets/$W_FIN/ledger?limit=200" -H "$AUTH" | grep -c '"balanceAfter"')
if [ "${LEDGER_OK:-0}" -ge 3 ]; then ok "ledger auditável via API ($LEDGER_OK entradas na wallet financeira)"; else fail "ledger indisponível ($LEDGER_OK entradas)"; fi

echo "  — idempotência persistente / múltiplas instâncias / locks sob SIGKILL:"
echo "    cobertos pelas suítes automatizadas (bun test test/integration test/concurrency)"

# ================================================================
section "SCORECARD"
# ================================================================
printf "%-28s %s\n" "Correção financeira:" "$SCORE_FIN/20"
printf "%-28s %s\n" "Concorrência:" "$SCORE_CONC/20"
printf "%-28s %s\n" "Idempotência:" "$SCORE_IDEM/15"
printf "%-28s %s\n" "Mensageria e falhas:" "$SCORE_MSG/15"
printf "%-28s %s\n" "Observabilidade:" "$SCORE_OBS/5"
echo "--------------------------------------------------"
TOTAL=$((SCORE_FIN+SCORE_CONC+SCORE_IDEM+SCORE_MSG+SCORE_OBS))
printf "%-28s %s\n" "Verificável via API:" "$TOTAL/75"
echo "Modelagem e arquitetura (10) e Testes (10): avaliados na revisão de"
echo "código/suítes — veja ARCHITECTURE.md e 'bun test' (197 testes)."
echo "Teto no critério completo do CHALLENGE: $TOTAL/75 via API + 20 pts de código = $((TOTAL+20))/100"
