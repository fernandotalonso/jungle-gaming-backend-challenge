#!/usr/bin/env bash
# Sobe/para/verifica múltiplas instâncias da API para testes multi-instância.
#
# Uso:
#   bash scripts/instances.sh start [N]   # N instâncias nas portas 4000..4000+N-1 (default 3)
#   bash scripts/instances.sh stop        # para todas
#   bash scripts/instances.sh status      # health check em cada porta
#
# Cada instância roda 'bun run start:dev' com APP_PORT próprio — todas
# compartilham PostgreSQL/LocalStack e os workers SQS ficam ativos em todas
# (seguro por design: lock por wallet + inbox persistente + SKIP LOCKED).
# Para instâncias só-API (sem workers), exporte antes:
#   CONSUMER_ENABLED=false PUBLISHER_ENABLED=false
#
# Lembrete: pare as instâncias ('stop') antes de rodar 'bun test' — elas
# disputam as filas com as suítes de mensageria.

set -uo pipefail
CMD="${1:-status}"
N="${2:-3}"
RUNTIME_DIR="/tmp/jungle-instances"
mkdir -p "$RUNTIME_DIR"

instance_ports() {
  seq 4000 $((4000 + N - 1))
}

is_up() {
  curl -s -m 3 "http://localhost:$1/health/live" > /dev/null 2>&1
}

case "$CMD" in
  start)
    for PORT in $(instance_ports); do
      if is_up "$PORT"; then
        echo "instância $PORT: já rodando"
        continue
      fi
      APP_PORT="$PORT" nohup bun run start:dev > "/tmp/jungle-instance-$PORT.log" 2>&1 &
      echo "instância $PORT: iniciando (log em /tmp/jungle-instance-$PORT.log)"
    done
    sleep 8
    for PORT in $(instance_ports); do
      if is_up "$PORT"; then
        echo "instância $PORT: ✓ no ar"
      else
        echo "instância $PORT: ✗ não subiu — veja /tmp/jungle-instance-$PORT.log"
      fi
    done
    ;;

  stop)
    pkill -9 -f "bun --watch src/main.ts" 2>/dev/null
    pkill -9 -f "bun run start:dev" 2>/dev/null
    sleep 1
    echo "instâncias paradas"
    ;;

  status)
    for PORT in $(instance_ports); do
      if is_up "$PORT"; then
        READY=$(curl -s -m 3 "http://localhost:$PORT/health/ready" | head -c 60)
        echo "instância $PORT: ✓ no ar — $READY"
      else
        echo "instância $PORT: ✗ offline"
      fi
    done
    ;;

  *)
    echo "uso: bash scripts/instances.sh [start|stop|status] [N]"
    ;;
esac
