// Lightweight server configuration loader.
//
// Reads config.json from the server root at require time. A missing or broken
// config file must never prevent the server from booting, so any read/parse
// failure falls back to the defaults below (with a warning logged).
//
// Config keys (config.json):
//   monsterHpPerPlayer  extra max-HP fraction added to enemies per ADDITIONAL
//                       party member. 0.5 = +50% HP per extra player, so a
//                       3-player party faces enemies at x2.0 HP. Clients receive
//                       this as `hpScale` in the handshakeResponse and apply it
//                       using their own party roster size.
//   saveUploadKbS       per-socket save-UPLOAD bandwidth cap in kb/s (saveChunk
//                       token bucket; the client paces itself at ~512 kb/s, well
//                       under this). Range [1, 10240]; default 1024.
//   saveDownloadKbS     per-socket save-DOWNLOAD pacing in kb/s (the login save is
//                       streamed as 8192-char saveDownload parts at this rate).
//                       Range [1, 10240]; default 200.
//   port                TCP port the server listens on. Range [1, 65535]; default
//                       15151. The process.env.PORT environment variable, when set,
//                       overrides this (handy for a quick one-off launch without
//                       editing config.json).
const fs = require('fs');
const path = require('path');

const CONFIG_FILE = path.join(__dirname, 'config.json');

const DEFAULTS = {
	monsterHpPerPlayer: 0.5,
	saveUploadKbS: 1024,
	saveDownloadKbS: 200,
	port: 15151,
};

// Round 17: mod version. The server rejects any client whose mod version differs
// (handshake gate in protocol.js). Bump this TOGETHER with the client mod version
// (client src/multiplayer.ts MP_VERSION + package.json "version") on every release.
const MOD_VERSION = '1.70.16';

function loadConfig() {
	const cfg = Object.assign({}, DEFAULTS);
	try {
		if (fs.existsSync(CONFIG_FILE)) {
			const raw = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
			if (raw && typeof raw === 'object') Object.assign(cfg, raw);
		} else {
			console.warn('[config] ' + CONFIG_FILE + ' not found; using defaults');
		}
	} catch (e) {
		console.warn('[config] failed to read ' + CONFIG_FILE + '; using defaults:', e.message);
	}
	// Clamp the multiplier to a sane, finite, non-negative range so a typo in the
	// config file (a string, a negative, or Infinity) can't produce absurd HP factors.
	const hp = Number(cfg.monsterHpPerPlayer);
	cfg.monsterHpPerPlayer = (isFinite(hp) && hp >= 0 && hp <= 10) ? hp : DEFAULTS.monsterHpPerPlayer;
	// Clamp the save bandwidth caps to a sane finite range [1, 10240] kb/s so a
	// config typo can't turn the save stream into a firehose or a crawl.
	const clampKbS = (key, def) => {
		const v = Number(cfg[key]);
		return (isFinite(v) && v >= 1 && v <= 10240) ? v : def;
	};
	cfg.saveUploadKbS = clampKbS('saveUploadKbS', DEFAULTS.saveUploadKbS);
	cfg.saveDownloadKbS = clampKbS('saveDownloadKbS', DEFAULTS.saveDownloadKbS);
	// Clamp the listen port to a valid TCP range so a config typo can't produce an
	// invalid port that would crash http.listen at boot.
	const p = Number(cfg.port);
	cfg.port = (isFinite(p) && p >= 1 && p <= 65535) ? Math.floor(p) : DEFAULTS.port;
	return cfg;
}

const config = loadConfig();
// Hardcoded (never configurable via config.json): a version mismatch is a BUILD
// mismatch, and every update bumps server + client in lockstep.
config.version = MOD_VERSION;

console.log('[config] multiplayer mod v' + config.version +
	' | monsterHpPerPlayer = ' + config.monsterHpPerPlayer +
	' (monsters gain +' + (config.monsterHpPerPlayer * 100) + '% max HP per extra party member)' +
	' | saveUploadKbS = ' + config.saveUploadKbS +
	' | saveDownloadKbS = ' + config.saveDownloadKbS +
	' | port = ' + config.port);

module.exports = config;
