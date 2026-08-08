// Party: in-memory party management (not persisted — LAN sessions). One person
// in at most one party; leader leaves -> leadership transfers; empty party
// disbands. Parties exist so that PATH/DUNGEON maps can be shared by exactly
// the party members (world.js keys those instances by partyId).
function Party() {
	// Null-prototype maps so reserved keys can't collide with party/user data.
	// partyId -> { id, leader, members: [username] }
	this.parties = Object.create(null);
	// username -> partyId
	this.userParty = Object.create(null);
	// username -> {partyId:true} they've been invited to (prevents guessing ids).
	this.pendingInvites = Object.create(null);
	this._nextId = 1;
}

Party.prototype.partyOf = function (username) {
	return this.userParty[username];
};

Party.prototype.getParty = function (partyId) {
	return this.parties[partyId];
};

// Record that `username` was invited to `partyId`.
Party.prototype.addInvite = function (partyId, username) {
	if (!this.pendingInvites[username]) this.pendingInvites[username] = Object.create(null);
	this.pendingInvites[username][partyId] = true;
};

// True (and consumes the invite) if `username` was actually invited to `partyId`.
// On success also drops the user's OTHER pending invites — once you've joined a
// party, stale invites to other parties must not be usable to bounce you again.
Party.prototype.consumeInvite = function (partyId, username) {
	const set = this.pendingInvites[username];
	if (set && set[partyId]) {
		delete this.pendingInvites[username];
		return true;
	}
	return false;
};

// Drop all pending invites for a user (on logout).
Party.prototype.clearInvites = function (username) {
	delete this.pendingInvites[username];
};

// Drop every pending invite that points at `partyId` (called when that party
// disbands) so a stale invite to a now-dead party id can't be replayed later.
Party.prototype.clearInvitesForParty = function (partyId) {
	for (const user in this.pendingInvites) {
		const set = this.pendingInvites[user];
		if (set && set[partyId]) {
			delete set[partyId];
			// Keep the map tidy: drop the user's bucket once it's empty.
			if (Object.keys(set).length === 0) delete this.pendingInvites[user];
		}
	}
};

// Create a party with `leader` as the only member. Returns the partyId.
Party.prototype.createParty = function (leader) {
	// If already in a party, reuse it (leader inviting more people).
	const existing = this.userParty[leader];
	if (existing) return existing;
	const id = 'p' + (this._nextId++);
	// Round 20: openedChests — chestKey ("<mapName>:<mapId>") -> {username:true}
	// of party members who have opened that chest. Per-PARTY storage (survives
	// reconnects; strangers in shared towns can never pollute it). Deleted with
	// the record when the party disbands (removeMember single-member collapse).
	this.parties[id] = { id, leader, members: [leader], openedChests: Object.create(null) };
	this.userParty[leader] = id;
	return id;
};

// Round 20: record that `username` opened `chestKey` in the given party. Returns
// true when the name was NEWLY added (the caller then broadcasts the open to the
// instance); false when it was already known (no-op — avoids redundant relays).
Party.prototype.markChestOpened = function (partyId, chestKey, username) {
	const p = this.parties[partyId];
	if (!p) return false;
	if (!p.openedChests) p.openedChests = Object.create(null);
	let set = p.openedChests[chestKey];
	if (!set) set = p.openedChests[chestKey] = Object.create(null);
	if (set[username]) return false;
	set[username] = true;
	return true;
};

// Round 20: the party's opened-chest map (chestKey -> {username:true}), or null
// if the party doesn't exist. Used by world.changeMap to push a per-map snapshot
// to a joining member.
Party.prototype.getOpenedChests = function (partyId) {
	const p = this.parties[partyId];
	return p ? p.openedChests : null;
};

Party.prototype.addMember = function (partyId, username) {
	const p = this.parties[partyId];
	if (!p) return false;
	if (!p.members.includes(username)) p.members.push(username);
	this.userParty[username] = partyId;
	return true;
};

// Remove a member. Returns the (possibly updated) party or null if disbanded.
Party.prototype.removeMember = function (username) {
	const partyId = this.userParty[username];
	if (!partyId) return null;
	const p = this.parties[partyId];
	delete this.userParty[username];
	if (!p) return null;

	p.members = p.members.filter((m) => m !== username);
	if (p.members.length === 0) {
		delete this.parties[partyId];
		this.clearInvitesForParty(partyId);
		return null;
	}
	if (p.leader === username) {
		p.leader = p.members[0];
	}
	// A party of one is just solo again — disband so world.js keys them solo.
	if (p.members.length === 1) {
		delete this.userParty[p.members[0]];
		delete this.parties[partyId];
		this.clearInvitesForParty(partyId);
		return null;
	}
	return p;
};

module.exports = new Party();
