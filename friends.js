// Friends: persistent friend lists (LAN trust — username is identity). A friend
// edge only becomes mutual once the target ACCEPTS a request: the requester first
// lands in the target's `incoming` box (and sees the target as a pending/outgoing
// request), and only on accept do both sides become real friends and see each
// other. Legacy one-directional entries (from before this flow) are NOT shown to
// the side that never had the edge — fixes "A sees B but B doesn't see A".
const persistence = require('./persistence');
const accounts = require('./accounts');

function Friends() {}

function acc(username) {
    return accounts.getAccount(username);
}
function friendArr(a) {
    a.friends = a.friends || [];
    return a.friends;
}
function incomingArr(a) {
    a.incoming = a.incoming || [];
    return a.incoming;
}
function outgoingArr(a) {
    a.outgoing = a.outgoing || [];
    return a.outgoing;
}

// One-directional legacy entries (me lists X but X doesn't list me) came from the
// old buggy flow; reclassify them as a pending outgoing request instead of a
// friend so lists stop being asymmetric. Runs lazily whenever we read a user.
function migrate(username) {
    const me = acc(username);
    if (!me) return;
    const fr = friendArr(me);
    for (let i = fr.length - 1; i >= 0; i--) {
        const other = fr[i];
        const them = acc(other);
        const mutual = them && friendArr(them).includes(username);
        if (!mutual) {
            fr.splice(i, 1);
            // If the other side has a pending incoming from me, keep it; else this
            // becomes my outgoing request toward them.
            if (them && incomingArr(them).includes(username)) {
                if (!outgoingArr(me).includes(other)) outgoingArr(me).push(other);
            } else if (them) {
                if (!incomingArr(them).includes(username)) incomingArr(them).push(username);
                if (!outgoingArr(me).includes(other)) outgoingArr(me).push(other);
            }
        }
    }
}

// Confirmed (mutual) friends with online flags.
Friends.prototype.list = function (username) {
    migrate(username);
    const me = acc(username);
    if (!me) return [];
    return friendArr(me).map((name) => ({ name, online: accounts.isOnline(name) }));
};

// Pending requests addressed TO me (I can accept/decline), with online flags.
Friends.prototype.requests = function (username) {
    migrate(username);
    const me = acc(username);
    if (!me) return [];
    return incomingArr(me).map((name) => ({ name, online: accounts.isOnline(name) }));
};

// Send a friend request. Does NOT create a friendship yet.
// Returns { ok, error?, autoAccepted?, toOffline? }.
Friends.prototype.request = function (username, targetName) {
    if (username === targetName) return { ok: false, error: 'Cannot add yourself' };
    if (!accounts.exists(targetName)) return { ok: false, error: 'No such player: ' + targetName };
    migrate(username);
    migrate(targetName);

    const me = acc(username);
    const them = acc(targetName);

    // Already friends?
    if (friendArr(me).includes(targetName)) return { ok: false, error: 'Already friends' };
    // I already have a pending outgoing request to them.
    if (outgoingArr(me).includes(targetName)) return { ok: false, error: 'Request already sent' };

    // If THEY already requested ME, this is effectively an accept -> mutual now.
    if (incomingArr(me).includes(targetName)) {
        this.accept(username, targetName);
        return { ok: true, autoAccepted: true };
    }

    if (!outgoingArr(me).includes(targetName)) outgoingArr(me).push(targetName);
    if (!incomingArr(them).includes(username)) incomingArr(them).push(username);
    persistence.save();
    return { ok: true, toOffline: !accounts.isOnline(targetName) };
};

// Accept an incoming request from `fromName`. Makes the friendship mutual.
Friends.prototype.accept = function (username, fromName) {
    const me = acc(username);
    const them = acc(fromName);
    if (!me) return { ok: false, error: 'No account' };
    // Clear the pending markers on both sides.
    me.incoming = incomingArr(me).filter((n) => n !== fromName);
    if (them) them.outgoing = outgoingArr(them).filter((n) => n !== username);
    // Make it mutual.
    if (!friendArr(me).includes(fromName)) friendArr(me).push(fromName);
    if (them && !friendArr(them).includes(username)) friendArr(them).push(username);
    persistence.save();
    return { ok: true };
};

// Decline (or cancel) a request. `fromName` is the other party.
Friends.prototype.decline = function (username, fromName) {
    const me = acc(username);
    const them = acc(fromName);
    if (me) me.incoming = incomingArr(me).filter((n) => n !== fromName);
    if (them) them.outgoing = outgoingArr(them).filter((n) => n !== username);
    persistence.save();
    return { ok: true };
};

// Remove a confirmed friend (both directions).
Friends.prototype.remove = function (username, friendName) {
    const me = acc(username);
    const them = acc(friendName);
    if (me && me.friends) me.friends = me.friends.filter((f) => f !== friendName);
    if (them && them.friends) them.friends = them.friends.filter((f) => f !== username);
    persistence.save();
    return { ok: true };
};

// Usernames that should receive presence updates about `username`: confirmed
// friends plus anyone with a pending request involving them.
Friends.prototype.presenceSubscribers = function (username) {
    const subs = new Set();
    const me = acc(username);
    if (me) {
        friendArr(me).forEach((f) => subs.add(f));
        incomingArr(me).forEach((f) => subs.add(f));
        outgoingArr(me).forEach((f) => subs.add(f));
    }
    return subs;
};

module.exports = new Friends();
