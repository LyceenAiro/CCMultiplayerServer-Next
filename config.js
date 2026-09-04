// Lightweight server configuration loader.
//
// Reads config.json from the server root at require time. A missing or broken
// config file must never prevent the server from booting, so any read/parse
// failure falls back to the defaults below (with a warning logged).
//
// Config keys (config.json):
//   monsterHpPerPlayer  extra max-HP fraction added to enemies per ADDITIONAL
//                       player IN THE ROOM (1.75.x: room player count, not the
//                       party roster). 0.7 = +70% HP per extra player, so a
//                       3-player room faces enemies at x2.4 HP. Clients receive
//                       this as `hpScale` in the handshakeResponse and apply it
//                       using their room player count.
//   monsterBossHpPerPlayer
//                       extra max-HP fraction for BOSS enemies ONLY (enemyType
//                       .boss on the client), same per-ADDITIONAL-player scheme.
//                       Default 1.0 = +100% max HP per extra player (a 3-player
//                       room faces bosses at x3 HP). Sent as hpScaleBoss in
//                       the handshakeResponse; regular enemies keep using
//                       monsterHpPerPlayer.
//   monsterBreakPerPlayer
//                       extra hit-count break threshold fraction per ADDITIONAL
//                       player in the room. 0.7 = +70% per extra player. Sent as
//                       breakScale in the handshakeResponse.
//   monsterStatusThresholdPerPlayer
//                       extra elemental-status THRESHOLD fraction per ADDITIONAL
//                       player in the room. 0.6 = +60% bar-fill required per
//                       extra player (the enemy's statusInflict susceptibility is
//                       divided by 1 + 0.6 * extra). Sent as statusScale in the
//                       handshakeResponse.
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
//   softDeathReviveHpNormal / softDeathReviveHpBoss
//                       HP fraction restored on a soft-death revive. Normal field /
//                       non-boss combat revives use the former (default 0.5 = 50%);
//                       revives while a boss fight is active use the latter
//                       (default 0.25 = 25%). Range [0.01, 1].
//   softDeathReviveTimeNormal / softDeathReviveTimeBoss
//                       soft-death revive countdown in SECONDS. Normal combat uses
//                       the former, boss combat the latter; both default to 30.
//                       Range [1, 3600]. Out-of-combat deaths keep the built-in
//                       ~3s quick revive and are not configurable. All four values
//                       are sent to clients under the same names in the
//                       handshakeResponse.
//   perfectGuardBaseMs  member-side perfect-guard compensation, BASE grace in
//                       MILLISECONDS: after a monster's hit lands on a member,
//                       raising guard within this window still counts as a PERFECT
//                       guard (the hit deals no damage while the window is open).
//                       Default 10; 0 disables the base part; negatives clamp to 0.
//   perfectGuardPingFactor
//                       member-side perfect-guard compensation, NETWORK part: the
//                       window above is extended by factor x the member's measured
//                       round-trip latency to the host (0.6 x ping by default).
//                       Stacks with perfectGuardBaseMs. 0 disables the network
//                       part; negatives clamp to 0. Both values are sent to
//                       clients in the handshakeResponse.
const fs = require('fs');
const path = require('path');

const CONFIG_FILE = path.join(__dirname, 'config.json');

