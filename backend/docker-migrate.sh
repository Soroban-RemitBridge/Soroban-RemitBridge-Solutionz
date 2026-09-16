#!/bin/sh
#
# Apply the database schema, then exec the container's command.
#
# Two paths, and the choice is deliberate rather than a fallback that hides a
# problem:
#
#   * `prisma/migrations/` present → `prisma migrate deploy`. This is what a real
#     deployment uses. Migrations are reviewed files, applied in order, and
#     recorded — the only version of this that is safe on a database holding
#     financial records.
#
#   * No migrations directory → `prisma db push` with a loud warning. The
#     repository now ships one (`prisma/migrations/`, generated against Postgres
#     16 with `npm run prisma:migrate -- --name init`), so this path is for a
#     checkout where it has been removed or not yet generated. `db push` is fine
#     for local development and is a data-loss risk anywhere else, so it says so.
#
# `set -e` matters more than usual here: if the schema step fails, the API must
# not start. A service running against a schema it does not match is far worse
# than a service that is down and says why.

set -e

MIGRATIONS_DIR="prisma/migrations"

if [ -d "$MIGRATIONS_DIR" ] && [ -n "$(ls -A "$MIGRATIONS_DIR" 2>/dev/null)" ]; then
  echo "[migrate] applying migrations with 'prisma migrate deploy'"
  npx prisma migrate deploy
else
  echo "[migrate] ------------------------------------------------------------"
  echo "[migrate] WARNING: no $MIGRATIONS_DIR directory found."
  echo "[migrate] Using 'prisma db push', which can drop columns and lose data."
  echo "[migrate] Before deploying this anywhere real, generate a migration"
  echo "[migrate] history against a real database with:"
  echo "[migrate]     npm run prisma:migrate -- --name init"
  echo "[migrate] ------------------------------------------------------------"
  npx prisma db push --skip-generate
fi

exec "$@"
