// World: the heart of the lobby architecture. Owns map *instances* — the unit
// of routing. Every sync event is broadcast only within one instance. Each
// instance has exactly one host client that is authoritative for enemies/combat
// in that instance (the server itself runs no game logic).
//
// instanceId rules (I1):
//   shared-town area          -> town:<area>[#N]           (whole area shares; 32/channel)
//   PATH/DUNGEON, in a party  -> party:<partyId>:<mapName>
//   PATH/DUNGEON, solo        -> solo:<username>:<mapName>
//
// areaType values come from the client (sc.AREA_TYPE): 0=TOWN, 1=PATH, 2=DUNGEON.
const party = require('./party');
const { isValidEntityId } = require('./validate');

const AREA_TOWN = 0;

// Main-city (主城) areas: the WHOLE area is one open-matchmaking town, not just a
// single sub-map. Players in these areas auto-match (no party required) into a
// town instance. A TOWN-area map not in this list stays a normal party/solo map.
//   rookie-harbor = 新手港 (Rookie Harbor)
//   rhombus-sqr   = 罗姆斯广场 (Rhombus Square, incl. 迎新桥)
const SHARED_TOWNS = ['rookie-harbor', 'rhombus-sqr'];

// Max players in one main-city instance (channel). A full channel forces the next
// joiner into a new `town:<area>#N` channel (like MMO channels).
const TOWN_CAPACITY = 32;

/** The main-city AREA a map belongs to, or null (not a shared town). */
function sharedTownArea(mapName, areaType) {
	if (areaType !== AREA_TOWN) return null;
	const area = mapName.indexOf('.') === -1 ? mapName : mapName.substring(0, mapName.indexOf('.'));
	return SHARED_TOWNS.indexOf(area) !== -1 ? area : null;
}

function World() {
	// Null-prototype maps so reserved keys (__proto__/...) can never collide.
	// instanceId -> { id, mapName, areaType, host, members: [username], entities: {id: {...}} }
	this.instances = Object.create(null);
	// username -> instanceId (which instance each player is currently in)
	this.userInstance = Object.create(null);
	// Round 19: PVP-duel instance isolation. username -> true forces the player's
	// routing to solo:<user>:<map> regardless of party/shared-town rules (duels
	// happen in shared towns too). Cleared on disconnect.
	this.userIsolation = Object.create(null);
}

// True when `instanceId` is a town instance of the given AREA (any channel).
World.prototype.isTownInstanceOfArea = function (instanceId, area) {
	if (typeof instanceId !== 'string') return false;
	const prefix = 'town:' + area;
	return instanceId === prefix || instanceId.indexOf(prefix + '#') === 0;
};

// Compute the instance a player should join for a given map.
World.prototype.instanceIdFor = function (username, mapName, areaType) {
	// Round 19: PVP-duel isolation OVERRIDES every routing rule. While isolated,
	// the player is ALWAYS solo on the given map — even in a shared town and even
	// if they're in a party (so a duel can't be yanked back into a group by a
	// party accept/kick/leave or by wandering through a shared-town map).
	if (this.userIsolation[username]) {
		return 'solo:' + username + ':' + mapName;
	}
	const townArea = sharedTownArea(mapName, areaType);
	if (townArea) {
		// Stay in the town channel we're already in (a re-sync or a move between two
		// sub-maps of the same area must never hop channels).
		const cur = this.userInstance[username];
		if (cur && this.isTownInstanceOfArea(cur, townArea)) return cur;
		// Otherwise join the first channel with room; a full channel spills into a
		// new `town:<area>#N` channel.
		for (let channel = 0; channel < 1000; channel++) {
			const id = channel === 0 ? ('town:' + townArea) : ('town:' + townArea + '#' + channel);
			const inst = this.instances[id];
			if (!inst || inst.members.length < TOWN_CAPACITY) return id;
		}
		return 'town:' + townArea + '#999'; // unreachable safety net
	}
	const partyId = party.partyOf(username);
	if (partyId) {
		return 'party:' + partyId + ':' + mapName;
	}
	return 'solo:' + username + ':' + mapName;
};

World.prototype.instanceOf = function (username) {
	return this.userInstance[username];
};

// The usernames in the instance the given player is currently in (empty array if
// they are in no instance). Used by the Social-menu "房间玩家" tab.
World.prototype.getInstanceMembers = function (username) {
	const instanceId = this.userInstance[username];
	const inst = instanceId && this.instances[instanceId];
	return inst ? inst.members.slice() : [];
};

World.prototype.getInstance = function (instanceId) {
	return this.instances[instanceId];
};

World.prototype.isHostOf = function (username, instanceId) {
	const inst = this.instances[instanceId];
	return !!inst && inst.host === username;
};

