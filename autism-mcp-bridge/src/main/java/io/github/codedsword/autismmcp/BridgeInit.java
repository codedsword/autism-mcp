// SPDX-License-Identifier: GPL-3.0-only
// Part of autism-mcp-bridge, an addon for AUTISM Client (https://github.com/codedsword/autism-mcp). GPL-3.0.
package io.github.codedsword.autismmcp;

import net.fabricmc.api.ClientModInitializer;
import net.fabricmc.fabric.api.client.message.v1.ClientReceiveMessageEvents;

public final class BridgeInit implements ClientModInitializer {
    @Override
    public void onInitializeClient() {
        ClientReceiveMessageEvents.GAME.register((message, overlay) -> {
            if (!overlay) BridgeAddon.BRIDGE.observe.recordChat("system", message.getString(), null);
        });
        ClientReceiveMessageEvents.CHAT.register((message, signed, sender, params, ts) ->
            BridgeAddon.BRIDGE.observe.recordChat("chat", message.getString(), sender == null ? null : sender.name()));
    }
}
