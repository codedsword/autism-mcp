// SPDX-License-Identifier: GPL-3.0-only
// Part of autism-mcp-bridge, an addon for AUTISM Client (https://github.com/codedsword/autism-mcp). GPL-3.0.
package io.github.codedsword.autismmcp;

import autismclient.api.ApiVersion;
import autismclient.api.SimpleAddon;
import autismclient.api.event.AddonEvents;
import autismclient.api.module.SimpleModule;

public final class BridgeAddon extends SimpleAddon {
    public static final String ID = "autism-mcp-bridge";
    static final Bridge BRIDGE = new Bridge();

    public BridgeAddon() {
        super(ApiVersion.CURRENT, "io.github.codedsword.autismmcp");
    }

    @Override
    protected void initialize() {
        SimpleModule module = new SimpleModule("mcp-bridge", "MCP Bridge",
            "Exposes a localhost-only, token-protected JSON/WebSocket bridge for the autism-mcp server (research use).")
            .addText("bridge_dir", "Bridge dir (empty = <game dir>/autism-mcp)", "")
            .onEnabled(self -> BRIDGE.start(self.getText("bridge_dir")))
            .onDisabled(self -> BRIDGE.stop());
        registerModule(module);

        AddonEvents.onTick(BRIDGE::onTick);
        AddonEvents.onPacketSend(BRIDGE::onPacketSend);
        AddonEvents.onPacketReceive(BRIDGE::onPacketReceive);
        AddonEvents.onGameJoin(BRIDGE::onGameJoin);
        AddonEvents.onGameLeft(BRIDGE::onGameLeft);
    }

    @Override
    public void onUnload() {
        BRIDGE.stop();
    }
}
