// SPDX-License-Identifier: GPL-3.0-only
// Part of autism-mcp-bridge, an addon for AUTISM Client (https://github.com/codedsword/autism-mcp). GPL-3.0.
package io.github.codedsword.autismmcp;

import autismclient.modules.Module;
import com.google.gson.JsonObject;
import net.minecraft.client.KeyMapping;
import net.minecraft.client.gui.screens.TitleScreen;
import net.minecraft.client.gui.screens.ConnectScreen;
import net.minecraft.client.multiplayer.ServerData;
import net.minecraft.client.multiplayer.resolver.ServerAddress;
import net.minecraft.client.player.LocalPlayer;
import net.minecraft.core.BlockPos;
import net.minecraft.core.Direction;
import net.minecraft.network.chat.Component;
import net.minecraft.network.protocol.game.ServerboundPlayerActionPacket;
import net.minecraft.world.InteractionHand;
import net.minecraft.world.entity.Entity;
import net.minecraft.world.inventory.ContainerInput;
import net.minecraft.world.phys.BlockHitResult;
import net.minecraft.world.phys.EntityHitResult;
import net.minecraft.world.phys.Vec3;

import java.util.EnumMap;
import java.util.Locale;
import java.util.Map;

/** Actions. Every op runs on the client thread (dispatched from the tick listener). */
public final class Act {
    private static final int MAX_INPUT_TICKS = 200;
    private final Bridge b;
    private final Map<Key, Integer> holds = new EnumMap<>(Key.class);

    private enum Key { FORWARD, BACK, LEFT, RIGHT, JUMP, SNEAK, SPRINT }

    Act(Bridge b) {
        this.b = b;
    }

    void register(Map<String, Bridge.Op> ops) {
        ops.put("connect", this::connect);
        ops.put("disconnect", a -> { disconnect(); return ok(); });
        ops.put("chat", this::chat);
        ops.put("command", this::command);
        ops.put("set_input", this::setInput);
        ops.put("look", this::look);
        ops.put("use_item", this::useItem);
        ops.put("attack", this::attack);
        ops.put("interact_block", this::interactBlock);
        ops.put("interact_entity", this::interactEntity);
        ops.put("click_slot", this::clickSlot);
        ops.put("close_screen", a -> { b.observe.need().closeContainer(); return ok(); });
        ops.put("drop", a -> {
            LocalPlayer p = b.observe.need();
            return flag("dropped", p.drop(Bridge.bool(a, "all", false)));
        });
        ops.put("swap_hands", a -> {
            b.observe.need();
            b.mc.getConnection().send(new ServerboundPlayerActionPacket(
                ServerboundPlayerActionPacket.Action.SWAP_ITEM_WITH_OFFHAND, BlockPos.ZERO, Direction.DOWN));
            return ok();
        });
        ops.put("select_slot", a -> {
            int s = Bridge.integer(a, "slot", null);
            if (s < 0 || s > 8) throw new BridgeError("invalid_argument", "slot must be 0..8");
            b.observe.need().getInventory().setSelectedSlot(s);
            return ok();
        });
        ops.put("set_module", this::setModule);
        ops.put("set_module_setting", this::setModuleSetting);
    }

    // ---- connection --------------------------------------------------------------------------

    private JsonObject connect(JsonObject a) throws BridgeError {
        String address = Bridge.str(a, "address", true);
        String host = Safety.hostOf(address);
        if (!b.allowedTargets.contains(host)) {
            throw new BridgeError("target_not_allowed", "Host '" + host + "' is not in allowed_targets " + b.allowedTargets + ".");
        }
        ServerData data = new ServerData("mcp-target", address, ServerData.Type.OTHER);
        ConnectScreen.startConnecting(new TitleScreen(), b.mc, ServerAddress.parseString(address), data, false, null);
        return ok();
    }

    private void disconnect() throws BridgeError {
        var conn = b.mc.getConnection();
        if (conn == null) throw new BridgeError("not_connected", "Not connected to a server.");
        conn.getConnection().disconnect(Component.literal("Disconnected by autism-mcp"));
    }

    /** Refuses any in-world action when the current server is not an allowed target. */
    void requireAllowedServer() throws BridgeError {
        var s = b.mc.getCurrentServer();
        if (s == null) return;
        String host = Safety.hostOf(s.ip);
        if (!b.allowedTargets.contains(host)) {
            throw new BridgeError("target_not_allowed", "Connected server '" + host + "' is not in allowed_targets.");
        }
    }

    // ---- chat --------------------------------------------------------------------------------

    private JsonObject chat(JsonObject a) throws BridgeError {
        b.observe.need();
        requireAllowedServer();
        String m = Bridge.str(a, "message", true);
        if (m.length() > 256) throw new BridgeError("invalid_argument", "message exceeds 256 characters.");
        if (m.startsWith("/")) throw new BridgeError("invalid_argument", "Use the 'command' op for commands.");
        b.mc.getConnection().sendChat(m);
        return ok();
    }

