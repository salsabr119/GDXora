#!/usr/bin/env bash
# Run all migrations + SQL tests against a throwaway local Postgres database.
#   PGHOST/PGPORT/PGUSER select the server (defaults: local socket, postgres).
set -euo pipefail
cd "$(dirname "$0")/.."
DB="${TEST_DB:-gdxora_test}"
PSQL=(psql -X -q -v ON_ERROR_STOP=1 --set=SHOW_CONTEXT=never)

"${PSQL[@]}" -d postgres -c "drop database if exists $DB" -c "create database $DB"
"${PSQL[@]}" -d "$DB" -f supabase/tests/00_supabase_shim.sql
for f in supabase/migrations/*.sql; do
  echo "migrate  $f"
  "${PSQL[@]}" -d "$DB" -o /dev/null -f "$f"
done
for f in supabase/tests/[1-9]*_test.sql; do
  echo "test     $f"
  "${PSQL[@]}" -d "$DB" -o /dev/null -f "$f"
done
echo "✓ all database tests passed"
