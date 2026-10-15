// SPDX-License-Identifier: GPL-3.0-only
// Part of autism-mcp-bridge, an addon for AUTISM Client (https://github.com/codedsword/autism-mcp). GPL-3.0.
package io.github.codedsword.autismmcp;

import autismclient.modules.Module;
import autismclient.modules.ModuleRegistry;
import com.google.gson.JsonArray;
import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import net.minecraft.client.multiplayer.ClientLevel;
import net.minecraft.client.player.LocalPlayer;
import net.minecraft.core.BlockPos;
import net.minecraft.core.registries.BuiltInRegistries;
import net.minecraft.nbt.CompoundTag;
import net.minecraft.network.chat.Component;
import net.minecraft.world.effect.MobEffectInstance;
import net.minecraft.world.entity.Entity;
import net.minecraft.world.inventory.AbstractContainerMenu;
import net.minecraft.world.inventory.Slot;
import net.minecraft.world.item.ItemStack;
import net.minecraft.world.level.block.entity.BlockEntity;
import net.minecraft.world.level.block.state.BlockState;
import net.minecraft.world.phys.Vec3;

import java.util.ArrayDeque;
import java.util.ArrayList;
import java.util.List;
import java.util.Locale;
import java.util.Map;

/** Read-only requests, plus tick-driven event detection (screen, inventory, health). */
public final class Observe {
    static final int MAX_BLOCK_VOLUME = 4096;
    static final int MAX_ENTITIES = 200;
    static final int MAX_CHAT = 500;
    static final int MAX_STR = 300;

    /** Module ids/names containing any of these are never listed or changeable (login, hide/OpSec, spoofing). */
    static final List<String> MODULE_DENY = List.of("hide", "login", "account", "discord", "microsoft",
        "protect", "spoof", "stealth", "opsec", "privacy", "mcp-bridge", "anonym");

    private final Bridge b;
    private final ArrayDeque<JsonObject> chat = new ArrayDeque<>();
    private long chatSeq;
    private String lastScreen = "";
    private int lastInvHash;
    private float lastHealth = -1;

    Observe(Bridge b) {
        this.b = b;
    }

    void register(Map<String, Bridge.Op> ops) {
        ops.put("status", a -> status());
        ops.put("get_state", a -> state());
        ops.put("get_inventory", a -> inventory());
        ops.put("get_screen", a -> screen());
        ops.put("get_entities", this::entities);
        ops.put("get_blocks", this::blocks);
        ops.put("get_block", this::block);
        ops.put("get_chat", this::chatLog);
        ops.put("list_modules", a -> listModules());
        ops.put("get_module_settings", this::moduleSettings);
    }

    // ---- chat (fed by BridgeInit via Fabric events) -----------------------------------------

    void recordChat(String kind, String text, String sender) {
        JsonObject o = new JsonObject();
        o.addProperty("seq", ++chatSeq);
        o.addProperty("tick", b.tick());
        o.addProperty("kind", kind);
        o.addProperty("text", clip(text));
        if (sender != null) o.addProperty("sender", sender);
        synchronized (chat) {
            chat.addLast(o);
            while (chat.size() > MAX_CHAT) chat.removeFirst();
        }
        b.emit("chat", o);
    }

    private JsonElement chatLog(JsonObject a) throws BridgeError {
        long since = Bridge.integer(a, "since", 0);
        int limit = Math.min(Bridge.integer(a, "limit", 100), MAX_CHAT);
        JsonArray out = new JsonArray();
        synchronized (chat) {
            for (JsonObject o : chat) {
                if (o.get("seq").getAsLong() > since) out.add(o);
            }
        }
        while (out.size() > limit) out.remove(0);
        JsonObject r = new JsonObject();
        r.add("messages", out);
        return r;
    }

    // ---- state ------------------------------------------------------------------------------

