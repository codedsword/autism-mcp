#!/usr/bin/env bash
# SPDX-License-Identifier: GPL-3.0-only
# Downloads (once) and starts a Paper test server on 127.0.0.1:25565 in ./testserver, offline mode, fixed seed.
source "$(dirname "$0")/lib.sh"

if [[ "$(toml_get eula_accepted)" != "true" ]]; then
  cat >&2 <<MSG
The Minecraft EULA has not been accepted.
Read https://aka.ms/MinecraftEULA and, if you agree, set  eula_accepted = true  in $ROOT/config.toml
under [server]. This script never accepts it for you.
MSG
  exit 2
fi
if server_running; then echo "server already running (pid $(cat "$SERVER_DIR/server.pid"))"; exit 0; fi

mkdir -p "$SERVER_DIR"
cd "$SERVER_DIR"

if [[ ! -f paper.jar ]]; then
  echo "Resolving latest stable Paper build for $MC_VERSION ..."
  meta="$(curl -fsSL "https://fill.papermc.io/v3/projects/paper/versions/$MC_VERSION/builds")"
  # newest STABLE build; fall back to newest build of any channel (noted in the output)
  build="$(jq -c '[.[] | select(.channel=="STABLE")][0] // .[0]' <<<"$meta")"
  url="$(jq -r '.downloads["server:default"].url' <<<"$build")"
  sha="$(jq -r '.downloads["server:default"].checksums.sha256' <<<"$build")"
  id="$(jq -r '.id' <<<"$build")"; channel="$(jq -r '.channel' <<<"$build")"
  [[ "$url" != "null" && -n "$url" ]] || { echo "no Paper build found for $MC_VERSION" >&2; exit 1; }
  echo "Downloading Paper $MC_VERSION build $id ($channel)"
  curl -fsSL "$url" -o paper.jar.tmp
  echo "$sha  paper.jar.tmp" | sha256sum -c - >/dev/null || { echo "checksum mismatch" >&2; rm -f paper.jar.tmp; exit 1; }
  mv paper.jar.tmp paper.jar
  echo "paper $MC_VERSION build $id ($channel) sha256=$sha" > paper.version
fi

echo "eula=true" > eula.txt   # only reached when the user set eula_accepted = true in config.toml
cat > server.properties <<PROPS
online-mode=false
server-ip=127.0.0.1
server-port=25565
level-seed=$WORLD_SEED
level-name=world
gamemode=survival
difficulty=normal
spawn-protection=0
enable-rcon=false
motd=autism-mcp local test server
max-players=2
enforce-secure-profile=false
PROPS

# offline UUID for the throwaway player, op level 4
uuid="$(python3 - "$TEST_PLAYER" <<'PY'
import hashlib,sys,uuid
h=bytearray(hashlib.md5(("OfflinePlayer:"+sys.argv[1]).encode()).digest())
h[6]=(h[6]&0x0f)|0x30; h[8]=(h[8]&0x3f)|0x80
print(uuid.UUID(bytes=bytes(h)))
PY
)"
printf '[{"uuid":"%s","name":"%s","level":4,"bypassesPlayerLimit":false}]\n' "$uuid" "$TEST_PLAYER" > ops.json

rm -f console.fifo; mkfifo console.fifo
: > "$LOG_DIR/server.log"
# keep the fifo open for writing so the server never sees EOF on stdin
( exec 3<>console.fifo; exec tail -f /dev/null >/dev/null 2>&1 ) &
echo $! > fifo-holder.pid
nohup java -Xms1G -Xmx2G -jar paper.jar --nogui < console.fifo >> "$LOG_DIR/server.log" 2>&1 &
echo $! > server.pid

echo -n "Waiting for the server to finish starting"
for _ in $(seq 1 180); do
  if grep -q 'Done (' "$LOG_DIR/server.log" 2>/dev/null; then echo; echo "server up on 127.0.0.1:25565 (op: $TEST_PLAYER)"; exit 0; fi
  server_running || { echo; echo "server exited early; see $LOG_DIR/server.log" >&2; tail -20 "$LOG_DIR/server.log" >&2; exit 1; }
  echo -n "."; sleep 1
done
echo; echo "timed out waiting for 'Done'; see $LOG_DIR/server.log" >&2; exit 1