// Whether the given user is the block host of whatever instance they are CURRENTLY
// in (reuses the username -> instanceId mapping world.js already maintains). Round 20:
// the pingReport relay stamps isHost so clients can label the instance host.
World.prototype.isHostUser = function (username) {
	const instanceId = this.userInstance[username];
	return instanceId ? this.isHostOf(username, instanceId) : false;
};

// The map + last-known position of a player (for "teleport me to the leader").
World.prototype.getMemberLocation = function (username) {
	const instanceId = this.userInstance[username];
	const inst = instanceId && this.instances[instanceId];
	if (!inst) return null;
	// A town instance spans a whole area; use the member's REAL sub-map when known.
	const map = (inst.memberMap && inst.memberMap[username]) || inst.mapName;
	return { map, pos: (inst.memberPos && inst.memberPos[username]) || null };
};

// After a party disbands (or FORMS), members still standing in an instance that
// no longer matches their party state would keep broadcasting to (and seeing)
// the wrong set of players. Recompute their instance (party / solo / shared-town)
// and move them. Returns { instanceId, isHost, mapName } when the player was
// actually migrated, or null when nothing changed (caller may then skip nudges).
World.prototype.recomputeMemberInstance = function (ctx, username) {
	const cur = this.userInstance[username];
	if (!cur) return null;
	const inst = this.instances[cur];
	if (!inst) { delete this.userInstance[username]; return null; }
	const target = this.instanceIdFor(username, inst.mapName, inst.areaType);
	if (target === cur) return null; // instance still correct
	const pos = (inst.memberPos && inst.memberPos[username]) || { x: 0, y: 0, z: 0 };
	const res = this.changeMap(ctx, username, inst.mapName, inst.areaType, pos);
	return { instanceId: target, isHost: !!(res && res.isHost), mapName: inst.mapName };
};

// A player enters `mapName` (areaType reported by the client). Moves them out of
// their old instance and into the target one, creating it if needed. Returns
// { instanceId, isHost, members: [{name, pos}] } for the changeMapResponse.
World.prototype.changeMap = function (ctx, username, mapName, areaType, pos) {
	const instanceId = this.instanceIdFor(username, mapName, areaType);

	// Already in the target instance (e.g. a re-sync): DON'T leave+rejoin — that
	// would flap the host to someone else and spam members with leave/enter. Just
	// refresh our position and answer with the current state.
	if (this.userInstance[username] === instanceId) {
		const cur = this.instances[instanceId];
		if (cur) {
			const prevMap = (cur.memberMap && cur.memberMap[username]) || null;
			if (cur.memberPos) cur.memberPos[username] = pos;
			if (!cur.memberMap) cur.memberMap = Object.create(null);
			cur.memberMap[username] = mapName;
			// A member moved to a DIFFERENT sub-map of the same town area (still the
			// same instance): tell the other members it left the old map and entered the
			// new one, so their clients spawn the mirror only for the sub-map they share.
			if (prevMap && prevMap !== mapName) {
				for (const other of cur.members) {
					if (other === username) continue;
					const sock = ctx.getSocket(other);
					if (!sock) continue;
					sock.emit('onPlayerChangeMap', { player: username, enters: false, map: prevMap, marker: null });
					sock.emit('onPlayerChangeMap', { player: username, enters: true, position: pos, map: mapName, marker: null });
				}
			}
			const members = cur.members.filter((m) => m !== username)
				.map((m) => ({ name: m, pos: cur.memberPos ? cur.memberPos[m] : undefined, map: (cur.memberMap && cur.memberMap[m]) || cur.mapName }));
			// Round 20: a re-sync is still an instance (re)join — re-push the party's
			// opened-chest snapshot for this map so a party formed/rejoined here is
			// immediately ghost-aware.
			this.emitChestState(ctx, username, mapName);
			return { instanceId, isHost: cur.host === username, members, host: cur.host };
		}
	}

	this.leaveCurrentInstance(ctx, username);

	let inst = this.instances[instanceId];
	if (!inst) {
		inst = this.instances[instanceId] = {
			id: instanceId, mapName, areaType, host: null, members: [], entities: Object.create(null),
			memberMap: Object.create(null),
		};
	}

	// First one in becomes the host of this instance.
	const isHost = !inst.host || !ctx.isOnline(inst.host);
	if (isHost) inst.host = username;

	// Round 35 (void-creature): a party member who crosses a map exit FIRST becomes the
	// lone host of the fresh `party:<pid>:<map>` instance. Round-35's first fix told that
	// crosser to force-strip its local enemies (mpForceStripNextLoad) and wait for the
	// leader's relay — but that left the whole map EMPTY whenever the leader didn't
	// immediately follow, which is wrong: whether a room has monsters should depend ONLY
	// on whether you're the host of that room's instance, never on the leader.
	//
	// The engine is a strict teleport-and-replace (clearMap kills every entity incl. the
	// player, then loadLevel rebuilds the new map fresh) — there is NO adjacent-map
	// streaming and no window where the member and leader share two maps. So the first
	// crosser is the SOLE occupant of the new instance and its locally-spawned enemies
	// are the authoritative set, relayed to teammates when they cross in. We therefore
	// do NOT force-strip here anymore: the crosser keeps host and spawns its own
	// authoritative enemies. No mpForceStripNextLoad is emitted.

	// Notify existing members that this player entered, and vice versa.
	const members = [];
	for (const other of inst.members) {
		const sock = ctx.getSocket(other);
		if (!sock) continue;
		members.push({ name: other, pos: inst.memberPos ? inst.memberPos[other] : undefined, map: (inst.memberMap && inst.memberMap[other]) || inst.mapName });
		sock.emit('onPlayerChangeMap', { player: username, enters: true, position: pos, map: mapName, marker: null });
		ctx.getSocket(username).emit('onPlayerChangeMap', { player: other, enters: true, position: (inst.memberPos && inst.memberPos[other]), map: (inst.memberMap && inst.memberMap[other]) || inst.mapName, marker: null });
	}

	inst.members.push(username);
	this.userInstance[username] = instanceId;
	if (!inst.memberPos) inst.memberPos = {};
	inst.memberPos[username] = pos;
	if (!inst.memberMap) inst.memberMap = Object.create(null);
	inst.memberMap[username] = mapName;

	// Replay this instance's entity bucket to the newcomer so they see enemies.
	if (!isHost) {
		for (const id in inst.entities) {
			const e = inst.entities[id];
			if (e) ctx.getSocket(username).emit('registerEntity', { id: e.id, type: e.type, pos: e.pos, settings: e.settings });
		}
	}
	// Replay cached member profiles so the newcomer's Social info box is correct
	// (per-instance cache first, global account cache as fallback).
	if (inst.members) {
		for (const name of inst.members) {
			if (name === username) continue;
			const prof = (inst.memberProfiles && inst.memberProfiles[name]) || this.getAccountProfile(name);
			if (prof) ctx.getSocket(username).emit('updatePlayerProfile', { player: name, profile: prof });
		}
	}
	// Round 11: replay the host's party-bot roster so late joiners see the bots.
	// Round 27 (item 2): carry the cached per-bot maps so the off-map HUD hide/grey
	// works for a late joiner too (botMaps is set by the same broadcast that cached bots).
	if (!isHost && inst.bots && inst.bots.length) {
		ctx.getSocket(username).emit('partyBots', { bots: inst.bots, maps: inst.botMaps || {} });
	}

	// Round 20: push the party's opened-chest snapshot for the JOINED map (filtered
	// to this map's prefix to keep the payload small) so the newcomer immediately
	// knows which of this map's chests their party members already opened.
	this.emitChestState(ctx, username, mapName);

	return { instanceId, isHost, members, host: inst.host };
};

