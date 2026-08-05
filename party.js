// Party: in-memory party management (not persisted — LAN sessions). One person
// in at most one party; leader leaves -> leadership transfers; empty party
// disbands. Parties exist so that PATH/DUNGEON maps can be shared by exactly
// the party members (world.js keys those instances by partyId).
function Party() {
	// partyId -> { id, leader, members: [username] }
	this.parties = {};
	// username -> partyId
	this.userParty = {};
	this._nextId = 1;
}

Party.prototype.partyOf = function (username) {
	return this.userParty[username];
};

Party.prototype.getParty = function (partyId) {
	return this.parties[partyId];
};

// Create a party with `leader` as the only member. Returns the partyId.
Party.prototype.createParty = function (leader) {
	// If already in a party, reuse it (leader inviting more people).
	const existing = this.userParty[leader];
	if (existing) return existing;
	const id = 'p' + (this._nextId++);
	this.parties[id] = { id, leader, members: [leader] };
	this.userParty[leader] = id;
	return id;
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
		return null;
	}
	if (p.leader === username) {
		p.leader = p.members[0];
	}
	// A party of one is just solo again — disband so world.js keys them solo.
	if (p.members.length === 1) {
		delete this.userParty[p.members[0]];
		delete this.parties[partyId];
		return null;
	}
	return p;
};

module.exports = new Party();
