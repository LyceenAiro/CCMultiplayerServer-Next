// Accounts: username-is-account. Login-or-register, session takeover (a stale
// socket for the same name is kicked so reconnects work), and the online table.
// 1.78.x: accounts may carry a scrypt password hash (stored in the per-user
// save file — see persistence.js/auth.js); the reset-code state below lives on
// the account record here in db.json so it survives restarts and is readable by
// the admin page.
const crypto = require('crypto');
const persistence = require('./persistence');

// 1.78.x: one-time reset code tuning. 6 chars from [A-Z0-9], valid 2h, dead on
// use. Brute-force guard: 5 wrong codes within a rolling 1h window locks reset
// for 1h AND destroys the outstanding code.
const RESET_CODE_CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
const RESET_CODE_LEN = 6;
const RESET_CODE_TTL_MS = 2 * 3600 * 1000;
const RESET_FAIL_WINDOW_MS = 3600 * 1000;
const RESET_FAIL_MAX = 5;
const RESET_LOCK_MS = 3600 * 1000;

// 1.78.x: login brute-force guard. Wrong PASSWORDS count per-account in a
// rolling 10-minute window; the 5th failure locks LOGIN for 10 minutes. State
// lives on the account record (loginFails [ts], loginLockedUntil epoch ms) so
// it survives restarts and is readable/clearable from the admin page. The
// lock is checked BEFORE password verification, so a locked account cannot be
// probed at all; a successful login clears the counter.
const LOGIN_FAIL_WINDOW_MS = 10 * 60 * 1000;
const LOGIN_FAIL_MAX = 5;
const LOGIN_LOCK_MS = 10 * 60 * 1000;

function generateResetCode() {
	let s = '';
	for (let i = 0; i < RESET_CODE_LEN; i++) s += RESET_CODE_CHARS[crypto.randomInt(RESET_CODE_CHARS.length)];
	return s;
}

function Accounts() {
	// username -> socket (live connections only). Null-prototype so reserved keys
	// (__proto__/constructor/toString) can never be mistaken for a real account.
	this.online = Object.create(null);
}

// Returns { account, tookOver, isNew, alreadyOnline }.
//   isNew         — account did not exist before this login (first-ever login)
//   alreadyOnline — another LIVE socket is already logged in under this name
// Registers the account if new. Does NOT kick an existing socket; the caller
// decides (we reject duplicate logins instead of taking over).
Accounts.prototype.login = function (username, socket) {
	const accounts = persistence.db.accounts;
	let isNew = false;
	if (!accounts[username]) {
		accounts[username] = { createdAt: new Date().toISOString(), friends: [] };
		isNew = true;
		console.log('[accounts] registered new account: ' + username);
	}

	const account = accounts[username];
	const existing = this.online[username];
	let alreadyOnline = !!(existing && existing.id !== socket.id);

	// A duplicate login is only *real* if the old socket is still connected. A
	// crashed/closed client can leave a ghost entry whose socket is dead; treat
	// that as offline (and clean it up) so the name isn't locked forever.
	if (alreadyOnline && !socketConnected(existing)) {
		console.log('[accounts] clearing ghost session for ' + username + ' (dead socket ' + existing.id + ')');
		delete this.online[username];
		alreadyOnline = false;
	}

	if (!alreadyOnline) {
		this.online[username] = socket;
		account.lastSeen = new Date().toISOString();
		persistence.save();
	}
	return { account, tookOver: false, isNew, alreadyOnline };
};

// Best-effort liveness check for a socket.io socket.
function socketConnected(s) {
	try {
		return !!(s && s.connected !== false && (!s.disconnected));
	} catch (e) {
		return false;
	}
}

Accounts.prototype.logout = function (username) {
	const accounts = persistence.db.accounts;
	if (accounts[username]) {
		accounts[username].lastSeen = new Date().toISOString();
		persistence.save();
	}
	if (this.online[username]) delete this.online[username];
};

Accounts.prototype.isOnline = function (username) {
	return Object.prototype.hasOwnProperty.call(this.online, username);
};

