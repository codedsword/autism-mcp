// SPDX-License-Identifier: GPL-3.0-only
import { readFileSync, existsSync, mkdirSync, copyFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "smol-toml";

export interface Config {
  rootDir: string;
  allowedTargets: string[];
  bridgeDir: string;
  packetsPerSecond: number;
  packetBurst: number;
  experimentMaxPackets: number;
  experimentMaxSeconds: number;
  findingsDir: string;
  logsDir: string;
  scriptsDir: string;
}

const HARD_CAP_PPS = 100;

function expandHome(p: string): string {
  return p === "~" || p.startsWith("~/") ? homedir() + p.slice(1) : p;
}

export function projectRoot(): string {
  if (process.env.AUTISM_MCP_ROOT) return resolve(process.env.AUTISM_MCP_ROOT);
  // dist/ or src/ -> mcp-server -> project root
  return resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
}

export function loadConfig(rootDir = projectRoot()): Config {
  const file = resolve(rootDir, "config.toml");
  const raw = existsSync(file) ? (parse(readFileSync(file, "utf8")) as Record<string, any>) : {};
  const limits = (raw.limits ?? {}) as Record<string, number>;
  const bridge = (raw.bridge ?? {}) as Record<string, string>;
  const targets = Array.isArray(raw.allowed_targets) && raw.allowed_targets.length > 0
    ? (raw.allowed_targets as string[]) : ["127.0.0.1", "localhost"];
  const pps = Math.min(Number(limits.packets_per_second ?? 20), HARD_CAP_PPS);
  return {
    rootDir,
    allowedTargets: targets.map((t) => String(t).toLowerCase()),
    bridgeDir: resolve(rootDir, expandHome(bridge.dir ?? ".bridge")),
    packetsPerSecond: pps > 0 ? pps : 20,
    packetBurst: Math.min(Number(limits.packet_burst ?? 50), 100),
    experimentMaxPackets: Number(limits.experiment_max_packets ?? 5000),
    experimentMaxSeconds: Number(limits.experiment_max_seconds ?? 600),
    findingsDir: resolve(rootDir, "findings"),
    logsDir: resolve(rootDir, "logs"),
    scriptsDir: resolve(rootDir, "scripts"),
  };
}

/** Strip an optional :port and brackets, lowercase. */
export function hostOf(address: string): string {
  let a = address.trim().toLowerCase();
  if (a.startsWith("[")) {
    const end = a.indexOf("]");
    return end > 0 ? a.slice(1, end) : a;
  }
  const idx = a.lastIndexOf(":");
  if (idx > 0 && a.indexOf(":") === idx) a = a.slice(0, idx);
  return a;
}

export function isTargetAllowed(cfg: Config, address: string): boolean {
  return cfg.allowedTargets.includes(hostOf(address));
}

/**
 * The addon cannot see the project dir when the launcher is sandboxed (Flatpak), so the policy file is copied
 * next to port/token in the bridge dir. The addon enforces allowed_targets from this copy.
 */
export function syncConfigToBridge(cfg: Config): void {
  const src = resolve(cfg.rootDir, "config.toml");
  if (!existsSync(src)) return;
  mkdirSync(cfg.bridgeDir, { recursive: true });
  copyFileSync(src, resolve(cfg.bridgeDir, "config.toml"));
}
