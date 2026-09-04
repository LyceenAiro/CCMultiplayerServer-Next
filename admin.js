// 1.73.0: server admin web UI + REST API + debug commands.
//
// Mounted at /admin (server.js). Everything except the static page requires the
// configured adminToken (config.json "adminToken"; empty = admin UI DISABLED).
// 1.78.x (security): the WHOLE mount — static page AND API — is additionally
// IP-gated: localhost only unless config.adminAllowIps whitelists the client IP.
//
// Features:
//   - list players (online status, last-seen, save timestamp)
//   - view a player's decrypted main save: stats + equipment names (itemdb)
//   - switch the main save to one of its mirrors (镜像回档)
//   - export / import the MAIN save only (mirrors are never touched either way)
//   - rename a player (account + friend lists + save file; online player is
//     disconnected so they re-login under the new name)
//   - debug commands to ONLINE players over the game socket (adminCommand /
//     adminAck): giveExp / giveCredits / giveItem / teleport
const fs = require('fs');
const path = require('path');
const express = require('express');
const accounts = require('./accounts');
const config = require('./config');
const persistence = require('./persistence');
const savecodec = require('./savecodec');
const itemdb = require('./itemdb');
const { isValidName } = require('./validate');

const ADMIN_HTML = path.join(__dirname, 'admin.html');

// ---- adminCommand ack tracking ----
const pending = new Map(); // id -> { resolve, timer }
let cmdSeq = 1;
const CMD_TIMEOUT_MS = 5000;

function resolveAck(username, data) {
	try {
		if (!data || typeof data.cmdId !== 'number') return;
		const p = pending.get(data.cmdId);
		if (!p) return;
		pending.delete(data.cmdId);
		clearTimeout(p.timer);
		p.resolve({ ok: data.ok === true, msg: typeof data.msg === 'string' ? data.msg.slice(0, 200) : '' });
	} catch (e) { /* ignore */ }
}

// Emit an adminCommand to an online player and await its adminAck.
function sendCommand(name, payload) {
	return new Promise((resolve) => {
		const sock = accounts.getSocket(name);
		if (!sock) { resolve({ ok: false, msg: '玩家不在线' }); return; }
		const id = cmdSeq++;
		const timer = setTimeout(() => {
			pending.delete(id);
			resolve({ ok: false, msg: '客户端未响应（可能断线或 mod 版本过旧）' });
		}, CMD_TIMEOUT_MS);
		pending.set(id, { resolve, timer });
		try { sock.emit('adminCommand', Object.assign({ cmdId: id }, payload)); }
		catch (e) {
			pending.delete(id); clearTimeout(timer);
			resolve({ ok: false, msg: '发送失败' });
		}
	});
}

// ---- helpers ----
// 1.78.x: password/reset state for the admin page. "game" is the already-loaded
// per-user save object (the password hash lives there); "acc" is the db.json
// account record (reset code + lockout live there). The admin sees the active
// reset CODE (that hand-off is the identity check) but NEVER the password —
// only its salted hash exists and it is not exposed here either.
function passwordState(game, acc) {
	const now = Date.now();
	let reset = null;
	if (acc && acc.resetCode && Number(acc.resetCode.expiresAt) > now && typeof acc.resetCode.code === 'string') {
		reset = { code: acc.resetCode.code, expiresAt: Number(acc.resetCode.expiresAt) };
	}
	return {
		hasPassword: !!(game && game.password && game.password.hash),
		reset,
		resetLockedUntil: (acc && Number(acc.resetLockedUntil) > now) ? Number(acc.resetLockedUntil) : 0,
		// 1.78.x: login brute-force lockout (wrong passwords) — admin can see
		// it here and lift it early via clearLoginLock.
		loginLockedUntil: (acc && Number(acc.loginLockedUntil) > now) ? Number(acc.loginLockedUntil) : 0,
	};
}

function itemName(id) {
	const it = itemdb.all().items.find((x) => x.id === id);
	if (!it) return null;
	return it.names.zh_CN || it.names.zh_TW || it.names.en_US || Object.values(it.names)[0] || null;
}

function summarizeSave(raw) {
	const data = savecodec.decryptSlotData(raw);
	if (!data) return { corrupt: true };
	const p = data.player || {};
	const equip = {};
	if (p.equip && typeof p.equip === 'object') {
		for (const slot of ['head', 'leftArm', 'rightArm', 'torso', 'feet']) {
			const id = p.equip[slot];
			if (typeof id === 'number' && id >= 0) {
				equip[slot] = { id, name: itemName(id) };
			}
		}
	}
	return {
		corrupt: false,
		map: typeof data.map === 'string' ? data.map : '',
		playtime: typeof data.playtime === 'number' ? data.playtime : 0,
		chapter: typeof p.chapter === 'number' ? p.chapter : 0,
		player: {
			level: p.level, exp: p.exp, credit: p.credit, hp: p.hp,
			spLevel: p.spLevel,
			equip,
		},
	};
}