Accounts.prototype.getSocket = function (username) {
	return Object.prototype.hasOwnProperty.call(this.online, username) ? this.online[username] : undefined;
};

Accounts.prototype.exists = function (username) {
	return Object.prototype.hasOwnProperty.call(persistence.db.accounts, username);
};

Accounts.prototype.getAccount = function (username) {
	return Object.prototype.hasOwnProperty.call(persistence.db.accounts, username)
		? persistence.db.accounts[username] : undefined;
};

Accounts.prototype.onlineNames = function () {
	return Object.keys(this.online);
};

// ---- 1.78.x: one-time password reset codes ----
// The code is generated HERE but only ever displayed on the admin page — the
// player asks the admin for it out-of-band, which is the identity check. State
// lives on the account record: resetCode {code, expiresAt}, resetFails [ts],
// resetLockedUntil (epoch ms).

// Step 1 (HTTP /auth/requestReset): mint a code, or keep the still-valid one
// (idempotent — re-clicking never invalidates a code the admin may already have
// read out). Refused while the account is reset-locked.
Accounts.prototype.requestResetCode = function (username) {
	const acc = this.getAccount(username);
	if (!acc) return { ok: false, msg: '账号不存在 (no such account)' };
	const now = Date.now();
	if (Number(acc.resetLockedUntil) > now) {
		const mins = Math.ceil((acc.resetLockedUntil - now) / 60000);
		return { ok: false, lockedMs: acc.resetLockedUntil - now, msg: '密码重置已锁定，请约 ' + mins + ' 分钟后再试 (reset locked — retry in ~' + mins + ' min)' };
	}
	if (acc.resetCode && Number(acc.resetCode.expiresAt) > now) {
		return { ok: true, reused: true, expiresInMs: acc.resetCode.expiresAt - now, msg: '重置验证码已生成，请联系服务器管理员索取（2 小时内有效）(code generated — ask the server admin; valid 2h)' };
	}
	const code = generateResetCode();
	acc.resetCode = { code, expiresAt: now + RESET_CODE_TTL_MS };
	persistence.save();
	console.log('[accounts] password reset code for ' + username + ': ' + code + ' (valid 2h; shown on the admin page)');
	return { ok: true, expiresInMs: RESET_CODE_TTL_MS, msg: '重置验证码已生成，请联系服务器管理员索取（2 小时内有效）(code generated — ask the server admin; valid 2h)' };
};

// Step 2 (HTTP /auth/confirmReset): validate the code. One-time — success
// destroys it. Wrong codes count in a rolling 1h window; the 5th wrong code
// locks reset for 1h and destroys the outstanding code.
Accounts.prototype.confirmResetCode = function (username, code) {
	const acc = this.getAccount(username);
	if (!acc) return { ok: false, msg: '账号不存在 (no such account)' };
	const now = Date.now();
	if (Number(acc.resetLockedUntil) > now) {
		const mins = Math.ceil((acc.resetLockedUntil - now) / 60000);
		return { ok: false, lockedMs: acc.resetLockedUntil - now, msg: '密码重置已锁定，请约 ' + mins + ' 分钟后再试 (reset locked — retry in ~' + mins + ' min)' };
	}
	const rc = acc.resetCode;
	if (!rc || !(Number(rc.expiresAt) > now)) {
		if (rc) { delete acc.resetCode; persistence.save(); }
		return { ok: false, msg: '验证码不存在或已过期，请重新获取 (no active code — request one first)' };
	}
	const given = String(code || '').toUpperCase().trim();
	if (given !== rc.code) {
		const fails = Array.isArray(acc.resetFails) ? acc.resetFails.filter((ts) => now - Number(ts) < RESET_FAIL_WINDOW_MS) : [];
		fails.push(now);
		if (fails.length >= RESET_FAIL_MAX) {
			acc.resetLockedUntil = now + RESET_LOCK_MS;
			delete acc.resetCode;
			acc.resetFails = [];
			persistence.save();
			console.warn('[accounts] reset lockout for ' + username + ': ' + RESET_FAIL_MAX + ' wrong codes within 1h — code destroyed, locked 1h');
			return { ok: false, lockedMs: RESET_LOCK_MS, msg: '验证码连续错误次数过多：已锁定 1 小时，已生成的验证码作废 (too many wrong codes — locked 1h, code destroyed)' };
		}
		acc.resetFails = fails;
		persistence.save();
		return { ok: false, failsLeft: RESET_FAIL_MAX - fails.length, msg: '验证码错误，还可尝试 ' + (RESET_FAIL_MAX - fails.length) + ' 次 (wrong code — ' + (RESET_FAIL_MAX - fails.length) + ' attempts left)' };
	}
	delete acc.resetCode;
	acc.resetFails = [];
	persistence.save();
	return { ok: true };
};

