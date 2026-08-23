// 1.73.0 (admin UI): CrossCode save-slot codec, CryptoJS-compatible.
//
// The game stores save slots as "[-!_0_!-]" + CryptoJS.AES(passphrase) output.
// The passphrase derives from the engine's (dead-ended) key dance:
//   c = 75*undefined + ""      -> "NaN"
//   d = ig.blog(...) ^ NaN     -> 0   (ig.blog returns a STRING, so d^NaN === 0)
//   key = ":_." + c + d        -> ":_.NaN0"
// CryptoJS.AES with a string passphrase uses OpenSSL EVP_BytesToKey (MD5) and
// embeds an 8-byte salt in a "Salted__"-headed base64 blob. Re-implemented here
// with node:crypto only — no new dependency.
const crypto = require('crypto');

const PREFIX = '[-!_0_!-]';
const PASSPHRASE = Buffer.from(':_.NaN0', 'utf8');

function evpBytesToKey(passphrase, salt) {
	// 32-byte key + 16-byte IV, MD5 chain (CryptoJS default kdf params).
	let out = Buffer.alloc(0);
	let prev = Buffer.alloc(0);
	while (out.length < 48) {
		const h = crypto.createHash('md5');
		h.update(prev); h.update(passphrase); h.update(salt);
		prev = h.digest();
		out = Buffer.concat([out, prev]);
	}
	return { key: out.slice(0, 32), iv: out.slice(32, 48) };
}

// Decrypt one raw slot string -> parsed save object (null when not ours/broken).
function decryptSlotData(src) {
	try {
		if (typeof src !== 'string' || src.indexOf(PREFIX) !== 0) return null;
		const raw = Buffer.from(src.slice(PREFIX.length), 'base64');
		if (raw.length < 32 || raw.slice(0, 8).toString('utf8') !== 'Salted__') return null;
		const salt = raw.slice(8, 16);
		const { key, iv } = evpBytesToKey(PASSPHRASE, salt);
		const d = crypto.createDecipheriv('aes-256-cbc', key, iv);
		const plain = Buffer.concat([d.update(raw.slice(16)), d.final()]).toString('utf8');
		return JSON.parse(plain);
	} catch (e) {
		return null;
	}
}

// Encrypt a save object -> raw slot string the game (and CryptoJS) reads back.
function encryptSlotData(obj) {
	const salt = crypto.randomBytes(8);
	const { key, iv } = evpBytesToKey(PASSPHRASE, salt);
	const c = crypto.createCipheriv('aes-256-cbc', key, iv);
	const body = Buffer.concat([c.update(Buffer.from(JSON.stringify(obj), 'utf8')), c.final()]);
	return PREFIX + Buffer.concat([Buffer.from('Salted__', 'utf8'), salt, body]).toString('base64');
}

function isEncryptedSlot(src) {
	return typeof src === 'string' && src.indexOf(PREFIX) === 0;
}

module.exports = { decryptSlotData, encryptSlotData, isEncryptedSlot };