    private JsonElement status() {
        JsonObject o = new JsonObject();
        o.addProperty("bridge", "autism-mcp-bridge");
        o.addProperty("minecraft_version", b.mc.getLaunchedVersion());
        o.addProperty("in_world", b.mc.level != null && b.mc.player != null);
        var server = b.mc.getCurrentServer();
        o.addProperty("server_address", server == null ? "" : server.ip);
        LocalPlayer p = b.mc.player;
        o.addProperty("player_name", p == null ? "" : p.getGameProfile().name());
        var conn = b.mc.getConnection();
        if (conn != null && p != null) {
            var info = conn.getPlayerInfo(p.getUUID());
            if (info != null) o.addProperty("ping_ms", info.getLatency());
        }
        o.addProperty("screen", b.mc.gui.screen() == null ? "" : b.mc.gui.screen().getClass().getSimpleName());
        o.addProperty("fps", b.mc.getFps());
        return o;
    }

    private JsonElement state() throws BridgeError {
        LocalPlayer p = need();
        JsonObject o = new JsonObject();
        o.add("position", vec(p.position()));
        o.addProperty("yaw", p.getYRot());
        o.addProperty("pitch", p.getXRot());
        o.add("velocity", vec(p.getDeltaMovement()));
        o.addProperty("health", p.getHealth());
        o.addProperty("hunger", p.getFoodData().getFoodLevel());
        o.addProperty("saturation", p.getFoodData().getSaturationLevel());
        o.addProperty("gamemode", String.valueOf(b.mc.gameMode == null ? null : b.mc.gameMode.getPlayerMode()));
        o.addProperty("dimension", String.valueOf(b.mc.level.dimension()));
        o.addProperty("on_ground", p.onGround());
        o.addProperty("held_slot", p.getInventory().getSelectedSlot());
        o.addProperty("xp_level", p.experienceLevel);
        JsonArray fx = new JsonArray();
        for (MobEffectInstance e : p.getActiveEffects()) {
            JsonObject eo = new JsonObject();
            eo.addProperty("effect", String.valueOf(e.getEffect()));
            eo.addProperty("amplifier", e.getAmplifier());
            eo.addProperty("duration", e.getDuration());
            fx.add(eo);
        }
        o.add("effects", fx);
        return o;
    }

    private JsonElement screen() {
        JsonObject o = new JsonObject();
        var s = b.mc.gui.screen();
        o.addProperty("open", s != null);
        if (s != null) {
            o.addProperty("class", s.getClass().getName());
            o.addProperty("title", s.getTitle().getString());
        }
        LocalPlayer p = b.mc.player;
        if (p != null) {
            o.addProperty("window_id", p.containerMenu.containerId);
            o.addProperty("menu", p.containerMenu.getClass().getSimpleName());
        }
        return o;
    }

    private JsonElement inventory() throws BridgeError {
        LocalPlayer p = need();
        AbstractContainerMenu menu = p.containerMenu;
        JsonObject o = new JsonObject();
        o.addProperty("window_id", menu.containerId);
        o.addProperty("state_id", menu.getStateId());
        o.addProperty("menu", menu.getClass().getSimpleName());
        o.add("carried", stack(menu.getCarried()));
        JsonArray slots = new JsonArray();
        for (Slot s : menu.slots) {
            ItemStack st = s.getItem();
            if (st.isEmpty()) continue;
            JsonObject so = stack(st);
            so.addProperty("slot", s.index);
            slots.add(so);
        }
        o.add("slots", slots);
        o.addProperty("slot_count", menu.slots.size());
        o.addProperty("selected_hotbar", p.getInventory().getSelectedSlot());
        return o;
    }

    static JsonObject stack(ItemStack st) {
        JsonObject o = new JsonObject();
        if (st.isEmpty()) {
            o.addProperty("item", "minecraft:air");
            o.addProperty("count", 0);
            return o;
        }
        o.addProperty("item", String.valueOf(BuiltInRegistries.ITEM.getKey(st.getItem())));
        o.addProperty("count", st.getCount());
        o.addProperty("name", clip(st.getHoverName().getString()));
        o.addProperty("components", clip(String.valueOf(st.getComponentsPatch())));
        return o;
    }

