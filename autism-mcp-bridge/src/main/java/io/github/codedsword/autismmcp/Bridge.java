// SPDX-License-Identifier: GPL-3.0-only
// Part of autism-mcp-bridge, an addon for AUTISM Client (https://github.com/codedsword/autism-mcp). GPL-3.0.
package io.github.codedsword.autismmcp;

import com.google.gson.Gson;
import com.google.gson.JsonArray;
import com.google.gson.JsonElement;
import com.google.gson.JsonNull;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import net.minecraft.client.Minecraft;
import net.minecraft.network.protocol.Packet;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.Iterator;
import java.util.List;
import java.util.Map;
import java.util.concurrent.ConcurrentLinkedQueue;
import java.util.concurrent.atomic.AtomicLong;

/** Infrastructure: lifecycle, request queue (socket thread -> client thread), dispatch, event fan-out. */
public final class Bridge {
    interface Op {
        JsonElement run(JsonObject args) throws BridgeError;
    }

    private record Job(JsonElement id, String op, JsonObject args) {}

    private static final class Waiter {
        final JsonElement id;
        long untilTick;
        Waiter(JsonElement id, long untilTick) { this.id = id; this.untilTick = untilTick; }
    }

    static final Gson GSON = new Gson();
    private static final int MAX_JOBS_PER_TICK = 64;

    final Minecraft mc = Minecraft.getInstance();
    private final ConcurrentLinkedQueue<Job> jobs = new ConcurrentLinkedQueue<>();
    private final List<Waiter> waiters = new ArrayList<>();
    private final Map<String, Op> ops = new HashMap<>();
    private final AtomicLong tick = new AtomicLong();
    private volatile WsServer ws;
    private volatile Path root;
    volatile List<String> allowedTargets = List.of("127.0.0.1", "localhost");
    final PacketTap packets = new PacketTap(this);
    final Observe observe = new Observe(this);
    final Act act = new Act(this);

    public Bridge() {
        observe.register(ops);
        act.register(ops);
        packets.register(ops);
        ops.put("ping", a -> {
            JsonObject o = new JsonObject();
            o.addProperty("pong", true);
            return o;
        });
    }

    /**
     * Where port/token/config.toml live. Default: <game dir>/autism-mcp, which is always writable (also inside a
     * Flatpak-sandboxed launcher) and readable by the MCP server on the host.
     */
    static String defaultBridgeDir() {
        return net.fabricmc.loader.api.FabricLoader.getInstance().getGameDir().resolve("autism-mcp").toString();
    }

    public long tick() {
        return tick.get();
    }

    public synchronized void start(String dirSetting) {
        stop();
        try {
            String d = dirSetting == null || dirSetting.isBlank() ? defaultBridgeDir() : dirSetting;
            root = Path.of(d.replaceFirst("^~", System.getProperty("user.home"))).toAbsolutePath();
            Files.createDirectories(root);
            allowedTargets = Safety.loadAllowedTargets(root);
            packets.configure(root);
            String token = Safety.newToken();
            ws = new WsServer(token, this::onSocketMessage, () -> {
                if (!hasClient()) packets.reset();
            });
            Safety.writePrivate(root.resolve("token"), token);
            Safety.writePrivate(root.resolve("port"), String.valueOf(ws.port()));
            log("bridge listening on 127.0.0.1:" + ws.port() + " dir=" + root + " (allowed targets: " + allowedTargets + ")");
        } catch (IOException | RuntimeException e) {
            log("bridge failed to start: " + e);
            stop();
        }
    }

    public synchronized void stop() {
        WsServer s = ws;
        ws = null;
        if (s != null) s.close();
        packets.reset();
        jobs.clear();
        Path r = root;
        if (r != null) {
            try {
                Files.deleteIfExists(r.resolve("token"));
                Files.deleteIfExists(r.resolve("port"));
            } catch (IOException ignored) { }
        }
    }

    boolean hasClient() {
        WsServer s = ws;
        return s != null && s.hasClient();
    }

    static void log(String msg) {
        autismclient.AutismClientAddon.LOG.info("[autism-mcp-bridge] {}", msg);
    }

    // ---- socket thread -> queue ------------------------------------------------------------

    private void onSocketMessage(String text) {
        try {
            JsonObject req = JsonParser.parseString(text).getAsJsonObject();
            JsonElement id = req.get("id");
            String op = req.has("op") ? req.get("op").getAsString() : "";
            JsonObject args = req.has("args") && req.get("args").isJsonObject() ? req.getAsJsonObject("args") : new JsonObject();
            jobs.add(new Job(id == null ? JsonNull.INSTANCE : id, op, args));
        } catch (RuntimeException e) {
            reply(JsonNull.INSTANCE, false, null, "bad_request", "Malformed request: " + e.getMessage());
        }
    }

