#!/usr/bin/env bash
# Склеивает supabase/sql/01..07 в один файл supabase/all.sql: его можно целиком вставить в SQL Editor Supabase.
set -euo pipefail
cd "$(dirname "$0")/.."
node scripts/gen-words.mjs >/dev/null
out=supabase/all.sql
{
  echo "-- NXTCORE: полная схема базы (собрано scripts/build-sql.sh). Выполняйте один раз на чистом проекте."
  for f in supabase/sql/0[1-7]_*.sql; do
    echo; echo "-- ===== $(basename "$f") ====="; cat "$f"
  done
} > "$out"
echo "готово: $out ($(wc -l < "$out") строк)"