function renamePlayer(oldName, newName) {
	if (!isValidName(newName)) return { ok: false, msg: '新名字不合法（1-24 位：字母/数字/下划线/中文/短横线）' };
	if (oldName === newName) return { ok: false, msg: '新旧名字相同' };
	if (accounts.exists(newName)) return { ok: false, msg: '该名字已被占用' };
	const oldFile = saveFileForPublic(oldName);
	const newFile = saveFileForPublic(newName);
	if (fs.existsSync(newFile)) return { ok: false, msg: '目标名字的存档文件已存在' };
	const db = persistence.db;
	if (!db.accounts[oldName]) return { ok: false, msg: '玩家不存在' };
	// 1) account key
	db.accounts[newName] = db.accounts[oldName];
	delete db.accounts[oldName];
	// 2) every friend/incoming/outgoing list that mentions the old name
	for (const k in db.accounts) {
		const a = db.accounts[k];
		for (const arr of ['friends', 'incoming', 'outgoing']) {
			if (!Array.isArray(a[arr])) continue;
			for (let i = 0; i < a[arr].length; i++) if (a[arr][i] === oldName) a[arr][i] = newName;
		}
	}
	persistence.save();
	// 3) save file (contains mirrors inside the same file — they follow along)
	try {
		if (fs.existsSync(oldFile)) fs.renameSync(oldFile, newFile);
	} catch (e) {
		return { ok: false, msg: '账户已改名但存档文件迁移失败: ' + e.message };
	}
	// 4) an online player must re-login under the new name
	if (accounts.isOnline(oldName)) {
		const sock = accounts.getSocket(oldName);
		try { if (sock) sock.emit('adminRenamed', { name: newName }); } catch (e) { /* ignore */ }
		setTimeout(() => { try { if (sock) sock.disconnect(true); } catch (e) { /* ignore */ } }, 400);
		return { ok: true, msg: '已改名；该玩家在线，已被断开，需用新名字重新登录' };
	}
	return { ok: true, msg: '已改名' };
}

// saveFileFor is module-private in persistence.js — replicate exactly.
function saveFileForPublic(username) {
	let h = 0;
	for (let i = 0; i < username.length; i++) h = ((h * 31 + username.charCodeAt(i)) >>> 0);
	return path.join(__dirname, 'data', 'saves', encodeURIComponent(username) + '.' + h.toString(36) + '.json');
}

// ---- 1.78.x (admin security): IP gate helpers ----
// The peer IP comes from the SOCKET — X-Forwarded-For is NEVER trusted (a
// client can set that header to anything, so honoring it would make the whole
// gate spoofable). localhost ALWAYS passes, whatever the config says, so a
// bad whitelist can never lock the machine's own admin out.
function adminClientIp(req) {
	let ip = (req.socket && req.socket.remoteAddress) || '';
	if (ip.indexOf('::ffff:') === 0) ip = ip.slice(7); // IPv6-mapped IPv4
	return String(ip).toLowerCase();
}
function adminIpAllowed(ip, list) {
	for (let i = 0; i < list.length; i++) {
		const e = list[i];
		if (e === '*') return true;
		if (e.charAt(e.length - 1) === '*') {
			if (ip.indexOf(e.slice(0, -1)) === 0) return true;
		} else if (ip === e) return true;
	}
	return false;
}