// Remove a player from whatever instance they're in (host migration / cleanup).
World.prototype.leaveCurrentInstance = function (ctx, username) {
	const instanceId = this.userInstance[username];
	if (!instanceId) return;
	delete this.userInstance[username];

	const inst = this.instances[instanceId];
	if (!inst) return;

	inst.members = inst.members.filter((m) => m !== username);
	if (inst.memberPos) delete inst.memberPos[username];
	if (inst.memberProfiles) delete inst.memberProfiles[username];
	if (inst.memberMap) delete inst.memberMap[username];

	// Tell remaining members this player left.
	for (const other of inst.members) {
		const sock = ctx.getSocket(other);
		if (sock) sock.emit('onPlayerChangeMap', { player: username, enters: false, map: inst.mapName, marker: null });
	}

	// Migrate host if the host left.
	if (inst.host === username) {
		inst.host = null;
		const next = inst.members.find((m) => ctx.isOnline(m));
		if (next) {
			inst.host = next;
			const sock = ctx.getSocket(next);
			if (sock) {
				// Main-city refactor: a town instance spans a whole area, so the new host
				// may be on a DIFFERENT sub-map than the instance's first joiner. Tag the
				// setHost with the NEW host's own sub-map so its client's map-check accepts it.
				sock.emit('setHost', { isHost: true, map: (inst.memberMap && inst.memberMap[next]) || inst.mapName });
				console.log('[world] instance ' + instanceId + ' host migrated to ' + next);
			}
		}
	}

	// Destroy empty instances (and their entity bucket).
	if (inst.members.length === 0) {
		delete this.instances[instanceId];
		console.log('[world] instance unloaded (empty): ' + instanceId);
	}
};

