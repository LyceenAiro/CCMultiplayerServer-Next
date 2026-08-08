// Accounts: username-is-account (no password, LAN trust). Login-or-register,
// session takeover (a stale socket for the same name is kicked so reconnects
// work), and the online table.
const persistence = require('./persistence');

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

module.exports = new Accounts();
