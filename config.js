// Lightweight server configuration loader.
//
// Reads config.json from the server root at require time. A missing or broken
// config file must never prevent the server from booting, so any read/parse
// failure falls back to the defaults below (with a warning logged).
//
// Config keys (config.json):
//   monsterHpPerPlayer  extra max-HP fraction added to enemies per ADDITIONAL
//                       party member. 0.7 = +70% HP per extra player, so a
//                       3-player party faces enemies at x2.4 HP. Clients receive
//                       this as `hpScale` in the handshakeResponse and apply it
//                       using their own party roster size.
//   monsterBreakPerPlayer
//                       extra hit-count break threshold fraction per ADDITIONAL
//                       party member. 0.7 = +70% per extra player. Sent as
//                       breakScale in the handshakeResponse.
//   monsterAttackPerPlayer / monsterDefensePerPlayer / monsterFocusPerPlayer
//                       same scheme for the attack/defense/focus stats (default
//                       0.1 = +10% per extra player). Sent as attackScale /
//                       defenseScale / focusScale.
//   monsterResistFlatPerPlayer
//                       FLAT elemental-resistance increase per extra player, as
//                       a fraction (0.1 = +10 percentage points resistance).
//                       Default 0 = no adjustment. Sent as resistFlat.
//   monsterResistPercentPerPlayer
//                       PERCENTAGE elemental-resistance increase per extra
//                       player; applies ONLY to positive resistance (elemFactor
//                       below 1 after the flat boost) and never touches negative
//                       resistance (weakness). Default 0 = no adjustment. Sent
//                       as resistPercent.
//   saveUploadKbS       per-socket save-UPLOAD bandwidth cap in kb/s (saveChunk
//                       token bucket; the client paces itself at ~512 kb/s, well
//                       under this). Range [1, 65536]; default 16384.
//   saveDownloadKbS     per-socket save-DOWNLOAD pacing in kb/s (the login save is
//                       streamed as 8192-char saveDownload parts at this rate).
//                       Range [1, 65536]; default 16384.
//   port                TCP port the server listens on. Range [1, 65535]; default
//                       15151. The process.env.PORT environment variable, when set,
//                       overrides this (handy for a quick one-off launch without
//                       editing config.json).
//   playerCollision     whether online players block each other. false (default)
//                       = players NEVER collide (walk-through everywhere, not just
//                       towns/cutscenes). true = normal player-vs-player collision.
//                       Sent to clients as `playerCollision` in the handshakeResponse.
const fs = require('fs');
const path = require('path');

const CONFIG_FILE = path.join(__dirname, 'config.json');

const DEFAULTS = {
	monsterHpPerPlayer: 0.7,
	monsterBreakPerPlayer: 0.7,
	monsterAttackPerPlayer: 0.1,
	monsterDefensePerPlayer: 0.1,
	monsterFocusPerPlayer: 0.1,
	monsterResistFlatPerPlayer: 0,
	monsterResistPercentPerPlayer: 0,
	saveUploadKbS: 16384,
	saveDownloadKbS: 16384,
	port: 15151,
	// 1.73.0 (admin UI): access token for the /admin web interface. EMPTY =
	// admin UI disabled (safe default). Set any long random string to enable.
	adminToken: '',
	// 1.73.0 (admin UI): teleport presets offered in the debug panel. Each entry:
	// { "label": "显示名", "map": "rookie-harbor.center", "marker": "entrance" }
	// (marker optional; omit to land on the map's default spawn).
	adminTeleports: [],
	// 1.74.x (player collision): whether online players collide with each other.
	// false (default) = players NEVER block each other (walk-through everywhere,
	// not just towns/cutscenes). true = normal player-vs-player collision.
	playerCollision: false,
};

