// SPDX-License-Identifier: GPL-3.0-only
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { BridgeClient } from "../src/bridge.js";
import { loadConfig, isTargetAllowed } from "../src/config.js";
import { Context, bound } from "../src/context.js";
import { createServer } from "../src/index.js";
import { buildTools } from "../src/tools.js";
import { MockBridge } from "./mockBridge.js";

let mock: MockBridge;
let ctx: Context;
let client: Client;

async function call(name: string, args: Record<string, unknown> = {}): Promise<any> {
  const r: any = await client.callTool({ name, arguments: args });
  return JSON.parse(r.content[0].text);
}

beforeAll(async () => {
  mock = new MockBridge();
  await mock.start();
  const cfg = loadConfig(mock.root);
  ctx = new Context(cfg, new BridgeClient(cfg));
  const server = createServer(ctx);
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(a);
  client = new Client({ name: "test", version: "0" });
  await client.connect(b);
});

afterAll(async () => {
  ctx.bridge.close();
  await mock.stop();
});

describe("config and scope", () => {
  it("defaults to localhost and 127.0.0.1 and honours the hard pps cap", () => {
    const cfg = loadConfig(mock.root);
    expect(cfg.allowedTargets).toEqual(["127.0.0.1", "localhost"]);
    expect(isTargetAllowed(cfg, "localhost:25565")).toBe(true);
    expect(isTargetAllowed(cfg, "play.example.com")).toBe(false);
    expect(cfg.packetsPerSecond).toBe(5);
  });
});

describe("tool surface", () => {
  it("lists every spec tool with a description and schema", async () => {
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name);
    for (const n of ["mc_status", "mc_connect", "mc_disconnect", "mc_wait_ticks", "mc_wait_for", "mc_get_state", "mc_get_inventory",
      "mc_get_entities", "mc_get_blocks", "mc_get_block", "mc_get_chat", "mc_look", "mc_set_input", "mc_use_item", "mc_attack",
      "mc_interact_block", "mc_interact_entity", "mc_click_slot", "mc_close_screen", "mc_drop", "mc_swap_hands", "mc_select_slot",
      "mc_chat", "mc_command", "mc_teleport_via_command", "mc_list_modules", "mc_get_module_settings", "mc_toggle_module",
      "mc_set_module_setting", "mc_packet_capture_start", "mc_packet_capture_stop", "mc_packet_capture_get", "mc_packet_send",
      "mc_packet_delay", "mc_packet_drop", "mc_experiment_start", "mc_experiment_snapshot", "mc_experiment_diff",
      "mc_experiment_stop", "mc_finding_record", "mc_finding_list", "mc_finding_get", "mc_finding_replay", "mc_reset_world_state"]) {
      expect(names, n).toContain(n);
    }
    for (const t of tools) {
      expect(t.description!.length, t.name).toBeGreaterThan(30);
      expect(t.inputSchema.type).toBe("object");
    }
  });

  it("does not expose login/OpSec surface", async () => {
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).join(" ")).not.toMatch(/login|account|microsoft|discord|hide|opsec|spoof/i);
    expect(buildTools(ctx).length).toBe(tools.length);
  });
});

describe("validation and scope enforcement", () => {
  it("rejects schema violations", async () => {
    await expect(client.callTool({ name: "mc_select_slot", arguments: { slot: 99 } })).resolves.toMatchObject({ isError: true });
    await expect(client.callTool({ name: "mc_get_entities", arguments: { radius: 9999 } })).resolves.toMatchObject({ isError: true });
  });

  it("refuses connect to a host outside allowed_targets without touching the bridge", async () => {
    const before = mock.requests.length;
    const r = await call("mc_connect", { address: "mc.hypixel.net:25565" });
    expect(r.ok).toBe(false);
    expect(r.error.code).toBe("target_not_allowed");
    expect(mock.requests.length).toBe(before);
  });

  it("allows localhost connect", async () => {
    const r = await call("mc_connect", { address: "localhost:25565" });
    expect(r.ok).toBe(true);
    expect(mock.requests.at(-1)!.op).toBe("connect");
  });

  it("refuses packet sends when the connected server is not allowed", async () => {
    mock.address = "evil.example.net:25565";
    const r = await call("mc_packet_send", { type: "ServerboundChatCommandPacket", args: "command=hi" });
    mock.address = "localhost:25565";
    expect(r.ok).toBe(false);
    expect(r.error.code).toBe("target_not_allowed");
  });

  it("rate limits packet sends (burst 3)", async () => {
    const results = [];
    for (let i = 0; i < 6; i++) results.push(await call("mc_packet_send", { type: "ServerboundChatCommandPacket", args: "command=hi", dry_run: false }));
    expect(results.some((r) => r.ok)).toBe(true);
    expect(results.some((r) => !r.ok && r.error.code === "rate_limited")).toBe(true);
  });

  it("returns a structured error when the bridge is gone", async () => {
    const cfg = loadConfig(mock.root);
    cfg.bridgeDir = join(mock.root, "nope");
    const lonely = new Context(cfg, new BridgeClient(cfg));
    const r = await lonely.call("status");
    expect(r.ok).toBe(false);
    expect(r.error!.code).toBe("bridge_unavailable");
  });
});

