#!/usr/bin/env bash
# SPDX-License-Identifier: GPL-3.0-only
# Shared helpers. Source this file; do not execute it.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CLIENT_DIR="${AUTISM_CLIENT_DIR:-$ROOT/../Autism-Client}"
SERVER_DIR="$ROOT/testserver"
LOG_DIR="$ROOT/logs"
MC_VERSION="26.2"
PRISM_INSTANCE="${PRISM_INSTANCE:-autism-mcp}"
PRISM_DATA="${PRISM_DATA:-$HOME/.var/app/org.prismlauncher.PrismLauncher/data/PrismLauncher}"
INSTANCE_MINECRAFT="$PRISM_DATA/instances/$PRISM_INSTANCE/minecraft"
TEST_PLAYER="${TEST_PLAYER:-McpTester}"
WORLD_SEED="${WORLD_SEED:-4242424242}"

mkdir -p "$LOG_DIR"

toml_get() { # toml_get key  (flat top-level or any-section key = value)
  sed -nE "s/^[[:space:]]*$1[[:space:]]*=[[:space:]]*\"?([^\"#]*)\"?.*/\1/p" "$ROOT/config.toml" | head -1 | tr -d '[:space:]'
}

server_running() {
  [[ -f "$SERVER_DIR/server.pid" ]] && kill -0 "$(cat "$SERVER_DIR/server.pid")" 2>/dev/null
}

console() { # send a console command to the running server
  printf '%s\n' "$1" > "$SERVER_DIR/console.fifo"
}