    private JsonElement entities(JsonObject a) throws BridgeError {
        LocalPlayer p = need();
        double r = Math.min(Bridge.number(a, "radius", 16.0), 128.0);
        String filter = Bridge.str(a, "filter", false);
        String f = filter == null ? null : filter.toLowerCase(Locale.ROOT);
        JsonArray out = new JsonArray();
        boolean truncated = false;
        List<Entity> found = b.mc.level.getEntities((Entity) null, p.getBoundingBox().inflate(r), e -> true);
        for (Entity e : found) {
            if (e == p) continue;
            String type = String.valueOf(BuiltInRegistries.ENTITY_TYPE.getKey(e.getType()));
            String name = e.getName().getString();
            if (f != null && !type.toLowerCase(Locale.ROOT).contains(f) && !name.toLowerCase(Locale.ROOT).contains(f)) continue;
            if (out.size() >= MAX_ENTITIES) { truncated = true; break; }
            JsonObject o = new JsonObject();
            o.addProperty("id", e.getId());
            o.addProperty("uuid", e.getUUID().toString());
            o.addProperty("type", type);
            o.addProperty("name", clip(name));
            o.add("position", vec(e.position()));
            o.addProperty("distance", Math.round(e.distanceTo(p) * 100) / 100.0);
            out.add(o);
        }
        JsonObject r2 = new JsonObject();
        r2.add("entities", out);
        r2.addProperty("truncated", truncated);
        return r2;
    }

    private static BlockPos pos(JsonObject a, String k) throws BridgeError {
        if (!a.has(k) || !a.get(k).isJsonObject()) throw new BridgeError("invalid_argument", "'" + k + "' must be {x,y,z}.");
        JsonObject o = a.getAsJsonObject(k);
        return new BlockPos(Bridge.integer(o, "x", null), Bridge.integer(o, "y", null), Bridge.integer(o, "z", null));
    }

    private JsonElement blocks(JsonObject a) throws BridgeError {
        need();
        BlockPos lo = pos(a, "min");
        BlockPos hi = pos(a, "max");
        BlockPos min = new BlockPos(Math.min(lo.getX(), hi.getX()), Math.min(lo.getY(), hi.getY()), Math.min(lo.getZ(), hi.getZ()));
        BlockPos max = new BlockPos(Math.max(lo.getX(), hi.getX()), Math.max(lo.getY(), hi.getY()), Math.max(lo.getZ(), hi.getZ()));
        long vol = (long) (max.getX() - min.getX() + 1) * (max.getY() - min.getY() + 1) * (max.getZ() - min.getZ() + 1);
        if (vol > MAX_BLOCK_VOLUME) throw new BridgeError("too_large", "Volume " + vol + " exceeds the cap of " + MAX_BLOCK_VOLUME + " blocks.");
        ClientLevel level = b.mc.level;
        JsonArray out = new JsonArray();
        BlockPos.MutableBlockPos m = new BlockPos.MutableBlockPos();
        for (int x = min.getX(); x <= max.getX(); x++)
            for (int y = min.getY(); y <= max.getY(); y++)
                for (int z = min.getZ(); z <= max.getZ(); z++) {
                    BlockState s = level.getBlockState(m.set(x, y, z));
                    if (s.isAir()) continue;
                    JsonObject o = new JsonObject();
                    o.addProperty("x", x);
                    o.addProperty("y", y);
                    o.addProperty("z", z);
                    o.addProperty("state", clip(String.valueOf(s)));
                    out.add(o);
                }
        JsonObject r = new JsonObject();
        r.add("blocks", out);
        r.addProperty("volume", vol);
        r.addProperty("non_air", out.size());
        return r;
    }

    private JsonElement block(JsonObject a) throws BridgeError {
        need();
        BlockPos p = pos(a, "pos");
        BlockState s = b.mc.level.getBlockState(p);
        JsonObject o = new JsonObject();
        o.addProperty("block", String.valueOf(BuiltInRegistries.BLOCK.getKey(s.getBlock())));
        o.addProperty("state", clip(String.valueOf(s)));
        BlockEntity be = b.mc.level.getBlockEntity(p);
        if (be != null) {
            o.addProperty("block_entity", String.valueOf(BuiltInRegistries.BLOCK_ENTITY_TYPE.getKey(be.getType())));
            try {
                CompoundTag tag = be.saveWithFullMetadata(b.mc.level.registryAccess());
                o.addProperty("block_entity_data", clip(String.valueOf(tag), 2000));
            } catch (RuntimeException e) {
                o.addProperty("block_entity_data_error", e.getClass().getSimpleName());
            }
        }
        return o;
    }

