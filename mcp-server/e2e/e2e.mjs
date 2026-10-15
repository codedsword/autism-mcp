// SPDX-License-Identifier: GPL-3.0-only
// End-to-end smoke test: drives the real MCP server over stdio against the real client + local test server.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..", "..");
const transport = new StdioClientTransport({ command: "node", args: [join(root, "mcp-server", "dist", "index.js")], env: { ...process.env, AUTISM_MCP_ROOT: root } });
const client = new Client({ name: "e2e", version: "0" });
await client.connect(transport);

let failures = 0;
const check = (name, cond, extra = "") => {
  console.log(`${cond ? "PASS" : "FAIL"}  ${name}${extra ? "  " + extra : ""}`);
  if (!cond) failures++;
};
const call = async (name, args = {}) => JSON.parse((await client.callTool({ name, arguments: args })).content[0].text);

try {
  let st = await call("mc_status");
  check("bridge reachable", st.ok, st.ok ? "" : JSON.stringify(st.error));
  if (!st.ok) throw new Error("bridge not reachable; launch the client and enable the 'MCP Bridge' module");

  const denied = await call("mc_connect", { address: "example.com:25565" });
  check("non-allowed target refused", !denied.ok && denied.error.code === "target_not_allowed");

  if (!st.data.in_world) {
    const c = await call("mc_connect", { address: "127.0.0.1:25565" });
    check("connect to local test server", c.ok, c.ok ? "" : JSON.stringify(c.error));
    const j = await call("mc_wait_for", { event: "game_join", timeout_ms: 45000 });
    check("joined world", j.ok);
  }
  await call("mc_wait_ticks", { n: 40 });
  const state = await call("mc_get_state");
  check("get_state", state.ok && state.data.position, state.ok ? JSON.stringify(state.data.position) : "");
  const inv = await call("mc_get_inventory");
  check("get_inventory", inv.ok && Array.isArray(inv.data.slots));

  const e = await call("mc_experiment_start", { name: "e2e movement", hypothesis: "holding forward moves the player" });
  check("experiment start", e.ok);
  const expId = e.data.experiment_id;
  await call("mc_set_input", { key: "forward", ticks: 20 });
  await call("mc_wait_ticks", { n: 30 });
  await call("mc_chat", { message: "e2e hello" });
  await call("mc_wait_ticks", { n: 10 });
  const snap = await call("mc_experiment_snapshot", { label: "after" });
  check("snapshot", snap.ok);
  const diff = await call("mc_experiment_diff", { label_a: "start", label_b: "after" });
  const moved = diff.ok && diff.data.position && (Math.abs(diff.data.position.dx) + Math.abs(diff.data.position.dz)) > 0.5;
  check("player moved", moved, diff.ok ? JSON.stringify(diff.data.position) : "");
  const stop = await call("mc_experiment_stop", { outcome: "e2e finished" });
  check("experiment stop", stop.ok);
  const rec = await call("mc_finding_record", { title: "e2e movement check", severity_guess: "cosmetic", summary: "Smoke test finding", experiment_id: expId });
  check("finding recorded", rec.ok && existsSync(join(rec.data.dir, "finding.md")));
  const rep = await call("mc_finding_replay", { id: rec.data.id });
  check("finding replay executed", rep.ok, rep.ok ? rep.data.reproducibility : JSON.stringify(rep.error));
  const md = readFileSync(join(rec.data.dir, "finding.md"), "utf8");
  check("finding has reproduction steps", md.includes("mc_set_input"));
} catch (err) {
  console.error("e2e aborted:", err.message);
  failures++;
} finally {
  await client.close();
}
console.log(failures === 0 ? "E2E PASSED" : `E2E FAILED (${failures})`);
process.exit(failures === 0 ? 0 : 1);
