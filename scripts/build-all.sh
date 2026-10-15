#!/usr/bin/env bash
# SPDX-License-Identifier: GPL-3.0-only
# Builds the client (and publishes its API to ~/.m2), the bridge addon, and the MCP server.
source "$(dirname "$0")/lib.sh"
echo "== client: publishToMavenLocal"
( cd "$CLIENT_DIR" && ./gradlew publishToMavenLocal --no-daemon -q )
echo "== client jar"
( cd "$CLIENT_DIR" && ./gradlew build --no-daemon -q ) || echo "(client 'build' failed or was skipped; the published API is enough for the addon)"
echo "== bridge addon"
( cd "$ROOT/autism-mcp-bridge" && ./gradlew build --no-daemon -q )
ls -1 "$ROOT"/autism-mcp-bridge/build/libs/*.jar
echo "== mcp-server"
( cd "$ROOT/mcp-server" && npm ci --no-audit --no-fund --silent && npm run --silent build )
echo "build-all OK"
