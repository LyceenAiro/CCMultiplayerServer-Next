// 1.78.x: login passwords — hashing primitives + the PUBLIC pre-login HTTP
// routes for the one-time reset-code flow.
//
// Passwords are stored as salted scrypt hashes in the per-user save file
// (persistence.setPassword) — the plaintext never touches disk and cannot be
// recovered by the server admin either. The client sends the plaintext password
// over the (LAN) socket at login; verification happens here server-side.
//
// Reset flow (the game client's login panel calls these BEFORE the socket
// exists, which is why they are plain HTTP and CORS-open like /version):
//   POST /auth/requestReset {username}              -> generate/keep the code
//   POST /auth/confirmReset {username, code, password} -> one-time use
// The code itself is generated per-account in accounts.js and shown on the
// ADMIN page; brute-force protection (5 wrong codes within 1h -> 1h lockout +
// code destroyed) also lives in accounts.js.
const crypto = require('crypto');
const express = require('express');
const { isValidName } = require('./validate');
const bots = require('./bots');

const SCRYPT_KEYLEN = 64;

function hashPassword(password) {
	const salt = crypto.randomBytes(16).toString('hex');
	const hash = crypto.scryptSync(String(password), salt, SCRYPT_KEYLEN).toString('hex');
	return { algo: 'scrypt', salt, hash, setAt: new Date().toISOString() };
}

function verifyPassword(password, rec) {
	try {
		if (!rec || rec.algo !== 'scrypt' || typeof rec.salt !== 'string' || typeof rec.hash !== 'string') return false;
		const calc = crypto.scryptSync(String(password), rec.salt, SCRYPT_KEYLEN);
		const expect = Buffer.from(rec.hash, 'hex');
		return calc.length === expect.length && crypto.timingSafeEqual(calc, expect);
	} catch (e) {
		return false;
	}
}

// 4-64 chars, anything printable the user can type (client enforces the same).
function isValidPassword(pw) {
	return typeof pw === 'string' && pw.length >= 4 && pw.length <= 64;
}

// Deps are injected by server.js (NOT required at module top) so this module
// never participates in a circular require with accounts.js/persistence.js.
function createRouter(deps) {
	const accounts = deps.accounts;
	const persistence = deps.persistence;
	const router = express.Router();

	// CORS-open (same stance as /version): the game client fetches these from
	// the login panel, cross-origin, before any socket connection exists.
	router.use(function (req, res, next) {
		res.set('Access-Control-Allow-Origin', '*');
		res.set('Access-Control-Allow-Headers', 'Content-Type');
		res.set('Access-Control-Allow-Methods', 'POST, OPTIONS');
		if (req.method === 'OPTIONS') return res.status(204).end();
		next();
	});
	router.use(express.json({ limit: '8kb' }));

	// 1.78.x: per-IP rate limit for the PUBLIC reset endpoints. The account-
	// level lockout in accounts.js stops single-account code guessing, but an
	// attacker could still spray one attempt per account across MANY accounts
	// (or hammer requestReset to churn db writes). 60 req/min per IP is far
	// above legit use (request + a few confirm retries). In-memory only — a
	// restart resets the buckets, which is fine for a best-effort throttle.
	const AUTH_RL_WINDOW_MS = 60 * 1000;
	const AUTH_RL_MAX = 60;
	const authRl = new Map(); // ip -> {t, n}
	router.use(function (req, res, next) {
		const now = Date.now();
		const ip = String(req.ip || (req.socket && req.socket.remoteAddress) || '?');
		let e = authRl.get(ip);
		if (!e || now - e.t > AUTH_RL_WINDOW_MS) { e = { t: now, n: 0 }; authRl.set(ip, e); }
		e.n++;
		// Lazy sweep so a spray from many spoofed IPs can't grow the map forever.
		if (authRl.size > 1000) {
			for (const [k, v] of authRl) { if (now - v.t > AUTH_RL_WINDOW_MS) authRl.delete(k); }
		}
		if (e.n > AUTH_RL_MAX) {
			console.warn('[auth] rate limit exceeded for ' + ip + ' (' + e.n + '/min)');
			return res.status(429).json({ ok: false, msg: '请求过于频繁，请稍后再试 (too many requests — slow down)' });
		}
		next();
	});

	// Step 1: request a one-time reset code. The code is NOT returned to the
	// caller — it appears on the admin page, and the player asks the admin for
	// it (that hand-off IS the identity check). Idempotent while a code is
	// active: re-requesting keeps the same code until it expires.
	router.post('/requestReset', function (req, res) {
		const name = req.body && typeof req.body.username === 'string' ? req.body.username.trim() : '';
		if (!name || !isValidName(name)) return res.json({ ok: false, msg: '用户名不合法 (invalid username)' });
		if (bots.isBotName(name)) return res.json({ ok: false, msg: '该账号无需密码 (bot accounts have no password)' });
		res.json(accounts.requestResetCode(name));
	});

	// Step 2: redeem the code + set the new password. One-time: a success
	// destroys the code; wrong codes count towards the 5-per-hour lockout.
	router.post('/confirmReset', function (req, res) {
		const b = req.body || {};
		const name = typeof b.username === 'string' ? b.username.trim() : '';
		const code = typeof b.code === 'string' ? b.code : '';
		const pw = typeof b.password === 'string' ? b.password : '';
		if (!name || !isValidName(name)) return res.json({ ok: false, msg: '用户名不合法 (invalid username)' });
		if (!isValidPassword(pw)) return res.json({ ok: false, msg: '新密码需为 4-64 个字符 (new password must be 4-64 chars)' });
		const r = accounts.confirmResetCode(name, code);
		if (!r.ok) return res.json(r);
		if (!persistence.setPassword(name, hashPassword(pw))) {
			return res.json({ ok: false, msg: '密码写入失败，请重试 (failed to store the password — retry)' });
		}
		console.log('[auth] ' + name + ' reset their password via one-time code');
		res.json({ ok: true, msg: '密码已重置，请使用新密码登录 (password reset — log in with the new password)' });
	});

	return router;
}

module.exports = { hashPassword, verifyPassword, isValidPassword, createRouter };
