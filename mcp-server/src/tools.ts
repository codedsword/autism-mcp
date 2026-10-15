// SPDX-License-Identifier: GPL-3.0-only
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { z } from "zod";
import { Context, fail, type ToolResult } from "./context.js";
import { diffSnapshots, type Severity } from "./experiments.js";
import { hostOf, isTargetAllowed } from "./config.js";

export type ToolKind = "read" | "action" | "meta";

export interface ToolDef {
  name: string;
  description: string;
  kind: ToolKind;
  shape: z.ZodRawShape;
  handler: (args: any) => Promise<ToolResult>;
}

const Pos = z.object({ x: z.number().int(), y: z.number().int(), z: z.number().int() });
const Hand = z.enum(["main", "off"]).default("main");
const SEVERITIES = ["cosmetic", "gameplay", "economy-breaking", "server-stability", "security"] as const;

export function buildTools(ctx: Context): ToolDef[] {
  const tools: ToolDef[] = [];

  const add = (t: ToolDef) => tools.push(t);

  /** Bridge read op: no experiment action record, no rate limit beyond the global bucket. */
  const read = (name: string, description: string, shape: z.ZodRawShape, op: string, map?: (a: any) => any, timeout = 5000) =>
    add({
      name, description, kind: "read", shape,
      handler: async (a) => ctx.call(op, map ? map(a) : a, timeout),
    });

  /** Bridge action op: rate limited, audited, and recorded into the active experiment. */
  const action = (name: string, description: string, shape: z.ZodRawShape, op: string, map?: (a: any) => any, timeout = 5000) =>
    add({
      name, description, kind: "action", shape,
      handler: async (a) => {
        if (!ctx.actionBucket.take()) return fail("rate_limited", "Too many action calls; slow down.");
        const limit = ctx.store.checkLimits();
        if (limit) return fail("experiment_limit", limit);
        const bridgeArgs = map ? map(a) : a;
        const res = await ctx.call(op, bridgeArgs, timeout);
        ctx.store.record("action", res.tick ?? -1, { tool: name, op, args: bridgeArgs, ok: res.ok, error: res.error, data: res.data });
        return res;
      },
    });

  // ---- 4.1 session and lifecycle ------------------------------------------------------------------
  add({
    name: "mc_status",
    kind: "read",
    description:
      "Reports whether the bridge to the AUTISM client is reachable and, if so, the client's status: Minecraft version, whether the player is in a world, server address, player name, ping, open screen and FPS. Call this first. No side effects.",
    shape: {},
    handler: async () => {
      const r = await ctx.call("status");
      return r.ok ? { ...r, data: { bridge_connected: true, active_experiment: ctx.store.active?.id ?? null, ...(r.data as object) } } : r;
    },
  });

  add({
    name: "mc_connect",
    kind: "action",
    description:
      "Connects the client to a Minecraft server. Refused unless the host is in allowed_targets in config.toml (default: localhost and 127.0.0.1). Parameter: address like 'localhost' or 'localhost:25565'. The connection completes asynchronously: use mc_wait_for with event 'game_join' afterwards.",
    shape: { address: z.string().min(1).max(255) },
    handler: async (a) => {
      if (!isTargetAllowed(ctx.cfg, a.address)) {
        const r = fail("target_not_allowed", `Host '${hostOf(a.address)}' is not in allowed_targets (${ctx.cfg.allowedTargets.join(", ")}).`);
        return r;
      }
      const r = await ctx.call("connect", { address: a.address });
      ctx.store.record("action", r.tick ?? -1, { tool: "mc_connect", op: "connect", args: a, ok: r.ok });
      return r;
    },
  });

  action("mc_disconnect", "Disconnects the client from the current server. Side effect: ends the play session; any bounded packet delay/drop rules are cleared.", {}, "disconnect");

  add({
    name: "mc_wait_ticks",
    kind: "read",
    description: "Waits until n client ticks (20 per second) have passed, measured by the client itself (deterministic, unlike sleeping). n is 1..1200. Returns the tick reached.",
    shape: { n: z.number().int().min(1).max(1200) },
    handler: async (a) => ctx.call("wait_ticks", { ticks: a.n }, Math.max(5000, a.n * 100 + 5000)),
  });

  add({
    name: "mc_wait_for",
    kind: "read",
    description:
      "Waits for a client event or times out. event is one of: chat, game_join, game_left, screen_open, screen_close, inventory_change, entity_spawn, entity_despawn, block_update, damage, disconnect, tick_marker. Optional contains: only matches events whose JSON contains this substring. timeout_ms is 100..60000. Returns the matching event, or error code 'timeout'.",
    shape: {
      event: z.string().min(1).max(40),
      timeout_ms: z.number().int().min(100).max(60000).default(10000),
      contains: z.string().max(200).optional(),
    },
    handler: async (a) => {
      try {
        await ctx.bridge.connect();
      } catch (e) {
        return fail("bridge_unavailable", (e as Error).message);
      }
      return new Promise<ToolResult>((resolveP) => {
        const off = ctx.bridge.onEvent((ev) => {
          if (ev.event !== a.event) return;
          if (a.contains && !JSON.stringify(ev.data).includes(a.contains)) return;
          clearTimeout(timer);
          off();
          resolveP({ ok: true, data: ev, tick: ev.tick });
        });
        const timer = setTimeout(() => {
          off();
          resolveP(fail("timeout", `No '${a.event}' event within ${a.timeout_ms} ms.`));
        }, a.timeout_ms);
      });
    },
  });

  // ---- 4.2 observation ---------------------------------------------------------------------------
  read("mc_get_state", "Returns the player's position, yaw/pitch, velocity, health, hunger, saturation, gamemode, dimension, on_ground, active effects, held hotbar slot and XP level. Read-only.", {}, "get_state");
  read("mc_get_inventory", "Returns the currently open container menu (the player inventory when no container is open): window_id, state_id, carried (cursor) stack, and every non-empty slot with slot index, item id, count, display name and a component summary. Use window_id/state_id with mc_click_slot. Read-only.", {}, "get_inventory");
  read("mc_get_screen", "Returns which screen is open (class, title) and the current container window id and menu type. Read-only.", {}, "get_screen");
  read("mc_get_entities", "Lists loaded entities within radius (1..128, default 16) of the player, optionally filtered by a substring of type id or name. Returns entity id (use with attack/interact), uuid, type, name, position and distance. Capped at 200 entities (truncated flag). Read-only.", {
    radius: z.number().min(1).max(128).default(16),
    filter: z.string().max(64).optional(),
  }, "get_entities");
  read("mc_get_blocks", "Lists non-air blocks in the box min..max (inclusive block coordinates). Volume is capped at 4096 blocks. Returns each block's position and block state string. Read-only.", { min: Pos, max: Pos }, "get_blocks");
  read("mc_get_block", "Returns one block's id, state and, if it has a block entity, its type and NBT data (truncated). Read-only.", { pos: Pos }, "get_block");
  read("mc_get_chat", "Returns chat and system messages received since sequence number 'since' (default 0 = all buffered, up to 500). Each has seq, tick, kind (chat|system), text and sender. Read-only.", {
    since: z.number().int().min(0).default(0),
    limit: z.number().int().min(1).max(500).default(100),
  }, "get_chat");

  // ---- 4.3 actions ------------------------------------------------------------------------------
  action("mc_look", "Rotates the player. Provide either yaw and pitch (degrees, pitch -90..90) or target {x,y,z} to face a world position. Client-side rotation; sent to the server with the next movement packet.", {
    yaw: z.number().optional(), pitch: z.number().min(-90).max(90).optional(),
    target: z.object({ x: z.number(), y: z.number(), z: z.number() }).optional(),
  }, "look", (a) => {
    if (!a.target && (a.yaw === undefined || a.pitch === undefined)) throw new Error("Provide target, or both yaw and pitch.");
    return a;
  });
  action("mc_set_input", "Holds a movement key for N client ticks (max 200; 0 releases it). key is one of forward, back, left, right, jump, sneak, sprint. Held keys are released on disconnect.", {
    key: z.enum(["forward", "back", "left", "right", "jump", "sneak", "sprint"]),
    ticks: z.number().int().min(0).max(200).default(1),
  }, "set_input");
  action("mc_use_item", "Uses the item in the given hand (right-click in air). Returns the interaction result.", { hand: Hand }, "use_item");
  action("mc_attack", "Attacks the entity with the given id (from mc_get_entities) with a normal vanilla attack.", { entity_id: z.number().int() }, "attack");
  action("mc_interact_block", "Right-clicks (uses item on) the block at pos on the given face. Must be within 8 blocks. face is up, down, north, south, east or west.", {
    pos: Pos, face: z.enum(["up", "down", "north", "south", "east", "west"]).default("up"), hand: Hand,
  }, "interact_block");
  action("mc_interact_entity", "Right-clicks the entity with the given id (villagers, minecarts, animals...).", { entity_id: z.number().int(), hand: Hand }, "interact_entity");
  action("mc_click_slot", "Sends a container click through the vanilla client. window must equal the open window id (see mc_get_inventory). slot is the menu slot index (-999 = outside window). button is the mouse button or hotbar index for SWAP. mode is PICKUP, QUICK_MOVE, SWAP, CLONE, THROW, QUICK_CRAFT or PICKUP_ALL. Returns once the click is dispatched; observe the result with mc_get_inventory.", {
    window: z.number().int().optional(), slot: z.number().int().min(-999).max(200), button: z.number().int().min(0).max(8).default(0),
    mode: z.enum(["PICKUP", "QUICK_MOVE", "SWAP", "CLONE", "THROW", "QUICK_CRAFT", "PICKUP_ALL"]).default("PICKUP"),
  }, "click_slot");
  action("mc_close_screen", "Closes the open container/screen and sends the container-close packet.", {}, "close_screen");
  action("mc_drop", "Drops the held item (one, or the whole stack with all=true).", { all: z.boolean().default(false) }, "drop");
  action("mc_swap_hands", "Swaps main hand and off hand items (sends the swap-offhand action packet).", {}, "swap_hands");
  action("mc_select_slot", "Selects the held hotbar slot (0..8, where 0 is the leftmost). Changes which item mc_use_item, mc_drop and mc_interact_block use.", { slot: z.number().int().min(0).max(8) }, "select_slot");
  action("mc_chat", "Sends a plain chat message (max 256 chars, must not start with '/'; use mc_command for commands). Only allowed while connected to an allowed target.", { message: z.string().min(1).max(256) }, "chat");
  action("mc_command", "Runs a server command (leading '/' optional, max 256 chars). Only allowed while connected to an allowed target.", { command: z.string().min(1).max(256) }, "command");
  action("mc_teleport_via_command", "Teleports the player with '/tp x y z'. Only works if the player has server permission (op on the local test server).", {
    x: z.number(), y: z.number(), z: z.number(),
  }, "command", (a) => ({ command: `tp ${a.x} ${a.y} ${a.z}` }));

  // client modules (login, hide/OpSec and spoofing modules are filtered out by the addon)
  read("mc_list_modules", "Lists AUTISM client modules (id, name, category, enabled, description). Account/login, privacy/OpSec and anti-detection modules are intentionally not exposed. Read-only.", {}, "list_modules");
  read("mc_get_module_settings", "Returns a module's settings: id, label, description, type and current value. module is the id or name from mc_list_modules.", { module: z.string().min(1).max(80) }, "get_module_settings");
  action("mc_toggle_module", "Enables or disables a client module. enabled omitted = toggle.", { module: z.string().min(1).max(80), enabled: z.boolean().optional() }, "set_module");
  action("mc_set_module_setting", "Sets one module setting. value must match the setting's type (boolean, integer, number, string, or enum constant name).", {
    module: z.string().min(1).max(80), setting: z.string().min(1).max(80), value: z.union([z.boolean(), z.number(), z.string()]),
  }, "set_module_setting");

  // ---- 4.4 packet-level research tools ----------------------------------------------------------
  add({
    name: "mc_packet_capture_start", kind: "action",
    description: "Starts capturing packets into a bounded ring buffer (2000). directions: any of C2S, S2C (default both). types: substrings of packet class names, e.g. ['ContainerClick','BlockUpdate'] (default all). Clears the buffer. Decoded with the client's own packet decoders, plus the raw hex head.",
    shape: { directions: z.array(z.enum(["C2S", "S2C"])).max(2).optional(), types: z.array(z.string().max(80)).max(20).optional() },
    handler: async (a) => ctx.call("packet_capture_start", a),
  });
  add({
    name: "mc_packet_capture_stop", kind: "action",
    description: "Stops packet capture. The buffer stays readable with mc_packet_capture_get until the next start.",
    shape: {}, handler: async () => ctx.call("packet_capture_stop"),
  });
  add({
    name: "mc_packet_capture_get", kind: "read",
    description: "Returns captured packets with seq greater than 'since' (default 0), up to limit (max 500). Each has seq, tick, dir (C2S|S2C), class, protocol type, decoded fields, numeric id and hex head.",
    shape: { since: z.number().int().min(0).default(0), limit: z.number().int().min(1).max(500).default(100) },
    handler: async (a) => ctx.call("packet_capture_get", a),
  });
  add({
    name: "mc_packet_send", kind: "action",
    description:
      "Sends one crafted serverbound (C2S) packet built by the client's own argument builder. type is the packet class simple name, e.g. 'ServerboundChatCommandPacket'. args is the client's key=value argument string (use args='help=true' to get the field help for a type; dry_run=true builds and decodes without sending). Rate limited (default 20/s, burst 50, hard cap 100/s), counted against the experiment's packet cap, and refused unless connected to an allowed target. Every send is logged to the active experiment. No flooding or malformed-length generators exist.",
    shape: { type: z.string().min(1).max(120), args: z.string().max(2000).default(""), dry_run: z.boolean().default(false) },
    handler: async (a) => {
      const limit = ctx.store.checkLimits();
      if (limit) return fail("experiment_limit", limit);
      if (!a.dry_run && !ctx.packetBucket.take()) return fail("rate_limited", "Packet rate limit exceeded; slow down.");
      const st = await ctx.call("status");
      if (st.ok) {
        const addr = (st.data as any)?.server_address;
        if (addr && !isTargetAllowed(ctx.cfg, addr)) {
          const r = fail("target_not_allowed", `Connected server '${hostOf(addr)}' is not in allowed_targets.`);
          return r;
        }
      }
      const r = await ctx.call("packet_send", { type: a.type, args: a.args, dry_run: a.dry_run });
      if (r.ok && !a.dry_run && ctx.store.active) ctx.store.active.packetsSent++;
      ctx.store.record("action", r.tick ?? -1, { tool: "mc_packet_send", op: "packet_send", args: { type: a.type, args: a.args, dry_run: a.dry_run }, ok: r.ok, error: r.error, data: r.data });
      return r;
    },
  });
  add({
    name: "mc_packet_delay", kind: "action",
    description: "Holds the next 'count' (1..50) outgoing (C2S) packets whose class name contains 'type' for 'ms' (1..5000) milliseconds, then resends them. The rule expires after ttl_ms (default 10000, max 60000), on disconnect, and at experiment end. S2C is not supported (the client's receive hook cannot cancel).",
    shape: { type: z.string().min(1).max(80), ms: z.number().int().min(1).max(5000), count: z.number().int().min(1).max(50).default(1), ttl_ms: z.number().int().min(100).max(60000).default(10000) },
    handler: async (a) => {
      const r = await ctx.call("packet_rule", { kind: "delay", direction: "C2S", ...a });
      ctx.store.record("action", r.tick ?? -1, { tool: "mc_packet_delay", op: "packet_rule", args: { kind: "delay", direction: "C2S", ...a }, ok: r.ok });
      return r;
    },
  });
  add({
    name: "mc_packet_drop", kind: "action",
    description: "Silently drops the next 'count' (1..50) outgoing (C2S) packets whose class name contains 'type'. The rule expires after ttl_ms (default 10000, max 60000), on disconnect, and at experiment end. S2C is not supported.",
    shape: { type: z.string().min(1).max(80), count: z.number().int().min(1).max(50).default(1), ttl_ms: z.number().int().min(100).max(60000).default(10000) },
    handler: async (a) => {
      const r = await ctx.call("packet_rule", { kind: "drop", direction: "C2S", ...a });
      ctx.store.record("action", r.tick ?? -1, { tool: "mc_packet_drop", op: "packet_rule", args: { kind: "drop", direction: "C2S", ...a }, ok: r.ok });
      return r;
    },
  });

  // ---- 4.5 experiments and findings -------------------------------------------------------------
  const takeSnapshot = async (label: string, blockRadius: number): Promise<{ ok: boolean; snap?: any; error?: any; tick?: number }> => {
    const st = await ctx.call("get_state");
    if (!st.ok) return { ok: false, error: st.error };
    const [inv, ent] = await Promise.all([ctx.call("get_inventory"), ctx.call("get_entities", { radius: 12 })]);
    const p = (st.data as any).position;
    const fx = Math.floor(p.x), fy = Math.floor(p.y), fz = Math.floor(p.z);
    const blocks = blockRadius > 0
      ? await ctx.call("get_blocks", { min: { x: fx - blockRadius, y: fy - 1, z: fz - blockRadius }, max: { x: fx + blockRadius, y: fy + 2, z: fz + blockRadius } })
      : { ok: true, data: { blocks: [] } };
    const snap = {
      label, state: st.data, inventory: inv.data, entities: (ent.data as any)?.entities ?? [],
      blocks: (blocks.data as any)?.blocks ?? [],
    };
    return { ok: true, snap, tick: st.tick };
  };

  const drainPackets = async (): Promise<number> => {
    const exp = ctx.store.active;
    if (!exp) return 0;
    let n = 0;
    for (let i = 0; i < 6; i++) {
      const r = await ctx.call("packet_capture_get", { since: exp.lastPacketSeq, limit: 500 });
      if (!r.ok) break;
      const pk = (r.data as any).packets as any[];
      for (const p of pk) {
        ctx.store.record(p.dir === "C2S" ? "packet_c2s" : "packet_s2c", p.tick, p);
        exp.lastPacketSeq = Math.max(exp.lastPacketSeq, p.seq);
        n++;
      }
      if (!(r.data as any).truncated) break;
    }
    return n;
  };

  add({
    name: "mc_experiment_start", kind: "meta",
    description: "Begins recording an experiment: takes an initial snapshot labeled 'start', starts full packet capture, and then records every action, event and packet until mc_experiment_stop. Caps: 5000 sent packets and 10 minutes by default. Only one experiment can be active. Returns the experiment id.",
    shape: { name: z.string().min(1).max(80), hypothesis: z.string().max(2000).default("") },
    handler: async (a) => {
      let exp;
      try {
        exp = ctx.store.start(a.name, a.hypothesis);
      } catch (e) {
        return fail("experiment_active", (e as Error).message);
      }
      const unsub = ctx.bridge.onEvent((ev) => {
        if (ctx.store.active?.id === exp.id && ev.event !== "tick_marker") ctx.store.record("event", ev.tick, ev);
      });
      (exp as any)._unsub = unsub;
      await ctx.call("packet_capture_start", {});
      const s = await takeSnapshot("start", 2);
      if (s.ok) {
        exp.snapshots.set("start", s.snap);
        ctx.store.record("snapshot", s.tick ?? -1, s.snap);
      }
      return { ok: true, data: { experiment_id: exp.id, initial_snapshot: s.ok, note: s.ok ? undefined : "No world yet; snapshot skipped." } };
    },
  });
  add({
    name: "mc_experiment_snapshot", kind: "meta",
    description: "Stores a labeled snapshot in the active experiment: player state, full inventory/container, entities within 12 blocks, and non-air blocks in a box around the player (block_radius default 2, max 8). Also drains newly captured packets into the experiment. Use before and after the suspicious action, then mc_experiment_diff.",
    shape: { label: z.string().min(1).max(40), block_radius: z.number().int().min(0).max(8).default(2) },
    handler: async (a) => {
      const exp = ctx.store.active;
      if (!exp) return fail("no_experiment", "No active experiment; call mc_experiment_start.");
      const s = await takeSnapshot(a.label, a.block_radius);
      if (!s.ok) return fail(s.error?.code ?? "snapshot_failed", s.error?.message ?? "Snapshot failed.");
      exp.snapshots.set(a.label, s.snap);
      ctx.store.record("snapshot", s.tick ?? -1, s.snap);
      const pk = await drainPackets();
      return { ok: true, tick: s.tick, data: { label: a.label, items: (s.snap!.inventory?.slots ?? []).length, entities: s.snap!.entities.length, blocks: s.snap!.blocks.length, packets_recorded: pk } };
    },
  });
  add({
    name: "mc_experiment_diff", kind: "meta",
    description: "Structured diff between two snapshot labels of an experiment (default: the active one): items gained/lost by id and count, position delta, block changes, entity appeared/disappeared, health/hunger/gamemode/dimension changes.",
    shape: { label_a: z.string().min(1).max(40), label_b: z.string().min(1).max(40), experiment_id: z.string().max(120).optional() },
    handler: async (a) => {
      let a1: any, b1: any;
      if (!a.experiment_id || a.experiment_id === ctx.store.active?.id) {
        const exp = ctx.store.active;
        if (!exp) return fail("no_experiment", "No active experiment; pass experiment_id for a finished one.");
        a1 = exp.snapshots.get(a.label_a);
        b1 = exp.snapshots.get(a.label_b);
      } else {
        const recs = ctx.store.loadExperimentRecords(a.experiment_id).filter((r) => r.type === "snapshot");
        a1 = recs.find((r) => (r.payload as any).label === a.label_a)?.payload;
        b1 = recs.find((r) => (r.payload as any).label === a.label_b)?.payload;
      }
      if (!a1 || !b1) return fail("unknown_snapshot", `Snapshot '${!a1 ? a.label_a : a.label_b}' not found.`);
      return { ok: true, data: diffSnapshots(a1, b1) };
    },
  });
  add({
    name: "mc_experiment_stop", kind: "meta",
    description: "Stops the active experiment: drains remaining packets, stops capture, clears any packet delay/drop rules, and writes the record. outcome is a short free-text result (e.g. 'duplicated 64 diamonds'). Returns the experiment id for mc_finding_record.",
    shape: { outcome: z.string().min(1).max(500) },
    handler: async (a) => {
      const exp = ctx.store.active;
      if (!exp) return fail("no_experiment", "No active experiment.");
      await drainPackets();
      await ctx.call("packet_capture_stop");
      await ctx.call("packet_rules_clear");
      (exp as any)._unsub?.();
      const done = ctx.store.stop(a.outcome);
      return { ok: true, data: { experiment_id: done.id, records: done.records.length, packets_sent: done.packetsSent, file: done.file } };
    },
  });
  add({
    name: "mc_finding_record", kind: "meta",
    description: "Writes a finding to findings/<id>/finding.md (+ experiment.jsonl, finding.json) from a finished experiment: reproduction steps are generated from the recorded actions. severity_guess: cosmetic | gameplay | economy-breaking | server-stability | security. Local files only; nothing is uploaded.",
    shape: {
      title: z.string().min(3).max(120), severity_guess: z.enum(SEVERITIES), summary: z.string().min(1).max(4000),
      experiment_id: z.string().min(1).max(120), expected: z.string().max(2000).optional(), actual: z.string().max(2000).optional(),
      mitigation: z.string().max(2000).optional(), notes: z.string().max(4000).optional(),
    },
    handler: async (a) => {
      const st = await ctx.call("status");
      const environment = {
        minecraft: (st.data as any)?.minecraft_version ?? "unknown (bridge offline)",
        server_address: (st.data as any)?.server_address ?? null,
        client: "AUTISM Client 5.0 (see NOTES.md for pinned commit)",
        addon: "autism-mcp-bridge 1.0.0",
        server_software: "Paper (local test server, see NOTES.md)",
      };
      try {
        const r = ctx.store.recordFinding({
          title: a.title, severity: a.severity_guess as Severity, summary: a.summary, experimentId: a.experiment_id,
          notes: a.notes, environment, expected: a.expected, actual: a.actual, mitigation: a.mitigation,
        });
        return { ok: true, data: r };
      } catch (e) {
        return fail("finding_failed", (e as Error).message);
      }
    },
  });
  add({
    name: "mc_finding_list", kind: "meta",
    description: "Lists recorded findings: id, title, severity, date and number of replays. Read-only.",
    shape: {}, handler: async () => ({ ok: true, data: { findings: ctx.store.listFindings() } }),
  });
  add({
    name: "mc_finding_get", kind: "meta",
    description: "Returns a finding's markdown, metadata and the number of experiment records. Read-only.",
    shape: { id: z.string().min(1).max(120) },
    handler: async (a) => {
      try {
        return { ok: true, data: ctx.store.getFinding(a.id) };
      } catch (e) {
        return fail("not_found", (e as Error).message);
      }
    },
  });
  add({
    name: "mc_finding_replay", kind: "action",
    description:
      "Re-executes a finding's recorded actions and C2S packets in order (using recorded tick gaps, each capped at 100 ticks) against the current world, then compares the item deltas between the first and last snapshot with the original run. Replay only runs while connected to an allowed target. Set reset=true to restore the world backup and reconnect first (local test server only). Records the result as 'n of m replays matched' in the finding.",
    shape: { id: z.string().min(1).max(120), reset: z.boolean().default(false) },
    handler: async (a) => {
      if (ctx.store.active) return fail("experiment_active", "Stop the active experiment before replaying.");
      let recs;
      try {
        recs = ctx.store.findingRecords(a.id);
      } catch (e) {
        return fail("not_found", (e as Error).message);
      }
      const st0 = await ctx.call("status");
      if (!st0.ok) return st0;
      if (a.reset) {
        const rr = await resetWorld(ctx);
        if (!rr.ok) return rr;
      }
      const st = await ctx.call("status");
      const addr = (st.data as any)?.server_address;
      if (!st.ok || !(st.data as any)?.in_world) return fail("not_in_world", "The client must be in a world on an allowed target to replay.");
      if (addr && !isTargetAllowed(ctx.cfg, addr)) return fail("target_not_allowed", `Connected server '${hostOf(addr)}' is not in allowed_targets.`);

      const snaps = recs.filter((r) => r.type === "snapshot").map((r) => r.payload as any);
      const exp = ctx.store.start(`replay-${a.id}`, `Replay of ${a.id}`);
      const before = await takeSnapshot("replay_start", 2);
      const log: any[] = [];
      let lastTick: number | null = null;
      for (const r of recs.filter((x) => x.type === "action")) {
        const p = r.payload as any;
        if (!p.op || p.tool === "mc_connect") continue;
        if (p.op === "packet_send") {
          if (!ctx.packetBucket.take()) await new Promise((res) => setTimeout(res, 1000 / ctx.cfg.packetsPerSecond));
          exp.packetsSent++;
        }
        if (ctx.store.checkLimits()) break;
        if (lastTick !== null && r.tick > lastTick) {
          await ctx.call("wait_ticks", { ticks: Math.min(100, r.tick - lastTick) }, 15000);
        }
        lastTick = r.tick;
        const res = await ctx.call(p.op, p.args ?? {});
        ctx.store.record("action", res.tick ?? -1, { tool: p.tool, op: p.op, args: p.args, ok: res.ok, error: res.error });
        log.push({ tool: p.tool, ok: res.ok, error: res.error?.code });
      }
      await ctx.call("wait_ticks", { ticks: 10 }, 5000);
      const after = await takeSnapshot("replay_end", 2);
      ctx.store.stop("replay finished");

      const first = snaps[0];
      const last = snaps[snaps.length - 1];
      const orig = first && last ? diffSnapshots(first, last).items : null;
      const repl = before.ok && after.ok ? diffSnapshots(before.snap, after.snap).items : null;
      const key = (x: any) => JSON.stringify((x ?? []).map((i: any) => [i.item, i.delta]).sort());
      const matched = orig !== null && repl !== null && key(orig) === key(repl);
      const tally = ctx.store.addReplayResult(a.id, matched, { original_items: orig, replay_items: repl, steps: log });
      return { ok: true, data: { matched, reproducibility: `${tally.n} of ${tally.m}`, original_item_delta: orig, replay_item_delta: repl, steps: log } };
    },
  });
  add({
    name: "mc_reset_world_state", kind: "action",
    description: "Local test server only: disconnects the client, stops the test server, restores the world backup taken by scripts/world-backup.sh, restarts the server and reconnects the client, so experiments start from the same state. Takes up to ~2 minutes. Fails if the scripts or backup are missing.",
    shape: {},
    handler: async () => resetWorld(ctx),
  });

  return tools;
}

