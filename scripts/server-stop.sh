#!/usr/bin/env bash
# SPDX-License-Identifier: GPL-3.0-only
source "$(dirname "$0")/lib.sh"
cd "$SERVER_DIR" 2>/dev/null || { echo "no testserver dir"; exit 0; }
if server_running; then
  pid="$(cat server.pid)"
  console stop || true
  for _ in $(seq 1 60); do kill -0 "$pid" 2>/dev/null || break; sleep 1; done
  if kill -0 "$pid" 2>/dev/null; then echo "graceful stop timed out, sending SIGTERM"; kill "$pid" || true; sleep 3; fi
  echo "server stopped"
else
  echo "server not running"
fi
[[ -f fifo-holder.pid ]] && { kill "$(cat fifo-holder.pid)" 2>/dev/null || true; rm -f fifo-holder.pid; }
rm -f server.pid console.fifo
