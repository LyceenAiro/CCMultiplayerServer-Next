# CCMultiplayerServer-Next

> English | [中文版本](README.zh-CN.md)

[![Discord Server](https://img.shields.io/discord/382339402338402315.svg?label=Discord%20Server)](https://discord.gg/SJmMZKy)

Relay server for the CrossCode multiplayer mod,
[CCMultiplayerClient-Next](https://github.com/LyceenAiro/CCMultiplayerClient-Next),
forked from [CCMultiplayerServer](https://github.com/CCDirectLink/CCMultiplayerServer).

It is a Node.js + socket.io **message relay** and **session authority**: clients
never talk to each other directly. Position / animation / entity / combat
updates are sent here and forwarded to the other players on the same map
instance. The server also elects the **host**, migrates it when the host leaves,
and owns accounts, cloud saves, parties, friends, trading and admin tools.

> **Current release: 3.0.4.** Must match the client handshake version.
> The server is game-version agnostic (CrossCode 1.1.0 and 1.4.2 share the same
> wire style), but the Next fork is a large extension of the original relay —
> see the feature notes below.

## Requirements

- [Node.js](https://nodejs.org/en/download/) ≥ 14

## Installing

```bash
npm install
```

## Running

```bash
npm start
# or: node server.js
```

Default listen port is **15151** (`config.json` → `port`). Override with the
`PORT` environment variable:

```bash
PORT=8080 npm start
```

Then point the client's `config/config.json` at it, e.g.:

```json
{ "hostname": "your-server-ip", "port": 15151, "type": "http" }
```

## How it works

- `server.js` sets up Express + socket.io, loads config, and wires
  `protocol.js` / `admin.js` / static game-file routes.
- `protocol.js` is the main socket surface: handshake, map instances, entity
  and combat relays, social/trade, save streams, ping, etc.
- `world.js` manages map instances, host election and host migration.
- `party.js` / `friends.js` handle party rosters and friend lists.
- `accounts.js` + `persistence.js` + `savecodec.js` store accounts, passwords,
  friendships and per-user cloud saves under `data/`.
- `traffic.js` enforces relay rate caps (field vs town) on the hot streams.
- `config.js` loads `config.json` (with safe defaults if the file is missing).
- Optional `./game` folder is served under `/data/*` and `/media/*` for
  development only (not required for a normal relay).

### Notable server-side features

- **Accounts & cloud saves** — login streams the auto-slot save; uploads are
  chunked and rate-limited. Optional per-account password and lock state.
- **Save mirrors** — last **five distinct save images** per player; the client
  can restore one via `saveMirrorRestore`.
- **Parties & friends** — invite/accept/leave/kick, leader transfer, friend
  requests.
- **Trading** — server-mediated trade with configurable ratio and a lockout
  after save import / mirror rollback (anti-dupe).
- **Progress wall** — `blockedMaps` refuses entry to unfinished maps and can
  bounce players already inside (client then returns them to a safe hub).
- **Soft-death revive tuning** — HP fraction / countdown for normal and boss
  combat, pushed to clients in the handshake.
- **Monster scaling** — per-extra-player HP / break / status / ATK / DEF / FOC
  (and optional resist) multipliers, sent as handshake tuning.
- **Admin web UI** — `/admin` when `adminToken` is set (default localhost-only;
  extend with `adminAllowIps`).
- **AFK kick** — separate field/town timeouts; **maxPlayers** cap.
- **Ping / net badges** — `mpPing` / `netPing` for client HUDs.

### Versioned protocol notes (historical)

- **1.71.0** save mirrors; **1.71.2** `puzzleState` grip ownership
  (`own`/`ot`); **1.71.3** PushPullDest / solved boxes stay personal save state
  (legacy `pl`/`dl` accepted but unused); **1.71.7** `questKill` cross-map under
  story sync; **1.71.9** `enemySoundStop` for looped enemy sounds.

For the full event groups see the client README's
[Network protocol](https://github.com/LyceenAiro/CCMultiplayerClient-Next#network-protocol)
section.

## Configuration (`config.json`)

Missing keys fall back to defaults. Important knobs:

| Key | Default | Meaning |
| --- | --- | --- |
| `port` | `15151` | TCP listen port (`PORT` env overrides) |
| `maxPlayers` | `20` | max concurrent logins |
| `playerCollision` | `false` | players walk through each other when false |
| `monsterHpPerPlayer` / `monsterBossHpPerPlayer` | `0.7` / `1.0` | extra max-HP fraction per extra player in the room |
| `monsterAttackPerPlayer` / `Defense` / `Focus` | `0.1` | same scheme for ATK/DEF/FOC |
| `monsterStatusThresholdPerPlayer` | `0.6` | harder elemental status per extra player |
| `softDeathReviveHpNormal` / `…Boss` | `0.5` / `0.25` | revive HP fraction |
| `softDeathReviveTimeNormal` / `…Boss` | `30` / `30` | revive countdown seconds |
| `perfectGuardBaseMs` / `perfectGuardPingFactor` | `10` / `0.6` | member perfect-guard compensation |
| `tradeEnabled` / `tradeRatio` / `tradeLockHours` | `true` / `2` / `48` | trading + anti-dupe lockout |
| `relayMaxTickField` / `relayMaxTickTown` | `30` / `10` | max Hz for hot streams |
| `healHz` | `1` | self-heal heartbeat for hot streams |
| `saveUploadKbS` / `saveDownloadKbS` | `16384` | save bandwidth caps |
| `afkFieldMinutes` / `afkTownMinutes` | `120` / `720` | AFK disconnect timeouts |
| `blockedMaps` | `[]` | progress-wall map IDs (current: `autumn-fall.path-01`) |
| `adminToken` | empty | enables `/admin` when non-empty |
| `adminAllowIps` | `[]` | extra IPs for `/admin` (localhost always allowed) |

Restart the server after editing `config.json`.

## Built With

- [Node.js](https://nodejs.org/en/docs/) — JavaScript runtime
- [socket.io](https://socket.io/) — realtime transport
- [express](https://expressjs.com/) — static file serving + admin UI

## Authors / Contributors

- **[2767mr](https://github.com/2767mr)** — initial work on
  [CCMultiplayerServer](https://github.com/CCDirectLink/CCMultiplayerServer)
- **[Vankerkom](https://github.com/Vankerkom)** — various suggestions on
  [CCMultiplayerServer](https://github.com/CCDirectLink/CCMultiplayerServer)
- **[LyceenAiro](https://github.com/LyceenAiro)** — continued development,
  testing and maintenance (CCMultiplayerServer-Next)

## License

This project is licensed under the MIT License — see the [LICENSE](LICENSE)
file for details.