    // ---- client thread ---------------------------------------------------------------------

    public void onTick(Minecraft client) {
        long now = tick.incrementAndGet();
        act.onTick(now);
        observe.onTick(now);
        for (Iterator<Waiter> it = waiters.iterator(); it.hasNext();) {
            Waiter w = it.next();
            if (now >= w.untilTick) {
                it.remove();
                JsonObject o = new JsonObject();
                o.addProperty("waited_until_tick", now);
                reply(w.id, true, o, null, null);
            }
        }
        Job j;
        int n = 0;
        while (n++ < MAX_JOBS_PER_TICK && (j = jobs.poll()) != null) execute(j);
    }

    private void execute(Job j) {
        if (j.op().equals("wait_ticks")) {
            int ticks = j.args().has("ticks") ? j.args().get("ticks").getAsInt() : 1;
            if (ticks < 1 || ticks > 1200) {
                reply(j.id(), false, null, "invalid_argument", "ticks must be 1..1200");
                return;
            }
            waiters.add(new Waiter(j.id(), tick.get() + ticks));
            return;
        }
        Op op = ops.get(j.op());
        if (op == null) {
            reply(j.id(), false, null, "unknown_op", "Unknown op '" + j.op() + "'.");
            return;
        }
        try {
            reply(j.id(), true, op.run(j.args()), null, null);
        } catch (BridgeError e) {
            reply(j.id(), false, null, e.code, e.getMessage());
        } catch (RuntimeException e) {
            reply(j.id(), false, null, "internal_error", e.getClass().getSimpleName() + ": " + e.getMessage());
        }
    }

    void reply(JsonElement id, boolean ok, JsonElement data, String code, String message) {
        JsonObject o = new JsonObject();
        o.add("id", id);
        o.addProperty("ok", ok);
        o.addProperty("tick", tick.get());
        if (ok) {
            o.add("data", data == null ? JsonNull.INSTANCE : data);
        } else {
            JsonObject e = new JsonObject();
            e.addProperty("code", code);
            e.addProperty("message", message);
            o.add("error", e);
        }
        send(o);
    }

    /** Pushes {event, tick, data} to the connected MCP server. Safe from any thread. */
    void emit(String event, JsonObject data) {
        JsonObject o = new JsonObject();
        o.addProperty("event", event);
        o.addProperty("tick", tick.get());
        o.add("data", data == null ? new JsonObject() : data);
        send(o);
    }

    private void send(JsonObject o) {
        WsServer s = ws;
        if (s != null) s.send(GSON.toJson(o));
    }

    // ---- AddonEvents hooks -----------------------------------------------------------------

    public boolean onPacketSend(Packet<?> p) {
        return packets.onSend(p);
    }

    public void onPacketReceive(Packet<?> p) {
        packets.onReceive(p);
    }

    public void onGameJoin() {
        JsonObject o = new JsonObject();
        emit("game_join", o);
    }

    public void onGameLeft() {
        packets.clearRules();
        act.releaseInputs();
        emit("game_left", new JsonObject());
    }

    // ---- arg helpers -----------------------------------------------------------------------

    static String str(JsonObject a, String k, boolean required) throws BridgeError {
        if (!a.has(k) || a.get(k).isJsonNull()) {
            if (required) throw new BridgeError("invalid_argument", "Missing required argument '" + k + "'.");
            return null;
        }
        return a.get(k).getAsString();
    }

    static int integer(JsonObject a, String k, Integer dflt) throws BridgeError {
        if (!a.has(k) || a.get(k).isJsonNull()) {
            if (dflt == null) throw new BridgeError("invalid_argument", "Missing required argument '" + k + "'.");
            return dflt;
        }
        try {
            return a.get(k).getAsInt();
        } catch (RuntimeException e) {
            throw new BridgeError("invalid_argument", "Argument '" + k + "' must be an integer.");
        }
    }

    static double number(JsonObject a, String k, Double dflt) throws BridgeError {
        if (!a.has(k) || a.get(k).isJsonNull()) {
            if (dflt == null) throw new BridgeError("invalid_argument", "Missing required argument '" + k + "'.");
            return dflt;
        }
        try {
            return a.get(k).getAsDouble();
        } catch (RuntimeException e) {
            throw new BridgeError("invalid_argument", "Argument '" + k + "' must be a number.");
        }
    }

    static boolean bool(JsonObject a, String k, boolean dflt) {
        return a.has(k) && !a.get(k).isJsonNull() ? a.get(k).getAsBoolean() : dflt;
    }

    static JsonArray array() {
        return new JsonArray();
    }
}