const DEFAULTS = {
	monsterHpPerPlayer: 0.7,
	// 1.76.x: separate per-extra-member HP increment for bosses (enemyType.boss);
	// default +100% per extra party member.
	monsterBossHpPerPlayer: 1.0,
	monsterBreakPerPlayer: 0.7,
	monsterStatusThresholdPerPlayer: 0.6,
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
	// 1.78.x (admin security): /admin is LOCAL-ONLY by default (127.0.0.1 / ::1
	// always pass). List extra client IPs here to allow admin access from other
	// devices. Entries: exact IPs ("203.0.113.7"), a trailing-* prefix for a
	// whole LAN ("192.168.1.*"), or "*" to disable the restriction entirely
	// (NOT recommended). The peer IP is read from the SOCKET, never from
	// X-Forwarded-For (spoofable). IPv6-mapped IPv4 is normalized
	// (::ffff:1.2.3.4 matches 1.2.3.4).
	adminAllowIps: [],
	// 1.74.x (player collision): whether online players collide with each other.
	// false (default) = players NEVER block each other (walk-through everywhere,
	// not just towns/cutscenes). true = normal player-vs-player collision.
	playerCollision: false,
	softDeathReviveHpNormal: 0.5,
	softDeathReviveHpBoss: 0.25,
	softDeathReviveTimeNormal: 30,
	softDeathReviveTimeBoss: 30,
	// Member perfect-guard compensation: base grace window (ms) + ping-scaled
	// extension (factor x RTT). Each part disables at 0; both stack.
	perfectGuardBaseMs: 10,
	perfectGuardPingFactor: 0.6,
	// 1.77.x (player trading): master switch + the exchange LOSS ratio. What the
	// RECEIVER gets = floor(given / tradeRatio) — default 2 means "give 6, the
	// partner receives 3". 1 = lossless 1:1. Range [1, 1000], fractions allowed
	// (2.5 -> give 6, receive floor(6/2.5)=2).
	tradeEnabled: true,
	tradeRatio: 2,
	// Anti-dupe lockout: after a save IMPORT (admin) or a MIRROR rollback the
	// account cannot trade for this many hours (item state was rewound, so
	// trading would duplicate goods). 0 disables the lockout entirely.
	tradeLockHours: 48,
	// 1.78.x (progress wall): map IDs players may NOT enter (mod-undeveloped
	// areas). A client attempting to enter one keeps its current map — the
	// teleport is cancelled BEFORE any load, so the blocked map's story never
	// runs — and gets a "wait for a future update" toast; anyone already inside
	// is bounced back out. Accepts dotted ("heat-dng.f1.midboss") or slashed
	// ("heat-dng/f1/midboss") form, case-insensitive. Empty list = feature off.
	blockedMaps: [],
};

