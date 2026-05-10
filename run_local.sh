#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────
# Step 1: dump kmb.eta from EC2 and restore into local postgres
# Step 2: run the Spark analysis job locally via Docker
#
# Usage:
#   ./run_local.sh dump          # only dump + restore
#   ./run_local.sh spark         # only run spark (data already local)
#   ./run_local.sh               # both
#
# Set EC2_HOST before running, e.g.:
#   export EC2_HOST=ubuntu@<YOUR_EC2_IP>
#   export SSH_KEY=~/.ssh/my-key.pem
# ─────────────────────────────────────────────────────────────

set -euo pipefail

EC2_HOST="${EC2_HOST:-}"        # must be set: e.g. ubuntu@<EC2_IP>
SSH_KEY="${SSH_KEY:-}"          # e.g. export SSH_KEY=~/.ssh/my-key.pem
DUMP_FILE="/tmp/kmb_eta_dump.sql"

LOCAL_PG_PORT="5432"
LOCAL_PG_DB="hkbus"
LOCAL_PG_USER="postgres"
LOCAL_PG_PASS="postgres"

# --network host works on Linux; on macOS/Windows Docker Desktop it is a no-op
# so we use host.docker.internal there instead of 127.0.0.1
if [[ "$(uname -s)" == "Linux" ]]; then
  SPARK_NETWORK="--network host"
  LOCAL_PG_HOST="127.0.0.1"
else
  SPARK_NETWORK=""
  LOCAL_PG_HOST="host.docker.internal"
fi

SSH_OPTS="-o StrictHostKeyChecking=no -o ConnectTimeout=10"
[ -n "$SSH_KEY" ] && SSH_OPTS="$SSH_OPTS -i $SSH_KEY"

MODE="${1:-all}"

# ── STEP 1: dump from EC2 ────────────────────────────────────
if [[ "$MODE" == "dump" || "$MODE" == "all" ]]; then
  if [[ -z "$EC2_HOST" ]]; then
    echo "ERROR: EC2_HOST is not set. Export it first: export EC2_HOST=ubuntu@<EC2_IP>"
    exit 1
  fi

  echo "==> Dumping kmb.eta from EC2 ($EC2_HOST)..."
  ssh $SSH_OPTS "$EC2_HOST" \
    "docker exec hk-bus-postgres pg_dump -U postgres -d hkbus -t kmb.eta --data-only -F plain" \
    > "$DUMP_FILE"

  echo "==> Dump saved to $DUMP_FILE ($(wc -l < "$DUMP_FILE") lines)"

  echo "==> Starting local postgres (docker-compose.collector.yml)..."
  docker compose -f docker-compose.collector.yml up -d postgres
  sleep 3

  echo "==> Applying schema (idempotent)..."
  docker exec hk-bus-postgres psql -U postgres -d hkbus \
    -f /docker-entrypoint-initdb.d/init.sql 2>/dev/null || true

  echo "==> Restoring dump into local postgres..."
  docker exec -i hk-bus-postgres psql -U postgres -d hkbus < "$DUMP_FILE"

  echo "==> Row count in local kmb.eta:"
  docker exec hk-bus-postgres psql -U postgres -d hkbus \
    -c "SELECT COUNT(*) FROM kmb.eta;"
fi

# ── STEP 2: run Spark locally ────────────────────────────────
if [[ "$MODE" == "spark" || "$MODE" == "all" ]]; then
  echo "==> Building spark-jobs Docker image locally..."
  docker build -t hk-bus-spark:local spark-jobs/

  echo "==> Running KMB Spark analysis (local mode)..."
  docker run --rm \
    $SPARK_NETWORK \
    --memory=8g \
    -e JDBC_URL="jdbc:postgresql://${LOCAL_PG_HOST}:${LOCAL_PG_PORT}/${LOCAL_PG_DB}" \
    -e DB_USER="$LOCAL_PG_USER" \
    -e DB_PASSWORD="$LOCAL_PG_PASS" \
    hk-bus-spark:local

  echo "==> Checking result tables..."
  for tbl in kmb.spark_analytics kmb.spark_peak_hours kmb.spark_route_reliability; do
    echo -n "  $tbl: "
    docker exec hk-bus-postgres psql -U postgres -d hkbus \
      -c "SELECT COUNT(*) FROM $tbl;" -t 2>/dev/null | tr -d ' ' || echo "table missing"
  done

  echo "==> Done! Check output above for any errors."
fi
