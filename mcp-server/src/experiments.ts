// SPDX-License-Identifier: GPL-3.0-only
import { appendFileSync, mkdirSync, existsSync, readFileSync, writeFileSync, readdirSync, copyFileSync } from "node:fs";
import { resolve } from "node:path";
import type { Config } from "./config.js";

export type RecordType = "action" | "event" | "packet_c2s" | "packet_s2c" | "snapshot";

export interface RecordLine {
  t: number; // wall clock ms
  tick: number;
  type: RecordType;
  payload: unknown;
}

export interface Experiment {
  id: string;
  name: string;
  hypothesis: string;
  startedAt: number;
  packetsSent: number;
  lastPacketSeq: number;
  records: RecordLine[];
  snapshots: Map<string, any>;
  file: string;
}

export type Severity = "cosmetic" | "gameplay" | "economy-breaking" | "server-stability" | "security";

function slug(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40) || "experiment";
}

export class ExperimentStore {
  active: Experiment | null = null;
  private counter = 0;

  constructor(private cfg: Config) {}

  private dir(...p: string[]): string {
    return resolve(this.cfg.findingsDir, ...p);
  }

  start(name: string, hypothesis: string): Experiment {
    if (this.active) throw new Error(`Experiment '${this.active.id}' is still active; stop it first.`);
    const id = `${new Date().toISOString().replace(/[-:T]/g, "").slice(0, 14)}-${slug(name)}-${++this.counter}`;
    const dir = this.dir("_experiments", id);
    mkdirSync(dir, { recursive: true });
    const exp: Experiment = {
      id, name, hypothesis, startedAt: Date.now(), packetsSent: 0, lastPacketSeq: 0,
      records: [], snapshots: new Map(), file: resolve(dir, "experiment.jsonl"),
    };
    writeFileSync(resolve(dir, "meta.json"), JSON.stringify({ id, name, hypothesis, startedAt: exp.startedAt }, null, 2));
    this.active = exp;
    return exp;
  }

  record(type: RecordType, tick: number, payload: unknown): void {
    const exp = this.active;
    if (!exp) return;
    if (Date.now() - exp.startedAt > this.cfg.experimentMaxSeconds * 1000) return; // caps enforced via checkLimits
    const line: RecordLine = { t: Date.now(), tick, type, payload };
    exp.records.push(line);
    appendFileSync(exp.file, JSON.stringify(line) + "\n");
  }

  /** Returns an error message if the active experiment exceeded its caps. */
  checkLimits(): string | null {
    const exp = this.active;
    if (!exp) return null;
    if (Date.now() - exp.startedAt > this.cfg.experimentMaxSeconds * 1000) {
      return `Experiment exceeded its ${this.cfg.experimentMaxSeconds}s duration cap; stop it.`;
    }
    if (exp.packetsSent >= this.cfg.experimentMaxPackets) {
      return `Experiment reached its cap of ${this.cfg.experimentMaxPackets} sent packets; stop it.`;
    }
    return null;
  }

  stop(outcome: string): Experiment {
    const exp = this.active;
    if (!exp) throw new Error("No active experiment.");
    this.record("event", -1, { kind: "experiment_stop", outcome });
    writeFileSync(
      resolve(this.dir("_experiments", exp.id), "meta.json"),
      JSON.stringify({ id: exp.id, name: exp.name, hypothesis: exp.hypothesis, startedAt: exp.startedAt, stoppedAt: Date.now(), outcome, records: exp.records.length }, null, 2),
    );
    this.active = null;
    return exp;
  }

