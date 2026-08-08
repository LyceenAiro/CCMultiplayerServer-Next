// Shared validation helpers. Central place for the username/entity-id rules so
// every handler rejects prototype-pollution keys and oversized/garbage input the
// same way.

// A legal username: word chars, CJK, and dash, 1-24 long. This excludes the
// dangerous JS keys (__proto__/constructor/prototype contain no special chars but
// we block them explicitly) and keeps db/Map keys sane.
// NOTE: must be a null-prototype map — on a plain object literal `{__proto__:1}`
// is a *setter* (not an own property), so RESERVED['__proto__'] would read as
// undefined and the blocklist would silently miss exactly the key it exists for.
const RESERVED = Object.create(null);
['__proto__', 'constructor', 'prototype', 'toString', 'valueOf', 'hasOwnProperty',
	'updatedAt', '__defineGetter__', '__defineSetter__', '__lookupGetter__', '__lookupSetter__']
	.forEach((k) => { RESERVED[k] = true; });
// NOTE: 'autoSlot' is NOT reserved — it is the one save-slot key the client
// uploads and the handshake restore reads (save.autoSlot). Reserving it made
// every saveUpload a silent no-op (round-7 "no save ever works" bug). It is not
// an object-magic key: writing it onto the save container is the intended write.

function isValidName(name) {
    if (typeof name !== 'string') return false;
    if (name.length < 1 || name.length > 24) return false;
    if (!/^[\w一-鿿-]+$/.test(name)) return false;
    if (RESERVED[name]) return false;
    return true;
}

// A save-slot key: word chars/dash, 1-32, and never a reserved/magic key. The
// reserved check matters because slots are written onto a plain object
// (existing[slot] = data) where "__proto__"/"updatedAt" would clobber state.
function isValidSlotKey(slot) {
    if (typeof slot !== 'string') return false;
    if (slot.length < 1 || slot.length > 32) return false;
    if (!/^[\w-]+$/.test(slot)) return false;
    if (RESERVED[slot]) return false;
    return true;
}

// Entity ids come from the host client; they must be a finite number (or a short
// non-reserved string) so they can't pollute the instance entity bucket.
function isValidEntityId(id) {
    if (typeof id === 'number') return isFinite(id);
    if (typeof id === 'string') return id.length > 0 && id.length <= 32 && !RESERVED[id];
    return false;
}

// A Vec3-ish position payload: numbers for x/y (z optional).
function isValidPos(pos) {
    return !!pos && typeof pos === 'object' &&
        typeof pos.x === 'number' && isFinite(pos.x) &&
        typeof pos.y === 'number' && isFinite(pos.y) &&
        (pos.z === undefined || (typeof pos.z === 'number' && isFinite(pos.z)));
}

module.exports = { isValidName, isValidEntityId, isValidPos, isValidSlotKey, RESERVED };