World.prototype.disconnect = function (ctx, username) {
	this.leaveCurrentInstance(ctx, username);
	// Round 19: a PVP duel ends when either side disconnects; never leave the
	// override behind on a logged-out session (it'd leak onto a later login).
	delete this.userIsolation[username];
	// The global profile cache belongs to the live session; drop it so the
	// map can't grow unbounded (every account that ever connected) and so a
	// stale profile is never replayed after someone logs back in.
	if (this.accountProfiles) delete this.accountProfiles[username];
};

// ---- sync-event routing helpers (all scoped to the caller's instance) ----

// Round 20: GHOST CHESTS — push the joining user's PARTY's opened-chest snapshot
// for `mapName` to their socket. Emitted on every changeMap (instance join AND
// re-sync). Keys are filtered to the joined map's prefix ("<mapName>:") so only
// chests relevant to the map the player is actually on are sent. No-op when the
// player is solo (feature is party-only) or the party has nothing opened here.
World.prototype.emitChestState = function (ctx, username, mapName) {
	const partyId = party.partyOf(username);
	if (!partyId) return;
	const opened = party.getOpenedChests(partyId);
	if (!opened) return;
	const sock = ctx.getSocket(username);
	if (!sock) return;
	const prefix = mapName + ':';
	const out = Object.create(null);
	for (const key in opened) {
		if (key.indexOf(prefix) !== 0) continue;
		out[key] = Object.keys(opened[key]);
	}
	if (Object.keys(out).length === 0) return; // nothing opened on this map
	sock.emit('chestState', { opened: out });
};

// Broadcast `event`/`payload` to all members of the user's instance except the sender.
World.prototype.broadcastToInstance = function (ctx, username, event, payload) {
	const instanceId = this.userInstance[username];
	if (!instanceId) return;
	const inst = this.instances[instanceId];
	if (!inst) return;
	for (const other of inst.members) {
		if (other === username) continue;
		const sock = ctx.getSocket(other);
		if (sock) sock.emit(event, payload);
	}
};

// Host-only relay: forward `event`/`payload` to the instance only if `username` is
// the instance host. Used by the new snapshot sync (only the host broadcasts the
// entity block); replaces the fragile per-entity id-bucket relay for live state.
World.prototype.broadcastHostState = function (ctx, username, event, payload) {
	const instanceId = this.userInstance[username];
	if (!instanceId || !this.isHostOf(username, instanceId)) return;
	this.broadcastToInstance(ctx, username, event, payload);
};

// Track a position for correct spawn placement of future joiners.
World.prototype.updateMemberPos = function (username, pos) {
	const instanceId = this.userInstance[username];
	const inst = instanceId && this.instances[instanceId];
	if (inst && inst.memberPos) inst.memberPos[username] = pos;
};

// Track a player's real profile (level/stats/equip) for the Social info box.
// Cached BOTH per-instance (replayed to joiners of that instance) and globally
// per-account (so a friend's card shows real stats even when you've never
// shared a map — the client pulls it via friendList).
World.prototype.updateMemberProfile = function (username, profile) {
	// null-prototype map: usernames are keys, so a name like "__proto__"
	// must not be able to pollute Object.prototype.
	if (!this.accountProfiles) this.accountProfiles = Object.create(null);
	this.accountProfiles[username] = profile;
	const instanceId = this.userInstance[username];
	const inst = instanceId && this.instances[instanceId];
	if (!inst) return;
	if (!inst.memberProfiles) inst.memberProfiles = {};
	inst.memberProfiles[username] = profile;
};

/** The last uploaded profile for an account (may be undefined). */
World.prototype.getAccountProfile = function (username) {
	return this.accountProfiles && this.accountProfiles[username];
};

// Register an authoritative entity into the caller's instance bucket (host only).
World.prototype.registerEntity = function (ctx, username, data) {
	const instanceId = this.userInstance[username];
	if (!instanceId || !this.isHostOf(username, instanceId)) return;
	if (!isValidEntityId(data.id)) return;
	const inst = this.instances[instanceId];
	// Store a whitelist copy (not the raw payload) so a hostile/oversized settings
	// blob can't be replayed to every future joiner.
	inst.entities[data.id] = { id: data.id, type: data.type, pos: data.pos, settings: data.settings };
	this.broadcastToInstance(ctx, username, 'registerEntity', { id: data.id, type: data.type, pos: data.pos, settings: data.settings });
};

World.prototype.entityAction = function (ctx, username, event, data, requireHost) {
	const instanceId = this.userInstance[username];
	if (!instanceId) return;
	if (requireHost && !this.isHostOf(username, instanceId)) return;
	if (!data || !isValidEntityId(data.id)) return;
	const inst = this.instances[instanceId];
	// Keep the bucket roughly in sync for late joiners.
	if (event === 'killEntity' && inst.entities[data.id]) delete inst.entities[data.id];
	if (event === 'updateEntityPosition' && inst.entities[data.id]) inst.entities[data.id].pos = data.pos;
	this.broadcastToInstance(ctx, username, event, data);
};

module.exports = new World();
