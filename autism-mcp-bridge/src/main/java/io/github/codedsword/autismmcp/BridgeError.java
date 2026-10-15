// SPDX-License-Identifier: GPL-3.0-only
// Part of autism-mcp-bridge, an addon for AUTISM Client (https://github.com/codedsword/autism-mcp). GPL-3.0.
package io.github.codedsword.autismmcp;

/** Structured error returned to the MCP server as {code, message}. */
public final class BridgeError extends Exception {
    public final String code;

    public BridgeError(String code, String message) {
        super(message);
        this.code = code;
    }
}