    private JsonObject command(JsonObject a) throws BridgeError {
        b.observe.need();
        requireAllowedServer();
        String c = Bridge.str(a, "command", true);
        if (c.startsWith("/")) c = c.substring(1);
        if (c.isBlank() || c.length() > 256) throw new BridgeError("invalid_argument", "command must be 1..256 characters.");
        b.mc.getConnection().sendCommand(c);
        return ok();
    }

    // ---- input -------------------------------------------------------------------------------

    private JsonObject setInput(JsonObject a) throws BridgeError {
        b.observe.need();
        requireAllowedServer();
        String key = Bridge.str(a, "key", true).toUpperCase(Locale.ROOT);
        int ticks = Bridge.integer(a, "ticks", 1);
        if (ticks < 0 || ticks > MAX_INPUT_TICKS) throw new BridgeError("invalid_argument", "ticks must be 0.." + MAX_INPUT_TICKS);
        Key k;
        try {
            k = Key.valueOf(key);
        } catch (IllegalArgumentException e) {
            throw new BridgeError("invalid_argument", "key must be one of forward, back, left, right, jump, sneak, sprint.");
        }
        if (ticks == 0) {
            holds.remove(k);
            apply(k, false);
        } else {
            holds.put(k, ticks);
        }
        return ok();
    }

    private KeyMapping mapping(Key k) {
        var o = b.mc.options;
        return switch (k) {
            case FORWARD -> o.keyUp;
            case BACK -> o.keyDown;
            case LEFT -> o.keyLeft;
            case RIGHT -> o.keyRight;
            case JUMP -> o.keyJump;
            case SNEAK -> o.keyShift;
            case SPRINT -> o.keySprint;
        };
    }

    private void apply(Key k, boolean down) {
        mapping(k).setDown(down);
    }

    void onTick(long tick) {
        for (var it = holds.entrySet().iterator(); it.hasNext();) {
            var e = it.next();
            if (e.getValue() <= 0) {
                apply(e.getKey(), false);
                it.remove();
            } else {
                apply(e.getKey(), true);
                e.setValue(e.getValue() - 1);
            }
        }
    }

    void releaseInputs() {
        for (Key k : holds.keySet()) apply(k, false);
        holds.clear();
    }

    private JsonObject look(JsonObject a) throws BridgeError {
        LocalPlayer p = b.observe.need();
        if (a.has("target") && a.get("target").isJsonObject()) {
            JsonObject t = a.getAsJsonObject("target");
            Vec3 to = new Vec3(Bridge.number(t, "x", null), Bridge.number(t, "y", null), Bridge.number(t, "z", null));
            Vec3 from = p.getEyePosition();
            double dx = to.x - from.x, dy = to.y - from.y, dz = to.z - from.z;
            double h = Math.sqrt(dx * dx + dz * dz);
            p.setYRot((float) (Math.toDegrees(Math.atan2(dz, dx)) - 90.0));
            p.setXRot((float) -Math.toDegrees(Math.atan2(dy, h)));
        } else {
            double yaw = Bridge.number(a, "yaw", null);
            double pitch = Bridge.number(a, "pitch", null);
            if (pitch < -90 || pitch > 90) throw new BridgeError("invalid_argument", "pitch must be -90..90");
            p.setYRot((float) yaw);
            p.setXRot((float) pitch);
        }
        return ok();
    }

    // ---- interaction -------------------------------------------------------------------------

    private static InteractionHand hand(JsonObject a) {
        return "off".equalsIgnoreCase(a.has("hand") ? a.get("hand").getAsString() : "main")
            ? InteractionHand.OFF_HAND : InteractionHand.MAIN_HAND;
    }

    private JsonObject useItem(JsonObject a) throws BridgeError {
        LocalPlayer p = b.observe.need();
        requireAllowedServer();
        var r = b.mc.gameMode.useItem(p, hand(a));
        JsonObject o = new JsonObject();
        o.addProperty("result", String.valueOf(r));
        return o;
    }

    private Entity entity(JsonObject a) throws BridgeError {
        int id = Bridge.integer(a, "entity_id", null);
        Entity e = b.mc.level.getEntity(id);
        if (e == null) throw new BridgeError("not_found", "No entity with id " + id + " is loaded.");
        return e;
    }

    private JsonObject attack(JsonObject a) throws BridgeError {
        LocalPlayer p = b.observe.need();
        requireAllowedServer();
        Entity e = entity(a);
        b.mc.gameMode.attack(p, e);
        p.swing(InteractionHand.MAIN_HAND);
        return ok();
    }

    private JsonObject interactEntity(JsonObject a) throws BridgeError {
        LocalPlayer p = b.observe.need();
        requireAllowedServer();
        Entity e = entity(a);
        var r = b.mc.gameMode.interact(p, e, new EntityHitResult(e), hand(a));
        JsonObject o = new JsonObject();
        o.addProperty("result", String.valueOf(r));
        return o;
    }