// Round 17: mod version. The server rejects any client whose mod version differs
// (handshake gate in protocol.js). Bump this TOGETHER with the client mod version
// (client src/multiplayer.ts MP_VERSION + package.json "version") on every release.
const MOD_VERSION = '1.74.0';

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
	// Clamp the multipliers to a sane, finite, non-negative range so a typo in the
	// config file (a string, a negative, or Infinity) can't produce absurd factors.
	const clampFrac = (key, def, max) => {
		const v = Number(cfg[key]);
		return (isFinite(v) && v >= 0 && v <= max) ? v : def;
	};
	cfg.monsterHpPerPlayer = clampFrac('monsterHpPerPlayer', DEFAULTS.monsterHpPerPlayer, 10);
	cfg.monsterBreakPerPlayer = clampFrac('monsterBreakPerPlayer', DEFAULTS.monsterBreakPerPlayer, 10);
	cfg.monsterAttackPerPlayer = clampFrac('monsterAttackPerPlayer', DEFAULTS.monsterAttackPerPlayer, 10);
	cfg.monsterDefensePerPlayer = clampFrac('monsterDefensePerPlayer', DEFAULTS.monsterDefensePerPlayer, 10);
	cfg.monsterFocusPerPlayer = clampFrac('monsterFocusPerPlayer', DEFAULTS.monsterFocusPerPlayer, 10);
	// resFlat is a resistance FRACTION per extra player (1 = +100 points — capped
	// there); resPercent is a multiplier fraction (10 = +1000%).
	cfg.monsterResistFlatPerPlayer = clampFrac('monsterResistFlatPerPlayer', DEFAULTS.monsterResistFlatPerPlayer, 1);
	cfg.monsterResistPercentPerPlayer = clampFrac('monsterResistPercentPerPlayer', DEFAULTS.monsterResistPercentPerPlayer, 10);
	// Clamp the save bandwidth caps to a sane finite range [1, 65536] kb/s so a
	// config typo can't turn the save stream into a firehose or a crawl.
	const clampKbS = (key, def) => {
		const v = Number(cfg[key]);
		return (isFinite(v) && v >= 1 && v <= 65536) ? v : def;
	};
	cfg.saveUploadKbS = clampKbS('saveUploadKbS', DEFAULTS.saveUploadKbS);
	cfg.saveDownloadKbS = clampKbS('saveDownloadKbS', DEFAULTS.saveDownloadKbS);
	// Clamp the listen port to a valid TCP range so a config typo can't produce an
	// invalid port that would crash http.listen at boot.
	const p = Number(cfg.port);
	cfg.port = (isFinite(p) && p >= 1 && p <= 65535) ? Math.floor(p) : DEFAULTS.port;
	// adminToken: plain string (may be empty = disabled). adminTeleports: keep only
	// well-formed entries so the admin UI never chokes on config typos.
	cfg.adminToken = (typeof cfg.adminToken === 'string') ? cfg.adminToken : '';
	if (!Array.isArray(cfg.adminTeleports)) cfg.adminTeleports = [];
	cfg.adminTeleports = cfg.adminTeleports.filter((t) =>
		t && typeof t.label === 'string' && typeof t.map === 'string'
		&& /^[\w.\-]{1,64}$/.test(t.map)
		&& (t.marker === undefined || (typeof t.marker === 'string' && t.marker.length <= 64)));
	// playerCollision: strict boolean — only an explicit true enables player
	// collision; anything else (missing key, string, number) means no collision.
	cfg.playerCollision = (cfg.playerCollision === true);
	return cfg;
}

const config = loadConfig();
// Hardcoded (never configurable via config.json): a version mismatch is a BUILD
// mismatch, and every update bumps server + client in lockstep.
config.version = MOD_VERSION;

console.log('[config] multiplayer mod v' + config.version +
	' | monsterHpPerPlayer = ' + config.monsterHpPerPlayer +
	' (monsters gain +' + (config.monsterHpPerPlayer * 100) + '% max HP per extra party member)' +
	' | monsterBreakPerPlayer = +' + (config.monsterBreakPerPlayer * 100) + '% per extra member' +
	' | atk/def/foc per player = +' + (config.monsterAttackPerPlayer * 100) + '%/+' +
		(config.monsterDefensePerPlayer * 100) + '%/+' + (config.monsterFocusPerPlayer * 100) + '%' +
	' | resist flat/percent per player = +' + (config.monsterResistFlatPerPlayer * 100) + 'pt/+' +
		(config.monsterResistPercentPerPlayer * 100) + '%' +
	' | saveUploadKbS = ' + config.saveUploadKbS +
	' | saveDownloadKbS = ' + config.saveDownloadKbS +
	' | playerCollision = ' + config.playerCollision +
	' | port = ' + config.port);

module.exports = config;
