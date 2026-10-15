// SPDX-License-Identifier: GPL-3.0-only
// Part of autism-mcp-bridge, an addon for AUTISM Client (https://github.com/codedsword/autism-mcp). GPL-3.0.
package io.github.codedsword.autismmcp;

import autismclient.util.AutismPacketArgumentBuilder;
import autismclient.util.AutismPacketCapture;
import autismclient.util.AutismPacketDecodedView;
import autismclient.util.AutismPacketFieldValue;
import autismclient.util.AutismPacketSender;
import com.google.gson.JsonArray;
import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import net.minecraft.network.protocol.Packet;

import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayDeque;
import java.util.ArrayList;
import java.util.Collections;
import java.util.IdentityHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * Packet capture ring buffer, bounded delay/drop rules, and rate-limited crafted C2S sends.
 * Reuses the client's AutismPacketCapture / AutismPacketDecodedView / AutismPacketArgumentBuilder.
 */
public final class PacketTap {
    static final int RING = 2000;
    static final int MAX_RULE_COUNT = 50;
    static final int MAX_RULE_MS = 5000;
    static final String[] PACKAGES = {
        "net.minecraft.network.protocol.game.", "net.minecraft.network.protocol.common.",
        "net.minecraft.network.protocol.configuration.", "net.minecraft.network.protocol.ping.",
        "net.minecraft.network.protocol.cookie.",
    };

    private static final class Rule {
        final String kind; // drop | delay
        final String type;
        int remaining;
        final int delayMs;
        final long expiresAtMs;
        Rule(String kind, String type, int remaining, int delayMs, long expiresAtMs) {
            this.kind = kind; this.type = type; this.remaining = remaining; this.delayMs = delayMs; this.expiresAtMs = expiresAtMs;
        }
    }

    private final Bridge b;
    private final ArrayDeque<JsonObject> ring = new ArrayDeque<>();
    private long seq;
    private volatile boolean capturing;
    private volatile Set<String> dirs = Set.of("C2S", "S2C");
    private volatile List<String> types = List.of();
    private final List<Rule> rules = Collections.synchronizedList(new ArrayList<>());
    private final Set<Packet<?>> resending = Collections.synchronizedSet(Collections.newSetFromMap(new IdentityHashMap<>()));
    private volatile Safety.Bucket bucket = new Safety.Bucket(20, 50);

    PacketTap(Bridge b) {
        this.b = b;
    }

    void configure(Path root) {
        double pps = 20, burst = 50;
        try {
            String t = Files.readString(root.resolve("config.toml"));
            Matcher m = Pattern.compile("(?m)^\\s*packets_per_second\\s*=\\s*(\\d+)").matcher(t);
            if (m.find()) pps = Math.max(1, Math.min(Integer.parseInt(m.group(1)), Safety.HARD_CAP_PPS));
            m = Pattern.compile("(?m)^\\s*packet_burst\\s*=\\s*(\\d+)").matcher(t);
            if (m.find()) burst = Math.max(1, Math.min(Integer.parseInt(m.group(1)), 100));
        } catch (Exception ignored) { }
        bucket = new Safety.Bucket(pps, burst);
    }

    void register(Map<String, Bridge.Op> ops) {
        ops.put("packet_capture_start", this::start);
        ops.put("packet_capture_stop", a -> { capturing = false; return stats(); });
        ops.put("packet_capture_get", this::get);
        ops.put("packet_send", this::send);
        ops.put("packet_rule", this::addRule);
        ops.put("packet_rules_clear", a -> { clearRules(); return Act.ok(); });
    }

    void reset() {
        capturing = false;
        synchronized (ring) { ring.clear(); }
        clearRules();
    }

    void clearRules() {
        rules.clear();
        resending.clear();
    }

    // ---- ops ---------------------------------------------------------------------------------

    private JsonElement start(JsonObject a) {
        Set<String> d = new java.util.HashSet<>();
        if (a.has("directions") && a.get("directions").isJsonArray()) {
            for (JsonElement e : a.getAsJsonArray("directions")) d.add(e.getAsString().toUpperCase(Locale.ROOT));
        }
        if (d.isEmpty()) d = Set.of("C2S", "S2C");
        List<String> t = new ArrayList<>();
        if (a.has("types") && a.get("types").isJsonArray()) {
            for (JsonElement e : a.getAsJsonArray("types")) t.add(e.getAsString().toLowerCase(Locale.ROOT));
        }
        synchronized (ring) { ring.clear(); }
        dirs = d;
        types = t;
        capturing = true;
        return stats();
    }