    private JsonObject interactBlock(JsonObject a) throws BridgeError {
        LocalPlayer p = b.observe.need();
        requireAllowedServer();
        JsonObject pos = a.has("pos") && a.get("pos").isJsonObject() ? a.getAsJsonObject("pos") : null;
        if (pos == null) throw new BridgeError("invalid_argument", "'pos' must be {x,y,z}.");
        BlockPos bp = new BlockPos(Bridge.integer(pos, "x", null), Bridge.integer(pos, "y", null), Bridge.integer(pos, "z", null));
        Direction face;
        try {
            face = Direction.valueOf((Bridge.str(a, "face", false) == null ? "UP" : Bridge.str(a, "face", false)).toUpperCase(Locale.ROOT));
        } catch (IllegalArgumentException ex) {
            throw new BridgeError("invalid_argument", "face must be one of up, down, north, south, east, west.");
        }
        if (p.position().distanceTo(Vec3.atCenterOf(bp)) > 8.0) {
            throw new BridgeError("out_of_reach", "Block is more than 8 blocks from the player.");
        }
        Vec3 hit = Vec3.atCenterOf(bp).add(face.getStepX() * 0.5, face.getStepY() * 0.5, face.getStepZ() * 0.5);
        var r = b.mc.gameMode.useItemOn(p, hand(a), new BlockHitResult(hit, face, bp, false));
        JsonObject o = new JsonObject();
        o.addProperty("result", String.valueOf(r));
        return o;
    }

    private JsonObject clickSlot(JsonObject a) throws BridgeError {
        LocalPlayer p = b.observe.need();
        requireAllowedServer();
        int window = Bridge.integer(a, "window", p.containerMenu.containerId);
        int slot = Bridge.integer(a, "slot", null);
        int button = Bridge.integer(a, "button", 0);
        String mode = Bridge.str(a, "mode", false);
        ContainerInput ci;
        try {
            ci = ContainerInput.valueOf(mode == null ? "PICKUP" : mode.toUpperCase(Locale.ROOT));
        } catch (IllegalArgumentException e) {
            throw new BridgeError("invalid_argument", "mode must be PICKUP, QUICK_MOVE, SWAP, CLONE, THROW, QUICK_CRAFT or PICKUP_ALL.");
        }
        if (window != p.containerMenu.containerId) {
            throw new BridgeError("stale_window", "Window " + window + " is not open; current is " + p.containerMenu.containerId + ".");
        }
        if (slot < -999 || slot >= p.containerMenu.slots.size()) {
            throw new BridgeError("invalid_argument", "slot out of range (-999 or 0.." + (p.containerMenu.slots.size() - 1) + ").");
        }
        b.mc.gameMode.handleContainerInput(window, slot, button, ci, p);
        return ok();
    }

    // ---- modules -----------------------------------------------------------------------------

    private JsonObject setModule(JsonObject a) throws BridgeError {
        Module m = Observe.findModule(Bridge.str(a, "module", true));
        boolean enabled = Bridge.bool(a, "enabled", !m.isEnabled());
        m.setEnabled(enabled);
        JsonObject o = new JsonObject();
        o.addProperty("module", m.id());
        o.addProperty("enabled", m.isEnabled());
        return o;
    }

    @SuppressWarnings({"unchecked", "rawtypes"})
    private JsonObject setModuleSetting(JsonObject a) throws BridgeError {
        Module m = Observe.findModule(Bridge.str(a, "module", true));
        String sid = Bridge.str(a, "setting", true);
        for (var s : m.settings()) {
            if (!s.id().equalsIgnoreCase(sid)) continue;
            Object cur = s.get();
            var v = a.get("value");
            if (v == null || v.isJsonNull()) throw new BridgeError("invalid_argument", "Missing 'value'.");
            Object next;
            try {
                if (cur instanceof Boolean) next = v.getAsBoolean();
                else if (cur instanceof Integer) next = v.getAsInt();
                else if (cur instanceof Double) next = v.getAsDouble();
                else if (cur instanceof Float) next = v.getAsFloat();
                else if (cur instanceof String) next = v.getAsString();
                else if (cur instanceof Enum<?> en) next = Enum.valueOf((Class) en.getDeclaringClass(), v.getAsString());
                else throw new BridgeError("unsupported_setting", "Setting type " + (cur == null ? "null" : cur.getClass().getSimpleName()) + " cannot be set remotely.");
            } catch (IllegalArgumentException | UnsupportedOperationException | IllegalStateException e) {
                throw new BridgeError("invalid_argument", "Value does not fit setting type: " + e.getMessage());
            }
            ((autismclient.api.module.Setting) s).set(next);
            JsonObject o = new JsonObject();
            o.addProperty("setting", s.id());
            o.addProperty("value", Observe.clip(String.valueOf(s.get())));
            return o;
        }
        throw new BridgeError("not_found", "Module '" + m.id() + "' has no setting '" + sid + "'.");
    }

    // ---- helpers -----------------------------------------------------------------------------

    static JsonObject ok() {
        JsonObject o = new JsonObject();
        o.addProperty("done", true);
        return o;
    }

    static JsonObject flag(String name, boolean v) {
        JsonObject o = new JsonObject();
        o.addProperty(name, v);
        return o;
    }
}
