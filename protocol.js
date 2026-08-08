// Protocol: binds every socket's events and translates them into calls on the
// accounts/friends/party/world/persistence modules. Replaces the old User class.
// Auth model: a socket must complete `handshake` (login) before any other event
// is honoured; until then all other events are dropped.
const accounts = require('./accounts');
const friends = require('./friends');
const party = require('./party');
const world = require('./world');
const persistence = require('./persistence');
const config = require('./config');
const { isValidName, isValidEntityId, isValidPos, isValidSlotKey } = require('./validate');

// ctx passed to modules: lets them reach sockets / online checks without a
// direct dependency on the accounts module's internals.
const ctx = {
	isOnline: (name) => accounts.isOnline(name),
	getSocket: (name) => accounts.getSocket(name),
};

// Party-DISBAND cross-despawn. When a 2-person party disbands (party.removeMember
// returns null), every affected member is migrated to their own solo:<user>:<map>
// instance via recomputeMemberInstance -> changeMap -> leaveCurrentInstance. That
// path emits onPlayerChangeMap {enters:false} ONLY to players still remaining in
// the old instance, so the LAST player migrated away leaves an empty instance and
// nobody ever tells the earlier-migrated players they left — their client keeps a
// frozen mirror (playerState broadcasts are instance-scoped). After all migrations
// have settled, walk every ordered pair of affected players and, when they ended up
// in DIFFERENT instances, tell the first that the second left their instance. Same
// payload shape as world.leaveCurrentInstance (player/enters/map/marker) so the
// client's onPlayerChangeMap handler despawns the mirror. No-op for pairs still
// sharing an instance (shared towns never migrate, so they keep seeing each other).
function crossDespawnDifferentInstances(affected) {
	for (const a of affected) {
		const aSock = accounts.getSocket(a);
		if (!aSock) continue;
		const aInstId = world.instanceOf(a);
		const aInst = aInstId && world.getInstance(aInstId);
		if (!aInst) continue;
		for (const b of affected) {
			if (b === a) continue;
			const bInstId = world.instanceOf(b);
			if (!bInstId || bInstId === aInstId) continue; // still together: no despawn
			aSock.emit('onPlayerChangeMap', { player: b, enters: false, map: aInst.mapName, marker: null });
		}
	}
}

