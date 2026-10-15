#!/usr/bin/env bash
# SPDX-License-Identifier: GPL-3.0-only
# Usage: world-backup.sh [name]   (default: baseline). Stops the server briefly so the copy is consistent.
# Backs up the world(s) and all plugin data/config files under plugins/ (every non-.jar file: balances, listings,
# vaults, configs). Plugin jars are not copied.
source "$(dirname "$0")/../scripts/lib.sh"
name="${1:-baseline}"
[[ "$name" =~ ^[A-Za-z0-9._-]+$ ]] || { echo "bad backup name" >&2; exit 1; }
was_running=0; server_running && was_running=1
(( was_running )) && "$ROOT/tests/server-stop.sh"
[[ -d "$SERVER_DIR/world" ]] || { echo "no world to back up (start the server once first)" >&2; exit 1; }
rm -rf "$SERVER_DIR/backups/$name"; mkdir -p "$SERVER_DIR/backups/$name"
cp -a "$SERVER_DIR"/world* "$SERVER_DIR/backups/$name/"
if [[ -d "$SERVER_DIR/plugins" ]]; then
  ( cd "$SERVER_DIR" && find plugins -type f ! -name '*.jar' -print0 | xargs -0 -r cp -a --parents -t "backups/$name/" )
  echo "plugin data: $(find "$SERVER_DIR/backups/$name/plugins" -type f 2>/dev/null | wc -l) files"
fi
echo "backup '$name' written to $SERVER_DIR/backups/$name"
(( was_running )) && "$ROOT/tests/server-start.sh"
exit 0
