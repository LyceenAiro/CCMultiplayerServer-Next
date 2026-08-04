# CCMultiplayerServer

> English | [中文版本](README.zh-CN.md)

[![Discord Server](https://img.shields.io/discord/382339402338402315.svg?label=Discord%20Server)](https://discord.gg/SJmMZKy)

Relay server for the CrossCode multiplayer mod,
[CCMultiplayerClient](https://github.com/CCDirectLink/CCMultiplayerClient).

It is a small Node.js + socket.io **message relay**: clients never talk to each
other directly, every position/animation/entity update is sent here and
forwarded to the other players on the same map. The server also elects the
**host** client (the first to connect) and handles **host migration** when the
host disconnects.

> **Status:** compatible with the revived client. The server is game-version
> agnostic — the wire protocol did not change between CrossCode 1.1.0 and
> 1.4.2, so no code changes were needed for the 1.4.2 / CCLoader v2 update. It was
> re-verified against `socket.io-client@4.8.x` with a live handshake test.

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

The server listens on port **1423** by default. Override with the `PORT`
environment variable:

```bash
PORT=8080 npm start
```

Then point the client's `config/config.json` at it, e.g.:

```json
{ "hostname": "your-server-ip", "port": 1423, "type": "http" }
```

## How it works

- `server.js` sets up the HTTP + socket.io listener and hands each new
  connection to `user.js`.
- `user.js` tracks connected users, their current map and position, and the
  elected host. It relays the mod's events (`changeMap`, `updatePosition`,
  `updateAnimation`, `registerEntity`, `updateEntity*`, `throwBall`,
  `killEntity`, …) to the other users on the same map.
- `userUtilities.js` / `cmd.js` provide helpers and an optional interactive
  console.
- The server also serves static game files from a local `./game` folder under
  `/data/*` and `/media/*` (used for development; not required for a normal
  relay).

For the full event list see the client README's
[Network protocol](https://github.com/CCDirectLink/CCMultiplayerClient#network-protocol)
section.

## Built With

- [Node.js](https://nodejs.org/en/docs/) — JavaScript runtime
- [socket.io](https://socket.io/) — realtime transport
- [express](https://expressjs.com/) — static file serving