    private JsonElement stats() {
        JsonObject o = new JsonObject();
        o.addProperty("capturing", capturing);
        synchronized (ring) {
            o.addProperty("buffered", ring.size());
        }
        o.addProperty("last_seq", seq);
        return o;
    }

    private JsonElement get(JsonObject a) throws BridgeError {
        long since = Bridge.integer(a, "since", 0);
        int limit = Math.min(Bridge.integer(a, "limit", 100), 500);
        JsonArray out = new JsonArray();
        boolean truncated = false;
        synchronized (ring) {
            for (JsonObject o : ring) {
                if (o.get("seq").getAsLong() <= since) continue;
                if (out.size() >= limit) { truncated = true; break; }
                out.add(o);
            }
        }
        JsonObject r = new JsonObject();
        r.add("packets", out);
        r.addProperty("truncated", truncated);
        r.addProperty("capturing", capturing);
        return r;
    }

    // ---- capture hooks (netty / client threads) ----------------------------------------------

    boolean onSend(Packet<?> p) {
        if (resending.remove(p)) return false;
        if (capturing && dirs.contains("C2S")) record("C2S", p);
        return applyRules(p);
    }

    void onReceive(Packet<?> p) {
        if (capturing && dirs.contains("S2C")) record("S2C", p);
        notable(p);
    }

    private static String typeName(Packet<?> p) {
        String c = p.getClass().getSimpleName();
        return c.isEmpty() ? p.getClass().getName() : c;
    }

    private boolean matches(String name) {
        List<String> t = types;
        if (t.isEmpty()) return true;
        String n = name.toLowerCase(Locale.ROOT);
        for (String s : t) if (n.contains(s)) return true;
        return false;
    }

    private void record(String dir, Packet<?> p) {
        String name = typeName(p);
        if (!matches(name)) return;
        JsonObject o = new JsonObject();
        o.addProperty("seq", ++seq);
        o.addProperty("tick", b.tick());
        o.addProperty("time_ms", System.currentTimeMillis());
        o.addProperty("dir", dir);
        o.addProperty("class", name);
        try {
            o.addProperty("type", String.valueOf(p.type()));
        } catch (RuntimeException ignored) { }
        o.add("fields", fields(p));
        var snap = AutismPacketCapture.snapshot(p);
        if (snap != null) {
            o.addProperty("id", snap.numericPacketId());
            o.addProperty("hex", AutismPacketCapture.compactHex(snap.plaintextBytes(), 128));
        }
        synchronized (ring) {
            ring.addLast(o);
            while (ring.size() > RING) ring.removeFirst();
        }
    }

    private static JsonObject fields(Packet<?> p) {
        JsonObject f = new JsonObject();
        try {
            AutismPacketDecodedView v = AutismPacketDecodedView.decode(p);
            int n = 0;
            for (AutismPacketFieldValue fv : v.fields()) {
                if (n++ >= 24) break;
                f.addProperty(fv.name(), Observe.clip(fv.summary(), 160));
            }
            f.addProperty("_decode", v.status());
        } catch (RuntimeException e) {
            f.addProperty("_decode", "error:" + e.getClass().getSimpleName());
        }
        return f;
    }

    private void notable(Packet<?> p) {
        String n = typeName(p);
        String ev = switch (n) {
            case "ClientboundAddEntityPacket" -> "entity_spawn";
            case "ClientboundRemoveEntitiesPacket" -> "entity_despawn";
            case "ClientboundBlockUpdatePacket", "ClientboundSectionBlocksUpdatePacket" -> "block_update";
            case "ClientboundDisconnectPacket" -> "disconnect";
            default -> null;
        };
        if (ev == null || !b.hasClient()) return;
        JsonObject d = fields(p);
        b.emit(ev, d);
    }

    // ---- rules -------------------------------------------------------------------------------