function handleConnection(socket) {
	// username is set once the socket has logged in (handshake).
	let username = null;

	function authed() {
		return username !== null;
	}
	function dropIfNotAuthed(evt) {
		if (!authed()) {
			// A client that returned to the title screen may keep streaming playerState
			// for a while on a logged-out socket; logging every packet floods the server
			// console. One line per 5s per socket is plenty.
			const now = Date.now();
			if (!socket._mpDropLogAt || now - socket._mpDropLogAt > 5000) {
				socket._mpDropLogAt = now;
				console.warn('[protocol] dropping "' + evt + '" from unauthenticated socket ' + socket.id + ' (throttled 5s)');
			}
			return true;
		}
		return false;
	}

	// Per-socket event rate limit (combat relays): a buggy or hostile client must not
	// be able to flood the instance with damage packets and melt enemy/player HP.
	// ~50/s is far above any legit hit rate (fastest multi-hit combos are <20/s).
	function rateLimited(key, maxPerSec) {
		const now = Date.now();
		const r = socket._mpRate || (socket._mpRate = {});
		const e = r[key] || (r[key] = { t: now, n: 0 });
		if (now - e.t > 1000) { e.t = now; e.n = 0; }
		e.n++;
		return e.n > maxPerSec;
	}

	// ---- round 16: ping echo (client RTT measurement) ----
	// Intentionally NOT auth-gated: the client pings as soon as the socket exists
	// to measure handshake/RTT latency. Echo the received payload verbatim back to
	// the SAME socket — the client sends {t: <ms>} and reads `t` back. Garbage
	// payloads are echoed harmlessly; the per-socket rate limit (~10/s) prevents a
	// hostile client from using this to flood traffic.
	socket.on('mpPing', function (data) {
		if (rateLimited('mpPing', 10)) return;
		socket.emit('mpPing', data);
	});

	// ---- round 17: client ping REPORT (teammate name-tag pings) ----
	// Each client measures its own RTT with the mpPing echo probe above and
	// reports the smoothed value once per second. Unlike mpPing (which must run
	// PRE-auth to measure handshake latency), this is a normal game event: auth-
	// gated like the rest, with a light rate limit (clients send 1/s). The value
	// is stored on the socket and relayed to the reporter's current instance so
	// every player there can show it on their name tag (显示ping值).
	socket.on('pingReport', function (data) {
		if (dropIfNotAuthed('pingReport')) return;
		if (rateLimited('pingReport', 20)) return;
		const ms = Number(data && data.ms);
		if (!isFinite(ms) || ms < 0 || ms > 5000) return; // clamp to a sane range
		const ping = Math.round(ms);
		socket._mpPingMs = ping;
		// Round 20: stamp isHost so the receiving clients can label the map-instance
		// host's name tag with " (Host)" instead of a ping (world.isHostUser).
		world.broadcastToInstance(ctx, username, 'playerPing', { name: username, ping, isHost: world.isHostUser(username) });
	});

	// Whitelist the profile fields we display (Social info box). The profile is
	// cached server-side and amplified to friends/joiners, so never store or
	// forward a raw client blob.
	function sanitizeProfile(p) {
		if (!p || typeof p !== 'object') return null;
		const num = (v) => (typeof v === 'number' && isFinite(v)) ? Math.max(-1e7, Math.min(1e7, v)) : undefined;
		const out = {};
		for (const k of ['level', 'exp', 'hp', 'attack', 'defense', 'focus', 'currentHp', 'currentSp', 'maxSp']) {
			const v = num(p[k]);
			if (v !== undefined) out[k] = v;
		}
		if (p.equip && typeof p.equip === 'object') {
			out.equip = {};
			for (const s of ['head', 'leftArm', 'rightArm', 'torso', 'feet']) {
				const v = num(p.equip[s]);
				if (v !== undefined) out.equip[s] = Math.round(v);
			}
		}
		return out;
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
		// Round 17: server/client VERSION gate. Only a matching mod build may
		// connect. Both the FIRST connect and every RECONNECT run through this
		// handler (the client re-emits `handshake` from its reconnect path), so the
		// check is automatically re-applied on reconnects. Rejected here BEFORE any
		// login work so a mismatched client never touches accounts/world state.
		const clientVersion = data && data.version;
		if (clientVersion !== config.version) {
			socket.emit('handshakeResponse', {
				success: false,
				message: '版本不一致 Version mismatch: server=' + config.version + ' client=' + (clientVersion || '?'),
			});
			return;
		}
		const name = data && data.username;
		if (!name) {
			socket.emit('handshakeResponse', { failed: 'No username given' });
			return;
		}
		// Whitelist the username — blocks prototype-pollution keys (__proto__/
		// constructor/...) that would otherwise corrupt every object keyed by name.
		if (!isValidName(name)) {
			socket.emit('handshakeResponse', { failed: 'Illegal username: ' + name });
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
			console.log('[protocol] ' + name + ' logged in (v' + config.version + ')' + (isNew ? ' (new account)' : ''));
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
			// Round 16: per-extra-party-member enemy HP multiplier the client applies
			// using its own party roster size (config.json: monsterHpPerPlayer).
			hpScale: config.monsterHpPerPlayer,
			// Round 17: the accepted server version (harmless; useful for logs — the
			// client already sent its own version in the handshake payload).
			version: config.version,
			mapName: null, // no forced map; the client uses its own save / start map
			save: save && save.autoSlot ? { slot: 'autoSlot', data: save.autoSlot } : null,
		});

		// Proactively push the friend's list right after login. Friends are persisted
		// server-side, so a returning player already HAS friends — but their client
		// can't register its onFriendList handler until the socket exists, so a
		// client-initiated request right at login races and gets dropped (that's the
		// "must re-add a friend before they appear" bug). Server-push removes the race.
		try {
			socket.emit('friendList', { friends: friends.list(name) });
			socket.emit('friendRequests', { requests: friends.requests(name) });
		} catch (e) { /* non-fatal */ }
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
		// Leaving the party on logout keeps party state clean for LAN sessions.
		const partyId = party.partyOf(name);
		const survivors = partyId && party.getParty(partyId) ? party.getParty(partyId).members.filter((m) => m !== name) : [];
		// Notify presence BEFORE leaving the party/instance, so the party-member
		// branch of broadcastPresence still sees the roster (and friends too).
		broadcastPresence(name, false);
		// world.disconnect migrates the INSTANCE host if this player held it
		// (setHost to the next member) — survivors stay where they stand.
		world.disconnect(ctx, name);
		const updated = party.removeMember(name);
		if (updated) {
			// Round 12: a leader going offline NO LONGER disbands the party and NO
			// LONGER teleports survivors to a town (that yanked members out of the
			// field mid-fight). removeMember transfers leadership, the partyId (and
			// therefore the instanceId) is unchanged, and everyone keeps playing.
			pushPartyUpdate(updated.id);
		} else {
			// removeMember returned null => the party was disbanded (e.g. a 2-person
			// party lost its leader). The survivor stays in place but moves from the
			// dead party:<id> instance to their solo one — and must be told they are
			// now the host there, or their world goes empty (they were the member).
			for (const m of survivors) {
				const s = accounts.getSocket(m);
				if (s) s.emit('partyUpdate', null);
				const res = world.recomputeMemberInstance(ctx, m);
				if (res && res.isHost && s) s.emit('setHost', { isHost: true, map: res.mapName });
			}
		}
		accounts.logout(name);
		party.clearInvites(name);
	}

	// ---- map / world ----
	// changeMap carries the area type so the server can compute the instance.
	// We reply with a changeMapResponse so the client can await it before
	// loading the level (avoids the setHost / enemy-stripping race).
	socket.on('changeMap', function (data) {
		if (dropIfNotAuthed('changeMap')) return;
		// Validate the whole payload BEFORE touching world state — a malformed map
		// name/areaType used to throw mid-changeMap (after leaveCurrentInstance),
		// leaving the player in limbo with no response and the client hung.
		const mapName = data && data.name;
		const areaType = data && typeof data.areaType === 'number' ? data.areaType : 1; // default PATH
		const pos = data && isValidPos(data.pos) ? data.pos : { x: 0, y: 0, z: 0 };
		if (typeof mapName !== 'string' || !mapName || mapName.length > 128 || mapName.indexOf('..') !== -1) {
			socket.emit('changeMapResponse', { failed: 'bad map name' });
			return;
		}
		if (typeof data.areaType !== 'undefined' && (areaType < 0 || areaType > 2)) {
			socket.emit('changeMapResponse', { failed: 'bad areaType' });
			return;
		}

		// Round 19: PVP-duel instance isolation. TRI-STATE on `data.isolated`:
		//   true  -> enter PVP isolation (routing pinned to solo:<user>:<map>)
		//   false -> exit PVP isolation (routing rules resume)
		//   absent-> leave the override unchanged, so a normal teleport DURING a duel
		//           doesn't silently drop the override (the client re-asserts
		//           explicitly when it wants to enter/leave).
		if (data.isolated === true) {
			world.userIsolation[username] = true;
			console.log('[protocol] ' + username + ' entered PVP isolation on ' + mapName);
		} else if (data.isolated === false) {
			delete world.userIsolation[username];
			console.log('[protocol] ' + username + ' exited PVP isolation on ' + mapName);
		}

		const result = world.changeMap(ctx, username, mapName, areaType, pos);
		socket.emit('changeMapResponse', result);
	});

	socket.on('updatePosition', function (pos) {
		if (dropIfNotAuthed('updatePosition')) return;
		world.updateMemberPos(username, pos);
		world.broadcastToInstance(ctx, username, 'updatePosition', { player: username, pos });
	});

	// ---- NEW sync system: whole-state broadcast (replaces per-entity deltas) ----
	// Every client streams its own full player state each frame. The username is
	// authoritative (stamped server-side). No host gate — each player owns their state.
	socket.on('playerState', function (s) {
		if (dropIfNotAuthed('playerState')) return;
		if (!s || !isValidPos(s.pos)) return;
		world.updateMemberPos(username, s.pos);
		world.broadcastToInstance(ctx, username, 'playerState', {
			player: username, pos: s.pos, face: s.face, anim: s.anim,
			// Death flag: teammates despawn the mirror while its owner is dead
			// (instead of showing a frozen corpse) and respawn it on recovery.
			dead: s.dead ? 1 : 0,
			hp: s.hp, maxHp: s.maxHp, sp: s.sp, maxSp: s.maxSp,
			// Round 10: skill/ball charge flag — drives the party-wide charge
			// time-stop on every client.
			cg: s.cg ? 1 : 0,
			// Round 19: cutscene flag — teammates hide/hold the mirror while its
			// owner is in a cutscene, instead of showing it mid-anim outside the
			// cutscene's own actor set.
			cs: s.cs ? 1 : 0,
		});
	});
	// Only the instance host broadcasts the entity (enemy) state block. Keyed by the
	// map's stable mapId so host & members refer to the same creature. Members apply
	// it to puppet mirrors (their local enemy AI is disabled).
	socket.on('entityState', function (block) {
		if (dropIfNotAuthed('entityState')) return;
		if (!block || typeof block.map !== 'string' || !Array.isArray(block.e)) return;
		if (block.e.length > 512) return; // sanity cap
		world.broadcastHostState(ctx, username, 'entityState', { map: block.map, e: block.e, cb: !!block.cb });
	});

	// ---- round 19: cutscene-spawned monster sync (NON-host streaming) ----
	// During a cutscene the game can spawn monsters the client wants the whole
	// instance to see as temporary entities. Like playerState this is NOT
	// host-gated — each client streams its own cutscene's entities (the block
	// host's entityState only covers the regular combat enemies). The `from`
	// field (the stream owner's username) lets receivers ignore their own
	// entries and reap this stream's entities when the owner stops sending.
	// Rate-limited like the combat relays; the payload shape is the clients'
	// own (only map + list length are sanity-checked, entries missing a uid
	// are dropped as garbage).
	socket.on('cutsceneEntity', function (data) {
		if (dropIfNotAuthed('cutsceneEntity')) return;
		if (rateLimited('cutsceneEntity', 50)) return;
		if (!data || typeof data.map !== 'string' || !Array.isArray(data.list) || data.list.length > 64) return;
		const list = [];
		for (const e of data.list) {
			if (e && typeof e === 'object' && e.uid !== undefined) list.push(e);
		}
		world.broadcastToInstance(ctx, username, 'cutsceneEntity', { from: username, map: data.map, list });
	});

	// ---- round 17: host forwards an enemy ATTACK (uid + attack anim) to members ----
	// The instance host's client detects when one of its real enemies starts an attack
	// (fresh attack-anim edge at block cadence) and relays it here so every member's
	// puppet performs the same attack toward the local player — member puppets no longer
	// run the local AI, so the host's timing is authoritative. Host-only relay like
	// entityState (broadcastHostState: no-op unless the sender IS the instance host),
	// auth-gated + rate-limited like the combat relays; the payload is whitelisted
	// field-by-field (never a raw blob).
	socket.on('enemyAttack', function (data) {
		if (dropIfNotAuthed('enemyAttack')) return;
		if (rateLimited('enemyAttack', 50)) return;
		if (!data || typeof data.uid !== 'number') return;
		if (typeof data.anim !== 'string' || !data.anim || data.anim.length > 64) return;
		world.broadcastHostState(ctx, username, 'enemyAttack', { uid: data.uid, anim: data.anim });
	});

	socket.on('updateAnimation', function (data) {
		if (dropIfNotAuthed('updateAnimation')) return;
		if (!data) return;
		world.broadcastToInstance(ctx, username, 'updateAnimation', { player: username, face: data.face, anim: data.anim });
	});

	socket.on('updateAnimationTimer', function (timer) {
		if (dropIfNotAuthed('updateAnimationTimer')) return;
		world.broadcastToInstance(ctx, username, 'updateAnimationTimer', { player: username, timer });
	});

	socket.on('throwBall', function (data) {
		if (dropIfNotAuthed('throwBall')) return;
		if (!data) return;
		// Always stamp the real sender as the combatant — never trust a client-
		// supplied name, or a ball could be attributed to (and damage) someone else.
		data.combatant = username;
		world.broadcastToInstance(ctx, username, 'throwBall', data);
	});

	// ---- round 11: special-skill effect replay ----
	// A player cast a special skill: relay the effect sheet + key so every other
	// client re-spawns the visual on the caster's mirror. Sender stamped like
	// throwBall; params whitelisted client-side (serializable fields only).
	socket.on('skillFx', function (data) {
		if (dropIfNotAuthed('skillFx')) return;
		if (rateLimited('skillFx', 50)) return;
		if (!data || typeof data.sheet !== 'string' || typeof data.key !== 'string') return;
		if (data.sheet.length > 64 || data.key.length > 64) return;
		world.broadcastToInstance(ctx, username, 'skillFx', {
			player: username,
			sheet: data.sheet,
			key: data.key,
			f: (data.f && typeof data.f.x === 'number' && typeof data.f.y === 'number' && typeof data.f.z === 'number')
				? { x: data.f.x, y: data.f.y, z: data.f.z } : null,
			p: (data.p && typeof data.p === 'object') ? data.p : {},
		});
	});

	// ---- combat: host forwards an enemy-hit on a player's mirror to that player ----
	// Enemies on the host can target a remote player's mirror entity (an Enemy-typed,
	// party=PLAYER stand-in). The mirror's hp is owner-driven (the owner's playerState
	// overwrites it every frame), so damaging the mirror locally does nothing — the
	// host instead forwards the hit here and the owner's client applies the damage to
	// their REAL player. Payload carries the target player name; clients ignore hits
	// not meant for them.
	socket.on('combatHit', function (data) {
		if (dropIfNotAuthed('combatHit')) return;
		if (rateLimited('combatHit', 50)) return;
		if (!data || !isValidName(data.player)) return;
		const dmg = Number(data.damage);
		if (!isFinite(dmg) || dmg <= 0 || dmg > 100000) return;
		world.broadcastToInstance(ctx, username, 'combatHit', {
			player: data.player,
			damage: Math.round(dmg),
			element: typeof data.element === 'number' ? data.element : 0,
			critical: !!data.critical,
			// Round 11: attacker position so the owner can knock the player AWAY
			// from the hit (full hit feedback, see client applyCombatHit).
			ax: typeof data.ax === 'number' && isFinite(data.ax) ? data.ax : undefined,
			ay: typeof data.ay === 'number' && isFinite(data.ay) ? data.ay : undefined,
			// Round 20: the attacker's attack stat so a guarding owner can apply the
			// engine's PLAYER-shield damage reduction to the forwarded hit.
			attack: typeof data.attack === 'number' && isFinite(data.attack) && data.attack > 0 ? data.attack : 0,
		});
	});

	// ---- combat: a MEMBER reports damage it dealt to a shared enemy ----
	// The member's client applies its own hits to its local puppet for instant feedback
	// and forwards the same number here so the HOST deducts it from the authoritative
	// real enemy (uid). Only the host's client acts on it (it owns enemy HP); members
	// ignore it. Capped + validated like combatHit.
	socket.on('enemyDamage', function (data) {
		if (dropIfNotAuthed('enemyDamage')) return;
		if (rateLimited('enemyDamage', 50)) return;
		if (!data || typeof data.uid !== 'number') return;
		const dmg = Number(data.damage);
		if (!isFinite(dmg) || dmg <= 0 || dmg > 100000) return;
		world.broadcastToInstance(ctx, username, 'enemyDamage', {
			uid: data.uid,
			damage: Math.round(dmg),
			attacker: username, // authoritative sender, never client-supplied
		});
	});

	// ---- entity (enemy) sync: host-authoritative within the instance ----
	socket.on('registerEntity', function (data) {
		if (dropIfNotAuthed('registerEntity')) return;
		if (!data || data.type !== 'Enemy') return;
		if (!isValidEntityId(data.id)) return; // blocks __proto__/constructor bucket pollution
		world.registerEntity(ctx, username, data);
	});

	socket.on('updateEntityPosition', function (data) {
		if (dropIfNotAuthed('updateEntityPosition')) return;
		if (!data) return;
		world.entityAction(ctx, username, 'updateEntityPosition', data, true);
	});
	socket.on('updateEntityAnimation', function (data) {
		if (dropIfNotAuthed('updateEntityAnimation')) return;
		if (!data) return;
		world.entityAction(ctx, username, 'updateEntityAnimation', data, true);
	});
	socket.on('updateEntityState', function (data) {
		if (dropIfNotAuthed('updateEntityState')) return;
		if (!data) return;
		world.entityAction(ctx, username, 'updateEntityState', data, true);
	});
	socket.on('updateEntityTarget', function (data) {
		if (dropIfNotAuthed('updateEntityTarget')) return;
		if (!data) return;
		// target === 0 means "the reporting player themself" -> substitute their name.
		if (data.target === 0) data.target = username;
		world.entityAction(ctx, username, 'updateEntityTarget', data, true);
	});
	socket.on('updateEntityHealth', function (data) {
		if (dropIfNotAuthed('updateEntityHealth')) return;
		if (!data) return;
		// id === null means a player reporting their OWN health (anyone may); a
		// non-null id is an authoritative enemy (host only). maxHp rides along so the
		// receiving client can render the party HP bar against the right cap.
		if (data.id === null) {
			world.broadcastToInstance(ctx, username, 'updateEntityHealth', { id: username, hp: data.hp, maxHp: data.maxHp });
		} else {
			world.entityAction(ctx, username, 'updateEntityHealth', data, true);
		}
	});
	// Frequent, player-scoped live combat stats (currentHp/currentSp) for the in-game
	// party HUD. NOT host-gated — each client reports only its OWN values, and the
	// sender's username is authoritative (stamped server-side, never trusted).
	socket.on('updatePlayerStats', function (data) {
		if (dropIfNotAuthed('updatePlayerStats')) return;
		if (!data) return;
		world.broadcastToInstance(ctx, username, 'updatePlayerStats', {
			player: username, hp: data.hp, maxHp: data.maxHp, sp: data.sp, maxSp: data.maxSp,
		});
	});

	// ---- round 20: GHOST CHESTS — a player opened chests; tell their party ----
	// Party-only, per-PARTY storage (survives reconnects; a stranger in a shared
	// town can never pollute it because we look up the SENDER's party). Each entry
	// is {map, id} where id is the game-wide-unique chest mapId; the wire key is
	// "<mapName>:<id>". Only the first time a member opens a given chest do we
	// broadcast `chestOpenedBy` to their current instance (so both ends mark the
	// opener and the local chest renders as a 25%-alpha ghost for teammates).
	socket.on('chestOpened', function (data) {
		if (dropIfNotAuthed('chestOpened')) return;
		if (rateLimited('chestOpened', 10)) return;
		if (!data || !Array.isArray(data.list)) return;
		// Validate each entry and cap the list (belt-and-braces: the client already
		// caps at 128, but a hostile/buggy client must never grow the party store).
		const entries = [];
		const seen = Object.create(null);
		for (const e of data.list.slice(0, 128)) {
			if (!e || typeof e !== 'object') continue;
			const map = e.map;
			const id = e.id;
			if (typeof map !== 'string' || !map || map.length > 128 || map.indexOf('..') !== -1) continue;
			if (typeof id !== 'number' || !isFinite(id) || id <= 0 || id > 1e9) continue;
			const key = map + ':' + id;
			if (seen[key]) continue; // dedupe within one packet
			seen[key] = true;
			entries.push({ map, id, key });
		}
		if (!entries.length) return;
		const partyId = party.partyOf(username);
		if (!partyId) return; // solo -> the feature is party-only
		for (const e of entries) {
			if (party.markChestOpened(partyId, e.key, username)) {
				world.broadcastToInstance(ctx, username, 'chestOpenedBy', { key: e.key, by: username });
			}
		}
	});

	// Real player profile (level/stats/equip) for the Social info box. Broadcast
	// to the instance AND cached so players who join later still get it.
	socket.on('updatePlayerProfile', function (profile) {
		if (dropIfNotAuthed('updatePlayerProfile')) return;
		const clean = sanitizeProfile(profile);
		if (!clean) return;
		world.updateMemberProfile(username, clean);
		world.broadcastToInstance(ctx, username, 'updatePlayerProfile', { player: username, profile: clean });
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
		if (!isValidName(target)) {
			socket.emit('friendActionResult', { action: 'request', ok: false, error: 'No such player' });
			return;
		}
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
		if (!isValidName(from)) return;
		const res = friends.accept(username, from);
		if (!res.ok) {
			socket.emit('friendActionResult', { action: 'accept', ok: false, error: res.error });
			return;
		}
		// Both sides now see each other in their friends list.
		socket.emit('friendList', { friends: friends.list(username) });
		const other = accounts.getSocket(from);
		if (other) other.emit('friendList', { friends: friends.list(from) });
	});
	socket.on('friendDecline', function (data) {
		if (dropIfNotAuthed('friendDecline')) return;
		const from = data && data.name;
		if (!isValidName(from)) return;
		friends.decline(username, from);
		socket.emit('friendRequests', { requests: friends.requests(username) });
	});
	socket.on('friendRemove', function (data) {
		if (dropIfNotAuthed('friendRemove')) return;
		if (!isValidName(data && data.name)) return;
		friends.remove(username, data && data.name);
		// Refresh both sides so the removed entry disappears everywhere.
		socket.emit('friendList', { friends: friends.list(username) });
		const other = accounts.getSocket(data && data.name);
		if (other) other.emit('friendList', { friends: friends.list(data.name) });
	});
	socket.on('friendList', function () {
		if (dropIfNotAuthed('friendList')) return;
		const list = friends.list(username);
		socket.emit('friendList', { friends: list });
		// Push cached real profiles for online friends right away so the Social
		// info box shows level/stats/equip on FIRST open (not after a 3s pump or a
		// shared-map visit). Friends never met in-game have no instance cache, so
		// use the global account profile cache.
		try {
			for (const f of list) {
				if (!f || !f.online) continue;
				const prof = world.getAccountProfile(f.name);
				if (prof) socket.emit('updatePlayerProfile', { player: f.name, profile: prof });
			}
		} catch (e) { /* non-fatal */ }
	});
	socket.on('friendRequests', function () {
		if (dropIfNotAuthed('friendRequests')) return;
		socket.emit('friendRequests', { requests: friends.requests(username) });
	});

	// ---- party ----
	socket.on('partyInvite', function (data) {
		if (dropIfNotAuthed('partyInvite')) return;
		const to = data && data.to;
		// Reject invalid names, self-invites, and offline targets up front.
		if (!isValidName(to) || to === username || !accounts.isOnline(to)) {
			socket.emit('partyActionResult', { action: 'invite', ok: false, error: 'Player not online: ' + to });
			return;
		}
		const partyId = party.createParty(username);
		// ROUND 12: combined party cap (players + host-side bots) is 8. Bots live
		// client-side, so from the server's view the cap is simply 8 members.
		const cur = party.getParty(partyId);
		if (cur && cur.members.length >= 8) {
			socket.emit('partyActionResult', { action: 'invite', ok: false, error: '队伍已满（最多 8 人）' });
			return;
		}
		party.addInvite(partyId, to); // only the invited player may accept this id
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
		// Only someone actually invited may join (partyId is guessable: p1, p2, ...).
		if (!party.consumeInvite(partyId, username)) {
			socket.emit('partyActionResult', { action: 'accept', ok: false, error: 'No invite to this party' });
			return;
		}
		// ROUND 12: refuse to exceed the 8-member cap (race-safe re-check at accept).
		{
			const cap = party.getParty(partyId);
			if (cap && cap.members.length >= 8) {
				socket.emit('partyActionResult', { action: 'accept', ok: false, error: '队伍已满（最多 8 人）' });
				return;
			}
		}
		// Leave any current party first (forced disband of the acceptor's old party).
		// Capture the survivors BEFORE removing so a 2-person disband still notifies
		// the old teammate (removeMember returns null on disband).
		const prevPartyId = party.partyOf(username);
		const prevSurvivors = prevPartyId && party.getParty(prevPartyId)
			? party.getParty(prevPartyId).members.filter((m) => m !== username) : [];
		const prev = party.removeMember(username);
		if (prev) {
			pushPartyUpdate(prev.id);
		} else {
			for (const m of prevSurvivors) {
				const s = accounts.getSocket(m);
				if (s) s.emit('partyUpdate', null);
				// The old party disbanded: move its survivor out of the dead
				// party:<id> instance so they don't linger as a ghost.
				world.recomputeMemberInstance(ctx, m);
			}
		}
		party.addMember(partyId, username);
		// Broadcast the new roster to EVERY member (inviter + invitee).
		pushPartyUpdate(partyId);
		const p = party.getParty(partyId);
		// ROUND 10: actively migrate every online member already on a map into the
		// new party instance (solo:<u>:<map> -> party:<id>:<map>). The join path of
		// world.changeMap emits the mutual onPlayerChangeMap enter events, so BOTH
		// clients spawn each other's mirror immediately — no reliance on the client
		// reassert, which used to be dropped whenever it arrived mid-teleport (the
		// "组队后同图互不可见，重进才行" bug). Shared-town instances are unaffected
		// (their instance id never depends on the party).
		for (const m of p.members) {
			const wasHost = world.isHostOf(m, world.instanceOf(m));
			const migrated = world.recomputeMemberInstance(ctx, m);
			if (migrated) {
				console.log('[party] migrated ' + m + ' into ' + migrated.instanceId + ' (host=' + migrated.isHost + ')');
				const s = accounts.getSocket(m);
				// A migrated member's authority may have flipped (a solo-instance host
				// becomes a plain member of the merged party instance). Push the
				// authoritative host flag so the client stops/starts streaming the
				// enemy block; skip the nudge when nothing changed.
				if (s && migrated.isHost !== wasHost) {
					s.emit('setHost', { isHost: migrated.isHost, map: migrated.mapName });
				}
			}
		}
		// The disbanded old party's survivor is now in their own solo instance while
		// the acceptor migrated into the new party instance. If they ended up apart,
		// emit the missed enters:false both ways so neither keeps a frozen mirror.
		if (!prev) {
			crossDespawnDifferentInstances(prevSurvivors.concat([username]));
		}
		// Client-side belt-and-braces: re-assert our current instance (idempotent
		// server-side). Retried by the client when it arrives mid-teleport.
		for (const m of p.members) {
			const s = accounts.getSocket(m);
			if (s) s.emit('partyReSync');
		}
		// NOTE: joining a party NO LONGER auto-teleports the acceptor to the leader.
		// Regrouping is a separate, manual action: the client shows a
		// "传送到队友身边" button (enabled only while in a party) which emits
		// `partyRegroup`; only then do we answer with the leader's location so the
		// requester can teleport. This keeps party-up and travelling decoupled.
	});
	socket.on('partyRegroup', function (data) {
		if (dropIfNotAuthed('partyRegroup')) return;
		const partyId = party.partyOf(username);
		const p = partyId && party.getParty(partyId);
		if (!p) return;
		// Target defaults to the leader, but any OTHER party member may be named
		// (the client sends the clicked teammate card's username). A stale/invalid
		// target (teammate left between click and processing) falls back to the
		// leader instead of silently dropping.
		let target = (data && typeof data.target === 'string' && p.members.indexOf(data.target) !== -1)
			? data.target : p.leader;
		if (!target || target === username) return;
		const loc = world.getMemberLocation(target);
		// Only send a regroup when we actually know where the target is;
		// otherwise the requester would get a null map and teleport nowhere.
		if (loc && loc.map) {
			// pos must be a full numeric triple or the client's TeleportPosition
			// would read undefined y/z and wedge the load — drop to a map-default
			// teleport instead.
			const posOk = loc.pos && ['x', 'y', 'z'].every((k) => typeof loc.pos[k] === 'number' && isFinite(loc.pos[k]));
			socket.emit('partyMove', { leader: target, map: loc.map, pos: posOk ? loc.pos : null });
		}
	});
	socket.on('partyDecline', function (data) {
		if (dropIfNotAuthed('partyDecline')) return;
		party.consumeInvite(data && data.partyId, username); // a decline voids the invite
		// Notify the inviter (party leader) of the decline.
		const p = party.getParty(data && data.partyId);
		if (p) {
			const leader = accounts.getSocket(p.leader);
			if (leader) leader.emit('partyActionResult', { action: 'declined', ok: true, from: username });
		}
	});
	socket.on('partyLeave', function () {
		if (dropIfNotAuthed('partyLeave')) return;
		const partyId = party.partyOf(username);
		const others = partyId && party.getParty(partyId) ? party.getParty(partyId).members.filter((m) => m !== username) : [];
		const updated = party.removeMember(username);
		socket.emit('partyUpdate', null);
		if (updated) {
			pushPartyUpdate(updated.id);
		} else {
			// Party disbanded (2-person party lost a member) -> tell the survivor too.
			for (const m of others) {
				const s = accounts.getSocket(m);
				if (s) s.emit('partyUpdate', null);
				world.recomputeMemberInstance(ctx, m);
			}
		}
		// Whoever left is solo now: move them out of the party:<id> instance.
		world.recomputeMemberInstance(ctx, username);
		if (!updated) {
			// Disband case: leaver and survivor each end up in their own solo
			// instance. The last one to migrate left the old party instance empty,
			// so the other never got the enters:false that despawns their mirror.
			crossDespawnDifferentInstances(others.concat([username]));
		}
	});

	// ---- round 11: party BOT roster (host -> everyone in the instance) ----
	// The host's native party menu can add genuine game bots (Emilie/...) AND
	// round-12 "mod bots" (offline friends spawned as follower copies). Members
	// can't see them unless they know they exist: this relays the bot list and
	// member clients spawn local follower copies. Host-only publication; the list
	// is cached per-instance and replayed to late joiners by world.changeMap.
	// ROUND 12: dropped the fixed character whitelist — mod bots carry arbitrary
	// usernames. Combined party cap (players + bots) is 8, enforced client-side
	// by the host; we just cap the relayed list at 8.
	socket.on('partyBots', function (data) {
		if (dropIfNotAuthed('partyBots')) return;
		const instanceId = world.instanceOf(username);
		if (!instanceId || !world.isHostOf(username, instanceId)) return;
		let bots = (data && Array.isArray(data.bots)) ? data.bots : [];
		bots = bots.filter((b) => typeof b === 'string' && b.length > 0 && b.length <= 32).slice(0, 8);
		const inst = world.getInstance(instanceId);
		if (inst) inst.bots = bots;
		world.broadcastToInstance(ctx, username, 'partyBots', { bots: bots });
	});

	// ---- round 13: party LEADER streams live bot state (pos/anim/hp/level) ----
	// The party leader runs the follower bots with full AI and streams their live
	// state so members render the same bots as local puppets. NOT host-gated on
	// purpose: the bots belong to the party LEADER, who may be a plain member of
	// the instance (the block host can be someone else) — rate-limited instead,
	// exactly like the combat relays. Every payload is rebuilt field-by-field
	// (whitelist only), so a hostile/buggy leader can never forward a raw blob.
	socket.on('botState', function (data) {
		if (dropIfNotAuthed('botState')) return;
		if (rateLimited('botState', 30)) return;
		if (!data || !Array.isArray(data.bots)) return;
		const num = (v) => (typeof v === 'number' && isFinite(v)) ? Math.round(v) : undefined;
		const bots = [];
		for (const b of data.bots) {
			if (!b || typeof b !== 'object') continue;
			if (typeof b.n !== 'string' || b.n.length === 0 || b.n.length > 32) continue;
			const e = {
				n: b.n,
				x: num(b.x), y: num(b.y), z: num(b.z),
				fx: num(b.fx), fy: num(b.fy),
				a: typeof b.a === 'string' ? b.a.slice(0, 64) : '',
				hp: num(b.hp), mh: num(b.mh),
				lv: num(b.lv), ex: num(b.ex),
			};
			if (e.x === undefined || e.y === undefined || e.z === undefined) continue;
			bots.push(e);
		}
		world.broadcastToInstance(ctx, username, 'botState', {
			map: typeof data.map === 'string' ? data.map.slice(0, 64) : '',
			bots: bots.slice(0, 8),
			from: username,
		});
	});

	// Leader-only: remove a member from the party (the 踢出 button). Mirrors the
	// partyLeave bookkeeping, but the REQUESTER stays and the TARGET goes solo.
	socket.on('partyKick', function (data) {
		if (dropIfNotAuthed('partyKick')) return;
		const target = data && typeof data.target === 'string' ? data.target : null;
		if (!target || !isValidName(target) || target === username) return;
		const partyId = party.partyOf(username);
		const p = partyId && party.getParty(partyId);
		if (!p || p.leader !== username) return;          // leader-only
		if (p.members.indexOf(target) === -1) return;     // must actually be a member
		const others = p.members.filter((m) => m !== username && m !== target);
		const updated = party.removeMember(target);
		// The kicked player loses their party exactly like a leave.
		const tSock = accounts.getSocket(target);
		if (tSock) tSock.emit('partyUpdate', null);
		if (updated) {
			pushPartyUpdate(updated.id);
		} else {
			// Party disbanded (kick dropped it to one person): tell the kicker and
			// any survivors their party is gone too.
			socket.emit('partyUpdate', null);
			for (const m of others) {
				const s = accounts.getSocket(m);
				if (s) s.emit('partyUpdate', null);
				world.recomputeMemberInstance(ctx, m);
			}
		}
		// The kicked player is solo now: move them out of the party:<id> instance.
		world.recomputeMemberInstance(ctx, target);
		if (!updated) {
			// Disband case: the kicked player is now in their own solo instance
			// while the kicker stays on the old map. Emit the missed enters:false
			// both ways so neither client keeps a frozen mirror of the other.
			crossDespawnDifferentInstances(others.concat([username, target]));
		}
	});

	// ---- server-side save ----
	socket.on('saveUpload', function (data) {
		if (dropIfNotAuthed('saveUpload')) return;
		if (!data || typeof data.slot === 'undefined' || !data.data) return;
		// Whitelist the slot key AND block reserved/magic keys (__proto__, updatedAt)
		// — the slot lands on a plain object in saveGame, so a magic key would
		// clobber the save container instead of writing a slot. 'autoSlot' itself is
		// the legitimate slot the client uploads (see validate.js).
		const slot = String(data.slot);
		if (!isValidSlotKey(slot)) return;
		// Bound the save payload so a hostile/buggy client can't grow the file
		// without limit (a real CrossCode save is well under a few MB).
		if (typeof data.data === 'string' && data.data.length > 8 * 1024 * 1024) return;
		persistence.saveGame(username, slot, sanitizeSaveParty(data.data));
	});

	// The client can (older builds always did) serialize its injected multiplayer
	// pseudo-players into the save's party block. Restoring such a save crashes the
	// native party HUD (addObserver on a PartyMemberModel that doesn't exist at
	// runtime). Strip any party entry that isn't one of the game's real characters
	// so the stored save is always a clean single-player save. Authoritative here so
	// it also repairs saves already polluted by older clients.
	const NATIVE_PARTY = { Lea: 1, Shizuka: 1, Shizuka0: 1, Emilie: 1, Sergey: 1, Schneider: 1, Schneider2: 1, Hlin: 1, Grumpy: 1, Buggy: 1, Glasses: 1, Apollo: 1, Joern: 1, Triblader1: 1, Luke: 1 };
	function sanitizeSaveParty(raw) {
		try {
			if (typeof raw !== 'string') return raw;
			const d = JSON.parse(raw);
			const p = d && d.party;
			if (!p) return raw;
			if (p.currentParty && p.currentParty.length) {
				p.currentParty = p.currentParty.filter((n) => n === 'Lea' || NATIVE_PARTY[n]);
			}
			if (p.models) for (const k in p.models) if (!NATIVE_PARTY[k]) delete p.models[k];
			if (p.contacts) for (const k in p.contacts) if (!NATIVE_PARTY[k]) delete p.contacts[k];
			return JSON.stringify(d);
		} catch (e) { return raw; }
	}

	// ---- lobby queries (Social-menu "房间玩家" tab + online counter) ----
	// The members of the caller's current map instance (everyone they can see in
	// this room/town) INCLUDING the caller themself (round 9: the room list shows
	// yourself), plus the username of the instance's block host so the client can
	// mark who hosts the current block.
	socket.on('roomPlayers', function () {
		if (dropIfNotAuthed('roomPlayers')) return;
		const instanceId = world.instanceOf(username);
		const inst = instanceId ? world.getInstance(instanceId) : null;
		socket.emit('roomPlayers', {
			players: world.getInstanceMembers(username),
			host: inst && inst.host ? inst.host : null,
		});
	});
	// Total number of players currently online on this server.
	socket.on('onlineCount', function () {
		if (dropIfNotAuthed('onlineCount')) return;
		socket.emit('onlineCount', { count: accounts.onlineNames().length });
	});
}

module.exports = { handleConnection };
