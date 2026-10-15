#!/usr/bin/env bash
# SPDX-License-Identifier: GPL-3.0-only
# Waits until the in-client bridge has written its port/token files (module 'MCP Bridge' enabled).
source "$(dirname "$0")/lib.sh"
dir="$(toml_get dir)"; dir="${dir/#\~/$HOME}"; dir="${dir:-$INSTANCE_MINECRAFT/autism-mcp}"
for _ in $(seq 1 "${1:-120}"); do
  [[ -s "$dir/port" && -s "$dir/token" ]] && { echo "bridge ready on port $(cat "$dir/port")"; exit 0; }
  sleep 1
done
echo "bridge files not found in $dir" >&2; exit 1
