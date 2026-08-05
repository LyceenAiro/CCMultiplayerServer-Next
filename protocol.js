// Protocol: binds every socket's events and translates them into calls on the
// accounts/friends/party/world/persistence modules. Replaces the old User class.
// Auth model: a socket must complete `handshake` (login) before any other event
// is honoured; until then all other events are dropped.
const accounts = require('./accounts');
const friends = require('./friends');
const party = require('./party');
const world = require('./world');
const persistence = require('./persistence');

// ctx passed to modules: lets them reach sockets / online checks without a
// direct dependency on the accounts module's internals.
const ctx = {
	isOnline: (name) => accounts.isOnline(name),
	getSocket: (name) => accounts.getSocket(name),
};

function handleConnection(socket) {
	// username is set once the socket has logged in (handshake).
	let username = null;

	function authed() {
		return username !== null;
	}
	function dropIfNotAuthed(evt) {
		if (!authed()) {
			console.warn('[protocol] dropping "' + evt + '" from unauthenticated socket ' + socket.id);
			return true;
		}
		return false;
	}

	function broadcastPresence(name, online) {
		// Notify friends + party members (and, for simplicity, everyone in the
		// same instance) that this player's online state changed.
		const targets = friends.presenceSubscribers(name);
		const partyId = party.partyOf(name);
		if (partyId) {
			const p = party.getParty(partyId);
			if (p) p.members.forEach((m) => targets.add(m));
		}
		for (const t of targets) {
			const s = accounts.getSocket(t);
			if (s) s.emit('presence', { player: name, online });
		}
	}

	function pushPartyUpdate(partyId) {
		const p = party.getParty(partyId);
		if (!p) return;
		for (const m of p.members) {
			const s = accounts.getSocket(m);
			if (s) s.emit('partyUpdate', { partyId: p.id, leader: p.leader, members: p.members.slice() });
		}
	}

	// ---- login ----
	socket.on('handshake', function (data) {
		const name = data && data.username;
		if (!name) {
			socket.emit('handshakeResponse', { failed: 'No username given' });
			return;
		}
		if (username && username !== name) {
			// Already logged in on this socket under another name.
			socket.emit('handshakeResponse', { failed: 'Socket already logged in' });
			return;
		}

		const isReconnect = username === name;

		// Reject a duplicate login: if another live socket is already using this
		// name, block the new one (instead of the old session-takeover behaviour).
		if (!isReconnect && accounts.isOnline(name)) {
			const existing = accounts.getSocket(name);
			if (existing && existing.id !== socket.id && existing.connected !== false && !existing.disconnected) {
				console.log('[protocol] rejected duplicate login for ' + name);
				socket.emit('handshakeResponse', { failed: '该账号已在线 (account already logged in): ' + name });
				return;
			}
		}

		username = name;
		const { isNew } = accounts.login(name, socket);
		if (!isReconnect) {
			console.log('[protocol] ' + name + ' logged in' + (isNew ? ' (new account)' : ''));
			broadcastPresence(name, true);
		}

		// Stage 1+: everyone is host of their own solo experience until they join
		// a shared instance (world.changeMap decides the real host per-instance).
		// New accounts start from the shared default save (罗姆布斯广场-迎新桥);
		// returning accounts resume from their own uploaded save.
		let save = persistence.loadGame(name);
		if (!save && isNew) {
			save = persistence.loadDefaultSave();
			if (save) console.log('[protocol] ' + name + ' starts from the default save (罗姆布斯广场-迎新桥)');
		}
		socket.emit('handshakeResponse', {
			success: true,
			username: name,
			host: true,
			mapName: null, // no forced map; the client uses its own save / start map
			save: save && save.autoSlot ? { slot: 'autoSlot', data: save.autoSlot } : null,
		});
	});

	socket.on('disconnect', function () {
		if (!username) return;
		console.log('[protocol] ' + username + ' disconnected');
		doLogout();
	});

	// Explicit logout from the client (exit to title / window close) — the client
	// saves + emits this right before going away, so we don't rely solely on the
	// socket 'disconnect' event (which can lag or be missed on an unclean exit).
	socket.on('logout', function () {
		if (!username) return;
		console.log('[protocol] ' + username + ' logged out (client-initiated)');
		doLogout();
	});

	function doLogout() {
		const name = username;
		username = null;
		world.disconnect(ctx, name);
		// Leaving the party on logout keeps party state clean for LAN sessions.
		const updated = party.removeMember(name);
		if (updated) pushPartyUpdate(updated.id);
		accounts.logout(name);
		broadcastPresence(name, false);
	}

	// ---- map / world ----
	// changeMap carries the area type so the server can compute the instance.
	// We reply with a changeMapResponse so the client can await it before
	// loading the level (avoids the setHost / enemy-stripping race).
	socket.on('changeMap', function (data) {
		if (dropIfNotAuthed('changeMap')) return;
		const mapName = data && data.name;
		const areaType = typeof data.areaType === 'number' ? data.areaType : 1; // default PATH
		const pos = data.pos || { x: 0, y: 0, z: 0 };
		if (!mapName) return;

		const result = world.changeMap(ctx, username, mapName, areaType, pos);
		socket.emit('changeMapResponse', result);
	});

	socket.on('updatePosition', function (pos) {
		if (dropIfNotAuthed('updatePosition')) return;
		world.updateMemberPos(username, pos);
		world.broadcastToInstance(ctx, username, 'updatePosition', { player: username, pos });
	});

	socket.on('updateAnimation', function (data) {
		if (dropIfNotAuthed('updateAnimation')) return;
		world.broadcastToInstance(ctx, username, 'updateAnimation', { player: username, face: data.face, anim: data.anim });
	});

	socket.on('updateAnimationTimer', function (timer) {
		if (dropIfNotAuthed('updateAnimationTimer')) return;
		world.broadcastToInstance(ctx, username, 'updateAnimationTimer', { player: username, timer });
	});

	socket.on('throwBall', function (data) {
		if (dropIfNotAuthed('throwBall')) return;
		if (!data.combatant) data.combatant = username;
		world.broadcastToInstance(ctx, username, 'throwBall', data);
	});

	// ---- entity (enemy) sync: host-authoritative within the instance ----
	socket.on('registerEntity', function (data) {
		if (dropIfNotAuthed('registerEntity')) return;
		if (data.type !== 'Enemy') return;
		world.registerEntity(ctx, username, data);
	});

	socket.on('updateEntityPosition', function (data) {
		if (dropIfNotAuthed('updateEntityPosition')) return;
		world.entityAction(ctx, username, 'updateEntityPosition', data, true);
	});
	socket.on('updateEntityAnimation', function (data) {
		if (dropIfNotAuthed('updateEntityAnimation')) return;
		world.entityAction(ctx, username, 'updateEntityAnimation', data, true);
	});
	socket.on('updateEntityState', function (data) {
		if (dropIfNotAuthed('updateEntityState')) return;
		world.entityAction(ctx, username, 'updateEntityState', data, true);
	});
	socket.on('updateEntityTarget', function (data) {
		if (dropIfNotAuthed('updateEntityTarget')) return;
		// target === 0 means "the reporting player themself" -> substitute their name.
		if (data.target === 0) data.target = username;
		world.entityAction(ctx, username, 'updateEntityTarget', data, true);
	});
	socket.on('updateEntityHealth', function (data) {
		if (dropIfNotAuthed('updateEntityHealth')) return;
		// id === null means a player reporting their OWN health (anyone may); a
		// non-null id is an authoritative enemy (host only).
		if (data.id === null) {
			world.broadcastToInstance(ctx, username, 'updateEntityHealth', { id: username, hp: data.hp });
		} else {
			world.entityAction(ctx, username, 'updateEntityHealth', data, true);
		}
	});
	// Real player profile (level/stats/equip) for the Social info box. Broadcast
	// to the instance AND cached so players who join later still get it.
	socket.on('updatePlayerProfile', function (profile) {
		if (dropIfNotAuthed('updatePlayerProfile')) return;
		world.updateMemberProfile(username, profile);
		world.broadcastToInstance(ctx, username, 'updatePlayerProfile', { player: username, profile });
	});
	socket.on('killEntity', function (data) {
		if (dropIfNotAuthed('killEntity')) return;
		world.entityAction(ctx, username, 'killEntity', data, true);
	});

	// ---- friends (request -> accept -> mutual) ----
	// A friend edge is only created when the target ACCEPTS; before that the
	// requester just sits in the target's incoming box. Both sides then see each
	// other (fixes the old one-directional bug).
	socket.on('friendAdd', function (data) {
		if (dropIfNotAuthed('friendAdd')) return;
		const target = data && data.name;
		const res = friends.request(username, target);
		if (!res.ok) {
			socket.emit('friendActionResult', { action: 'request', ok: false, error: res.error });
			return;
		}
		if (res.autoAccepted) {
			// They had already requested us -> mutual now. Refresh both sides.
			socket.emit('friendList', { friends: friends.list(username) });
			const other = accounts.getSocket(target);
			if (other) other.emit('friendList', { friends: friends.list(target) });
			return;
		}
		socket.emit('friendActionResult', { action: 'request', ok: true, to: target, toOffline: res.toOffline });
		// Notify the target (if online) that they have an incoming request.
		const other = accounts.getSocket(target);
		if (other) other.emit('friendRequest', { from: username });
	});
	socket.on('friendAccept', function (data) {
		if (dropIfNotAuthed('friendAccept')) return;
		const from = data && data.name;
		friends.accept(username, from);
		// Both sides now see each other in their friends list.
		socket.emit('friendList', { friends: friends.list(username) });
		const other = accounts.getSocket(from);
		if (other) other.emit('friendList', { friends: friends.list(from) });
	});
	socket.on('friendDecline', function (data) {
		if (dropIfNotAuthed('friendDecline')) return;
		const from = data && data.name;
		friends.decline(username, from);
		socket.emit('friendRequests', { requests: friends.requests(username) });
	});
	socket.on('friendRemove', function (data) {
		if (dropIfNotAuthed('friendRemove')) return;
		friends.remove(username, data && data.name);
		// Refresh both sides so the removed entry disappears everywhere.
		socket.emit('friendList', { friends: friends.list(username) });
		const other = accounts.getSocket(data && data.name);
		if (other) other.emit('friendList', { friends: friends.list(data.name) });
	});
	socket.on('friendList', function () {
		if (dropIfNotAuthed('friendList')) return;
		socket.emit('friendList', { friends: friends.list(username) });
	});
	socket.on('friendRequests', function () {
		if (dropIfNotAuthed('friendRequests')) return;
		socket.emit('friendRequests', { requests: friends.requests(username) });
	});

	// ---- party ----
	socket.on('partyInvite', function (data) {
		if (dropIfNotAuthed('partyInvite')) return;
		const to = data && data.to;
		if (!to || !accounts.isOnline(to)) {
			socket.emit('partyActionResult', { action: 'invite', ok: false, error: 'Player not online: ' + to });
			return;
		}
		const partyId = party.createParty(username);
		const target = accounts.getSocket(to);
		target.emit('partyInvite', { from: username, partyId });
		socket.emit('partyActionResult', { action: 'invite', ok: true, to });
	});
	socket.on('partyAccept', function (data) {
		if (dropIfNotAuthed('partyAccept')) return;
		const partyId = data && data.partyId;
		if (!party.getParty(partyId)) {
			socket.emit('partyActionResult', { action: 'accept', ok: false, error: 'Party no longer exists' });
			return;
		}
		// Leave any current party first.
		const prev = party.removeMember(username);
		if (prev) pushPartyUpdate(prev.id);
		party.addMember(partyId, username);
		// Broadcast the new roster to EVERY member (inviter + invitee) so all
		// clients update their party UI/mirror. This was missing, which is why the
		// accept "did nothing".
		pushPartyUpdate(partyId);
	});
	socket.on('partyDecline', function (data) {
		if (dropIfNotAuthed('partyDecline')) return;
		// Notify the inviter (party leader) of the decline.
		const p = party.getParty(data && data.partyId);
		if (p) {
			const leader = accounts.getSocket(p.leader);
			if (leader) leader.emit('partyActionResult', { action: 'declined', ok: true, from: username });
		}
	});
	socket.on('partyLeave', function () {
		if (dropIfNotAuthed('partyLeave')) return;
		const updated = party.removeMember(username);
		socket.emit('partyUpdate', null);
		if (updated) pushPartyUpdate(updated.id);
	});

	// ---- server-side save ----
	socket.on('saveUpload', function (data) {
		if (dropIfNotAuthed('saveUpload')) return;
		if (!data || typeof data.slot === 'undefined' || !data.data) return;
		persistence.saveGame(username, data.slot, data.data);
	});

	// ---- lobby queries (Social-menu "房间玩家" tab + online counter) ----
	// The members of the caller's current map instance (everyone they can see in
	// this room/town), excluding the caller themself.
	socket.on('roomPlayers', function () {
		if (dropIfNotAuthed('roomPlayers')) return;
		socket.emit('roomPlayers', { players: world.getInstanceMembers(username).filter((n) => n !== username) });
	});
	// Total number of players currently online on this server.
	socket.on('onlineCount', function () {
		if (dropIfNotAuthed('onlineCount')) return;
		socket.emit('onlineCount', { count: accounts.onlineNames().length });
	});
}

module.exports = { handleConnection };