describe("observation and events", () => {
  it("returns state and inventory", async () => {
    const s = await call("mc_get_state");
    expect(s.ok).toBe(true);
    expect(s.data.position.y).toBe(64);
    expect(typeof s.tick).toBe("number");
    const inv = await call("mc_get_inventory");
    expect(inv.data.slots[0].item).toBe("minecraft:diamond");
  });

  it("wait_for resolves on a pushed event and times out otherwise", async () => {
    const p = call("mc_wait_for", { event: "game_join", timeout_ms: 2000 });
    setTimeout(() => mock.emit("game_join", { ok: 1 }), 100);
    const r = await p;
    expect(r.ok).toBe(true);
    expect(r.data.event).toBe("game_join");
    const t = await call("mc_wait_for", { event: "never", timeout_ms: 150 });
    expect(t.error.code).toBe("timeout");
  });
});

describe("experiment loop", () => {
  let expId = "";
  let findingId = "";

  it("runs snapshot, action, snapshot, diff, stop, record", async () => {
    const st = await call("mc_experiment_start", { name: "dupe test", hypothesis: "shift-click duplicates" });
    expect(st.ok).toBe(true);
    expId = st.data.experiment_id;
    mock.captured.push({ seq: 1, tick: 105, dir: "C2S", class: "ServerboundContainerClickPacket", fields: { slotNum: "37" } });
    await call("mc_click_slot", { slot: 37, mode: "QUICK_MOVE" });
    const snap = await call("mc_experiment_snapshot", { label: "after" });
    expect(snap.ok).toBe(true);
    expect(snap.data.packets_recorded).toBe(1);
    const diff = await call("mc_experiment_diff", { label_a: "start", label_b: "after" });
    expect(diff.data.items).toEqual([{ item: "minecraft:diamond", before: 1, after: 64, delta: 63 }]);
    expect(diff.data.identical).toBe(false);
    const stop = await call("mc_experiment_stop", { outcome: "gained 63 diamonds" });
    expect(stop.ok).toBe(true);
    expect(existsSync(stop.data.file)).toBe(true);
    const lines = readFileSync(stop.data.file, "utf8").trim().split("\n").map((l) => JSON.parse(l));
    const types = new Set(lines.map((l) => l.type));
    expect(types.has("snapshot")).toBe(true);
    expect(types.has("action")).toBe(true);
    expect(types.has("packet_c2s")).toBe(true);
  });

  it("records a finding with reproduction steps", async () => {
    const r = await call("mc_finding_record", {
      title: "Quick-move dupes diamond", severity_guess: "economy-breaking", summary: "63 extra diamonds",
      experiment_id: expId, expected: "1 diamond", actual: "64 diamonds",
    });
    expect(r.ok).toBe(true);
    findingId = r.data.id;
    const md = readFileSync(join(r.data.dir, "finding.md"), "utf8");
    expect(md).toContain("mc_click_slot");
    expect(md).toContain("economy-breaking");
    const list = await call("mc_finding_list");
    expect(list.data.findings.map((f: any) => f.id)).toContain(findingId);
    const got = await call("mc_finding_get", { id: findingId });
    expect(got.data.markdown).toContain("Quick-move dupes diamond");
  });

  it("replays the finding and updates reproducibility", async () => {
    mock.inventory = { window_id: 0, state_id: 1, slots: [{ slot: 36, item: "minecraft:diamond", count: 1 }], carried: { item: "minecraft:air", count: 0 } };
    const r = await call("mc_finding_replay", { id: findingId });
    expect(r.ok).toBe(true);
    expect(r.data.matched).toBe(true);
    expect(r.data.reproducibility).toBe("1 of 1");
    const md = readFileSync(join(loadConfig(mock.root).findingsDir, findingId, "finding.md"), "utf8");
    expect(md).toContain("1 of 1 replays matched");
  });

  it("writes an audit log of action calls", () => {
    const log = readFileSync(join(mock.root, "logs", "audit.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
    expect(log.some((l) => l.tool === "mc_click_slot")).toBe(true);
    expect(log.some((l) => l.tool === "mc_connect" && l.ok === false)).toBe(true);
  });
});

describe("output bounding", () => {
  it("truncates oversized payloads with a marker", () => {
    const big = { items: Array.from({ length: 5000 }, (_, i) => ({ i, pad: "x".repeat(50) })) };
    const b: any = bound(big, 20000);
    expect(JSON.stringify(b).length).toBeLessThanOrEqual(20000 + 100);
    expect(b.truncated).toBe(true);
  });
});