// ---- 1.78.x: login brute-force guard ----
// State on the account record: loginFails [ts] (rolling window),
// loginLockedUntil (epoch ms). Per-ACCOUNT (not per-IP), so spreading attempts
// across many sockets gains nothing.

// Checked BEFORE password verification. Returns { ok:true } or
// { ok:false, lockedMs, msg } with the remaining lock time.
Accounts.prototype.checkLoginLock = function (username) {
	const acc = this.getAccount(username);
	if (!acc) return { ok: true }; // unknown name: the normal login/register path decides
	const now = Date.now();
	if (Number(acc.loginLockedUntil) > now) {
		const mins = Math.ceil((acc.loginLockedUntil - now) / 60000);
		return { ok: false, lockedMs: acc.loginLockedUntil - now, msg: '密码错误次数过多，登录已锁定，请约 ' + mins + ' 分钟后再试 (too many wrong passwords — login locked, retry in ~' + mins + ' min)' };
	}
	return { ok: true };
};

// Records one wrong-password attempt. Returns { locked:false, failsLeft, msg }
// or, when the 5th failure trips the lock, { locked:true, lockedMs, msg }.
Accounts.prototype.recordLoginFail = function (username) {
	const acc = this.getAccount(username);
	if (!acc) return { locked: false, failsLeft: LOGIN_FAIL_MAX - 1, msg: '密码错误 (wrong password)' };
	const now = Date.now();
	const fails = Array.isArray(acc.loginFails) ? acc.loginFails.filter((ts) => now - Number(ts) < LOGIN_FAIL_WINDOW_MS) : [];
	fails.push(now);
	if (fails.length >= LOGIN_FAIL_MAX) {
		acc.loginLockedUntil = now + LOGIN_LOCK_MS;
		acc.loginFails = [];
		persistence.save();
		console.warn('[accounts] login lockout for ' + username + ': ' + LOGIN_FAIL_MAX + ' wrong passwords within 10min — locked 10min');
		return { locked: true, lockedMs: LOGIN_LOCK_MS, msg: '密码连续错误次数过多：账号已锁定 10 分钟 (too many wrong passwords — account locked 10 min)' };
	}
	acc.loginFails = fails;
	persistence.save();
	return { locked: false, failsLeft: LOGIN_FAIL_MAX - fails.length, msg: '密码错误，还可尝试 ' + (LOGIN_FAIL_MAX - fails.length) + ' 次 (wrong password — ' + (LOGIN_FAIL_MAX - fails.length) + ' attempts left)' };
};

// Clears the fail window AND any (expired or active) lock. Runs on every
// successful password login and from the admin page's manual unlock.
Accounts.prototype.clearLoginState = function (username) {
	const acc = this.getAccount(username);
	if (!acc) return;
	const hadFails = Array.isArray(acc.loginFails) && acc.loginFails.length > 0;
	const hadLock = Number(acc.loginLockedUntil) > 0;
	if (!hadFails && !hadLock) return; // nothing to clear — skip the db write
	acc.loginFails = [];
	delete acc.loginLockedUntil;
	persistence.save();
};

module.exports = new Accounts();
