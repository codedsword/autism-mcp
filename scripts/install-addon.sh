#!/usr/bin/env bash
# SPDX-License-Identifier: GPL-3.0-only
# Copies the addon jar into the Prism instance's mods folder and syncs config.toml next to the bridge files.
source "$(dirname "$0")/lib.sh"
jar="$(ls -1t "$ROOT"/autism-mcp-bridge/build/libs/autism-mcp-bridge-*.jar | grep -v -- '-sources' | head -1)"
[[ -f "$jar" ]] || { echo "build the addon first (scripts/build-all.sh)" >&2; exit 1; }
[[ -d "$INSTANCE_MINECRAFT" ]] || { echo "Prism instance not found: $INSTANCE_MINECRAFT (set PRISM_INSTANCE / PRISM_DATA)" >&2; exit 1; }
mkdir -p "$INSTANCE_MINECRAFT/mods" "$INSTANCE_MINECRAFT/autism-mcp"
rm -f "$INSTANCE_MINECRAFT"/mods/autism-mcp-bridge-*.jar
cp "$jar" "$INSTANCE_MINECRAFT/mods/"
cp "$ROOT/config.toml" "$INSTANCE_MINECRAFT/autism-mcp/config.toml"
echo "installed $(basename "$jar") -> $INSTANCE_MINECRAFT/mods/"
echo "Next: launch the instance from Prism (offline throwaway account), then enable the 'MCP Bridge' module."