  loadExperimentRecords(experimentId: string): RecordLine[] {
    const f = this.dir("_experiments", experimentId, "experiment.jsonl");
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(experimentId) || !existsSync(f)) throw new Error(`Unknown experiment '${experimentId}'.`);
    return readFileSync(f, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as RecordLine);
  }

  // ---- findings --------------------------------------------------------------------------------

  recordFinding(input: {
    title: string; severity: Severity; summary: string; experimentId: string; notes?: string;
    environment: Record<string, unknown>; expected?: string; actual?: string; mitigation?: string;
  }): { id: string; dir: string } {
    const records = this.loadExperimentRecords(input.experimentId);
    const meta = JSON.parse(readFileSync(this.dir("_experiments", input.experimentId, "meta.json"), "utf8"));
    const id = `${new Date().toISOString().slice(0, 10)}-${slug(input.title)}`;
    let finalId = id;
    for (let n = 2; existsSync(this.dir(finalId)); n++) finalId = `${id}-${n}`;
    const dir = this.dir(finalId);
    mkdirSync(dir, { recursive: true });
    copyFileSync(this.dir("_experiments", input.experimentId, "experiment.jsonl"), resolve(dir, "experiment.jsonl"));

    const actions = records.filter((r) => r.type === "action");
    const packets = records.filter((r) => r.type === "packet_c2s");
    const snaps = records.filter((r) => r.type === "snapshot");
    const steps = actions.map((a, i) => {
      const p = a.payload as any;
      return `${i + 1}. [tick ${a.tick}] \`${p.tool}\` ${JSON.stringify(p.args)}${p.ok === false ? " (failed: " + (p.error?.message ?? "?") + ")" : ""}`;
    });
    const pk = new Map<string, number>();
    for (const r of packets) {
      const c = String((r.payload as any)?.class ?? "?");
      pk.set(c, (pk.get(c) ?? 0) + 1);
    }
    const md = [
      `# ${input.title}`,
      ``,
      `- **id:** ${finalId}`,
      `- **date:** ${new Date().toISOString()}`,
      `- **severity guess:** ${input.severity}`,
      `- **experiment:** ${input.experimentId} (${meta.name})`,
      `- **reproducibility:** not yet replayed (0 of 0)`,
      ``,
      `## Environment`,
      "```json", JSON.stringify(input.environment, null, 2), "```",
      ``,
      `## Hypothesis`, meta.hypothesis || "(none)", ``,
      `## Summary`, input.summary, ``,
      `## Exact reproduction steps`,
      steps.length ? steps.join("\n") : "(no actions were recorded)", ``,
      `## Expected vs actual`,
      `**Expected:** ${input.expected ?? "(not stated)"}`, ``,
      `**Actual:** ${input.actual ?? "(not stated)"}`, ``,
      `## Observed diff`,
      `Snapshots recorded: ${snaps.map((s) => (s.payload as any)?.label).join(", ") || "none"}`,
      `Use \`mc_experiment_diff\` on the experiment for a structured diff.`, ``,
      `## Packets involved (C2S)`,
      pk.size ? [...pk].map(([c, n]) => `- ${c} x${n}`).join("\n") : "(none recorded)", ``,
      `## Suggested mitigation`, input.mitigation ?? "(none)", ``,
      `## Notes`, input.notes ?? "", ``,
    ].join("\n");
    writeFileSync(resolve(dir, "finding.md"), md);
    writeFileSync(resolve(dir, "finding.json"), JSON.stringify({
      id: finalId, title: input.title, severity: input.severity, experimentId: input.experimentId,
      date: new Date().toISOString(), environment: input.environment, replays: [],
    }, null, 2));
    return { id: finalId, dir };
  }

  listFindings(): { id: string; title: string; severity: string; date: string; replays: number }[] {
    if (!existsSync(this.cfg.findingsDir)) return [];
    return readdirSync(this.cfg.findingsDir)
      .filter((d) => !d.startsWith("_") && existsSync(this.dir(d, "finding.json")))
      .map((d) => {
        const j = JSON.parse(readFileSync(this.dir(d, "finding.json"), "utf8"));
        return { id: j.id, title: j.title, severity: j.severity, date: j.date, replays: (j.replays ?? []).length };
      });
  }

  getFinding(id: string): { markdown: string; meta: any; records: number } {
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(id) || !existsSync(this.dir(id, "finding.md"))) throw new Error(`Unknown finding '${id}'.`);
    return {
      markdown: readFileSync(this.dir(id, "finding.md"), "utf8"),
      meta: JSON.parse(readFileSync(this.dir(id, "finding.json"), "utf8")),
      records: readFileSync(this.dir(id, "experiment.jsonl"), "utf8").split("\n").filter(Boolean).length,
    };
  }

  findingRecords(id: string): RecordLine[] {
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(id) || !existsSync(this.dir(id, "experiment.jsonl"))) throw new Error(`Unknown finding '${id}'.`);
    return readFileSync(this.dir(id, "experiment.jsonl"), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as RecordLine);
  }

  addReplayResult(id: string, matched: boolean, detail: unknown): { n: number; m: number } {
    const f = this.dir(id, "finding.json");
    const j = JSON.parse(readFileSync(f, "utf8"));
    j.replays = [...(j.replays ?? []), { at: new Date().toISOString(), matched, detail }];
    writeFileSync(f, JSON.stringify(j, null, 2));
    const m = j.replays.length;
    const n = j.replays.filter((r: any) => r.matched).length;
    const mdFile = this.dir(id, "finding.md");
    const md = readFileSync(mdFile, "utf8").replace(/- \*\*reproducibility:\*\* .*/, `- **reproducibility:** ${n} of ${m} replays matched`);
    writeFileSync(mdFile, md);
    return { n, m };
  }
}