function runScript(path: string, args: string[], timeoutMs: number): Promise<{ code: number | null; out: string }> {
  return new Promise((res) => {
    const p = spawn(path, args, { stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    const t = setTimeout(() => p.kill("SIGTERM"), timeoutMs);
    p.stdout.on("data", (d) => (out += d));
    p.stderr.on("data", (d) => (out += d));
    p.on("close", (code) => {
      clearTimeout(t);
      res({ code, out: out.slice(-2000) });
    });
    p.on("error", (e) => {
      clearTimeout(t);
      res({ code: -1, out: String(e) });
    });
  });
}

export async function resetWorld(ctx: Context): Promise<ToolResult> {
  const script = resolve(ctx.cfg.scriptsDir, "world-restore.sh");
  if (!existsSync(script)) return fail("script_missing", "scripts/world-restore.sh not found.");
  await ctx.call("disconnect");
  const r = await runScript(script, [], 150_000);
  if (r.code !== 0) return fail("restore_failed", `world-restore.sh exited with ${r.code}: ${r.out}`);
  const c = await ctx.call("connect", { address: "127.0.0.1:25565" });
  if (!c.ok) return c;
  return new Promise<ToolResult>((resolveP) => {
    const off = ctx.bridge.onEvent((ev) => {
      if (ev.event !== "game_join") return;
      clearTimeout(timer);
      off();
      resolveP({ ok: true, data: { reset: true } });
    });
    const timer = setTimeout(() => {
      off();
      resolveP(fail("timeout", "Client did not rejoin within 60 s after the reset."));
    }, 60000);
  });
}
