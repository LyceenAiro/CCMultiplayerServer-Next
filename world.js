// World: the heart of the lobby architecture. Owns map *instances* — the unit
// of routing. Every sync event is broadcast only within one instance. Each
// instance has exactly one host client that is authoritative for enemies/combat
// in that instance (the server itself runs no game logic).
//
// instanceId rules (I1):
//   shared-town area          -> town:<mapName>            (whole server shares)
//   PATH/DUNGEON, in a party  -> party:<partyId>:<mapName>
//   PATH/DUNGEON, solo        -> solo:<username>:<mapName>
//
// areaType values come from the client (sc.AREA_TYPE): 0=TOWN, 1=PATH, 2=DUNGEON.
const party = require('./party');

const AREA_TOWN = 0;

// Only these areas are *shared* towns (open matchmaking). Per the user's design
// we started with just Rookie Harbor; Rhombus Square (罗姆布斯广场, incl. 迎新桥)
// is now shared too. A TOWN-area map not in this list is treated as a normal
// party/solo map.
const SHARED_TOWNS = ['rookie-harbor', 'rhombus-sqr'];

function isSharedTown(mapName, areaType) {
	if (areaType !== AREA_TOWN) return false;
	const area = mapName.indexOf('.') === -1 ? mapName : mapName.substring(0, mapName.indexOf('.'));
	return SHARED_TOWNS.indexOf(area) !== -1;
}

function World() {
	// instanceId -> { id, mapName, areaType, host, members: [username], entities: {id: {...}} }
	this.instances = {};
	// username -> instanceId (which instance each player is currently in)
	this.userInstance = {};
}

// Compute the instance a player should join for a given map.
World.prototype.instanceIdFor = function (username, mapName, areaType) {
	if (isSharedTown(mapName, areaType)) {
		return 'town:' + mapName;
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

// A player enters `mapName` (areaType reported by the client). Moves them out of
// their old instance and into the target one, creating it if needed. Returns
// { instanceId, isHost, members: [{name, pos}] } for the changeMapResponse.
World.prototype.changeMap = function (ctx, username, mapName, areaType, pos) {
	this.leaveCurrentInstance(ctx, username);

	const instanceId = this.instanceIdFor(username, mapName, areaType);
	let inst = this.instances[instanceId];
	if (!inst) {
		inst = this.instances[instanceId] = {
			id: instanceId, mapName, areaType, host: null, members: [], entities: {},
		};
	}

	// First one in becomes the host of this instance.
	let isHost = false;
	if (!inst.host || !ctx.isOnline(inst.host)) {
		inst.host = username;
		isHost = true;
	}

	// Notify existing members that this player entered, and vice versa.
	const members = [];
	for (const other of inst.members) {
		const sock = ctx.getSocket(other);
		if (!sock) continue;
		members.push({ name: other, pos: inst.memberPos ? inst.memberPos[other] : undefined });
		sock.emit('onPlayerChangeMap', { player: username, enters: true, position: pos, map: mapName, marker: null });
		ctx.getSocket(username).emit('onPlayerChangeMap', { player: other, enters: true, position: (inst.memberPos && inst.memberPos[other]), map: mapName, marker: null });
	}

	inst.members.push(username);
	this.userInstance[username] = instanceId;
	if (!inst.memberPos) inst.memberPos = {};
	inst.memberPos[username] = pos;

	// Replay this instance's entity bucket to the newcomer so they see enemies.
	if (!isHost) {
		for (const id in inst.entities) {
			const e = inst.entities[id];
			if (e) ctx.getSocket(username).emit('registerEntity', { id: e.id, type: e.type, pos: e.pos, settings: e.settings });
		}
	}
	// Replay cached member profiles so the newcomer's Social info box is correct.
	if (inst.memberProfiles) {
		for (const name in inst.memberProfiles) {
			if (name !== username) ctx.getSocket(username).emit('updatePlayerProfile', { player: name, profile: inst.memberProfiles[name] });
		}
	}

	return { instanceId, isHost, members };
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
				sock.emit('setHost', { isHost: true, map: inst.mapName });
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
};

// ---- sync-event routing helpers (all scoped to the caller's instance) ----

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

// Track a position for correct spawn placement of future joiners.
World.prototype.updateMemberPos = function (username, pos) {
	const instanceId = this.userInstance[username];
	const inst = instanceId && this.instances[instanceId];
	if (inst && inst.memberPos) inst.memberPos[username] = pos;
};

// Track a player's real profile (level/stats/equip) for the Social info box.
World.prototype.updateMemberProfile = function (username, profile) {
	const instanceId = this.userInstance[username];
	const inst = instanceId && this.instances[instanceId];
	if (!inst) return;
	if (!inst.memberProfiles) inst.memberProfiles = {};
	inst.memberProfiles[username] = profile;
};

// Register an authoritative entity into the caller's instance bucket (host only).
World.prototype.registerEntity = function (ctx, username, data) {
	const instanceId = this.userInstance[username];
	if (!instanceId || !this.isHostOf(username, instanceId)) return;
	const inst = this.instances[instanceId];
	inst.entities[data.id] = data;
	this.broadcastToInstance(ctx, username, 'registerEntity', { id: data.id, type: data.type, pos: data.pos, settings: data.settings });
};

World.prototype.entityAction = function (ctx, username, event, data, requireHost) {
	const instanceId = this.userInstance[username];
	if (!instanceId) return;
	if (requireHost && !this.isHostOf(username, instanceId)) return;
	const inst = this.instances[instanceId];
	// Keep the bucket roughly in sync for late joiners.
	if (event === 'killEntity' && inst.entities[data.id]) delete inst.entities[data.id];
	if (event === 'updateEntityPosition' && inst.entities[data.id]) inst.entities[data.id].pos = data.pos;
	this.broadcastToInstance(ctx, username, event, data);
};

module.exports = new World();
