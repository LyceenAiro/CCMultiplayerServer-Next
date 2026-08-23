// 1.73.0 (admin UI): server-side item catalog (id -> localized names), fed by
// whichever game client connects — the server ships no game assets, so the first
// client with a loaded inventory uploads the catalog once and every later client
// only re-uploads when its item count differs. Persisted to data/itemdb.json so
// the admin UI works before any client is online.
const fs = require('fs');
const path = require('path');

const DB_FILE = path.join(__dirname, 'data', 'itemdb.json');
const MAX_ITEMS = 5000;
const MAX_NAME_LEN = 96;
// Catalog FORMAT version: bump when the per-item shape grows (v2 added
// type/equipType/level/params for the admin stat tooltips). A cached catalog
// from an older format counts as STALE in itemdbHello, so the next client
// with a loaded inventory re-uploads even though the item count matches.
const CATALOG_VERSION = 2;

let db = { v: 0, uploadedAt: null, by: null, items: [] };
let writeTimer = null;

(function load() {
	try {
		if (fs.existsSync(DB_FILE)) {
			const raw = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
			if (raw && Array.isArray(raw.items)) db = raw;
		}
	} catch (e) {
		console.warn('[itemdb] failed to load:', e.message);
	}
})();

function scheduleWrite() {
	if (writeTimer) return;
	writeTimer = setTimeout(() => {
		writeTimer = null;
		try { fs.writeFileSync(DB_FILE, JSON.stringify(db)); }
		catch (e) { console.warn('[itemdb] write failed:', e.message); }
	}, 1500);
	if (writeTimer.unref) writeTimer.unref();
}

// Validate + normalize one uploaded catalog entry. Returns null to drop it.
function cleanItem(it) {
	if (!it || typeof it !== 'object') return null;
	const id = Number(it.id);
	if (!Number.isInteger(id) || id < 0 || id > 999999) return null;
	const names = {};
	const src = (it.names && typeof it.names === 'object') ? it.names : {};
	let n = 0;
	for (const k in src) {
		if (n >= 12) break;
		const v = src[k];
		if (/^[a-z]{2}_[A-Z]{2}$/.test(k) && typeof v === 'string' && v.length && v.length <= MAX_NAME_LEN) {
			names[k] = v; n++;
		}
	}
	if (!n && typeof it.name === 'string' && it.name.length && it.name.length <= MAX_NAME_LEN) {
		names.en_US = it.name;
	}
	if (!Object.keys(names).length) return null;
	const out = { id, names };
	// v2: optional stat summary for the admin hover tooltip.
	if (typeof it.type === 'string' && /^[A-Z_]{1,16}$/.test(it.type)) out.type = it.type;
	if (typeof it.equipType === 'string' && /^[A-Z_]{1,16}$/.test(it.equipType)) out.equipType = it.equipType;
	const lv = Number(it.level);
	if (Number.isInteger(lv) && lv > 0 && lv <= 99) out.level = lv;
	const pr = it.params;
	if (pr && typeof pr === 'object') {
		const params = {};
		for (const k of ['hp', 'attack', 'defense', 'focus']) {
			const v = Number(pr[k]);
			if (Number.isFinite(v) && v !== 0 && Math.abs(v) < 100000) params[k] = Math.round(v);
		}
		if (Array.isArray(pr.elemFactor) && pr.elemFactor.length === 4) {
			const ef = pr.elemFactor.map((x) => {
				const v = Number(x);
				return (Number.isFinite(v) && v >= 0 && v <= 10) ? Math.round(v * 100) / 100 : 1;
			});
			params.elemFactor = ef;
		}
		if (Object.keys(params).length) out.params = params;
	}
	return out;
}

function count() { return db.items.length; }
function all() { return db; }

// Wire the two catalog events onto one authed socket (called from protocol).
function bind(socket, getUsername) {
	socket.on('itemdbHello', function (data) {
		try {
			if (!getUsername()) return;
			const c = data && Number(data.count);
			// Ask for an upload only when our cache is missing or clearly stale
			// (different item count — game updates / different client version).
			if (!db.items.length || db.v !== CATALOG_VERSION || (Number.isInteger(c) && c !== db.items.length)) {
				socket.emit('itemdbWant');
			}
		} catch (e) { /* ignore */ }
	});
	let lastUpload = 0;
	socket.on('itemdbUpload', function (data) {
		try {
			const username = getUsername();
			if (!username) return;
			const now = Date.now();
			if (now - lastUpload < 60000) return; // 1/min per socket
			if (!data || !Array.isArray(data.items) || data.items.length > MAX_ITEMS) return;
			const items = [];
			for (const it of data.items) {
				const c = cleanItem(it);
				if (c) items.push(c);
			}
			if (items.length < 100) return; // a partial/corrupt dump never replaces a good one
			lastUpload = now;
			db = { v: CATALOG_VERSION, uploadedAt: new Date().toISOString(), by: username, items };
			scheduleWrite();
			console.log('[itemdb] catalog uploaded by ' + username + ': ' + items.length + ' items');
		} catch (e) { /* ignore */ }
	});
}

module.exports = { bind, count, all };
