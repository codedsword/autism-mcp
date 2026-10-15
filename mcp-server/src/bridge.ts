// SPDX-License-Identifier: GPL-3.0-only
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import WebSocket from "ws";
import type { Config } from "./config.js";

export interface BridgeReply {
  ok: boolean;
  data?: unknown;
  error?: { code: string; message: string };
  tick?: number;
}

export interface BridgeEvent {
  event: string;
  tick: number;
  data: unknown;
}

type Pending = {
  resolve: (r: BridgeReply) => void;
  timer: NodeJS.Timeout;
};

const MAX_EVENT_BUFFER = 2000;

export class BridgeClient {
  private ws: WebSocket | null = null;
  private pending = new Map<number, Pending>();
  private nextId = 1;
  private connecting: Promise<void> | null = null;
  readonly events: BridgeEvent[] = [];
  private listeners = new Set<(e: BridgeEvent) => void>();
  private closeListeners = new Set<() => void>();

  constructor(private cfg: Config) {}

  get connected(): boolean {
    return this.ws?.readyState === WebSocket.OPEN;
  }

  onEvent(fn: (e: BridgeEvent) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  onClose(fn: () => void): () => void {
    this.closeListeners.add(fn);
    return () => this.closeListeners.delete(fn);
  }

  private readEndpoint(): { port: number; token: string } {
    const portFile = resolve(this.cfg.bridgeDir, "port");
    const tokenFile = resolve(this.cfg.bridgeDir, "token");
    if (!existsSync(portFile) || !existsSync(tokenFile)) {
      throw new Error(
        "Bridge files not found. Start the client with the autism-mcp-bridge addon and enable the 'MCP Bridge' module.",
      );
    }
    const port = Number(readFileSync(portFile, "utf8").trim());
    const token = readFileSync(tokenFile, "utf8").trim();
    if (!Number.isInteger(port) || port < 1 || port > 65535 || !token) throw new Error("Bridge port/token files are invalid.");
    return { port, token };
  }

  async connect(): Promise<void> {
    if (this.connected) return;
    if (this.connecting) return this.connecting;
    this.connecting = new Promise<void>((resolveP, reject) => {
      let ep;
      try {
        ep = this.readEndpoint();
      } catch (e) {
        this.connecting = null;
        reject(e);
        return;
      }
      const ws = new WebSocket(`ws://127.0.0.1:${ep.port}/`, {
        headers: { "x-autism-token": ep.token },
        handshakeTimeout: 3000,
      });
      ws.once("open", () => {
        this.ws = ws;
        this.connecting = null;
        resolveP();
      });
      ws.once("error", (err) => {
        this.connecting = null;
        reject(new Error(`Bridge connection failed: ${(err as Error).message}`));
      });
      ws.on("message", (buf) => this.onMessage(buf.toString("utf8")));
      ws.on("close", () => {
        if (this.ws === ws) this.ws = null;
        for (const [id, p] of this.pending) {
          clearTimeout(p.timer);
          p.resolve({ ok: false, error: { code: "bridge_closed", message: "Bridge connection closed." } });
          this.pending.delete(id);
        }
        for (const fn of this.closeListeners) fn();
      });
    });
    return this.connecting;
  }

  private onMessage(text: string): void {
    let msg: any;
    try {
      msg = JSON.parse(text);
    } catch {
      return;
    }
    if (typeof msg.id === "number") {
      const p = this.pending.get(msg.id);
      if (!p) return;
      clearTimeout(p.timer);
      this.pending.delete(msg.id);
      p.resolve({ ok: !!msg.ok, data: msg.data, error: msg.error, tick: msg.tick });
    } else if (typeof msg.event === "string") {
      const ev: BridgeEvent = { event: msg.event, tick: msg.tick ?? -1, data: msg.data };
      this.events.push(ev);
      if (this.events.length > MAX_EVENT_BUFFER) this.events.splice(0, this.events.length - MAX_EVENT_BUFFER);
      for (const fn of this.listeners) fn(ev);
    }
  }

  async request(op: string, args: Record<string, unknown> = {}, timeoutMs = 5000): Promise<BridgeReply> {
    try {
      await this.connect();
    } catch (e) {
      return { ok: false, error: { code: "bridge_unavailable", message: (e as Error).message } };
    }
    const ws = this.ws!;
    const id = this.nextId++;
    return new Promise<BridgeReply>((resolveP) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        resolveP({ ok: false, error: { code: "timeout", message: `Bridge did not answer '${op}' within ${timeoutMs} ms.` } });
      }, timeoutMs);
      this.pending.set(id, { resolve: resolveP, timer });
      ws.send(JSON.stringify({ id, op, args }), (err) => {
        if (err) {
          clearTimeout(timer);
          this.pending.delete(id);
          resolveP({ ok: false, error: { code: "send_failed", message: err.message } });
        }
      });
    });
  }

  close(): void {
    this.ws?.close();
    this.ws = null;
  }
}
