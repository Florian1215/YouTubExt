#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
VENV_DIR="${SCRIPT_DIR}/.venv"
SERVER_PATH="${SCRIPT_DIR}/server/download_server.py"

if [ ! -d "${VENV_DIR}" ]; then
  echo "Virtual environment not found at ${VENV_DIR}." >&2
  echo "Create it with: python3 -m venv .venv" >&2
  exit 1
fi

if [ ! -f "${SERVER_PATH}" ]; then
  echo "Server script missing at ${SERVER_PATH}." >&2
  exit 1
fi

# shellcheck source=/dev/null
source "${VENV_DIR}/bin/activate"
exec python "${SERVER_PATH}" "$@"
