// SPDX-License-Identifier: GPL-3.0-only
import { appendFileSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { BridgeClient, type BridgeReply } from "./bridge.js";
import type { Config } from "./config.js";
import { ExperimentStore } from "./experiments.js";
import { TokenBucket } from "./ratelimit.js";

export interface ToolResult {
  ok: boolean;
  data?: unknown;
  error?: { code: string; message: string };
  tick?: number;
}

export const MAX_RESULT_CHARS = 60_000;

export class Context {
  readonly store: ExperimentStore;
  readonly packetBucket: TokenBucket;
  readonly actionBucket: TokenBucket;
  private auditFile: string;

  constructor(readonly cfg: Config, readonly bridge: BridgeClient) {
    this.store = new ExperimentStore(cfg);
    this.packetBucket = new TokenBucket(cfg.packetsPerSecond, cfg.packetBurst);
    this.actionBucket = new TokenBucket(50, 100);
    mkdirSync(cfg.logsDir, { recursive: true });
    this.auditFile = resolve(cfg.logsDir, "audit.jsonl");
    // Close the active experiment as 'aborted' if the bridge drops.
    bridge.onClose(() => {
      if (this.store.active) {
        try {
          this.store.stop("aborted: bridge connection lost");
        } catch { /* ignore */ }
      }
    });
  }

  audit(tool: string, args: unknown, result: ToolResult): void {
    const line = { ts: new Date().toISOString(), tool, args, ok: result.ok, error: result.error?.code, tick: result.tick };
    try {
      appendFileSync(this.auditFile, JSON.stringify(line) + "\n");
    } catch { /* never fail a tool because auditing failed */ }
  }

  async call(op: string, args: Record<string, unknown> = {}, timeoutMs = 5000): Promise<ToolResult> {
    const r: BridgeReply = await this.bridge.request(op, args, timeoutMs);
    return r.ok ? { ok: true, data: r.data, tick: r.tick } : { ok: false, error: r.error, tick: r.tick };
  }
}

export function fail(code: string, message: string): ToolResult {
  return { ok: false, error: { code, message } };
}

/** Bounds output size; arrays are shortened first, then the whole payload is replaced with a marker. */
export function bound(value: unknown, maxChars = MAX_RESULT_CHARS): unknown {
  let text = JSON.stringify(value);
  if (text.length <= maxChars) return value;
  const copy = JSON.parse(text);
  const shrink = (v: any): boolean => {
    let changed = false;
    if (Array.isArray(v) && v.length > 20) {
      v.length = Math.ceil(v.length / 2);
      changed = true;
    }
    if (v && typeof v === "object") for (const k of Object.keys(v)) changed = shrink(v[k]) || changed;
    return changed;
  };
  const original = text.length;
  for (let i = 0; i < 8 && text.length > maxChars; i++) {
    if (!shrink(copy)) break;
    text = JSON.stringify(copy);
  }
  if (text.length <= maxChars) {
    if (copy && typeof copy === "object" && !Array.isArray(copy)) {
      copy.truncated = true;
      copy.original_chars = original;
    }
    return copy;
  }
  return { truncated: true, original_chars: original, preview: text.slice(0, 2000) };
}