// ---- router ----
function createRouter(config) {
	const router = express.Router();

	const token = typeof config.adminToken === 'string' ? config.adminToken : '';
	if (!token) {
		console.warn('[admin] adminToken is empty in config.json — admin UI DISABLED');
		return null;
	}

	// 1.78.x (admin security): IP gate FIRST — covers the static page AND every
	// API route, and runs before the body parser so a denied remote request
	// costs almost nothing. Default LOCAL-ONLY (127.0.0.1 / ::1 always pass);
	// config.adminAllowIps adds remote IPs (exact / trailing-* prefix / '*' =
	// restriction off). Denied requests are logged with their source IP.
	const allowIps = Array.isArray(config.adminAllowIps) ? config.adminAllowIps : [];
	router.use((req, res, next) => {
		const ip = adminClientIp(req);
		if (ip === '127.0.0.1' || ip === '::1' || adminIpAllowed(ip, allowIps)) return next();
		console.warn('[admin] blocked non-local access from ' + (ip || '?') + ' to ' + req.originalUrl);
		res.status(403).json({ ok: false, msg: '管理页面仅允许本机或白名单 IP 访问 (admin access: localhost or whitelisted IPs only)' });
	});
	console.log('[admin] access: localhost only' + (allowIps.length ? ' + whitelist [' + allowIps.join(', ') + ']' : ''));

	router.use(express.json({ limit: '12mb' }));

	router.use('/api', (req, res, next) => {
		const t = req.get('x-admin-token') || req.query.token || '';
		if (t !== token) return res.status(401).json({ ok: false, msg: '未授权：token 错误' });
		next();
	});

	router.get('/', (req, res) => res.sendFile(ADMIN_HTML));

	// players overview (bot companion accounts are never listed — 1.73.0)
	const bots = require('./bots');
	router.get('/api/players', (req, res) => {
		const out = [];
		const db = persistence.db;
		for (const name in db.accounts) {
			if (bots.isBotName(name)) continue;
			const a = db.accounts[name];
			let updatedAt = null;
			let tradeLockUntil = 0;
			let pwGame = null;
			try {
				const g = persistence.loadGame(name);
				pwGame = g;
				if (g && typeof g.updatedAt === 'string') updatedAt = g.updatedAt;
				// Anti-dupe trade lockout deadline (epoch ms, 0 = not locked) — from
				// the same save object loadGame just read; no extra IO.
				const u = g && Number(g.tradeLockedUntil);
				if (isFinite(u) && u > 0) tradeLockUntil = u;
			} catch (e) { /* ignore */ }
			// 1.78.x: password/reset-code state (hash lives in the same save object).
			const pw = passwordState(pwGame, a);
			out.push({ name, online: accounts.isOnline(name), lastSeen: a.lastSeen || null, createdAt: a.createdAt || null, updatedAt, tradeLockUntil, hasPassword: pw.hasPassword, reset: pw.reset, resetLockedUntil: pw.resetLockedUntil, loginLockedUntil: pw.loginLockedUntil });
		}
		out.sort((x, y) => (y.online - x.online) || String(x.name).localeCompare(String(y.name)));
		res.json({ ok: true, players: out, tradeLockHours: config.tradeLockHours });
	});

	// one player's save detail
	router.get('/api/player/:name', (req, res) => {
		const name = req.params.name;
		if (!accounts.exists(name) || bots.isBotName(name)) return res.status(404).json({ ok: false, msg: '玩家不存在' });
		const game = persistence.loadGame(name);
		const save = game && typeof game.autoSlot === 'string' ? summarizeSave(game.autoSlot) : null;
		const pw = passwordState(game, accounts.getAccount(name));
		res.json({
			ok: true, name, online: accounts.isOnline(name),
			save,
			mirrors: persistence.listSaveMirrors(name),
			// 1.78.x: password + active reset-code state for the detail panel.
			hasPassword: pw.hasPassword,
			reset: pw.reset,
			resetLockedUntil: pw.resetLockedUntil,
			loginLockedUntil: pw.loginLockedUntil,
			// Anti-dupe trade lockout: deadline (epoch ms, 0 = not locked) + the
			// configured duration, so the page can show both.
			tradeLockUntil: persistence.getTradeLock(name),
			tradeLockHours: config.tradeLockHours,
		});
	});

	// switch main save to a mirror (镜像回档) — mirrors themselves untouched
	router.post('/api/player/:name/switchMirror', (req, res) => {
		const name = req.params.name;
		if (!accounts.exists(name)) return res.status(404).json({ ok: false, msg: '玩家不存在' });
		const index = req.body && Number(req.body.index);
		if (!Number.isInteger(index) || index < 0) return res.status(400).json({ ok: false, msg: 'index 不合法' });
		const data = persistence.loadSaveMirror(name, index);
		if (typeof data !== 'string' || !savecodec.isEncryptedSlot(data)) {
			return res.status(404).json({ ok: false, msg: '镜像不存在或已损坏' });
		}
		if (!persistence.setMainSave(name, data)) return res.status(500).json({ ok: false, msg: '写入失败' });
		// Anti-dupe: rolling back to a mirror rewinds item state -> trade lockout.
		if (config.tradeLockHours > 0) persistence.lockTrade(name, config.tradeLockHours * 3600000);
		const online = accounts.isOnline(name);
		res.json({ ok: true, msg: (online ? '已切换；该玩家在线，将在其下次登录时生效（或强制下线后立即生效）' : '已切换为指定镜像') + (config.tradeLockHours > 0 ? '；交易功能已锁定 ' + config.tradeLockHours + ' 小时' : '') });
	});

	// export MAIN save only
	router.get('/api/player/:name/export', (req, res) => {
		const name = req.params.name;
		const game = persistence.loadGame(name);
		if (!game || typeof game.autoSlot !== 'string') return res.status(404).json({ ok: false, msg: '该玩家没有主存档' });
		const out = { format: 'cc-multiplayer-save', version: 1, name, exportedAt: new Date().toISOString(), autoSlot: game.autoSlot };
		res.set({ 'Content-Type': 'application/json', 'Content-Disposition': 'attachment; filename="' + encodeURIComponent(name) + '.ccsave.json"' });
		res.send(JSON.stringify(out));
	});

	// import MAIN save only (mirrors preserved as-is)
	router.post('/api/player/:name/import', (req, res) => {
		const name = req.params.name;
		if (!accounts.exists(name)) return res.status(404).json({ ok: false, msg: '玩家不存在' });
		let raw = null;
		const b = req.body;
		if (typeof b === 'string') raw = b;
		else if (b && typeof b.autoSlot === 'string') raw = b.autoSlot;
		else if (b && typeof b.data === 'string') raw = b.data;
		if (!raw || !savecodec.isEncryptedSlot(raw) || !savecodec.decryptSlotData(raw)) {
			return res.status(400).json({ ok: false, msg: '存档内容无效（不是可识别的游戏存档）' });
		}
		if (!persistence.setMainSave(name, raw)) return res.status(500).json({ ok: false, msg: '写入失败' });
		// Anti-dupe: importing a save rewinds item state -> trade lockout.
		if (config.tradeLockHours > 0) persistence.lockTrade(name, config.tradeLockHours * 3600000);
		const online = accounts.isOnline(name);
		res.json({ ok: true, msg: (online ? '已导入主存档（镜像未动）；该玩家在线，将在其下次登录时生效' : '已导入主存档（镜像未动）') + (config.tradeLockHours > 0 ? '；交易功能已锁定 ' + config.tradeLockHours + ' 小时' : '') });
	});

	// rename
	router.post('/api/player/:name/rename', (req, res) => {
		const name = req.params.name;
		const newName = req.body && typeof req.body.newName === 'string' ? req.body.newName.trim() : '';
		if (!accounts.exists(name)) return res.status(404).json({ ok: false, msg: '玩家不存在' });
		res.json(renamePlayer(name, newName));
	});

	// clear the anti-dupe trade lockout (admin override). Clears the save-file
	// deadline (authoritative); when the player is ONLINE we also push a live
	// clearTradeLock command so their local trade gate opens without re-login.
	router.post('/api/player/:name/clearTradeLock', async (req, res) => {
		const name = req.params.name;
		if (!accounts.exists(name) || bots.isBotName(name)) return res.status(404).json({ ok: false, msg: '玩家不存在' });
		if (!persistence.clearTradeLock(name)) return res.status(500).json({ ok: false, msg: '写入失败' });
		let msg = '交易锁定已解除';
		if (accounts.isOnline(name)) {
			const ack = await sendCommand(name, { kind: 'clearTradeLock' });
			msg += ack.ok ? '（在线玩家已实时生效）' : '（在线玩家本地未确认：' + ack.msg + '；最迟其下次登录时生效）';
		}
		res.json({ ok: true, msg, tradeLockUntil: persistence.getTradeLock(name) });
	});

	// 1.78.x: force-clear a player's login password (admin override). Removes the
	// scrypt hash from the per-user save file AND wipes any pending reset code /
	// lockout, so the account becomes password-less: its next login runs the
	// client's forced set-password flow. An online player keeps their current
	// (already-authenticated) session — the gate applies at the NEXT handshake.
	router.post('/api/player/:name/clearPassword', (req, res) => {
		const name = req.params.name;
		if (!accounts.exists(name) || bots.isBotName(name)) return res.status(404).json({ ok: false, msg: '玩家不存在' });
		if (!persistence.clearPassword(name)) return res.status(500).json({ ok: false, msg: '写入失败' });
		const acc = accounts.getAccount(name);
		if (acc) {
			delete acc.resetCode;
			acc.resetFails = [];
			delete acc.resetLockedUntil;
			// 1.78.x: also wipe the login brute-force state (fresh start).
			acc.loginFails = [];
			delete acc.loginLockedUntil;
			persistence.save();
		}
		console.log('[admin] password cleared for ' + name);
		res.json({ ok: true, msg: '密码已清除' + (accounts.isOnline(name) ? '；该玩家当前在线，本次会话不受影响' : '') + '；下次登录将要求设置新密码' });
	});

	// 1.78.x: lift a login brute-force lockout early (admin override). Clears
	// the rolling fail window AND the lock deadline; the password itself is
	// untouched. Works for offline players too (the gate applies at handshake).
	router.post('/api/player/:name/clearLoginLock', (req, res) => {
		const name = req.params.name;
		if (!accounts.exists(name) || bots.isBotName(name)) return res.status(404).json({ ok: false, msg: '玩家不存在' });
		accounts.clearLoginState(name);
		console.log('[admin] login lock cleared for ' + name);
		res.json({ ok: true, msg: '登录锁定已解除' });
	});

	// ---- debug commands (require online) ----
	const needOnline = (req, res) => {
		const name = req.params.name;
		if (!accounts.exists(name)) { res.status(404).json({ ok: false, msg: '玩家不存在' }); return null; }
		if (!accounts.isOnline(name)) { res.status(409).json({ ok: false, msg: '玩家不在线' }); return null; }
		return name;
	};
	const clampInt = (v, lo, hi) => {
		const n = Number(v);
		return (Number.isFinite(n) && n >= lo && n <= hi) ? Math.floor(n) : null;
	};

	router.post('/api/online/:name/giveExp', async (req, res) => {
		const name = needOnline(req, res); if (!name) return;
		const amount = clampInt(req.body && req.body.amount, 1, 1000000);
		if (amount === null) return res.status(400).json({ ok: false, msg: '数量不合法（1-1000000）' });
		res.json(await sendCommand(name, { kind: 'giveExp', amount }));
	});
	router.post('/api/online/:name/giveCredits', async (req, res) => {
		const name = needOnline(req, res); if (!name) return;
		const amount = clampInt(req.body && req.body.amount, 1, 9999999);
		if (amount === null) return res.status(400).json({ ok: false, msg: '数量不合法（1-9999999）' });
		res.json(await sendCommand(name, { kind: 'giveCredits', amount }));
	});
	router.post('/api/online/:name/giveItem', async (req, res) => {
		const name = needOnline(req, res); if (!name) return;
		const id = clampInt(req.body && req.body.id, 0, 999999);
		const amount = clampInt(req.body && req.body.amount, 1, 99);
		if (id === null || amount === null) return res.status(400).json({ ok: false, msg: '物品/数量不合法' });
		if (!itemName(id)) return res.status(400).json({ ok: false, msg: '未知物品 id（物品库可能尚未由客户端上传）' });
		res.json(await sendCommand(name, { kind: 'giveItem', id, amount }));
	});
	router.post('/api/online/:name/godMode', async (req, res) => {
		const name = needOnline(req, res); if (!name) return;
		const on = !!(req.body && req.body.on);
		res.json(await sendCommand(name, { kind: 'godMode', on }));
	});
	// 1.77.x: reset the map the player is CURRENTLY on back to pristine state —
	// the client clears that map's persisted var namespace (ig.vars.storage.maps[map])
	// and reloads the map. Rescues saves whose quest-map progress vars were polluted
	// (e.g. by an accidental regroup into a teammate's mid-quest instance: the
	// battle-start console on miners-bombquest-1 is gated by !map.bombsOn, so a
	// polluted save can never start the battle again).
	router.post('/api/online/:name/resetMap', async (req, res) => {
		const name = needOnline(req, res); if (!name) return;
		res.json(await sendCommand(name, { kind: 'resetMap' }));
	});
	router.post('/api/online/:name/teleport', async (req, res) => {
		const name = needOnline(req, res); if (!name) return;
		const b = req.body || {};
		const map = typeof b.map === 'string' && /^[w.-]{1,64}$/.test(b.map) ? b.map : null;
		if (!map) return res.status(400).json({ ok: false, msg: '地图名不合法' });
		const payload = { kind: 'teleport', map };
		if (typeof b.marker === 'string' && b.marker && b.marker.length <= 64) payload.marker = b.marker;
		res.json(await sendCommand(name, payload));
	});

	// catalogs for the page
	router.get('/api/itemdb', (req, res) => {
		const d = itemdb.all();
		res.json({ ok: true, uploadedAt: d.uploadedAt, by: d.by, count: d.items.length, items: d.items });
	});
	router.get('/api/teleports', (req, res) => {
		const list = Array.isArray(config.adminTeleports) ? config.adminTeleports : [];
		res.json({ ok: true, teleports: list.filter((t) => t && typeof t.label === 'string' && typeof t.map === 'string') });
	});

	return router;
}

module.exports = { createRouter, resolveAck, sendCommand };