// ---- diffing ------------------------------------------------------------------------------------

function itemMap(inv: any): Map<string, number> {
  const m = new Map<string, number>();
  for (const s of inv?.slots ?? []) m.set(s.item, (m.get(s.item) ?? 0) + (s.count ?? 0));
  if (inv?.carried?.count) m.set(inv.carried.item, (m.get(inv.carried.item) ?? 0) + inv.carried.count);
  return m;
}

export function diffSnapshots(a: any, b: any): any {
  const ia = itemMap(a?.inventory);
  const ib = itemMap(b?.inventory);
  const items: { item: string; before: number; after: number; delta: number }[] = [];
  for (const k of new Set([...ia.keys(), ...ib.keys()])) {
    const before = ia.get(k) ?? 0;
    const after = ib.get(k) ?? 0;
    if (before !== after) items.push({ item: k, before, after, delta: after - before });
  }
  const pa = a?.state?.position;
  const pb = b?.state?.position;
  const position = pa && pb
    ? { dx: pb.x - pa.x, dy: pb.y - pa.y, dz: pb.z - pa.z }
    : null;
  const blocksA = new Map<string, string>((a?.blocks ?? []).map((x: any) => [`${x.x},${x.y},${x.z}`, x.state]));
  const blocksB = new Map<string, string>((b?.blocks ?? []).map((x: any) => [`${x.x},${x.y},${x.z}`, x.state]));
  const blocks: any[] = [];
  for (const k of new Set([...blocksA.keys(), ...blocksB.keys()])) {
    if (blocksA.get(k) !== blocksB.get(k)) blocks.push({ pos: k, before: blocksA.get(k) ?? "air", after: blocksB.get(k) ?? "air" });
  }
  const ea = new Map<number, string>((a?.entities ?? []).map((e: any) => [e.id, e.type]));
  const eb = new Map<number, string>((b?.entities ?? []).map((e: any) => [e.id, e.type]));
  const entities = {
    appeared: [...eb].filter(([id]) => !ea.has(id)).map(([id, type]) => ({ id, type })),
    disappeared: [...ea].filter(([id]) => !eb.has(id)).map(([id, type]) => ({ id, type })),
  };
  const stat = (k: string) => (a?.state?.[k] !== b?.state?.[k] ? { before: a?.state?.[k], after: b?.state?.[k] } : undefined);
  return {
    items, position, blocks, entities,
    health: stat("health"), hunger: stat("hunger"), gamemode: stat("gamemode"), dimension: stat("dimension"),
    identical: items.length === 0 && blocks.length === 0 && entities.appeared.length === 0 && entities.disappeared.length === 0
      && (!position || (position.dx === 0 && position.dy === 0 && position.dz === 0)),
  };
}