// Round 17: mod version. The server rejects any client whose mod version differs
// (handshake gate in protocol.js). Bump this TOGETHER with the client mod version
// (client src/multiplayer.ts MP_VERSION + package.json "version") on every release.
const MOD_VERSION = '0.2.4';

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
	cfg.monsterBossHpPerPlayer = clampFrac('monsterBossHpPerPlayer', DEFAULTS.monsterBossHpPerPlayer, 10);
	cfg.monsterBreakPerPlayer = clampFrac('monsterBreakPerPlayer', DEFAULTS.monsterBreakPerPlayer, 10);
	cfg.monsterStatusThresholdPerPlayer = clampFrac('monsterStatusThresholdPerPlayer', DEFAULTS.monsterStatusThresholdPerPlayer, 10);
	cfg.monsterAttackPerPlayer = clampFrac('monsterAttackPerPlayer', DEFAULTS.monsterAttackPerPlayer, 10);
	cfg.monsterDefensePerPlayer = clampFrac('monsterDefensePerPlayer', DEFAULTS.monsterDefensePerPlayer, 10);
	cfg.monsterFocusPerPlayer = clampFrac('monsterFocusPerPlayer', DEFAULTS.monsterFocusPerPlayer, 10);
	// resFlat is a resistance FRACTION per extra player (1 = +100 points — capped
	// there); resPercent is a multiplier fraction (10 = +1000%).
	cfg.monsterResistFlatPerPlayer = clampFrac('monsterResistFlatPerPlayer', DEFAULTS.monsterResistFlatPerPlayer, 1);
	cfg.monsterResistPercentPerPlayer = clampFrac('monsterResistPercentPerPlayer', DEFAULTS.monsterResistPercentPerPlayer, 10);
	// Soft-death revive HP fractions: [0.01, 1] so a revive can never produce 0 HP.
	const clampReviveHp = (key, def) => {
		const v = Number(cfg[key]);
		return (isFinite(v) && v >= 0.01 && v <= 1) ? v : def;
	};
	cfg.softDeathReviveHpNormal = clampReviveHp('softDeathReviveHpNormal', DEFAULTS.softDeathReviveHpNormal);
	cfg.softDeathReviveHpBoss = clampReviveHp('softDeathReviveHpBoss', DEFAULTS.softDeathReviveHpBoss);
	// Soft-death revive countdowns: seconds, [1, 3600].
	const clampReviveSec = (key, def) => {
		const v = Number(cfg[key]);
		return (isFinite(v) && v >= 1 && v <= 3600) ? v : def;
	};
	cfg.softDeathReviveTimeNormal = clampReviveSec('softDeathReviveTimeNormal', DEFAULTS.softDeathReviveTimeNormal);
	cfg.softDeathReviveTimeBoss = clampReviveSec('softDeathReviveTimeBoss', DEFAULTS.softDeathReviveTimeBoss);
	// Perfect-guard compensation: non-negative only (0 = that part off). A
	// non-number falls back to the default; a negative clamps to 0; absurd values
	// cap at 5000ms / factor 10 so a typo can't defer member damage forever.
	const clampNonNeg = (key, def, max) => {
		const v = Number(cfg[key]);
		if (!isFinite(v)) return def;
		if (v < 0) return 0;
		return v > max ? max : v;
	};
		cfg.perfectGuardBaseMs = clampNonNeg('perfectGuardBaseMs', DEFAULTS.perfectGuardBaseMs, 5000);
		cfg.perfectGuardPingFactor = clampNonNeg('perfectGuardPingFactor', DEFAULTS.perfectGuardPingFactor, 10);
		// 1.77.x (trading): strict boolean master switch; ratio clamped to [1, 1000]
		// (< 1 would CREATE items out of thin air).
		cfg.tradeEnabled = (cfg.tradeEnabled !== false);
		{
			const r = Number(cfg.tradeRatio);
			cfg.tradeRatio = (isFinite(r) && r >= 1 && r <= 1000) ? r : DEFAULTS.tradeRatio;
		}
		{
			const h = Number(cfg.tradeLockHours);
			cfg.tradeLockHours = (isFinite(h) && h >= 0 && h <= 8760) ? h : DEFAULTS.tradeLockHours;
		}
		// 1.78.x (progress wall): sanitize to a deduped lowercase DOTTED-id list
		// so the changeMap gate here and the client's teleport gate compare one
		// canonical form. Bad entries are dropped silently (a typo must not break
		// the login payload for everyone).
		{
			const out = [];
			const seen = {};
			const list = Array.isArray(cfg.blockedMaps) ? cfg.blockedMaps : [];
			for (let i = 0; i < list.length && out.length < 256; i++) {
				const raw = list[i];
				if (typeof raw !== 'string') continue;
				const id = raw.trim().toLowerCase().split('/').join('.');
				if (!id || id.length > 128 || id.indexOf('..') !== -1 || seen[id]) continue;
				seen[id] = true;
				out.push(id);
			}
			cfg.blockedMaps = out;
		}
		// 1.78.x (admin security): sanitize the admin IP whitelist — lowercase
		// trimmed strings of IP characters only, ::ffff: prefix normalized away,
		// deduped. Bad entries are dropped silently (a typo must not lock the
		// admin out — localhost ALWAYS passes regardless of this list).
		{
			const out = [];
			const seen = {};
			const list = Array.isArray(cfg.adminAllowIps) ? cfg.adminAllowIps : [];
			for (let i = 0; i < list.length && out.length < 128; i++) {
				const raw = list[i];
				if (typeof raw !== 'string') continue;
				let id = raw.trim().toLowerCase();
				if (id.indexOf('::ffff:') === 0) id = id.slice(7);
				if (!id || id.length > 64 || seen[id]) continue;
				if (!/^[0-9a-f:.*]+$/.test(id)) continue;
				seen[id] = true;
				out.push(id);
			}
			cfg.adminAllowIps = out;
		}
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
	' (monsters gain +' + (config.monsterHpPerPlayer * 100) + '% max HP per extra player in the room)' +
	' | monsterBossHpPerPlayer = +' + (config.monsterBossHpPerPlayer * 100) + '% per extra player (bosses)' +
	' | monsterBreakPerPlayer = +' + (config.monsterBreakPerPlayer * 100) + '% per extra player' +
	' | monsterStatusThresholdPerPlayer = +' + (config.monsterStatusThresholdPerPlayer * 100) + '% per extra player' +
	' | atk/def/foc per player = +' + (config.monsterAttackPerPlayer * 100) + '%/+' +
		(config.monsterDefensePerPlayer * 100) + '%/+' + (config.monsterFocusPerPlayer * 100) + '%' +
	' | resist flat/percent per player = +' + (config.monsterResistFlatPerPlayer * 100) + 'pt/+' +
		(config.monsterResistPercentPerPlayer * 100) + '%' +
	' | softDeath revive HP normal/boss = ' + Math.round(config.softDeathReviveHpNormal * 100) + '%/' +
		Math.round(config.softDeathReviveHpBoss * 100) + '%' +
	' | softDeath revive time normal/boss = ' + config.softDeathReviveTimeNormal + 's/' +
		config.softDeathReviveTimeBoss + 's' +
	' | trade = ' + (config.tradeEnabled ? ('on, ratio 1:' + config.tradeRatio + ' (receiver gets floor(n/' + config.tradeRatio + '))') : 'off') +
	' | saveUploadKbS = ' + config.saveUploadKbS +
	' | saveDownloadKbS = ' + config.saveDownloadKbS +
	' | playerCollision = ' + config.playerCollision +
	' | port = ' + config.port);

module.exports = config;
