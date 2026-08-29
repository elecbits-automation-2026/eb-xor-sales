#!/usr/bin/env bash
# Load .env if present, then start the server.
set -a
[ -f .env ] && . ./.env
set +a
exec python -m uvicorn app.main:app --host "${HOST:-0.0.0.0}" --port "${PORT:-8000}" "$@"