    // ---- modules ----------------------------------------------------------------------------

    static boolean denied(Module m) {
        String key = (m.id() + " " + m.name()).toLowerCase(Locale.ROOT);
        for (String d : MODULE_DENY) if (key.contains(d)) return true;
        return false;
    }

    private JsonElement listModules() {
        JsonArray out = new JsonArray();
        for (Module m : ModuleRegistry.all()) {
            if (denied(m)) continue;
            JsonObject o = new JsonObject();
            o.addProperty("id", m.id());
            o.addProperty("name", m.name());
            o.addProperty("category", String.valueOf(m.category()));
            o.addProperty("enabled", m.isEnabled());
            o.addProperty("description", clip(m.description()));
            out.add(o);
        }
        JsonObject r = new JsonObject();
        r.add("modules", out);
        return r;
    }

    private JsonElement moduleSettings(JsonObject a) throws BridgeError {
        Module m = findModule(Bridge.str(a, "module", true));
        JsonArray out = new JsonArray();
        for (var s : m.settings()) {
            JsonObject o = new JsonObject();
            o.addProperty("id", s.id());
            o.addProperty("label", s.label());
            o.addProperty("description", clip(s.description()));
            Object v = s.get();
            o.addProperty("type", v == null ? "null" : v.getClass().getSimpleName());
            o.addProperty("value", clip(String.valueOf(v)));
            out.add(o);
        }
        JsonObject r = new JsonObject();
        r.addProperty("module", m.id());
        r.add("settings", out);
        return r;
    }

    static Module findModule(String idOrName) throws BridgeError {
        Module m = ModuleRegistry.get(idOrName);
        if (m == null || denied(m)) throw new BridgeError("not_found", "No such module (or module is not exposed): " + idOrName);
        return m;
    }

    // ---- tick-driven events -----------------------------------------------------------------

    void onTick(long tick) {
        if (!b.hasClient()) return;
        String screenName = b.mc.gui.screen() == null ? "" : b.mc.gui.screen().getClass().getName();
        if (!screenName.equals(lastScreen)) {
            JsonObject o = new JsonObject();
            o.addProperty("from", lastScreen);
            o.addProperty("to", screenName);
            b.emit(screenName.isEmpty() ? "screen_close" : "screen_open", o);
            lastScreen = screenName;
        }
        LocalPlayer p = b.mc.player;
        if (p == null) return;
        int h = 17;
        for (Slot s : p.containerMenu.slots) {
            ItemStack st = s.getItem();
            h = h * 31 + (st.isEmpty() ? 0 : BuiltInRegistries.ITEM.getKey(st.getItem()).hashCode() * 31 + st.getCount());
        }
        if (h != lastInvHash) {
            lastInvHash = h;
            JsonObject o = new JsonObject();
            o.addProperty("window_id", p.containerMenu.containerId);
            b.emit("inventory_change", o);
        }
        float hp = p.getHealth();
        if (lastHealth >= 0 && hp < lastHealth) {
            JsonObject o = new JsonObject();
            o.addProperty("from", lastHealth);
            o.addProperty("to", hp);
            b.emit("damage", o);
        }
        lastHealth = hp;
        if (tick % 20 == 0) b.emit("tick_marker", new JsonObject());
    }

    // ---- helpers ----------------------------------------------------------------------------

    LocalPlayer need() throws BridgeError {
        if (b.mc.player == null || b.mc.level == null) throw new BridgeError("not_in_world", "The client is not in a world.");
        return b.mc.player;
    }

    static JsonObject vec(Vec3 v) {
        JsonObject o = new JsonObject();
        o.addProperty("x", v.x);
        o.addProperty("y", v.y);
        o.addProperty("z", v.z);
        return o;
    }

    static String clip(String s) {
        return clip(s, MAX_STR);
    }

    static String clip(String s, int max) {
        if (s == null) return "";
        return s.length() <= max ? s : s.substring(0, max) + "...(" + (s.length() - max) + " more)";
    }
}
