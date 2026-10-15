// SPDX-License-Identifier: GPL-3.0-only
import { mkdirSync, writeFileSync, mkdtempSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WebSocketServer, type WebSocket } from "ws";

export interface MockOptions {
  token?: string;
  handlers?: Record<string, (args: any) => any>;
}

/** A scripted stand-in for the in-client bridge: same wire protocol, fake game state. */
export class MockBridge {
  readonly requests: { op: string; args: any }[] = [];
  readonly root: string;
  private wss!: WebSocketServer;
  private sockets = new Set<WebSocket>();
  tick = 100;
  inventory: any = { window_id: 0, state_id: 1, slots: [{ slot: 36, item: "minecraft:diamond", count: 1 }], carried: { item: "minecraft:air", count: 0 } };
  address = "localhost:25565";
  captured: any[] = [];

  constructor(private opts: MockOptions = {}) {
    this.root = mkdtempSync(join(tmpdir(), "autism-mcp-test-"));
  }

  async start(): Promise<void> {
    const token = this.opts.token ?? "testtoken";
    this.wss = new WebSocketServer({
      host: "127.0.0.1",
      port: 0,
      verifyClient: (info, cb) => cb(info.req.headers["x-autism-token"] === token, 401, "Unauthorized"),
    });
    await new Promise<void>((r) => this.wss.once("listening", () => r()));
    const port = (this.wss.address() as any).port;
    mkdirSync(join(this.root, ".bridge"), { recursive: true });
    writeFileSync(join(this.root, ".bridge", "port"), String(port));
    writeFileSync(join(this.root, ".bridge", "token"), token);
    chmodSync(join(this.root, ".bridge", "token"), 0o600);
    writeFileSync(join(this.root, "config.toml"), 'allowed_targets = ["127.0.0.1", "localhost"]\n[limits]\npackets_per_second = 5\npacket_burst = 3\nexperiment_max_packets = 4\n');
    this.wss.on("connection", (ws) => {
      this.sockets.add(ws);
      ws.on("close", () => this.sockets.delete(ws));
      ws.on("message", (buf) => this.onMessage(ws, JSON.parse(buf.toString())));
    });
  }

  emit(event: string, data: any = {}): void {
    for (const s of this.sockets) s.send(JSON.stringify({ event, tick: this.tick, data }));
  }

  private onMessage(ws: WebSocket, req: any): void {
    this.requests.push({ op: req.op, args: req.args });
    this.tick += 1;
    const reply = (ok: boolean, data?: any, error?: any) => ws.send(JSON.stringify({ id: req.id, ok, data, error, tick: this.tick }));
    const h = this.opts.handlers?.[req.op];
    if (h) {
      try {
        return reply(true, h(req.args));
      } catch (e) {
        return reply(false, undefined, { code: "mock_error", message: String(e) });
      }
    }
    switch (req.op) {
      case "status": return reply(true, { minecraft_version: "26.2", in_world: true, server_address: this.address, player_name: "Tester" });
      case "get_state": return reply(true, { position: { x: 10.5, y: 64, z: -3.5 }, health: 20, hunger: 20, gamemode: "SURVIVAL", dimension: "overworld" });
      case "get_inventory": return reply(true, this.inventory);
      case "get_entities": return reply(true, { entities: [], truncated: false });
      case "get_blocks": return reply(true, { blocks: [{ x: 10, y: 63, z: -4, state: "Block{minecraft:stone}" }] });
      case "packet_capture_start": this.captured = []; return reply(true, { capturing: true });
      case "packet_capture_get": return reply(true, { packets: this.captured.filter((p) => p.seq > (req.args.since ?? 0)), truncated: false });
      case "packet_capture_stop": case "packet_rules_clear": return reply(true, {});
      case "wait_ticks": return reply(true, { waited_until_tick: this.tick + req.args.ticks });
      case "click_slot":
        this.inventory = { ...this.inventory, slots: [...this.inventory.slots, { slot: 37, item: "minecraft:diamond", count: 63 }] };
        return reply(true, { done: true });
      case "packet_send": return reply(true, { class: req.args.type, sent: !req.args.dry_run, fields: {} });
      default: return reply(true, { done: true });
    }
  }

  async stop(): Promise<void> {
    for (const s of this.sockets) s.close();
    await new Promise<void>((r) => this.wss.close(() => r()));
  }
}
