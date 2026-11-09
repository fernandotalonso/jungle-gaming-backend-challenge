#!/usr/bin/env bash
# =============================================================================
# test-challenge.sh — testes manuais (curl) do Distributed Wagering Processor
#
# Cobre os critérios de pontuação: correção financeira, concorrência,
# idempotência, mensageria/falhas, modelagem, observabilidade.
#
# Requisitos: bash, curl, jq   (opcionais: aws cli, psql)
# Uso:        ./test-challenge.sh
#
# Variáveis (todas opcionais):
#   BASE          URL da API                    (default http://localhost:3000)
#   INSTANCES     várias instâncias, separadas por espaço; as requisições
#                 concorrentes são distribuídas entre elas
#                 ex.: "http://localhost:3000 http://localhost:3001 http://localhost:3002"
#   KC_URL        Keycloak                      (default http://localhost:8080)
#   REALM         realm                         (default jungle)
#   CLIENT_ID     client com "Direct access grants" habilitado (default jungle-api)
#   CLIENT_SECRET se o client for confidencial
#   KC_USER / KC_PASS   credenciais             (default jogardor1 / jogador1)
#   PROVIDER      providerId usado nos testes   (default provider-a)
#   WORKER_TIMEOUT segundos esperando o worker de PENDING_REFERENCE (default 60)
#   PSQL_CMD      habilita checagens direto no banco, ex.:
#                 PSQL_CMD="docker compose exec -T postgres psql -U postgres -d wagering"
#   ENABLE_SQS=1  habilita testes de fila (precisa de aws cli + LocalStack)
#   SQS_ENDPOINT  (default http://localhost:4566)  SQS_QUEUE / SQS_DLQ (nomes)
#
# Os caminhos e nomes de campos das respostas são os mais prováveis; se algum
# teste falhar por nome de campo/rota, ajuste os helpers no topo do script.
# =============================================================================
set -uo pipefail
export LC_ALL=C

