#!/usr/bin/env bash
# SPDX-License-Identifier: GPL-3.0-only
# Usage: world-restore.sh [name]   (default: baseline). Stops the server, restores the world, starts it again.
source "$(dirname "$0")/../scripts/lib.sh"
name="${1:-baseline}"
[[ "$name" =~ ^[A-Za-z0-9._-]+$ ]] || { echo "bad backup name" >&2; exit 1; }
[[ -d "$SERVER_DIR/backups/$name" ]] || { echo "no backup '$name' (run world-backup.sh first)" >&2; exit 1; }
"$ROOT/tests/server-stop.sh"
rm -rf "$SERVER_DIR"/world "$SERVER_DIR"/world_nether "$SERVER_DIR"/world_the_end
# plugin data: drop current non-jar files so state created after the backup does not survive (jars are kept)
if [[ -d "$SERVER_DIR/backups/$name/plugins" ]]; then
  find "$SERVER_DIR/plugins" -type f ! -name '*.jar' -delete
fi
cp -a "$SERVER_DIR/backups/$name/." "$SERVER_DIR/"
echo "restored backup '$name'"
"$ROOT/tests/server-start.sh"
