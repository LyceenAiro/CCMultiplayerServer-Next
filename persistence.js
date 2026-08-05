// Persistence layer: JSON-file backed store for accounts/friends/savegames.
// Debounces writes so rapid updates don't hammer the disk, and flushes on exit.
const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, 'data');
const DB_FILE = path.join(DATA_DIR, 'db.json');
const SAVES_DIR = path.join(DATA_DIR, 'saves');
// A pre-rolled "new game" save that every brand-new account starts from
// (罗姆布斯广场-迎新桥, story done, playtime zeroed). Optional: if absent, new
// players simply start fresh.
const DEFAULT_SAVE_FILE = path.join(DATA_DIR, 'default-save.json');

const FLUSH_INTERVAL_MS = 2000;

function Persistence() {
	this.db = { accounts: {} };
	this._dirty = false;
	this._timer = null;

	this._ensureDirs();
	this._load();

	// Best-effort flush on shutdown so we don't lose recent state.
	const flush = () => { try { this.flush(); } catch (e) { /* ignore */ } };
	process.on('exit', flush);
	process.on('SIGINT', () => { flush(); process.exit(0); });
	process.on('SIGTERM', () => { flush(); process.exit(0); });
}

Persistence.prototype._ensureDirs = function () {
	if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
	if (!fs.existsSync(SAVES_DIR)) fs.mkdirSync(SAVES_DIR, { recursive: true });
};

Persistence.prototype._load = function () {
	try {
		if (fs.existsSync(DB_FILE)) {
			const raw = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
			if (raw && raw.accounts) this.db = raw;
		}
	} catch (e) {
		console.error('[persistence] failed to load db.json, starting fresh:', e.message);
	}
};

// Mark dirty and schedule a debounced flush.
Persistence.prototype.save = function () {
	this._dirty = true;
	if (!this._timer) {
		this._timer = setTimeout(() => {
			this._timer = null;
			this.flush();
		}, FLUSH_INTERVAL_MS);
		if (this._timer.unref) this._timer.unref();
	}
};

Persistence.prototype.flush = function () {
	if (!this._dirty) return;
	this._dirty = false;
	try {
		const tmp = DB_FILE + '.tmp';
		fs.writeFileSync(tmp, JSON.stringify(this.db, null, '\t'));
		fs.renameSync(tmp, DB_FILE);
	} catch (e) {
		console.error('[persistence] flush failed:', e.message);
	}
};

// ---- per-user savegame files ----
Persistence.prototype.saveGame = function (username, slot, data) {
	const file = path.join(SAVES_DIR, encodeURIComponent(username) + '.json');
	let existing = {};
	try {
		if (fs.existsSync(file)) existing = JSON.parse(fs.readFileSync(file, 'utf8'));
	} catch (e) { /* overwrite */ }
	existing[slot] = data;
	existing.updatedAt = new Date().toISOString();
	try {
		fs.writeFileSync(file, JSON.stringify(existing, null, '\t'));
	} catch (e) {
		console.error('[persistence] saveGame failed for ' + username + ':', e.message);
	}
};

Persistence.prototype.loadGame = function (username) {
	const file = path.join(SAVES_DIR, encodeURIComponent(username) + '.json');
	try {
		if (fs.existsSync(file)) return JSON.parse(fs.readFileSync(file, 'utf8'));
	} catch (e) {
		console.error('[persistence] loadGame failed for ' + username + ':', e.message);
	}
	return null;
};

// The template new players start from (罗姆布斯广场-迎新桥). Returns the parsed
// default-save.json, or null when no template has been installed.
Persistence.prototype.loadDefaultSave = function () {
	try {
		if (fs.existsSync(DEFAULT_SAVE_FILE)) {
			return JSON.parse(fs.readFileSync(DEFAULT_SAVE_FILE, 'utf8'));
		}
	} catch (e) {
		console.error('[persistence] failed to read default-save.json:', e.message);
	}
	return null;
};

module.exports = new Persistence();
