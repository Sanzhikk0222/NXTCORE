#!/usr/bin/env bash
# Прогоняет SQL из supabase/sql на локальном Postgres с имитацией Supabase.
# Нужен установленный PostgreSQL. Использование:
#   PGBIN=/usr/lib/postgresql/16/bin PGHOST=/путь/к/сокету PGPORT=54329 bash tests/run-sql.sh
set -euo pipefail
cd "$(dirname "$0")/.."

PSQL="${PGBIN:-/usr/lib/postgresql/16/bin}/psql -h ${PGHOST:-/var/run/postgresql} -p ${PGPORT:-5432} -v ON_ERROR_STOP=1 -q"
DB="${NXT_TEST_DB:-nxt}"
RUN="${NXT_PSQL_USER:+su ${NXT_PSQL_USER} -c}"

run() {
  if [ -n "$RUN" ]; then su "${NXT_PSQL_USER}" -c "$PSQL -d $1 ${2:-}"; else $PSQL -d "$1" ${2:-}; fi
}

run postgres "-c 'drop database if exists $DB' -c 'create database $DB'"
for f in tests/sql/00_mock_supabase.sql supabase/sql/0[1-7]_*.sql tests/sql/10_scenarios.sql; do
  echo "→ $f"
  run "$DB" "-f $PWD/$f" 2>&1 | grep -v -E '^psql:.*(NOTICE|WARNING|HINT)' || true
done