BASE=${BASE:-http://localhost:3000}
# INSTANCES="http://localhost:4000 http://localhost:4001 http://localhost:4002"
read -r -a BASES <<<"${INSTANCES:-$BASE}"
KC_URL=${KC_URL:-http://localhost:8080}
REALM=${REALM:-jungle}
CLIENT_ID=${CLIENT_ID:-wagering-api}
CLIENT_SECRET=${CLIENT_SECRET:-local-dev-api-secret}
KC_USER=${KC_USER:-jogador1}
KC_PASS=${KC_PASS:-jogador1}
PROVIDER=${PROVIDER:-provider-a}
WORKER_TIMEOUT=${WORKER_TIMEOUT:-60}
PSQL_CMD=${PSQL_CMD:-}
ENABLE_SQS=${ENABLE_SQS:-0}
SQS_ENDPOINT=${SQS_ENDPOINT:-http://localhost:4566}
SQS_QUEUE=${SQS_QUEUE:-wager-transactions.fifo}
SQS_DLQ=${SQS_DLQ:-wager-transactions-dlq.fifo}

RUN=$(head -c4 /dev/urandom | od -An -tx1 | tr -d ' \n')   # sufixo único por execução
ROUND="round-$RUN"
PASS=0; FAIL=0; WARN=0
TMP=$(mktemp -d); trap 'rm -rf "$TMP"' EXIT
AUTH=1; TOKEN=""; CODE=""; BODY=""; W=""; P=""

for bin in curl jq; do
  command -v "$bin" >/dev/null || { echo "faltando: $bin"; exit 2; }
done

# ----------------------------------------------------------------------------- helpers
uuid()  { cat /proc/sys/kernel/random/uuid 2>/dev/null || uuidgen | tr 'A-Z' 'a-z'; }
ok()    { PASS=$((PASS+1)); printf '  \033[32m✔\033[0m %s\n' "$1"; }
bad()   { FAIL=$((FAIL+1)); printf '  \033[31m✘\033[0m %s\n' "$1"; [ -n "${2:-}" ] && printf '      %s\n' "$2"; }
warn()  { WARN=$((WARN+1)); printf '  \033[33m!\033[0m %s\n' "$1"; }
section() { printf '\n\033[1m== %s\033[0m\n' "$1"; }
norm()  { [ -z "${1:-}" ] && return 0; printf '%.2f' "$1" 2>/dev/null || echo "$1"; }
j()     { jq -r "$1" <<<"$BODY" 2>/dev/null; }

get_token() {
  local args=(-s -X POST "$KC_URL/realms/$REALM/protocol/openid-connect/token"
    -d grant_type=password -d "client_id=$CLIENT_ID"
    --data-urlencode "username=$KC_USER" --data-urlencode "password=$KC_PASS")
  [ -n "$CLIENT_SECRET" ] && args+=(-d "client_secret=$CLIENT_SECRET")
  local resp; resp=$(curl "${args[@]}")
  TOKEN=$(jq -r '.access_token // empty' <<<"$resp" 2>/dev/null)
  if [ -z "$TOKEN" ]; then
    echo "Falha ao obter token no Keycloak ($KC_URL/realms/$REALM). Resposta:"; echo "$resp"
    echo "Confira CLIENT_ID (client com Direct Access Grants), KC_USER e KC_PASS."; exit 2
  fi
}

# req METHOD PATH [BODY] [headers...]  -> preenche CODE e BODY
req() {
  local method=$1 path=$2 body=${3-}
  shift 2; [ $# -gt 0 ] && shift
  local args=(-s -o "$TMP/body" -w '%{http_code}' -X "$method" "${BASES[0]}$path")
  [ "$AUTH" = 1 ] && args+=(-H "Authorization: Bearer $TOKEN")
  [ -n "$body" ] && args+=(-H 'Content-Type: application/json' -d "$body")
  local h; for h in "$@"; do args+=(-H "$h"); done
  CODE=$(curl "${args[@]}"); BODY=$(cat "$TMP/body")
}

expect_code() { # nome codigo...
  local name=$1; shift; local c
  for c in "$@"; do [ "$CODE" = "$c" ] && { ok "$name (HTTP $CODE)"; return; }; done
  bad "$name" "esperado HTTP [$*], recebido $CODE, corpo: ${BODY:0:300}"
}
expect_eq() { [ "$2" = "$3" ] && ok "$1" || bad "$1" "esperado '$3', recebido '$2'"; }
expect_field() { # nome jq-expr esperado
  local v; v=$(j "$2")
  if [ -z "$v" ] || [ "$v" = null ]; then warn "$1: campo não encontrado ($2) — confira o nome do campo"
  else expect_eq "$1" "$v" "$3"; fi
}

bal() { req GET "/wallets/$1"; norm "$(j '(.balance.amount // .balance // .money.amount // empty)|tostring')"; }
body_bal() { norm "$(j '(.balanceAfter.amount // .balanceAfter // .wallet.balance.amount // .balance.amount // .balance // empty)|tostring')"; }
ledger_len() { req GET "/wallets/$1/ledger?limit=200"; j '(.items // .entries // .data // .)|length'; }

new_wallet() { # saldo [moeda]
  P=$(uuid)
  req POST /wallets "{\"playerId\":\"$P\",\"initialBalance\":{\"amount\":\"$1\",\"currency\":\"${2:-BRL}\"}}"
  W=$(j .id)
}

txbody() { # ext kind amount [ref] [currency]
  local r=""; [ -n "${4:-}" ] && r=",\"referenceExternalTransactionId\":\"$RUN-$4\""
  printf '{"providerId":"%s","externalTransactionId":"%s-%s","playerId":"%s","walletId":"%s","roundId":"%s","gameId":"fortune-chimp","kind":"%s","money":{"amount":"%s","currency":"%s"}%s}' \
    "$PROVIDER" "$RUN" "$1" "$P" "$W" "$ROUND" "$2" "$3" "${5:-BRL}" "$r"
}
# tx ext kind amount [ref] [currency] — ids ganham o prefixo $RUN; key = provider:RUN-ext
tx() { req POST /wagering/transactions "$(txbody "$1" "$2" "$3" "${4:-}" "${5:-BRL}")" "Idempotency-Key: $PROVIDER:$RUN-$1"; }
get_tx() { req GET "/providers/$PROVIDER/wagering/transactions/$RUN-$1"; }

# fire MODE(same|distinct) N TAG KIND AMOUNT [REF] — N requisições em paralelo
fire() {
  local mode=$1 n=$2 tag=$3 kind=$4 amt=$5 ref=${6:-} i ext url
  rm -f "$TMP/$tag".*
  for i in $(seq 1 "$n"); do
    ext=$tag; [ "$mode" = distinct ] && ext="$tag-$i"
    url=${BASES[$((i % ${#BASES[@]}))]}
    curl -s -o "$TMP/$tag.$i.body" -w '%{http_code}\n' -X POST "$url/wagering/transactions" \
      -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
      -H "Idempotency-Key: $PROVIDER:$RUN-$ext" \
      -d "$(txbody "$ext" "$kind" "$amt" "$ref")" >"$TMP/$tag.$i.code" &
  done
  wait
}
count_status() { local f n=0; for f in "$TMP/$1".*.body; do [ "$(jq -r '.status // empty' "$f" 2>/dev/null)" = "$2" ] && n=$((n+1)); done; echo $n; }
count_5xx() { cat "$TMP/$1".*.code 2>/dev/null | grep -c '^5'; }

poll_status() { # nome esperado
  local i s; for ((i=0; i<WORKER_TIMEOUT; i+=2)); do
    get_tx "$1"; s=$(j .status); [ "$s" = "$2" ] && return 0; sleep 2
  done; return 1
}
sql() { [ -n "$PSQL_CMD" ] && $PSQL_CMD -Atc "$1" 2>&1; }

# ----------------------------------------------------------------------------- 0. pré-requisitos
section "0. Pré-requisitos"
curl -s -o /dev/null "${BASES[0]}/health/live" || { echo "API fora do ar em ${BASES[0]}"; exit 2; }
get_token; ok "token obtido no Keycloak (realm $REALM, usuário $KC_USER)"
echo "  run=$RUN  instâncias=${#BASES[@]}"

# ----------------------------------------------------------------------------- 1. autenticação
section "1. Autenticação / saúde"
AUTH=0
req POST /wallets '{}';                         expect_code "POST /wallets sem token" 401 403
AUTH=0; TOKEN_BKP=$TOKEN; TOKEN="lixo.invalido.token"; AUTH=1
req POST /wallets '{}';                         expect_code "POST /wallets com token inválido" 401 403
TOKEN=$TOKEN_BKP
AUTH=0
req GET /health/live;                           expect_code "GET /health/live (público)" 200
req GET /health/ready;                          expect_code "GET /health/ready (público)" 200
AUTH=1

# ----------------------------------------------------------------------------- 2. wallets / Money
section "2. Wallets e validação de Money"
new_wallet "100.00"; expect_code "criar wallet 100.00 BRL" 200 201
WA=$W; PA=$P
expect_field "saldo inicial" '(.balance.amount // .balance)|tostring' "100.00"
expect_field "version inicial = 1" '.version|tostring' "1"
req POST /wallets "{\"playerId\":\"$PA\",\"initialBalance\":{\"amount\":\"100.00\",\"currency\":\"BRL\"}}"
expect_code "wallet duplicada (player+moeda)" 409
req GET "/wallets/$(uuid)";                     expect_code "wallet inexistente" 404
for amt in "10.001" "-5.00" "abc" "1e3" "" "10,50" "0x10"; do
  req POST /wallets "{\"playerId\":\"$(uuid)\",\"initialBalance\":{\"amount\":\"$amt\",\"currency\":\"BRL\"}}"
  expect_code "Money inválido amount='$amt'" 400 422
done
req POST /wallets "{\"playerId\":\"$(uuid)\",\"initialBalance\":{\"amount\":10.5,\"currency\":\"BRL\"}}"
expect_code "Money como number JSON (deve rejeitar)" 400 422
req POST /wallets "{\"playerId\":\"$(uuid)\",\"initialBalance\":{\"amount\":\"10.00\",\"currency\":\"brl\"}}"
expect_code "moeda inválida (minúscula)" 400 422

# ----------------------------------------------------------------------------- 3. idempotência
section "3. Idempotência"
W=$WA; P=$PA
tx bet-1 BET 25.00;                             expect_code "BET 25.00" 200 201
expect_field "status PROCESSED" .status PROCESSED
expect_eq "saldo 75.00" "$(bal "$WA")" "75.00"
tx bet-1 BET 25.00;                             expect_code "replay idêntico" 200 201
expect_field "replay: status PROCESSED" .status PROCESSED
expect_field "replay: idempotentReplay=true" '.idempotentReplay|tostring' true
expect_eq "replay não debita de novo" "$(bal "$WA")" "75.00"
tx bet-1 BET 30.00;                             expect_code "mesma key + payload diferente = conflito" 409 422
req POST /wagering/transactions "$(txbody nokey BET 1.00)"
expect_code "sem Idempotency-Key" 400
tx open-1 OPENING 10.00;                        expect_code "kind OPENING proibido" 400 422
req POST /wagering/transactions "$(txbody x1 BET 0.00)" "Idempotency-Key: $PROVIDER:$RUN-x1"
expect_code "amount 0.00" 400 422
req POST /wagering/transactions "$(txbody x2 BET -1.00)" "Idempotency-Key: $PROVIDER:$RUN-x2"
expect_code "amount negativo" 400 422
req POST /wagering/transactions "$(txbody x3 FOO 1.00)" "Idempotency-Key: $PROVIDER:$RUN-x3"
expect_code "kind inválido" 400 422
req POST /wagering/transactions '{"providerId":"x"}' "Idempotency-Key: k-$RUN"
expect_code "payload incompleto" 400 422
tx bet-usd BET 5.00 "" USD
if [ "$CODE" = 400 ] || [ "$CODE" = 422 ] || [ "$(j .status)" = REJECTED ]; then ok "moeda diferente da wallet rejeitada (HTTP $CODE)"
else bad "moeda diferente da wallet" "HTTP $CODE: ${BODY:0:200}"; fi
expect_eq "saldo intacto após rejeições" "$(bal "$WA")" "75.00"

# ----------------------------------------------------------------------------- 4. correção financeira
section "4. Correção financeira (regras de negócio)"
tx bet-big BET 999.00
expect_field "saldo insuficiente → REJECTED" .status REJECTED
CODE_INSUF=$(j .failureCode); echo "      failureCode(saldo insuficiente)=$CODE_INSUF"
expect_eq "saldo intacto" "$(bal "$WA")" "75.00"
tx win-1 WIN 10.00 bet-1;                       expect_code "WIN ref bet-1" 200 201
expect_eq "saldo 85.00 após WIN" "$(bal "$WA")" "85.00"
tx loss-1 LOSS 5.00 bet-1;                      expect_code "LOSS" 200 201
expect_eq "LOSS não altera saldo" "$(bal "$WA")" "85.00"
tx bet-2 BET 20.00
tx refund-1 REFUND 20.00 bet-2;                 expect_code "REFUND de bet-2" 200 201
expect_eq "saldo 85.00 após REFUND" "$(bal "$WA")" "85.00"
tx refund-2 REFUND 20.00 bet-2
expect_field "REFUND duplicado da mesma BET → REJECTED" .status REJECTED
tx bet-3 BET 10.00
tx refund-3 REFUND 5.00 bet-3
expect_field "REFUND com valor ≠ referência → REJECTED" .status REJECTED
tx refund-4 REFUND 10.00 win-1
expect_field "REFUND de WIN (só BET) → REJECTED" .status REJECTED
req POST /wagering/transactions "$(txbody refund-5 REFUND 10.00)" "Idempotency-Key: $PROVIDER:$RUN-refund-5"
expect_code "REFUND sem referência" 400 422
tx rollback-1 ROLLBACK 10.00 win-1;             expect_code "ROLLBACK de WIN" 200 201
expect_eq "saldo 65.00 após ROLLBACK de WIN" "$(bal "$WA")" "65.00"

# ROLLBACK de BET e de REFUND
new_wallet "100.00"; WB=$W
tx rb-bet BET 30.00; tx rb-bet-rb ROLLBACK 30.00 rb-bet
expect_eq "ROLLBACK de BET devolve o valor" "$(bal "$WB")" "100.00"
tx rf-bet BET 30.00; tx rf-ref REFUND 30.00 rf-bet; tx rf-ref-rb ROLLBACK 30.00 rf-ref
expect_eq "ROLLBACK de REFUND debita de novo" "$(bal "$WB")" "70.00"

# reversão que deixaria saldo negativo: código distinto de "saldo insuficiente"
new_wallet "100.00"; WN=$W
tx n-bet-a BET 50.00; tx n-win-a WIN 100.00 n-bet-a; tx n-bet-b BET 140.00
expect_eq "saldo 10.00 antes da reversão" "$(bal "$WN")" "10.00"
tx n-rb-win ROLLBACK 100.00 n-win-a
expect_field "ROLLBACK que negativaria o saldo → REJECTED" .status REJECTED
CODE_REV=$(j .failureCode); echo "      failureCode(reversão)=$CODE_REV"
[ -n "$CODE_REV" ] && [ "$CODE_REV" != "$CODE_INSUF" ] \
  && ok "failureCode da reversão difere do de saldo insuficiente" \
  || bad "failureCode da reversão deve diferir do de saldo insuficiente" "ambos='$CODE_REV'"
expect_eq "saldo não ficou negativo" "$(bal "$WN")" "10.00"

# referência de outro player/wallet
new_wallet "100.00"; WC=$W; PC=$P
tx c-bet BET 10.00
new_wallet "100.00"; WD=$W
tx d-refund REFUND 10.00 c-bet
st=$(j .status)
if [ "$st" = REJECTED ] || [ "$CODE" = 400 ] || [ "$CODE" = 422 ]; then ok "referência de outra wallet não é aceita ($st/$CODE)"
else bad "referência de outra wallet/player" "status=$st HTTP $CODE"; fi

# replay devolve o resultado ORIGINAL (saldo do momento), mesmo após outras operações
W=$WA; P=$PA
tx bet-1 BET 25.00
b=$(body_bal)
if [ -z "$b" ]; then warn "replay: campo de saldo não encontrado na resposta"
else expect_eq "replay de bet-1 devolve saldo original (75.00), não o atual" "$b" "75.00"; fi

# ----------------------------------------------------------------------------- 5. ledger / reconciliação
section "5. Ledger, paginação e reconciliação"
n=$(ledger_len "$WA")
[[ "$n" == 6 || "$n" == 7 ]] && ok "ledger da wallet A tem $n lançamentos (LOSS/REJECTED/replays não geram)" \
  || bad "tamanho do ledger" "esperado 6 (sem OPENING) ou 7, recebido $n"
req GET "/wallets/$WA/ledger?limit=2"
ids1=$(j '(.items // .entries // .data // .)|map(.id)|join(",")'); cur=$(j '(.nextCursor // .cursor // .pageInfo.endCursor // empty)')
if [ -z "$cur" ]; then warn "cursor de paginação não encontrado — confira o nome do campo"
else
  req GET "/wallets/$WA/ledger?limit=2&cursor=$cur"
  ids2=$(j '(.items // .entries // .data // .)|map(.id)|join(",")'); dup=0
  for id in ${ids2//,/ }; do [[ ",$ids1," == *",$id,"* ]] && dup=1; done
  [ -n "$ids2" ] && [ "$dup" = 0 ] && ok "paginação por cursor sem sobreposição" || bad "paginação por cursor" "p1=$ids1 p2=$ids2"
fi
req GET "/wallets/$WA/ledger?limit=2&cursor=cursor-invalido"; expect_code "cursor inválido" 400 422
req GET "/providers/$PROVIDER/wagering/transactions/$RUN-bet-1"; expect_code "consulta de transação por provider+externalId" 200
for w in "$WA" "$WB" "$WN"; do
  req POST "/wallets/$w/reconciliation"
  v=$(j '(.consistent // .isConsistent // .reconciled)|tostring')
  if [ "$v" = true ]; then ok "reconciliação consistente ($w)"
  elif [ "$v" = false ] || [ "$v" = null ] || [ -z "$v" ]; then bad "reconciliação ($w)" "HTTP $CODE: ${BODY:0:200}"; fi
done

# ----------------------------------------------------------------------------- 6. PENDING_REFERENCE
section "6. Referência fora de ordem (PENDING_REFERENCE + worker)"
new_wallet "100.00"; WP=$W
tx late-rb ROLLBACK 10.00 late-bet
expect_code "ROLLBACK antes da referência (aceito, pendente)" 200 202
expect_field "status PENDING_REFERENCE" .status PENDING_REFERENCE
expect_eq "saldo inalterado enquanto pendente" "$(bal "$WP")" "100.00"
tx late-bet BET 10.00
echo "      aguardando worker (até ${WORKER_TIMEOUT}s)..."
poll_status late-rb PROCESSED && ok "worker reprocessou: PENDING_REFERENCE → PROCESSED" || bad "worker não reprocessou a tempo"
expect_eq "saldo final 100.00 (bet + rollback)" "$(bal "$WP")" "100.00"

if [ "${TEST_TTL:-0}" = 1 ]; then
  tx orphan-rb ROLLBACK 10.00 nunca-chega
  echo "      aguardando expirar TTL/tentativas (até ${WORKER_TIMEOUT}s)..."
  poll_status orphan-rb REJECTED && ok "pendência sem referência expira em REJECTED" || bad "pendência não expirou (aumente WORKER_TIMEOUT ou reduza TTL no .env)"
else echo "  (opcional: TEST_TTL=1 testa expiração do PENDING_REFERENCE; exige TTL curto configurado)"; fi

# ----------------------------------------------------------------------------- 7. concorrência
section "7. Concorrência (${#BASES[@]} instância(s))"
get_token
# 7.1 cenário obrigatório: 100.00, duas apostas simultâneas de 80.00
new_wallet "100.00"; WR=$W
fire distinct 2 race BET 80.00
p=$(count_status race PROCESSED); r=$(count_status race REJECTED)
expect_eq "2×80.00: 1 PROCESSED" "$p" 1; expect_eq "2×80.00: 1 REJECTED" "$r" 1
expect_eq "2×80.00: saldo 20.00" "$(bal "$WR")" "20.00"
# 7.2 20 apostas de 10.00 sobre 100.00 → exatamente 10 aprovadas, saldo 0.00
new_wallet "100.00"; W20=$W
fire distinct 20 many BET 10.00
expect_eq "20×10.00: 10 PROCESSED" "$(count_status many PROCESSED)" 10
expect_eq "20×10.00: 10 REJECTED" "$(count_status many REJECTED)" 10
expect_eq "20×10.00: saldo 0.00 (nunca negativo)" "$(bal "$W20")" "0.00"
expect_eq "20×10.00: sem erros 5xx" "$(count_5xx many)" 0
# 7.3 mesma requisição 50× em paralelo → um único débito
new_wallet "1000.00"; W50=$W
fire same 50 dup BET 25.00
expect_eq "50× idêntica: sem 5xx" "$(count_5xx dup)" 0
expect_eq "50× idêntica: saldo 975.00 (um só débito)" "$(bal "$W50")" "975.00"
n=$(ledger_len "$W50"); [[ "$n" == 1 || "$n" == 2 ]] && ok "50× idêntica: um único lançamento de débito (ledger=$n)" || bad "50× idêntica: ledger" "tamanho=$n"
# 7.4 10 REFUNDs concorrentes da mesma BET → só 1 efetivo
new_wallet "100.00"; WF=$W
tx cr-bet BET 50.00
fire distinct 10 crefund REFUND 50.00 cr-bet
expect_eq "10 REFUNDs da mesma BET: 1 PROCESSED" "$(count_status crefund PROCESSED)" 1
expect_eq "10 REFUNDs da mesma BET: saldo 100.00" "$(bal "$WF")" "100.00"
# 7.5 wallets diferentes não bloqueiam entre si (sem lock global)
for k in 1 2 3 4 5; do new_wallet "50.00"; eval "WK$k=$W; PK$k=$P"; done
start=$(date +%s%N)
for k in 1 2 3 4 5; do
  eval "wk=\$WK$k; pk=\$PK$k"
  curl -s -o /dev/null -X POST "${BASES[0]}/wagering/transactions" -H "Authorization: Bearer $TOKEN" \
    -H 'Content-Type: application/json' -H "Idempotency-Key: $PROVIDER:$RUN-par-$k" \
    -d "{\"providerId\":\"$PROVIDER\",\"externalTransactionId\":\"$RUN-par-$k\",\"playerId\":\"$pk\",\"walletId\":\"$wk\",\"roundId\":\"$ROUND\",\"gameId\":\"g\",\"kind\":\"BET\",\"money\":{\"amount\":\"10.00\",\"currency\":\"BRL\"}}" &
done; wait
echo "      5 wallets em paralelo: $(( ($(date +%s%N) - start) / 1000000 )) ms"
for k in 1 2 3 4 5; do eval "wk=\$WK$k"; [ "$(bal "$wk")" = "40.00" ] || bad "wallet paralela $k com saldo errado"; done; ok "5 wallets em paralelo processadas corretamente"
for w in "$WR" "$W20" "$W50" "$WF"; do
  req POST "/wallets/$w/reconciliation"; v=$(j '(.consistent // .isConsistent // .reconciled)|tostring')
  [ "$v" = true ] && ok "reconciliação pós-concorrência ($w)" || bad "reconciliação pós-concorrência ($w)" "HTTP $CODE: ${BODY:0:200}"
done
[ ${#BASES[@]} -lt 3 ] && echo "  (dica: INSTANCES=\"http://localhost:3000 http://localhost:3001 http://localhost:3002\" repete tudo com 3 instâncias)"

# ----------------------------------------------------------------------------- 8. banco (opcional)
section "8. Invariantes no banco"
if [ -z "$PSQL_CMD" ]; then echo "  (pulado — defina PSQL_CMD para habilitar)"; else
  o=$(sql "SELECT count(*) FROM wallets w WHERE w.balance <> COALESCE((SELECT sum(CASE direction WHEN 'CREDIT' THEN amount ELSE -amount END) FROM wallet_ledger_entries l WHERE l.wallet_id=w.id),0)")
  expect_eq "saldo de toda wallet == soma do ledger" "$o" 0
  o=$(sql "SELECT count(*) FROM (SELECT balance_before, lag(balance_after) OVER (PARTITION BY wallet_id ORDER BY wallet_version) prev FROM wallet_ledger_entries) t WHERE prev IS NOT NULL AND prev <> balance_before")
  expect_eq "ledger encadeado (before[n] == after[n-1])" "$o" 0
  expect_eq "nenhum saldo negativo" "$(sql 'SELECT count(*) FROM wallets WHERE balance < 0')" 0
  o=$(sql "UPDATE wallet_ledger_entries SET amount = amount WHERE id = (SELECT id FROM wallet_ledger_entries LIMIT 1)")
  [[ "$o" == *append-only* || "$o" == *ERROR* ]] && ok "UPDATE no ledger bloqueado" || bad "UPDATE no ledger deveria falhar" "$o"
  o=$(sql "DELETE FROM wallet_ledger_entries WHERE id = (SELECT id FROM wallet_ledger_entries LIMIT 1)")
  [[ "$o" == *append-only* || "$o" == *ERROR* ]] && ok "DELETE no ledger bloqueado" || bad "DELETE no ledger deveria falhar" "$o"
  expect_eq "nenhuma transação com 2 lançamentos" "$(sql 'SELECT count(*) FROM (SELECT transaction_id FROM wallet_ledger_entries WHERE transaction_id IS NOT NULL GROUP BY 1 HAVING count(*)>1) t')" 0
  sleep 5
  o=$(sql "SELECT count(*) FROM outbox_messages WHERE published_at IS NULL AND created_at < now() - interval '30 seconds'")
  expect_eq "outbox sem eventos presos há >30s (publisher funcionando)" "$o" 0
  o=$(sql "SELECT count(*) FROM outbox_messages")
  [ "${o:-0}" -gt 0 ] && ok "outbox recebeu eventos ($o)" || bad "outbox vazia"
  expect_eq "sem eventos duplicados na outbox" "$(sql 'SELECT count(*) FROM (SELECT dedup_key FROM outbox_messages GROUP BY 1 HAVING count(*)>1) t')" 0
fi

# ----------------------------------------------------------------------------- 9. SQS (opcional)
section "9. Mensageria SQS"
if [ "$ENABLE_SQS" != 1 ] || ! command -v aws >/dev/null; then echo "  (pulado — ENABLE_SQS=1 e aws cli)"; else
  export AWS_ACCESS_KEY_ID=${AWS_ACCESS_KEY_ID:-test} AWS_SECRET_ACCESS_KEY=${AWS_SECRET_ACCESS_KEY:-test} AWS_DEFAULT_REGION=${AWS_DEFAULT_REGION:-us-east-1}
  sqs() { aws --endpoint-url "$SQS_ENDPOINT" sqs "$@"; }
  Q=$(sqs get-queue-url --queue-name "$SQS_QUEUE" --query QueueUrl --output text)
  D=$(sqs get-queue-url --queue-name "$SQS_DLQ" --query QueueUrl --output text)
  dlq_count() { sqs get-queue-attributes --queue-url "$D" --attribute-names ApproximateNumberOfMessages --query Attributes.ApproximateNumberOfMessages --output text; }
  new_wallet "100.00"; WS=$W; PS=$P
  # ATENÇÃO: ajuste o envelope abaixo ao formato real das suas mensagens
  msg() { printf '{"messageId":"%s","type":"WagerTransactionRequested","occurredAt":"%s","data":{"providerId":"%s","externalTransactionId":"%s-%s","idempotencyKey":"%s:%s-%s","playerId":"%s","walletId":"%s","roundId":"%s","gameId":"g","kind":"%s","money":{"amount":"%s","currency":"BRL"}}}' \
    "$1" "$(date -u +%FT%T.000Z)" "$PROVIDER" "$RUN" "$2" "$PROVIDER" "$RUN" "$2" "$PS" "$WS" "$ROUND" "$3" "$4"; }
  # redelivery: mesmo messageId 3×, com dedup-ids distintos
  for i in 1 2 3; do sqs send-message --queue-url "$Q" --message-group-id "$WS" --message-deduplication-id "d-$RUN-$i" \
    --message-body "$(msg "msg-$RUN-1" sqs-bet-1 BET 5.00)" >/dev/null; done
  P=$PS; W=$WS
  poll_status sqs-bet-1 PROCESSED && ok "mensagem consumida e processada" || bad "mensagem SQS não processada"
  sleep 3
  expect_eq "redelivery ×3: um único débito (95.00)" "$(bal "$WS")" "95.00"
  # erro de negócio (saldo insuficiente): mensagem confirmada, NÃO vai para DLQ
  before=$(dlq_count)
  sqs send-message --queue-url "$Q" --message-group-id "$WS" --message-deduplication-id "d-$RUN-big" \
    --message-body "$(msg "msg-$RUN-2" sqs-bet-big BET 9999.00)" >/dev/null
  poll_status sqs-bet-big REJECTED && ok "erro de negócio: REJECTED" || bad "erro de negócio não tratado"
  sleep 3; expect_eq "erro de negócio não foi para a DLQ" "$(dlq_count)" "$before"
  # mensagem venenosa → DLQ
  sqs send-message --queue-url "$Q" --message-group-id poison --message-deduplication-id "d-$RUN-poison" --message-body '{lixo' >/dev/null
  echo "      aguardando DLQ (até ${WORKER_TIMEOUT}s)..."
  for ((i=0; i<WORKER_TIMEOUT; i+=3)); do [ "$(dlq_count)" -gt "$before" ] && break; sleep 3; done
  [ "$(dlq_count)" -gt "$before" ] && ok "mensagem inválida foi para a DLQ" || bad "mensagem inválida não chegou na DLQ"
  # compatibilidade HTTP × SQS: mesma idempotência
  P=$PS; W=$WS; tx sqs-bet-1 BET 5.00
  expect_field "HTTP com a mesma key da fila devolve o resultado original" .status PROCESSED
  expect_eq "sem débito extra" "$(bal "$WS")" "95.00"
fi

# ----------------------------------------------------------------------------- 10. observabilidade
section "10. Observabilidade"
AUTH=0; req GET /metrics
[ "$CODE" = 200 ] && ok "GET /metrics responde" || warn "GET /metrics → HTTP $CODE (confira a rota de métricas)"
if [ "$CODE" = 200 ]; then
  for m in wager idempot outbox inbox; do
    grep -qi "$m" <<<"$BODY" && ok "métrica contendo '$m' presente" || warn "nenhuma métrica contendo '$m'"
  done
fi
AUTH=1

# ----------------------------------------------------------------------------- resumo
printf '\n\033[1m== Resumo\033[0m\n  \033[32m%d ok\033[0m   \033[31m%d falhas\033[0m   \033[33m%d avisos\033[0m\n' "$PASS" "$FAIL" "$WARN"
cat <<'EOF'

Verificações manuais (não automatizáveis aqui):
  • Crash entre commit e ack: mate (kill -9) o consumidor logo após processar e confira que não há débito duplicado.
  • Dois publishers da outbox ao mesmo tempo: sem eventos publicados em duplicidade.
  • SIGTERM: o serviço conclui as mensagens em andamento ou devolve a visibilidade.
  • Reinício do serviço no meio dos testes: rode o script de novo e rode as invariantes do bloco 8.
  • Logs: JSON estruturado com correlationId, providerId e externalTransactionId; sem dados sensíveis.
  • README.md e ARCHITECTURE.md completos (ORM, lock, hash, failureCode, TTL/tentativas).
EOF
[ "$FAIL" -eq 0 ]
