// Bots: VIRTUAL accounts for the official game companion characters (Emilie,
// C'tron, ...). A companion bot is a real in-game follower, but its account here
// is a seeded, never-logged-in account — it can never be "online". The point of
// these accounts: if a bot friend was accidentally removed, the player can
// re-add the companion through the normal add-friend flow (the story must have
// reached that companion first — enforced client-side), and the request
// AUTO-ACCEPTS instantly (the bot can't log in to accept).
//
// BOT_NAMES is the canonical server-side list. It MUST match the client's list
// in CCMultiplayerClient/src/ui/socialMenuInject.ts (BOT_ACCOUNTS) EXACTLY —
// same spelling, same order. Names are the companions' in-game names as players
// know them (Emilie = emilie's realname, C'tron = the 'Glasses' character's
// name, Lukas = the 'Luke' character's realname; the rest match their native
// character names).
const persistence = require('./persistence');

const BOT_NAMES = ['Emilie', "C'tron", 'Apollo', 'Joern', 'Lukas', 'Schneider', 'Shizuka', 'Buggy', 'Hlin'];

// Round 27 (item 1): searchable ALIASES for each bot so a removed bot friend can
// be found by more than its exact account id — the companion's native in-game
// contact id, its English display name, and its Chinese name. Match is
// case-insensitive substring (the searchPlayers fuzzy match). Values are matched
// lowercased, so keep them lowercase here. Adding to a list (or a new alias) is
// all it takes — searchPlayers walks this map for bot accounts.
const BOT_ALIASES = {
    'Emilie':    ['emilie', '艾米莉'],
    "C'tron":    ["c'tron", 'ctron', 'glasses', '西特隆', '眼镜'],
    'Apollo':    ['apollo', '阿波罗'],
    'Joern':     ['joern', '约恩'],
    'Lukas':     ['lukas', 'luke', '卢卡斯', '卢克'],
    'Schneider': ['schneider', '施耐德'],
    'Shizuka':   ['shizuka', '静香'],
    'Buggy':     ['buggy', '巴吉'],
    'Hlin':      ['hlin', '赫琳'],
};

// Every lowercase searchable string for a bot (the account id itself plus its
// aliases). Empty array for a non-bot.
function aliasesFor(name) {
    if (!isBotName(name)) return [];
    const list = [String(name).toLowerCase()];
    const extra = BOT_ALIASES[name];
    if (extra) for (const a of extra) list.push(String(a).toLowerCase());
    return list;
}

// Ensure every bot account exists in persistence.db.accounts (idempotent).
// Runs at server startup (module load — friends.js/protocol.js require this
// module at boot) and lazily before every friend request, so
// accounts.exists(botName) is ALWAYS true and searchPlayers finds them.
// Bots are never online: they never call login(), so isOnline() stays false
// and getSocket() stays undefined.
function seed() {
	const accs = persistence.db.accounts;
	let changed = false;
	for (const name of BOT_NAMES) {
		if (!Object.prototype.hasOwnProperty.call(accs, name)) {
			accs[name] = { createdAt: new Date().toISOString(), friends: [] };
			changed = true;
		}
	}
	if (changed) persistence.save();
	return changed;
}

// Is `name` a bot account? (Case-sensitive on purpose: usernames are identity.)
function isBotName(name) {
	return typeof name === 'string' && BOT_NAMES.indexOf(name) !== -1;
}

// Seed on first require — i.e. at server startup, before any socket connects
// (friends.js and protocol.js both load at boot and pull this module in).
seed();

module.exports = { BOT_NAMES, seed, isBotName, aliasesFor };