    private boolean applyRules(Packet<?> p) {
        if (rules.isEmpty()) return false;
        String n = typeName(p).toLowerCase(Locale.ROOT);
        long now = System.currentTimeMillis();
        synchronized (rules) {
            rules.removeIf(r -> r.remaining <= 0 || now > r.expiresAtMs);
            for (Rule r : rules) {
                if (!n.contains(r.type)) continue;
                r.remaining--;
                if (r.kind.equals("drop")) return true;
                resending.add(p);
                long delay = r.delayMs;
                Thread t = new Thread(() -> {
                    try { Thread.sleep(delay); } catch (InterruptedException ignored) { }
                    b.mc.execute(() -> {
                        if (b.mc.getConnection() != null) AutismPacketSender.sendPacketDirect(p);
                    });
                }, "autism-mcp-delay");
                t.setDaemon(true);
                t.start();
                return true;
            }
        }
        return false;
    }

    private JsonElement addRule(JsonObject a) throws BridgeError {
        String kind = Bridge.str(a, "kind", true).toLowerCase(Locale.ROOT);
        String dir = Bridge.str(a, "direction", false);
        if (!kind.equals("drop") && !kind.equals("delay")) throw new BridgeError("invalid_argument", "kind must be drop or delay.");
        if (dir != null && !dir.equalsIgnoreCase("C2S")) {
            throw new BridgeError("unsupported_direction", "Only C2S packets can be delayed or dropped: AddonEvents' receive listener is not cancellable.");
        }
        String type = Bridge.str(a, "type", true).toLowerCase(Locale.ROOT);
        int count = Bridge.integer(a, "count", 1);
        int ms = Bridge.integer(a, "ms", 0);
        int ttl = Bridge.integer(a, "ttl_ms", 10000);
        if (count < 1 || count > MAX_RULE_COUNT) throw new BridgeError("invalid_argument", "count must be 1.." + MAX_RULE_COUNT);
        if (kind.equals("delay") && (ms < 1 || ms > MAX_RULE_MS)) throw new BridgeError("invalid_argument", "ms must be 1.." + MAX_RULE_MS);
        if (ttl < 100 || ttl > 60000) throw new BridgeError("invalid_argument", "ttl_ms must be 100..60000");
        if (rules.size() >= 10) throw new BridgeError("too_many_rules", "At most 10 active rules.");
        rules.add(new Rule(kind, type, count, ms, System.currentTimeMillis() + ttl));
        return Act.ok();
    }

    // ---- crafted send ------------------------------------------------------------------------

    @SuppressWarnings("unchecked")
    private JsonElement send(JsonObject a) throws BridgeError {
        b.observe.need();
        b.act.requireAllowedServer();
        String type = Bridge.str(a, "type", true);
        String args = Bridge.str(a, "args", false);
        if (args != null && args.length() > 2000) throw new BridgeError("invalid_argument", "args exceeds 2000 characters.");
        if (!bucket.take()) throw new BridgeError("rate_limited", "Packet send rate limit exceeded; slow down.");
        Class<? extends Packet<?>> cls = resolve(type);
        var r = AutismPacketArgumentBuilder.build(cls, args == null ? "" : args);
        if (!r.ok() || r.packet() == null) {
            throw new BridgeError("build_failed", r.help() ? "Help: " + r.message() : r.message());
        }
        boolean dry = Bridge.bool(a, "dry_run", false);
        JsonObject o = new JsonObject();
        o.addProperty("class", cls.getSimpleName());
        o.add("fields", fields(r.packet()));
        o.addProperty("sent", !dry);
        if (!dry) AutismPacketSender.sendPacketDirect(r.packet());
        return o;
    }

    @SuppressWarnings("unchecked")
    private static Class<? extends Packet<?>> resolve(String type) throws BridgeError {
        String t = type.trim();
        if (!t.matches("[A-Za-z0-9_.]{1,120}")) throw new BridgeError("invalid_argument", "Invalid packet type name.");
        List<String> candidates = new ArrayList<>();
        if (t.contains(".")) candidates.add(t);
        else for (String pkg : PACKAGES) candidates.add(pkg + t);
        for (String c : candidates) {
            try {
                Class<?> k = Class.forName(c);
                if (!Packet.class.isAssignableFrom(k)) continue;
                if (!k.getSimpleName().startsWith("Serverbound")) {
                    throw new BridgeError("not_c2s", k.getSimpleName() + " is not a serverbound (C2S) packet.");
                }
                return (Class<? extends Packet<?>>) k;
            } catch (ClassNotFoundException ignored) { }
        }
        throw new BridgeError("unknown_packet", "No serverbound packet class named '" + type + "' (try e.g. ServerboundChatCommandPacket).");
    }
}
