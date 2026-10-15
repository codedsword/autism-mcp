# autism-mcp

MCP server + Fabric addon that let an AI agent drive and observe [AUTISM Client](https://github.com/AutismDevelopment/Autism-Client)
(Minecraft 26.2) for exploit-hunting research on **local test servers**: run a controlled
experiment, observe state and packets before and after, record a reproducible finding.


## Safety model

- Default and intended target: a local Paper or Fabric server you stand up yourself.
- `allowed_targets` in `config.toml` (default `127.0.0.1`, `localhost`). Both the MCP server and
  the addon refuse to connect, chat, run commands, interact, or send packets against anything else.
- The bridge binds `127.0.0.1` only and requires a random per-session token in a `chmod 600` file.
  Off by default — enable the **MCP Bridge** module in the client.
- Packet tools are rate-limited (hard cap 100/s), experiments have packet/time caps. No flooding,
  no telemetry, no upload. Findings stay in local files.
- No account/credential handling. Use an offline throwaway account.

## Requirements

Linux, Java 25, Node 20+, a Prism Launcher instance of AUTISM Client on Minecraft 26.2 (the client
has no headless mode — it runs on your display). No root needed.

## Setup

You bring your own local test server (Paper or Fabric, `127.0.0.1` or another address listed in
`config.toml`'s `allowed_targets`). `tests/` has optional helper scripts (`server-start.sh`,
`server-stop.sh`, `world-backup.sh`, `world-restore.sh`) for a disposable local Paper instance if
you'd rather not set one up by hand; `scripts/e2e.sh` itself doesn't call them.

```bash
git clone <this repo> && cd autism-mcp          # the client checkout must sit next to it: ../Autism-Client
scripts/build-all.sh                            # client API -> ~/.m2, addon jar, mcp-server build
PRISM_INSTANCE=<your-instance> scripts/install-addon.sh
```

1. Edit `config.toml`: point `[bridge] dir` at `<prism instance>/minecraft/autism-mcp`, and set
   `allowed_targets` to wherever your test server runs.
2. Start your test server. Join it offline-mode with an **offline throwaway account**.
3. `PRISM_INSTANCE=<your-instance> scripts/run-client.sh`, log in the same way, enable the
   **MCP Bridge** module in the client's module menu.
4. Register the MCP server with your agent, e.g. in `.mcp.json`:

```json
{ "mcpServers": { "autism": { "command": "node", "args": ["/abs/path/autism-mcp/mcp-server/dist/index.js"],
  "env": { "AUTISM_MCP_ROOT": "/abs/path/autism-mcp" } } } }
```

## Tools

All tools return JSON `{ok, data | error:{code,message}, tick}`.

| Group | Tools |
|---|---|
| Session | `mc_status`, `mc_connect`, `mc_disconnect`, `mc_wait_ticks`, `mc_wait_for` |
| Observe | `mc_get_state`, `mc_get_inventory`, `mc_get_screen`, `mc_get_entities`, `mc_get_blocks`, `mc_get_block`, `mc_get_chat` |
| Act | `mc_look`, `mc_set_input`, `mc_use_item`, `mc_attack`, `mc_interact_block`, `mc_interact_entity`, `mc_click_slot`, `mc_close_screen`, `mc_drop`, `mc_swap_hands`, `mc_select_slot`, `mc_chat`, `mc_command`, `mc_teleport_via_command` |
| Modules | `mc_list_modules`, `mc_get_module_settings`, `mc_toggle_module`, `mc_set_module_setting` |
| Packets | `mc_packet_capture_start/stop/get`, `mc_packet_send`, `mc_packet_delay`, `mc_packet_drop` |
| Research loop | `mc_experiment_start/snapshot/diff/stop`, `mc_finding_record/list/get/replay`, `mc_reset_world_state` |

Not implemented, on purpose: screenshots (no clean client API), macro list/run (no public entry
point in the client's macro system), S2C packet delay/drop (receive listeners can't cancel).

## Tests

```bash
cd mcp-server && npm test     # MCP layer against a mock bridge
scripts/e2e.sh                # real client + your own test server; launch the client from Prism when prompted
```

## License

GPL-3.0-only (see `LICENSE`); the addon links against AUTISM Client, which is GPL-3.0.
