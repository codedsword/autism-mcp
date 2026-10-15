#!/usr/bin/env bash
# SPDX-License-Identifier: GPL-3.0-only
# End-to-end: build everything, wait for the in-client bridge, run the scripted experiment through
# the real MCP server. Assumes you already have your own local test server running on an address
# listed in config.toml's allowed_targets, and the client connected to it.
# The client itself has no headless mode and is launched by you from Prism (see README). Exit codes:
#   0 passed, 1 test failed, 3 client/bridge not available.
source "$(dirname "$0")/lib.sh"

"$ROOT/scripts/build-all.sh"
"$ROOT/scripts/install-addon.sh"

echo "Waiting up to ${BRIDGE_WAIT:-180}s for the client bridge. Launch the Prism instance now (scripts/run-client.sh),"
echo "enable the 'MCP Bridge' module if it is not enabled yet, and make sure the client is connected to your test server."
"$ROOT/scripts/bridge-wait.sh" "${BRIDGE_WAIT:-180}" || { echo "client bridge not available" >&2; exit 3; }

cd "$ROOT/mcp-server"
node e2e/e2e.mjs
