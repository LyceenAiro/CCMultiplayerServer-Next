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
const fs = require('fs');
const path = require('path');

const CONFIG_FILE = path.join(__dirname, 'config.json');

const DEFAULTS = {
	monsterHpPerPlayer: 0.5,
};

// Round 17: mod version. The server rejects any client whose mod version differs
// (handshake gate in protocol.js). Bump this TOGETHER with the client mod version
// (client src/multiplayer.ts MP_VERSION + package.json "version") on every release.
const MOD_VERSION = '1.20.0';

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
	return cfg;
}

const config = loadConfig();
// Hardcoded (never configurable via config.json): a version mismatch is a BUILD
// mismatch, and every update bumps server + client in lockstep.
config.version = MOD_VERSION;

console.log('[config] multiplayer mod v' + config.version +
	' | monsterHpPerPlayer = ' + config.monsterHpPerPlayer +
	' (monsters gain +' + (config.monsterHpPerPlayer * 100) + '% max HP per extra party member)');

module.exports = config;
