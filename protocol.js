// Protocol: binds every socket's events and translates them into calls on the
// accounts/friends/party/world/persistence modules. Replaces the old User class.
// Auth model: a socket must complete `handshake` (login) before any other event
// is honoured; until then all other events are dropped.
const accounts = require('./accounts');
const friends = require('./friends');
const bots = require('./bots');
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

// ---- 1.70.61 story-sync pending handshakes ----
// storyStartRequests lives at MODULE scope: the leader creates the record in
// HIS connection closure, but each member's eligibility reply is handled inside
// the MEMBER's connection closure (a socket may only listen for its own events).
// storyJoinChecks stays per-connection (the accept + reply share one socket).
const storyStartRequests = Object.create(null);
let storyReqSeq = 1;

function handleConnection(socket) {
	// username is set once the socket has logged in (handshake).
	let username = null;

	// storyJoinChecks: reqId -> {quest, partyId, username, timer}. Settled on
	// answer/timeout so a hostile or stalled client can never pin an invite.
	const storyJoinChecks = Object.create(null);

	function authed() {
		return username !== null;
	}
	function dropIfNotAuthed(evt) {
		// ROUND 108: a socket whose handshake was version-rejected (or a pre-update
		// socket with an old version) must be dropped silently and closed. This is
		// the "old client keeps streaming playerState after a server update" fix.
		if (socket._mpVersionBlocked || (typeof socket._mpVersion === 'string' && socket._mpVersion !== config.version)) {
			// ROUND 114: use disconnect(false) — a DISCONNECT packet — NOT
			// disconnect(true). disconnect(true) closes only the TRANSPORT, which
			// socket.io-client treats as a "transport close" and AUTO-RECONNECTS
			// forever; a DISCONNECT packet is the client's "io server disconnect"
			// path and makes its Manager set skipReconnect=true, which is the only
			// server-side way to stop an OLD client from reconnection-looping.
			try { socket.disconnect(false); } catch (_) { /* ignore */ }
			return true;
		}
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

	// ---- round 25: netPing/netPong network-quality probe ----
	// Post-auth ping echo for the HUD network-quality badges. Unlike mpPing (which
	// runs PRE-auth to measure handshake latency), netPing is a normal game event:
	// auth-gated like the rest, rate-limited to ~4/s, and the echo only goes out
	// when both t and seq survive integer validation. Garbage payloads are dropped,
	// never echoed. The client matches the {t, seq} back to its probe to compute
	// median RTT + packet loss over a sliding window.
	socket.on('netPing', function (data) {
		if (dropIfNotAuthed('netPing')) return;
		if (rateLimited('netPing', 4)) return;
		const t = Number(data && data.t);
		const seq = Number(data && data.seq);
		if (!Number.isInteger(t) || !Number.isInteger(seq)) return;
		if (t < 0 || t > 0xffffffffffff) return; // sane timestamp window
		if (seq < 0 || seq > 0xffffffff) return; // seq is a client counter, small
		socket.emit('netPong', { t, seq });
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
		// ROUND 91: four non-neutral element factors for the quick-menu resistance
		// readout. Invalid/missing entries become 1 (neutral damage) — never null.
		if (Array.isArray(p.elemFactor)) {
			out.elemFactor = [];
			for (let i = 0; i < 4; i++) {
				const v = num(p.elemFactor[i]);
				out.elemFactor[i] = v !== undefined ? v : 1;
			}
		}
		return out;
	}

	function broadcastPresence(name, online) {
		// Notify friends + anyone with a pending request involving them + party
		// members that this player's online state changed. (An earlier comment
		// claimed "everyone in the same instance" too — that broadcast never
		// existed; instance presence comes from the client pulling friendList /
		// roomPlayers instead.)
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

	function pushPartyUpdate(partyId, lastLeft) {
		const p = party.getParty(partyId);
		if (!p) return;
		// Round 23 wave 3: `lastLeft` rides the roster broadcast (additive, optional)
		// so clients can toast the departure MANNER — {name, reason} where reason is
		// 'left' | 'kicked' | 'disconnected'. Absent -> clients default to 'left'.
		const payload = { partyId: p.id, leader: p.leader, members: p.members.slice() };
		if (lastLeft) payload.lastLeft = lastLeft;
		for (const m of p.members) {
			const s = accounts.getSocket(m);
			if (s) s.emit('partyUpdate', payload);
		}
	}

	// ROUND 95: a 2-person party DISBANDS into partyUpdate null, which carries no
	// roster diff for the survivor — so the survivor never got a join/leave toast.
	// This dedicated departure event rides alongside the null in every disband path
	// (leave / kick / accept-elsewhere / disconnect) so the survivor can toast it.
	function pushPartyMemberLeft(socket, name, reason) {
		if (!socket || typeof name !== 'string' || !name) return;
		const r = reason === 'kicked' || reason === 'disconnected' ? reason : 'left';
		socket.emit('partyMemberLeft', { name, reason: r });
	}

	// ---- 1.70.61 剧情同步模式 (story sync mode) ----
	// Server-side state machine: leader selects an accepted quest, every online
	// member confirms their local client can participate (quest active OR solved),
	// and from then on the leader relays quest state / story-event starts / skip
	// votes through the party. The server only stores the mode's envelope
	// (quest + leader); each CLIENT keeps the authoritative quest snapshot and
	// applies/restores it locally.
	const STORY_SYNC = {
		CHECK_TIMEOUT_MS: 15000,  // eligibility handshake timeout (start + join)
		STATE_MAX_TASKS: 128,     // sanity caps for sanitizeStoryQuestState
		STATE_MAX_ARRAY: 200,
		STATE_MAX_DEPTH: 8,
		STATE_MAX_KEYS: 64,
		STATE_MAX_NODES: 4096,
	};

	function isValidQuestId(quest) {
		return typeof quest === 'string' && /^[A-Za-z0-9_.-]{1,64}$/.test(quest);
	}

	function storyValue(v, depth, budget) {
		if (!budget || budget.count <= 0) return undefined;
		budget.count--;
		if (v === null || typeof v === 'boolean') return v;
		if (typeof v === 'number') return (isFinite(v) && Math.abs(v) <= 1e9) ? v : 0;
		if (typeof v === 'string') return v.slice(0, 64);
		if (depth >= STORY_SYNC.STATE_MAX_DEPTH) return undefined;
		if (Array.isArray(v)) {
			const out = [];
			const max = Math.min(v.length, STORY_SYNC.STATE_MAX_ARRAY);
			for (let i = 0; i < max && budget.count > 0; i++) {
				const c = storyValue(v[i], depth + 1, budget);
				if (c !== undefined) out.push(c);
			}
			return out;
		}
		if (typeof v === 'object') {
			const out = {};
			let n = 0;
			for (const k in v) {
				if (n >= STORY_SYNC.STATE_MAX_KEYS) break;
				if (!/^[A-Za-z0-9_.-]{1,64}$/.test(k)) continue;
				const c = storyValue(v[k], depth + 1, budget);
				if (c !== undefined) { out[k] = c; n++; }
			}
			return out;
		}
		return undefined;
	}

	// Rebuild quest progress field-by-field. The member client applies ONLY this
	// whitelisted {id,task,highest,finished,completed,labels} shape.
	function sanitizeStoryQuestState(raw) {
		if (!raw || typeof raw !== 'object') return null;
		if (!isValidQuestId(raw.id)) return null;
		const clampInt = (v, min, max) => {
			const n = Number(v);
			return (isFinite(n)) ? Math.max(min, Math.min(max, Math.round(n))) : min;
		};
		const budget = { count: STORY_SYNC.STATE_MAX_NODES };
		const completed = storyValue(raw.completed, 1, budget);
		const labels = storyValue(raw.labels, 1, budget);
		if (!Array.isArray(completed)) return null;
		const out = {
			id: raw.id,
			task: clampInt(raw.task, 0, STORY_SYNC.STATE_MAX_TASKS),
			highest: clampInt(raw.highest, 0, STORY_SYNC.STATE_MAX_TASKS),
			finished: !!raw.finished,
			completed: completed,
			labels: (labels && typeof labels === 'object' && !Array.isArray(labels)) ? labels : {},
		};
		// labels must map label names to booleans (the game only stores booleans).
		for (const k in out.labels) {
			if (typeof out.labels[k] !== 'boolean') return null;
		}
		return out;
	}

	// Emit `event` to every ONLINE member of a party (story events must cross
	// map/instance boundaries: an out-of-range member still needs nudge/vote state).
	function emitToParty(partyId, event, payload, exceptName) {
		const p = party.getParty(partyId);
		if (!p) return;
		for (const m of p.members) {
			if (m === exceptName) continue;
			const s = accounts.getSocket(m);
			if (s) s.emit(event, payload);
		}
	}

	// Abort any OPEN skip vote for a party sync and tell the remaining members the
	// result (pass:false). Used on departure/leader-cancel/new-event so a vote can
	// never strand the requester's modal. Never throws.
	function abortStoryVote(partyId, sync) {
		if (!sync || !sync.vote) return;
		const seq = sync.vote.seq;
		sync.vote = null;
		emitToParty(partyId, 'storySyncSkipResult', { seq, pass: false, reason: 'interrupted' });
	}

	// Party-departure bookkeeping for an ACTIVE story sync. MUST run BEFORE
	// party.removeMember (the party record — and its sync envelope — dies on a
	// disband). Semantics:
	//   leader leaves/logs out  -> the WHOLE team exits story sync (leaderLeft);
	//   member leaves/kicked   -> that member exits alone (leave), others continue.
	// A 2-person party collapse ends the mode for the survivor too (partyEnd).
	// `reason` is 'left' | 'kicked' | 'disconnected' (only for logging/end marker).
	function storySyncOnDeparture(partyId, name, reason) {
		const p = party.getParty(partyId);
		if (!p || !p.storySync) return;
		const sync = p.storySync;
		const quest = sync.quest;
		const survivors = p.members.filter((m) => m !== name);
		if (sync.leader === name) {
			abortStoryVote(partyId, sync);
			p.storySync = null;
			for (const m of survivors) {
				const s = accounts.getSocket(m);
				if (s) s.emit('storySyncEnd', { quest, reason: 'leaderLeft', leader: name });
			}
			const selfSock = accounts.getSocket(name);
			if (selfSock) selfSock.emit('storySyncEnd', { quest, reason: 'leaderLeft', leader: name });
			return;
		}
		const sock = accounts.getSocket(name);
		if (sock) sock.emit('storySyncEnd', { quest, reason: 'leave', by: name, manner: reason });
		// Any departure during an open skip vote invalidates "everyone agreed at
		// the same moment" — abort it for the remaining members.
		if (sync.vote) abortStoryVote(partyId, sync);
		// With only the leader left the party itself disbands below.
		if (survivors.length <= 1) {
			abortStoryVote(partyId, sync);
			p.storySync = null;
			for (const m of survivors) {
				const s = accounts.getSocket(m);
				if (s) s.emit('storySyncEnd', { quest, reason: 'partyEnd' });
			}
		}
	}

	// ---- round 23: paced save DOWNLOAD (handshakeResponse no longer carries save) ----
	// The client expects its save as a stream of `saveDownload` parts right after the
	// handshake: 8192-char chunks paced at config.saveDownloadKbS (default 200 kb/s,
	// ≈320ms apart) so a login burst can't spike the network. A player with no save
	// gets a single `saveDownload {slot:'autoSlot', total:0}` marker instead. The
	// timer chain is per-socket and cleared on disconnect; one download per login
	// (the handshake handler only runs once per connection — reconnects re-identify
	// and get a fresh stream, which the client handles by resetting its assembler).
	const SAVE_DOWNLOAD_PART = 8192;
	function streamSaveDownload(raw) {
		const parts = [];
		if (typeof raw === 'string' && raw.length) {
			for (let i = 0; i < raw.length; i += SAVE_DOWNLOAD_PART) parts.push(raw.substring(i, i + SAVE_DOWNLOAD_PART));
		}
		const total = parts.length;
		if (socket._mpSaveDownloadTimer) { clearTimeout(socket._mpSaveDownloadTimer); socket._mpSaveDownloadTimer = null; }
		if (total === 0) {
			socket.emit('saveDownload', { slot: 'autoSlot', total: 0, seq: 0, part: '' });
			return;
		}
		// Part-to-part delay so the average rate is exactly saveDownloadKbS kb/s.
		const intervalMs = Math.max(1, Math.round(SAVE_DOWNLOAD_PART * 8 / (config.saveDownloadKbS * 1024) * 1000));
		let seq = 0;
		const next = () => {
			if (socket.disconnected || !socket.connected) return;
			socket.emit('saveDownload', { slot: 'autoSlot', total, seq, part: parts[seq] });
			seq++;
			if (seq < total) socket._mpSaveDownloadTimer = setTimeout(next, intervalMs);
			else socket._mpSaveDownloadTimer = null;
		};
		socket._mpSaveDownloadTimer = setTimeout(next, intervalMs);
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
				// ROUND 86: structured server version so the client can detect
				// "server updated" specifically (vs any other login rejection) and
				// show the styled update popup instead of reconnect-forever.
				version: config.version,
			});
			// ROUND 108 + 114: an OLD client's reconnect path can leave the rejected
			// socket open and keep streaming playerState from `username=null`, which
			// spams dropIfNotAuthed every 5s forever. Mark it and send a real
			// DISCONNECT packet (NOT disconnect(true) — that only drops the transport
			// and socket.io-client auto-reconnects forever, exactly the reported
			// infinite-reconnect loop). The DISCONNECT packet makes the client's
			// Manager skip reconnection entirely.
			socket._mpVersion = clientVersion || '?';
			socket._mpVersionBlocked = true;
			setTimeout(function () { try { socket.disconnect(false); } catch (e) { /* ignore */ } }, 50);
			return;
		}
		socket._mpVersion = clientVersion;
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
		// NEW accounts are streamed the shared template save and the client lets the
		// player choose between that bridge start and a completely fresh story save
		// (handshakeResponse.isNew drives the prompt). Returning accounts resume
		// from their own uploaded save.
		let save = persistence.loadGame(name);
		if (!save && isNew) {
			save = persistence.loadDefaultSave();
			if (save) console.log('[protocol] ' + name + ' is a new account; template save ready');
		}
		socket.emit('handshakeResponse', {
			success: true,
			username: name,
			host: true,
			// ROUND 103: first-ever login — client shows the fresh/bridge choice popup.
			isNew: !!isNew,
			// Round 16: per-extra-party-member enemy HP multiplier the client applies
			// using its own party roster size (config.json: monsterHpPerPlayer).
			hpScale: config.monsterHpPerPlayer,
			// Round 17: the accepted server version (harmless; useful for logs — the
			// client already sent its own version in the handshake payload).
			version: config.version,
			mapName: null, // no forced map; the client uses its own save / start map
		});
		// Round 23: the save is NO LONGER embedded in the handshakeResponse (that
		// sent a ~60KB string in one packet). It is streamed as paced saveDownload
		// parts (config.saveDownloadKbS) right after — see streamSaveDownload above.
		streamSaveDownload(save && save.autoSlot ? save.autoSlot : null);

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
		// Round 23: clear any in-flight save-download timer chain (the socket is going
		// away; a timer left behind would emit into a dead socket on a later tick).
		if (socket._mpSaveDownloadTimer) { clearTimeout(socket._mpSaveDownloadTimer); socket._mpSaveDownloadTimer = null; }
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
		// 1.70.61: story-sync departure semantics run before the party record is
		// mutated (leader leaves -> whole team ends; member leaves -> only they do).
		storySyncOnDeparture(partyId, name, 'disconnected');
		// world.disconnect migrates the INSTANCE host if this player held it
		// (setHost to the next member) — survivors stay where they stand.
		world.disconnect(ctx, name);
		const updated = party.removeMember(name);
		if (updated) {
			// Round 12: a leader going offline NO LONGER disbands the party and NO
			// LONGER teleports survivors to a town (that yanked members out of the
			// field mid-fight). removeMember transfers leadership, the partyId (and
			// therefore the instanceId) is unchanged, and everyone keeps playing.
			// Round 23 wave 3: the survivors get the departure manner in lastLeft.
			pushPartyUpdate(updated.id, { name: name, reason: 'disconnected' });
		} else {
			// removeMember returned null => the party was disbanded (e.g. a 2-person
			// party lost its leader). The survivor stays in place but moves from the
			// dead party:<id> instance to their solo one — and must be told they are
			// now the host there, or their world goes empty (they were the member).
			for (const m of survivors) {
				const s = accounts.getSocket(m);
				if (s) {
					pushPartyMemberLeft(s, name, 'disconnected');
					s.emit('partyUpdate', null);
				}
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

		// Round 23: area-save anti-spam — track the latest map switches. A player who
		// churns maps (>=5 switches in the last 3s) gets its AREA saves suppressed
		// until 5s after the LAST switch (the saveChunk final-chunk step checks this).
		{
			const now = Date.now();
			if (!Array.isArray(socket._mpChangeTimes)) socket._mpChangeTimes = [];
			socket._mpChangeTimes.push(now);
			socket._mpLastChangeMapAt = now;
			const cutoff = now - 3000;
			while (socket._mpChangeTimes.length && socket._mpChangeTimes[0] < cutoff) socket._mpChangeTimes.shift();
			while (socket._mpChangeTimes.length > 16) socket._mpChangeTimes.shift();
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
	// Every client streams its own full player state. The username is authoritative
	// (stamped server-side). No host gate — each player owns their state.
	// Round 22 (opt 4): per-socket latest-wins relay cap ~25/s. The client already
	// caps its own stream at 20Hz (50ms floor), so a well-behaved socket is never
	// gated here — this only bounds a buggy/hostile client flooding every frame.
	// SIMPLEST acceptable: drop a playerState arriving <40ms after the last relayed
	// one (the next accepted packet carries fresh state anyway, so no staleness).
	socket.on('playerState', function (s) {
		if (dropIfNotAuthed('playerState')) return;
		if (!s || !isValidPos(s.pos)) return;
		const now = Date.now();
		if (socket._mpLastPlayerStateRelay && now - socket._mpLastPlayerStateRelay < 40) return;
		socket._mpLastPlayerStateRelay = now;
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
			// ROUND 104: fall/water flag — observers grant aggro grace while the
			// owner quick-falls/respawns.
			fl: s.fl ? 1 : 0,
			// Round 11/22 (opt 3): element mode + class drive the mirror's melee
			// sweep FX. They change rarely, so the client omits them when unchanged;
			// when present they're whitelisted (number 0-4 / bounded string). The
			// receiver guards on presence, so absent values are simply ignored.
			em: (typeof s.em === 'number' && s.em >= 0 && s.em <= 4) ? s.em : undefined,
			cl: (typeof s.cl === 'string' && s.cl.length <= 32) ? s.cl : undefined,
			// Round 27 (item 4) / Round 29 (fix): host-authoritative guard state.
			// The host recomputes monster damage against the member's REAL guard
			// timing + defense (recomputeHostMonsterHit); without these fields the
			// guard edge never reached the host and EVERY hit landed unguarded
			// (attacks passed straight through the member's shield). gd/gst/gws
			// ride every guard packet; gw/gm/ga/def are omitted when unchanged
			// (opt-3) — relay them through as-is so the receiver's presence-guard
			// cache keeps working.
			gd: s.gd ? 1 : 0,
			gst: (typeof s.gst === 'number' && s.gst >= 0) ? s.gst : undefined,
			gws: (typeof s.gws === 'number') ? s.gws : undefined,
			gw: (typeof s.gw === 'number') ? s.gw : undefined,
			gm: (typeof s.gm === 'number') ? s.gm : undefined,
			ga: (typeof s.ga === 'number') ? s.ga : undefined,
			def: (typeof s.def === 'number') ? s.def : undefined,
			// ROUND 79: member element factors / params damageFactor / focus - the host's
			// damage recompute reads these (engine g factor + the crit roll). ef is a
			// bounded 4-number array; df/fc plain finite numbers. Relay as-is so the
			// receiver's presence-guard cache keeps working.
			ef: (Array.isArray(s.ef) && s.ef.length <= 4) ? s.ef.map(function (v) { return typeof v === 'number' && isFinite(v) ? v : 1; }) : undefined,
			df: (typeof s.df === 'number' && isFinite(s.df)) ? s.df : undefined,
			fc: (typeof s.fc === 'number' && isFinite(s.fc)) ? s.fc : undefined,
			ggt: (typeof s.ggt === 'number') ? s.ggt : undefined,
		});
	});
	// ---- round 82: door-open visual sync ----
	// When a player walks into a mapped door their client broadcasts the door so the
	// other members on the same map can open their local copy and watch the remote
	// player's enter/exit walk instead of seeing them pass through a closed door /
	// pop out. Instance-scoped, auth-gated, field-whitelisted, heavily rate-limited.
	socket.on('doorTransition', function (data) {
		if (dropIfNotAuthed('doorTransition')) return;
		if (!data || typeof data.map !== 'string' || data.map.length > 128) return;
		if (rateLimited('doorTransition', 4)) return;
		const num = (v) => (typeof v === 'number' && isFinite(v)) ? Math.round(v) : 0;
		const dir = (data.dir === 'NORTH' || data.dir === 'SOUTH' || data.dir === 'EAST' || data.dir === 'WEST') ? data.dir : 'SOUTH';
		world.broadcastToInstance(ctx, username, 'doorTransition', {
			map: data.map,
			x: num(data.x), y: num(data.y), z: num(data.z),
			dir,
			targetMap: (typeof data.targetMap === 'string' && data.targetMap.length <= 128) ? data.targetMap : '',
			marker: (typeof data.marker === 'string' && data.marker.length <= 64) ? data.marker : '',
		});
	});
	// Only the instance host broadcasts the entity (enemy) state block. Keyed by the
	// map's stable mapId so host & members refer to the same creature. Members apply
	// it to puppet mirrors (their local enemy AI is disabled).
	socket.on('entityState', function (block) {
		if (dropIfNotAuthed('entityState')) return;
		if (!block || typeof block.map !== 'string' || !Array.isArray(block.e)) return;
		if (block.e.length > 512) return; // sanity cap
		// Round 24: f:1 marks a force-FULL block (the ~1s heartbeat). Whitelisted so it
		// survives relay — members count full-flagged blocks to learn the host's roster.
		// ROUND 81: st tags which host stream the block belongs to ('B' = fixed base /
		// idle enemies, 'H' = option-driven hostile / engaged enemies) so members can
		// measure the REAL per-stream tick for the network debug HUD.
		const f = block.f === 1 ? 1 : undefined;
		const st = block.st === 'B' ? 'B' : (block.st === 'H' ? 'H' : undefined);
		world.broadcastHostState(ctx, username, 'entityState', { map: block.map, e: block.e, cb: !!block.cb, f, st });
	});

	// ---- round 62: host streams enemy PROJECTILES so members see ranged attacks ----
	// The instance host runs the real enemy AI, so only it spawns enemy projectiles
	// (ig.ENTITY.Ball / ig.ENTITY.Stone with party ENEMY). Members' puppets run no AI and
	// never spawn them, so the host relays each live enemy projectile's uid/kind/source/
	// proxy-name/pos/vel here and every member spawns a VISUAL-ONLY copy (no local hit or
	// damage — the host already computes projectile damage and forwards it via combatHit).
	// Host-only like entityState (broadcastHostState no-ops unless the sender IS the
	// instance host), auth-gated + rate-limited; the payload is whitelisted field-by-field
	// (never a raw blob).
	socket.on('projectileState', function (block) {
		if (dropIfNotAuthed('projectileState')) return;
		// Max legit rate = the host's 怪物同步频率 (30/60Hz); 90/s leaves jitter headroom
		// while still capping floods. (The sibling entityState stream is unlimited.)
		if (rateLimited('projectileState', 90)) return;
		if (!block || typeof block.map !== 'string' || !Array.isArray(block.e)) return;
		if (block.e.length > 128) return; // projectiles are short-lived; the cap is generous
		const num = (v) => (typeof v === 'number' && isFinite(v)) ? Math.round(v) : 0;
		const list = [];
		for (const e of block.e) {
			if (!e || typeof e !== 'object' || typeof e.i !== 'number') continue;
			list.push({
				i: num(e.i),
				k: e.k === 'S' ? 'S' : 'B',           // Stone vs Ball (both are Projectile)
				src: num(e.src),                       // source enemy uid (0 = unknown)
				pn: (typeof e.pn === 'string' && e.pn.length <= 64) ? e.pn : '', // proxy name
				x: num(e.x), y: num(e.y), z: num(e.z),
				vx: num(e.vx), vy: num(e.vy),          // 2D velocity (flight angle only)
			});
		}
		world.broadcastHostState(ctx, username, 'projectileState', { map: block.map, e: list });
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
		// Round 22 (RC1): the targeted member's username rides along (null when the
		// host/bot/unknown was targeted). Whitelisted like every other relayed field.
		const t = (typeof data.t === 'string' && isValidName(data.t)) ? data.t : null;
		world.broadcastHostState(ctx, username, 'enemyAttack', { uid: data.uid, anim: data.anim, t });
	});

	// ---- round 33 (item 2b): host relays an enemy sound so member puppets aren't silent ----
	// Member puppets run NO local AI, so the engine's AI-driven PLAY_SOUND / PLAY_RANDOM_SOUND
	// steps never fire on a member — every enemy action is silent for them. The instance host
	// detects a real enemy's sound (a hook on ig.SoundHelper.playAtEntity /
	// ig.Sound.prototype.play) and relays the sound's path + playback params here so every
	// member replays it locally, positioned on their same-uid puppet. Host-only relay like
	// enemyAttack/loot (broadcastHostState no-ops unless the sender IS the instance host),
	// auth-gated + rate-limited; the payload is whitelisted field-by-field (never a raw blob).
	socket.on('enemySound', function (data) {
		if (dropIfNotAuthed('enemySound')) return;
		if (rateLimited('enemySound', 60)) return;
		if (!data || typeof data.uid !== 'number' || !Number.isInteger(data.uid) || data.uid <= 0) return;
		if (typeof data.path !== 'string' || !data.path || data.path.length > 200) return;
		const volume = (typeof data.volume === 'number' && isFinite(data.volume)) ? Math.max(0, Math.min(1, data.volume)) : 1;
		const variance = (typeof data.variance === 'number' && isFinite(data.variance)) ? Math.max(0, Math.min(1, data.variance)) : 0;
		const radius = (typeof data.radius === 'number' && isFinite(data.radius)) ? Math.max(0, Math.min(64, data.radius)) : undefined;
		const speed = (typeof data.speed === 'number' && isFinite(data.speed)) ? Math.max(0.1, Math.min(4, data.speed)) : undefined;
		world.broadcastHostState(ctx, username, 'enemySound', {
			uid: data.uid, path: data.path, volume, variance,
			loop: data.loop === true, global: data.global === true,
			...(radius !== undefined ? { radius } : {}),
			...(speed !== undefined ? { speed } : {}),
		});
	});

	// ---- round 34 (item 3): member relays ONE of its OWN player's attack sounds ----
	// A remote player's attack sounds (the 5 melee-swing segments, the ball THROW) are
	// played on an ig.ENTITY.Effect whose .target is the acting player, all global:false,
	// so the host-only/Enemy-gated enemySound relay never captures them and the other
	// clients hear an incomplete set. Any client that detects its OWN player's attack
	// sound relays it here so every OTHER same-instance client replays it positioned on
	// the attacker's mirror. Sender->instance like skillFx (broadcastToInstance), NOT the
	// host-only broadcastHostState (both host and member players attack). Auth-gated +
	// rate-limited; the payload is whitelisted field-by-field.
	socket.on('playerSound', function (data) {
		if (dropIfNotAuthed('playerSound')) return;
		if (rateLimited('playerSound', 60)) return;
		if (!data || typeof data.path !== 'string' || !data.path || data.path.length > 200) return;
		const volume = (typeof data.volume === 'number' && isFinite(data.volume)) ? Math.max(0, Math.min(1, data.volume)) : 1;
		const variance = (typeof data.variance === 'number' && isFinite(data.variance)) ? Math.max(0, Math.min(1, data.variance)) : 0;
		const radius = (typeof data.radius === 'number' && isFinite(data.radius)) ? Math.max(0, Math.min(64, data.radius)) : undefined;
		const speed = (typeof data.speed === 'number' && isFinite(data.speed)) ? Math.max(0.1, Math.min(4, data.speed)) : undefined;
		// ROUND 41 (item 2a): the host relays a MEMBER-husk's plain (unguarded) hit-receive
		// sound by overriding the packet's player tag to that member's name, so every watcher
		// (including the hit member) replays it on the victim's own mirror. Whitelist the tag
		// to a real OTHER player currently in the instance (never the sender's own name — a
		// sender faking its own name would be dropped by every watcher's self-check anyway);
		// on any mismatch fall back to stamping the sender. Client applyPlayerSound is
		// unchanged (it already keys on the packet's player field).
		let playerTag = username;
		if (typeof data.player === 'string' && data.player && data.player !== username) {
			try {
				const members = (typeof world.getInstanceMembers === 'function') ? world.getInstanceMembers(username) : [];
				if (members && members.indexOf(data.player) !== -1) playerTag = data.player;
			} catch (_) { /* fall back to the sender's name */ }
		}
		world.broadcastToInstance(ctx, username, 'playerSound', {
			player: playerTag, path: data.path, volume, variance,
			loop: data.loop === true,
			...(radius !== undefined ? { radius } : {}),
			...(speed !== undefined ? { speed } : {}),
		});
	});

	// ---- round 39 (item 1): a client RELEASED a sustained (looped) sound ----
	// The skill charge-up is relayed as a loop:true playerSound (so it plays continuously
	// like the native held charge) and is CUT on release by this packet — the old one-shot
	// relay let the final charge level ring out past release. Sender->instance like
	// playerSound (broadcastToInstance, both host and member players charge); auth-gated +
	// rate-limited; the payload is only the sender's name (no blob).
	socket.on('soundStop', function (data) {
		if (dropIfNotAuthed('soundStop')) return;
		if (rateLimited('soundStop', 60)) return;
		world.broadcastToInstance(ctx, username, 'soundStop', { player: username });
	});

	// ---- ROUND 95: ITEM-USE INDICATOR ----
	// A player consumed/used an item. Relay the item id to every OTHER player in
	// the same instance so they can pop the item icon above that player's head.
	// Item ids are string|number in the engine — validate both shapes; no raw blob.
	socket.on('itemUse', function (data) {
		if (dropIfNotAuthed('itemUse')) return;
		if (rateLimited('itemUse', 10)) return;
		const item = data && data.item;
		const valid = (typeof item === 'string' && item.length > 0 && item.length <= 80)
			|| (typeof item === 'number' && isFinite(item));
		if (!valid) return;
		world.broadcastToInstance(ctx, username, 'itemUse', { player: username, item });
	});

	// ---- ROUND 99: HEAL NUMBER relay ----
	// The HEALING player's own client already shows the green +N jump-numbers
	// (Combatant.heal -> ig.ENTITY.HitNumber.spawnHealingNumber). Relay the healed
	// amount to every OTHER same-instance player so spectators can spawn the same
	// green number above that player's mirror.
	socket.on('playerHeal', function (data) {
		if (dropIfNotAuthed('playerHeal')) return;
		if (rateLimited('playerHeal', 20)) return;
		const amount = Number(data && data.amount);
		if (!isFinite(amount) || amount <= 0 || amount > 999999) return;
		world.broadcastToInstance(ctx, username, 'playerHeal', { player: username, amount: Math.round(amount) });
	});

	// ---- round 23: host grants credits/items to members when it kills a monster ----
	// The instance host's death chain (EnemyType.resolveDefeat) grants credits + item
	// drops to the HOST's player. The host relays them here so every member's client
	// grants the SAME amounts to its own player (resolveDefeat runs only on the host's
	// authority). Host-only relay like entityState/enemyAttack (broadcastHostState
	// no-ops unless the sender IS the instance host), auth-gated + rate-limited; the
	// payload is whitelisted field-by-field (never a raw blob).
	socket.on('loot', function (data) {
		if (dropIfNotAuthed('loot')) return;
		if (rateLimited('loot', 50)) return;
		// Round 24 (loot fairness): uid must be a positive finite number (rejects the
		// 0/negative uids some old hosts could emit).
		if (!data || !isFinite(data.uid) || data.uid <= 0) return;
		const credit = Number(data.credit);
		if (!isFinite(credit) || credit < 0 || credit > 1000000) return;
		// boosterState: the enemy's booster state, coerced to an integer 0..10 (default 0).
		let boosterState = 0;
		if (isFinite(Number(data.boosterState))) {
			boosterState = Math.max(0, Math.min(10, Math.round(Number(data.boosterState))));
		}
		// drops: the RAW drop table (cap 16). Each entry is coerced field-by-field so a
		// member can roll its own drops safely (never a raw blob).
		if (!Array.isArray(data.drops) || data.drops.length > 16) return;
		const drops = [];
		for (const m of data.drops) {
			if (!m || typeof m !== 'object') continue;
			const item = (typeof m.item === 'string') ? m.item : (m.item != null ? String(m.item) : '');
			if (!item || item.length > 32) continue;
			const prob = Number(m.prob);
			if (!isFinite(prob) || prob < 0 || prob > 1) continue;
			let min = Number(m.min);
			if (!isFinite(min)) min = 1;
			min = Math.max(0, Math.min(99, Math.round(min)));
			let max = Number(m.max);
			if (!isFinite(max)) max = 0;
			max = Math.max(0, Math.min(99, Math.round(max)));
			const rank = (typeof m.rank === 'string') ? m.rank : '';
			drops.push({ item: item.slice(0, 32), prob, min, max, rank: rank.slice(0, 16), boosted: !!m.boosted });
		}
		world.broadcastHostState(ctx, username, 'loot', { uid: Math.round(data.uid), credit: Math.round(credit), boosterState, drops });
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
		// ROUND 27: a PERFECT-guard hit carries damage 0 (the member plays the counter
		// window + FX even though no HP is lost), so allow 0 — but ONLY for a flagged
		// monster hit. Every other hit still requires damage > 0.
		const isMonster = data.monster === true;
		if (!isFinite(dmg) || dmg > 100000) return;
		if (dmg <= 0 && !(isMonster && data.perfect === true)) return;
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
			// ROUND 27 (host-authoritative monster damage): passthrough verdict flags.
			// The host's recomputeHostMonsterHit emits these; the member applies them
			// VERBATIM (perfect = 0 damage + counter window; regular = chip + guard bar;
			// knockback = whether the engine knockback fires). PvP hits omit them.
			monster: isMonster ? true : undefined,
			perfect: data.perfect === true ? true : undefined,
			regular: data.regular === true ? true : undefined,
			knockback: typeof data.knockback === 'boolean' ? data.knockback : undefined,
			// ROUND 42 (Symptom 1): the attack's REAL sc.ATTACK_TYPE (melee MEDIUM/HEAVY/
			// MASSIVE), relayed from hitProps.visualType so the member plays the correct
			// hit sound (a hardcoded LIGHT made every melee hit sound like a ball-hit).
			attackType: typeof data.attackType === 'number' && isFinite(data.attackType) && data.attackType > 0 ? data.attackType : undefined,
			// ROUND 79: guard-bar drain (engine's ratio^1.5 value, NOT the HP chip) and the
			// FULL unguarded hit for the bar-break case. The host's recompute emits both on
			// regular-guard verdicts; the member's applyCombatHit feeds the bar with
			// shieldDmg and falls back to the full hit when the bar breaks.
			shieldDmg: (typeof data.shieldDmg === 'number' && isFinite(data.shieldDmg) && data.shieldDmg >= 0) ? Math.round(data.shieldDmg) : undefined,
			full: (typeof data.full === 'number' && isFinite(data.full) && data.full > 0) ? Math.round(data.full) : undefined,
			// ROUND 43 (enemy-hurt sound for teammates): the attacker's ATTACK ELEMENT,
			// forwarded from the member's local hit so every spectator can re-run
			// showHitEffect on the enemy PUPPET (the host's puppet-onDamage is silent,
			// so nothing native plays for them). Distinct from `element` (the monster's
			// element on a combatHit) — attackElement is what showHitEffect needs to
			// pick the connect sound (NEUTRAL+LIGHT etc.) + material hit-receive.
			attackElement: typeof data.attackElement === 'number' && isFinite(data.attackElement) && data.attackElement >= 0 && data.attackElement <= 4 ? Math.round(data.attackElement) : undefined,
		});
	});

	// ---- ROUND 43 (skill-release sound): replay a skill's FIRE sound on mirrors ----
	// The host's playAtEntity observer that relays enemy + charged-ball sounds also
	// silences SKILL-projectile launch sounds locally and (before this round) sent
	// nothing, so a skill like 回旋斩 / charged shots fired with NO sound for anyone
	// but the caster. The firing client emits the sound path it suppressed; every
	// other client replays it positioned on the caster's MIRROR. Loop sounds stay on
	// the existing playerSound/enemySound sustained-handle path; this is one-shots.
	socket.on('skillSound', function (data) {
		if (dropIfNotAuthed('skillSound')) return;
		if (rateLimited('skillSound', 60)) return;
		if (!data || typeof data.path !== 'string' || data.path.length > 200) return;
		if (!isValidName(data.player)) return;
		const vol = Number(data.volume);
		const varn = Number(data.variance);
		const spd = Number(data.speed);
		const rad = Number(data.radius);
		world.broadcastToInstance(ctx, username, 'skillSound', {
			player: data.player,
			path: data.path,
			volume: isFinite(vol) && vol > 0 && vol <= 2 ? vol : undefined,
			variance: isFinite(varn) && varn >= 0 && varn <= 1 ? varn : undefined,
			speed: isFinite(spd) && spd > 0 && spd <= 4 ? spd : undefined,
			radius: isFinite(rad) && rad > 0 ? rad : undefined,
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
		// ROUND 32 (item 3c): pass through the REAL attack's interrupt/knockback
		// strength. Old clients omit these -> type defaults to 2 (MEDIUM, the old
		// fabricated value) so behaviour is unchanged for a mixed client/server pair.
		let type = Number(data.type);
		if (!isFinite(type) || type < 0 || type > 5) type = 2;
		let knockback = Number(data.knockback);
		if (!isFinite(knockback) || knockback < 0 || knockback > 10) knockback = 0;
		// ROUND 44 (Gap A spectator enemy-hurt sound): the attacker relays its own hurt
		// FX (the engine suppresses the puppet's native showHitEffect), so spectators need
		// the connect+receive replay. Carry the attack's element + critical + ball so the
		// spectator's replayed showHitEffect picks the right material/element sound. Old
		// clients omit these -> neutral/non-crit defaults (behaviour unchanged).
		let attackElement = Number(data.attackElement);
		if (!isFinite(attackElement) || attackElement < 0 || attackElement > 4) attackElement = 0;
		// ROUND 72 (number style sync): the attacker also forwards the FINAL number
		// style its engine produced — shield result (silver GUARD), element-weakness
		// flag, offensive/defensive factors (number size + STRONG/WEAK appendix) — so
		// every spectator pops the identical styled number on its own puppet, and the
		// host can force the rolled crit. Old clients omit these -> plain defaults.
		let shield = Number(data.shield);
		if (!isFinite(shield) || shield < 0 || shield > 3) shield = 0;
		let off = Number(data.off);
		if (!isFinite(off) || off <= 0 || off > 10) off = 1;
		let def = Number(data.def);
		if (!isFinite(def) || def <= 0 || def > 10) def = 1;
		world.broadcastToInstance(ctx, username, 'enemyDamage', {
			uid: data.uid,
			damage: Math.round(dmg),
			attacker: username, // authoritative sender, never client-supplied
			type: Math.round(type),
			ball: data.ball === true,
			charged: data.charged === true,
			knockback: knockback,
			attackElement: Math.round(attackElement),
			critical: data.critical === true,
			shield: Math.round(shield),
			weak: data.weak === true,
			off: off,
			def: def,
		});
	});

	// ---- round 21: a MEMBER reports a monster hit it detected locally ----
	// The member now runs monster-hit DAMAGE locally (native pipeline: guard / i-frames /
	// knockback / perfect guard). Its real HP streams to the host via playerState anyway,
	// so this relay is BOOKKEEPING/telemetry only — the host does NOT re-apply any damage.
	// Mirrors the enemyDamage relay: authed + rate-limited + field-validated, then
	// broadcast back into the instance (only the host's client consumes it).
	socket.on('combatResult', function (data) {
		if (dropIfNotAuthed('combatResult')) return;
		if (rateLimited('combatResult', 50)) return;
		if (!data || typeof data.uid !== 'number') return;
		const dmg = Number(data.damage);
		if (!isFinite(dmg) || dmg < 0 || dmg > 100000) return; // a perfect guard can be 0
		if (typeof data.guarded !== 'boolean') return;
		world.broadcastToInstance(ctx, username, 'combatResult', {
			uid: data.uid,
			damage: Math.round(dmg),
			guarded: data.guarded,
		});
	});

	// ---- round 24: monster COUNTER / GUARD-BREAK fx relay ----
	// Any instance client (host on its real enemies, members on their puppets) detects
	// a counter/guard-break and relays it here so every OTHER client replays the same
	// visual on its copy of the enemy. Same-instance relay like the other combat
	// events (broadcastToInstance excludes the sender), auth-gated + rate-limited;
	// the payload is whitelisted field-by-field ({uid, kind}), never a raw blob.
	socket.on('combatFx', function (data) {
		if (dropIfNotAuthed('combatFx')) return;
		if (rateLimited('combatFx', 20)) return;
		if (!data || typeof data.uid !== 'number' || !Number.isInteger(data.uid) || data.uid <= 0) return;
		if (data.kind !== 'counter' && data.kind !== 'break') return;
		world.broadcastToInstance(ctx, username, 'combatFx', { from: username, uid: data.uid, kind: data.kind });
	});

	// ---- ROUND 74: plant destruct sync ----
	// Any instance client destroyed a map destructible (plant/bush/stone). Every OTHER
	// same-instance client destroys its own intact copy at the same mapId (the map data
	// is identical for everyone, so mapId unambiguously identifies the plant). Payload is
	// whitelisted field-by-field; the map string is bounded, never trusted. Solo players
	// never send this (the client's syncEmit skips solo instances).
	socket.on('plantBreak', function (data) {
		if (dropIfNotAuthed('plantBreak')) return;
		if (rateLimited('plantBreak', 20)) return;
		if (!data || typeof data.mapId !== 'number' || !Number.isInteger(data.mapId) || data.mapId <= 0) return;
		if (typeof data.map !== 'string' || data.map.length === 0 || data.map.length > 128) return;
		world.broadcastToInstance(ctx, username, 'plantBreak', { map: data.map, mapId: data.mapId });
	});

	// ---- round 45 (Gap A, host origin): the HOST applied a member's forwarded hit to a
	// real enemy. The server self-drops enemyDamage back to that member, so any OTHER member
	// spectating heard nothing. The host relays a cosmetic-only notice (NO damage here — HP
	// already moved via enemyDamage) so every other member replays the enemy's hurt FX on its
	// own puppet. Host-only (broadcastHostState), field-whitelisted, cosmetic only.
	// ROUND 58: pass through the `attacker` the host stamped on this packet (the member who
	// landed the hit). That attacking member is NOT self-dropped here (it isn't the host), so
	// it also receives this broadcast — its client skips the replay on an attacker match to
	// avoid hearing its own hurt sound twice. Validated to a bounded string, never trusted.
	socket.on('enemyHurt', function (data) {
		if (dropIfNotAuthed('enemyHurt')) return;
		if (rateLimited('enemyHurt', 50)) return;
		if (!data || typeof data.uid !== 'number' || !Number.isInteger(data.uid) || data.uid <= 0) return;
		let type = Number(data.type);
		if (!isFinite(type) || type < 0 || type > 5) type = 2;
		let attackElement = Number(data.attackElement);
		if (!isFinite(attackElement) || attackElement < 0 || attackElement > 4) attackElement = 0;
		const attacker = (typeof data.attacker === 'string' && data.attacker && data.attacker.length <= 64) ? data.attacker : undefined;
		// ROUND 72 (host-hit number sync): the host's OWN native hits now ride this
		// channel too, carrying the FINAL styled result ({damage, shield, weak, off,
		// def}, NO attacker stamp) so members pop the identical number on their
		// puppets. Member-originated relays keep {attacker} and no damage — cosmetic
		// FX only. Damage is optional: absent -> legacy FX-only behaviour.
		let hurtDmg = Number(data.damage);
		if (!isFinite(hurtDmg) || hurtDmg <= 0 || hurtDmg > 100000) hurtDmg = undefined;
		let shield = Number(data.shield);
		if (!isFinite(shield) || shield < 0 || shield > 3) shield = 0;
		let off = Number(data.off);
		if (!isFinite(off) || off <= 0 || off > 10) off = 1;
		let def = Number(data.def);
		if (!isFinite(def) || def <= 0 || def > 10) def = 1;
		world.broadcastHostState(ctx, username, 'enemyHurt', {
			uid: data.uid, type: Math.round(type),
			attackElement: Math.round(attackElement), critical: data.critical === true,
			...(attacker !== undefined ? { attacker } : {}),
			...(hurtDmg !== undefined ? { damage: Math.round(hurtDmg), shield: Math.round(shield), weak: data.weak === true, off: off, def: def } : {}),
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
		// ROUND 89 (offline search level): persist the sanitized profile on the
		// ACCOUNT so an offline friend's level/stats survive logout and server
		// restarts. updatePlayerProfile is event-driven (connect / real stat
		// changes), so this writes are rare, not per-frame.
		try {
			const account = accounts.getAccount(username);
			if (account) {
				account.profile = clean;
				persistence.save();
			}
		} catch (e) { /* non-fatal */ }
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
		// Bots: the official companion names may include characters outside the
		// plain \w username charset (e.g. "C'tron"), so they get a carve-out.
		if (!isValidName(target) && !bots.isBotName(target)) {
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
			// Round 23 wave 3: mutual auto-accept = friends now — toast BOTH users.
			socket.emit('friendAdded', { name: target });
			if (other) other.emit('friendAdded', { name: username });
			// Round 23 review: mirror the normal request-success result to the
			// REQUESTER so their add-friend window closes + toasts — the auto-accept
			// branch used to return early, leaving the window open on their side.
			socket.emit('friendActionResult', { action: 'request', ok: true, to: target, toOffline: res.toOffline });
			// Requests lists shrank on both sides; refresh them.
			socket.emit('friendRequests', { requests: friends.requests(username) });
			if (other) other.emit('friendRequests', { requests: friends.requests(target) });
			// Round 23 review: push the newly-mutual friend's cached profile so the
			// Social info box shows real stats on first open (same mechanism as the
			// client-requested friendList path).
			try {
				const prof = world.getAccountProfile(target);
				if (prof) socket.emit('updatePlayerProfile', { player: target, profile: prof });
				if (other) {
					const prof2 = world.getAccountProfile(username);
					if (prof2) other.emit('updatePlayerProfile', { player: username, profile: prof2 });
				}
			} catch (e) { /* non-fatal */ }
			return;
		}
		socket.emit('friendActionResult', { action: 'request', ok: true, to: target, toOffline: res.toOffline });
		// Round 23 wave 3: the requester's outgoing list grew — refresh it so the
		// 申请管理 tab + the add-friend window's pending-state stay accurate.
		socket.emit('friendRequests', { requests: friends.requests(username) });
		// Notify the target (if online) that they have an incoming request.
		const other = accounts.getSocket(target);
		if (other) {
			other.emit('friendRequest', { from: username });
			other.emit('friendRequests', { requests: friends.requests(target) });
		}
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
		// Round 23 wave 3: friendship established — toast BOTH users.
		socket.emit('friendAdded', { name: from });
		if (other) other.emit('friendAdded', { name: username });
		// Round 23 review: push the newly-mutual friend's cached profile so the
		// Social info box shows real stats on first open (same mechanism as the
		// client-requested friendList path).
		try {
			const prof = world.getAccountProfile(from);
			if (prof) socket.emit('updatePlayerProfile', { player: from, profile: prof });
			if (other) {
				const prof2 = world.getAccountProfile(username);
				if (prof2) other.emit('updatePlayerProfile', { player: username, profile: prof2 });
			}
		} catch (e) { /* non-fatal */ }
		// Requests lists shrank on both sides; refresh them.
		socket.emit('friendRequests', { requests: friends.requests(username) });
		if (other) other.emit('friendRequests', { requests: friends.requests(from) });
	});
	socket.on('friendDecline', function (data) {
		if (dropIfNotAuthed('friendDecline')) return;
		const from = data && data.name;
		if (!isValidName(from)) return;
		if (from === username) {
			// Self-guard: you can't decline a request to yourself.
			socket.emit('friendActionResult', { action: 'decline', ok: false, error: 'Cannot decline yourself' });
			return;
		}
		const res = friends.decline(username, from);
		if (!res.ok) {
			// Nothing was declined (no matching incoming request) — report the
			// failure instead of refreshing both sides as if a request vanished.
			socket.emit('friendActionResult', { action: 'decline', ok: false, error: res.error });
			return;
		}
		socket.emit('friendRequests', { requests: friends.requests(username) });
		// Round 23 wave 3: tell the requester their request was DECLINED (toast)
		// and refresh their outgoing list too — only when a request was actually
		// declined.
		const other = accounts.getSocket(from);
		if (other) {
			other.emit('friendRequests', { requests: friends.requests(from) });
			other.emit('friendRequestDeclined', { name: username });
		}
	});
	socket.on('friendRemove', function (data) {
		if (dropIfNotAuthed('friendRemove')) return;
		const name = data && data.name;
		// Bot carve-out: "C'tron" fails the plain \w name check; removing a bot
		// friend must keep working so the companion can be re-added afterward.
		if (!isValidName(name) && !bots.isBotName(name)) return;
		friends.remove(username, name);
		// Refresh both sides so the removed entry disappears everywhere.
		socket.emit('friendList', { friends: friends.list(username) });
		const other = accounts.getSocket(name);
		if (other) other.emit('friendList', { friends: friends.list(name) });
		// Round 23 review: deliberately NO cached-profile push here (unlike the
		// accept/auto-accept sites) — the friendship just ended, so neither side's
		// Social list shows the other anymore and the profile would be dead weight.
	});
	socket.on('friendList', function () {
		if (dropIfNotAuthed('friendList')) return;
		const list = friends.list(username);
		socket.emit('friendList', { friends: list });
		// Push cached real profiles right away so the Social info box shows
		// level/stats/equip on FIRST open (not after a 3s pump or a shared-map
		// visit). Live friends use the global session cache; OFFLINE friends now
		// fall back to the profile persisted on their account (ROUND 89), so their
		// level stays visible in the friend list / add-friend search too.
		try {
			for (const f of list) {
				if (!f) continue;
				let prof = world.getAccountProfile(f.name);
				if (!prof) {
					const acc = accounts.getAccount(f.name);
					prof = acc && acc.profile;
				}
				if (prof) socket.emit('updatePlayerProfile', { player: f.name, profile: prof });
			}
		} catch (e) { /* non-fatal */ }
	});
	socket.on('friendRequests', function () {
		if (dropIfNotAuthed('friendRequests')) return;
		socket.emit('friendRequests', { requests: friends.requests(username) });
	});

	// ---- round 23 wave 3: player SEARCH (the search-first add-friend flow) ----
	// Reply ONLY to the requester: a capped list of exact/prefix/substring matches
	// against every KNOWN account (username is identity; persistence.db.accounts is
	// the source of truth). Level comes from the live profile cache when the player
	// is online, and from the profile persisted on the account (ROUND 89) when they
	// are offline.
	socket.on('searchPlayers', function (data) {
		if (dropIfNotAuthed('searchPlayers')) return;
		if (rateLimited('searchPlayers', 2)) return;
		const raw = data && data.query;
		if (typeof raw !== 'string') return;
		const query = raw.trim();
		if (query.length < 1 || query.length > 20) return;
		const lower = query.toLowerCase();
		const accs = persistence.db.accounts || {};
		bots.seed(); // bots are virtual accounts: make sure they exist before listing
		// Round 27 (item 1): FUZZY search. The query is matched as a case-insensitive
		// SUBSTRING/regex against the username (any position — not just exact/prefix),
		// and against a bot's searchable aliases (its native contact id, English and
		// Chinese names) so a removed bot friend is re-addable by more than its
		// account id. For non-bot accounts the username is the only searchable string.
		const scored = [];
		for (const name of Object.keys(accs)) {
			// Bot carve-out: "C'tron" fails the plain \w name check but must still
			// be searchable — that's how a removed bot friend is re-added.
			if ((!isValidName(name) && !bots.isBotName(name)) || name === username) continue; // never list yourself
			const nl = name.toLowerCase();
			let rank = -1;
			if (nl === lower) rank = 0;            // exact
			else if (nl.indexOf(lower) === 0) rank = 1;  // prefix
			else if (nl.indexOf(lower) !== -1) rank = 2; // substring
			else if (bots.isBotName(name)) {
				// Bot alias match (English/Chinese/contact id): ranked like a substring
				// so it sorts after a direct name hit but still surfaces.
				const aliases = bots.aliasesFor(name);
				for (const a of aliases) {
					if (a === lower) { rank = Math.max(rank, 1); break; }
					if (a.indexOf(lower) !== -1) { rank = 2; break; }
				}
			}
			if (rank < 0) continue;
			let prof = world.getAccountProfile(name);
			if (!prof) {
				// ROUND 89: offline accounts keep their last sanitized profile.
				const acc = accounts.getAccount(name);
				prof = acc && acc.profile;
			}
			scored.push({
				name,
				rank,
				online: accounts.isOnline(name),
				level: prof && typeof prof.level === 'number' ? prof.level : undefined,
			});
		}
		// Exact first, then online-first within a rank, then alphabetical.
		scored.sort((a, b) => (a.rank - b.rank)
			|| ((b.online ? 1 : 0) - (a.online ? 1 : 0))
			|| (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
		const players = scored.slice(0, 8).map((m) => {
			const p = { name: m.name, online: m.online };
			if (typeof m.level === 'number') p.level = m.level;
			return p;
		});
		socket.emit('searchPlayersResult', { query, players });
	});

	// ---- round 23 wave 3: WITHDRAW an outgoing friend request ----
	// Removes it from the sender's outgoing box + the recipient's incoming box,
	// pushes the refreshed requests list to BOTH sockets, and pokes the recipient
	// with `friendRequestWithdrawn` so they can toast it.
	socket.on('friendRequestWithdraw', function (data) {
		if (dropIfNotAuthed('friendRequestWithdraw')) return;
		const target = data && data.name;
		if (!isValidName(target)) return;
		const res = friends.withdraw(username, target);
		if (!res.ok) {
			socket.emit('friendActionResult', { action: 'withdraw', ok: false, error: res.error });
			return;
		}
		socket.emit('friendRequests', { requests: friends.requests(username) });
		const other = accounts.getSocket(target);
		if (other) {
			other.emit('friendRequests', { requests: friends.requests(target) });
			other.emit('friendRequestWithdrawn', { name: username });
		}
		socket.emit('friendActionResult', { action: 'withdraw', ok: true, to: target });
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
		// Round 23 wave 3: busy-check — a player already sitting on a pending invite
		// can't be invited again (two popups would race for their accept/decline).
		// Checked BEFORE createParty/addInvite so no party/invite state is created.
		if (party.hasPendingInvite(to)) {
			socket.emit('partyActionResult', { action: 'invite', ok: false, error: 'busy' });
			return;
		}
		const hadParty = !!party.partyOf(username);
		const partyId = party.createParty(username);
		// ROUND 95: push the freshly-created solo party back to the inviter. Without
		// this, their first-ever roster snapshot is the post-accept [inviter, invitee],
		// so the prev roster is EMPTY and the "X joined the party" toast is skipped.
		if (!hadParty) pushPartyUpdate(partyId);
		// Round 23 review: never invite someone who is ALREADY a member of this
		// party (createParty returns the inviter's existing party). Reject with the
		// same partyActionResult error shape as the busy-check. The client doesn't
		// special-case 'inparty', so it surfaces as a generic failure toast.
		if (party.partyOf(to) === partyId) {
			socket.emit('partyActionResult', { action: 'invite', ok: false, error: 'inparty' });
			return;
		}
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
	function markStoryCheckSocket(reqId, quest) {
		socket._mpStoryChecks = socket._mpStoryChecks || Object.create(null);
		socket._mpStoryChecks[reqId] = quest;
	}
	function clearStoryCheckSocket(reqId) {
		if (socket._mpStoryChecks && socket._mpStoryChecks[reqId]) delete socket._mpStoryChecks[reqId];
	}

	// The actual join body (invite must already be consumed). Extracted so the
	// story-sync gate can run it from the async eligibility reply.
	function completePartyAccept(partyId) {
		// Leave any current party first (forced disband of the acceptor's old party).
		// Capture the survivors BEFORE removing so a 2-person disband still notifies
		// the old teammate (removeMember returns null on disband).
		const prevPartyId = party.partyOf(username);
		const prevSurvivors = prevPartyId && party.getParty(prevPartyId)
			? party.getParty(prevPartyId).members.filter((m) => m !== username) : [];
		// 1.70.61: leaving our old party must also exit its story sync (member
		// leaves alone; a 2-person collapse ends it for the survivor).
		if (prevPartyId && prevPartyId !== partyId) storySyncOnDeparture(prevPartyId, username, 'left');
		const prev = party.removeMember(username);
		if (prev) {
			// Round 23 wave 3: the acceptor left their OLD party — its survivors get
			// the departure manner.
			pushPartyUpdate(prev.id, { name: username, reason: 'left' });
		} else {
			for (const m of prevSurvivors) {
				const s = accounts.getSocket(m);
				if (s) {
					pushPartyMemberLeft(s, username, 'left');
					s.emit('partyUpdate', null);
				}
				// The old party disbanded: move its survivor out of the dead
				// party:<id> instance so they don't linger as a ghost.
				world.recomputeMemberInstance(ctx, m);
			}
		}
		party.addMember(partyId, username);
		// ROUND 96: tell the ACCEPTOR themselves they joined (the roster-diff toast
		// path only announces OTHER members; self transitions were silent).
		socket.emit('partySelfEvent', { event: 'join' });
		// Broadcast the new roster to EVERY member (inviter + invitee).
		pushPartyUpdate(partyId);
		const p = party.getParty(partyId);
		if (!p) {
			// Belt-and-braces: the party vanished between the invite check and the
			// join (e.g. the leader disconnected + party disbanded raced the accept).
			// Tell the acceptor it failed instead of throwing on p.members below.
			socket.emit('partyActionResult', { action: 'accept', ok: false, error: 'Party no longer exists' });
			return;
		}
		const joinedSync = p.storySync || null;
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
		// 1.70.61: joining a party that is mid-way through a story sync carries the
		// new member into the SAME sync (their coin was verified before accepting):
		// push the mode envelope to them and ask the leader to resend the current
		// quest state so the newcomer locks onto it immediately. A newcomer also
		// invalidates any OPEN skip vote (they were never in the original vote).
		if (joinedSync) {
			if (joinedSync.vote) abortStoryVote(partyId, joinedSync);
			socket.emit('storySyncStart', {
				quest: joinedSync.quest,
				leader: joinedSync.leader,
				members: p.members.slice(),
			});
			const ls = accounts.getSocket(joinedSync.leader);
			if (ls) ls.emit('storySyncResend', { quest: joinedSync.quest });
		}
		// NOTE: joining a party NO LONGER auto-teleports the acceptor to the leader.
		// Regrouping is a separate, manual action: the client shows a
		// "传送到队友身边" button (enabled only while in a party) which emits
		// `partyRegroup`; only then do we answer with the leader's location so the
		// requester can teleport. This keeps party-up and travelling decoupled.
	}

	function failStoryJoin(req, reason) {
		if (!req || req.settled) { clearStoryCheckSocket(req.reqId); return; }
		req.settled = true;
		if (req.timer) { clearTimeout(req.timer); req.timer = null; }
		delete storyJoinChecks[req.reqId];
		// Settle the invite one way or the other — a denied/answered acceptance
		// must not leave a pending invite pinned on the invitee forever.
		party.consumeInvite(req.partyId, req.username);
		req.socketResult.emit('partyActionResult', {
			action: 'accept', ok: false,
			error: '该队伍正在进行剧情同步，未承接或未完成当前同步任务的玩家无法加入',
			storyQuest: req.quest, storyReason: reason,
		});
	}

	socket.on('partyAccept', function (data) {
		if (dropIfNotAuthed('partyAccept')) return;
		const partyId = data && data.partyId;
		const targetParty = party.getParty(partyId);
		if (!targetParty) {
			socket.emit('partyActionResult', { action: 'accept', ok: false, error: 'Party no longer exists' });
			return;
		}
		// ROUND 12 + round 23 review: refuse to exceed the 8-member cap BEFORE
		// consuming the invite, so a full party doesn't burn it (the invite stays
		// valid for a later retry once someone leaves).
		if (targetParty.members.length >= 8) {
			socket.emit('partyActionResult', { action: 'accept', ok: false, error: '队伍已满（最多 8 人）' });
			return;
		}
		// Only someone actually invited may join (partyId is guessable: p1, p2, ...).
		// For a story-syncing party this check runs BEFORE the async eligibility
		// handshake so an uninvited guesser can't hold a check slot open.
		if (!party.hasInviteTo(partyId, username)) {
			socket.emit('partyActionResult', { action: 'accept', ok: false, error: 'No invite to this party' });
			return;
		}
		if (targetParty.storySync) {
			// 1.70.61: story sync active -> the acceptor's client must prove this
			// quest is accepted OR solved before the invite is consumed.
			const reqId = 'sj' + (storyReqSeq++);
			const rec = {
				reqId, quest: targetParty.storySync.quest, partyId, username,
				socketResult: socket, settled: false, timer: null,
			};
			rec.timer = setTimeout(function () { failStoryJoin(rec, 'timeout'); }, STORY_SYNC.CHECK_TIMEOUT_MS);
			storyJoinChecks[reqId] = rec;
			markStoryCheckSocket(reqId, rec.quest);
			socket.emit('storySyncJoinCheck', { reqId, quest: rec.quest });
			return;
		}
		if (!party.consumeInvite(partyId, username)) {
			socket.emit('partyActionResult', { action: 'accept', ok: false, error: 'No invite to this party' });
			return;
		}
		completePartyAccept(partyId);
	});

	// 1.70.61: partyAccept second phase — the acceptor's client just read its
	// local quest state and reports active/solved availability.
	socket.on('storySyncJoinCheckResult', function (data) {
		if (dropIfNotAuthed('storySyncJoinCheckResult')) return;
		if (rateLimited('storySyncJoinCheckResult', 10)) return;
		const reqId = data && data.reqId;
		const rec = reqId && storyJoinChecks[reqId];
		if (!rec || rec.username !== username) return;
		if (!socket._mpStoryChecks || socket._mpStoryChecks[reqId] !== rec.quest) return;
		clearStoryCheckSocket(reqId);
		if (rec.settled) return;
		if (!isValidQuestId(data.quest) || data.quest !== rec.quest) { failStoryJoin(rec, 'mismatch'); return; }
		const active = !!data.active;
		const solved = !!data.solved;
		const available = data.available !== false;
		if (!available || (!active && !solved)) { failStoryJoin(rec, available ? 'questNotReady' : 'unavailable'); return; }
		// Eligible: settle the pending record FIRST, then consume the invite and
		// run the normal join path (completePartyAccept re-validates the party).
		rec.settled = true;
		if (rec.timer) { clearTimeout(rec.timer); rec.timer = null; }
		delete storyJoinChecks[reqId];
		if (!party.consumeInvite(rec.partyId, username)) {
			socket.emit('partyActionResult', { action: 'accept', ok: false, error: 'No invite to this party' });
			return;
		}
		completePartyAccept(rec.partyId);
	});
	// ---- 1.70.61 剧情同步模式: core message handlers ----
	// Leader requests the mode; the server asks EVERY member's client (leader
	// included) whether the quest is active/solved. As soon as every answer is in
	// the server either raises the mode or pushes a failure to the whole party.

	function settleStoryStart(rec, ok, reason, names) {
		if (rec.settled) return;
		rec.settled = true;
		if (rec.timer) { clearTimeout(rec.timer); rec.timer = null; }
		delete storyStartRequests[rec.reqId];
		for (const m of rec.members) {
			const s = accounts.getSocket(m);
			if (s && s._mpStoryChecks && s._mpStoryChecks[rec.reqId]) delete s._mpStoryChecks[rec.reqId];
		}
		const p = party.getParty(rec.partyId);
		if (ok) {
			if (!p || p.storySync) {
				emitToParty(rec.partyId, 'storySyncStartFailed', {
					reqId: rec.reqId, quest: rec.quest,
					reason: !p ? 'partyGone' : 'busy', names: [],
				});
				return;
			}
			p.storySync = { quest: rec.quest, leader: rec.leader, startedAt: Date.now(), eventSeq: 0, vote: null };
			console.log('[story-sync] started in ' + rec.partyId + ': quest=' + rec.quest + ' leader=' + rec.leader + ' members=' + p.members.join(','));
			emitToParty(rec.partyId, 'storySyncStart', {
				quest: rec.quest, leader: rec.leader, members: p.members.slice(),
			});
		} else {
			emitToParty(rec.partyId, 'storySyncStartFailed', {
				reqId: rec.reqId, quest: rec.quest, reason: reason, names: names || [],
			});
		}
	}

	socket.on('storySyncRequest', function (data) {
		if (dropIfNotAuthed('storySyncRequest')) return;
		if (rateLimited('storySyncRequest', 2)) return;
		const quest = data && data.quest;
		if (!isValidQuestId(quest)) return;
		const partyId = party.partyOf(username);
		const p = partyId && party.getParty(partyId);
		if (!p || p.leader !== username || p.members.length < 2) {
			socket.emit('storySyncStartFailed', { reqId: '', quest: quest, reason: 'notLeader', names: [] });
			return;
		}
		if (p.storySync) {
			socket.emit('storySyncStartFailed', { reqId: '', quest: quest, reason: 'busy', names: [] });
			return;
		}
		// Every member must be ONLINE right now (an offline teammate can't confirm
		// eligibility and could never receive the start envelope).
		const offline = p.members.filter((m) => !accounts.isOnline(m));
		if (offline.length) {
			socket.emit('storySyncStartFailed', { reqId: '', quest: quest, reason: 'offline', names: offline });
			return;
		}
		const reqId = 'ss' + (storyReqSeq++);
		const rec = {
			reqId, quest, partyId, leader: username, members: p.members.slice(),
			answers: Object.create(null), settled: false, timer: null,
		};
		rec.timer = setTimeout(function () {
			const missing = rec.members.filter((m) => !rec.answers[m]);
			settleStoryStart(rec, false, 'timeout', missing);
		}, STORY_SYNC.CHECK_TIMEOUT_MS);
		storyStartRequests[reqId] = rec;
		for (const m of rec.members) {
			const s = accounts.getSocket(m);
			if (!s) continue;
			s._mpStoryChecks = s._mpStoryChecks || Object.create(null);
			s._mpStoryChecks[reqId] = quest;
			s.emit('storySyncCheck', { reqId, quest });
		}
		console.log('[story-sync] eligibility check ' + reqId + ' quest=' + quest + ' members=' + rec.members.join(','));
	});

	socket.on('storySyncCheckResult', function (data) {
		if (dropIfNotAuthed('storySyncCheckResult')) return;
		if (rateLimited('storySyncCheckResult', 10)) return;
		const reqId = data && data.reqId;
		const rec = reqId && storyStartRequests[reqId];
		if (!rec || rec.members.indexOf(username) === -1) return;
		if (!socket._mpStoryChecks || socket._mpStoryChecks[reqId] !== rec.quest) return;
		if (rec.settled) return;
		if (!isValidQuestId(data.quest) || data.quest !== rec.quest) return; // bad reply: still counts (timeout cleans up)
		rec.answers[username] = {
			available: data.available !== false,
			active: !!data.active,
			solved: !!data.solved,
		};
		delete socket._mpStoryChecks[reqId];
		if (Object.keys(rec.answers).length < rec.members.length) return;
		// All answered. Validate the CURRENT party shape: a departure mid-check
		// means the request is stale regardless of the answers.
		const p = party.getParty(rec.partyId);
		// 1.70.63 diagnostics: log every member's answer so a failed start can be
		// explained from the server log without re-running the handshake.
		console.log('[story-sync] check ' + rec.reqId + ' answers: ' + rec.members.map((m) => {
			const a = rec.answers[m];
			return m + '=' + (a ? (a.available ? (a.active ? 'active' : 'solved') : 'unavailable') : 'no-answer');
		}).join(', '));
		if (!p || p.leader !== rec.leader
			|| p.members.length !== rec.members.length
			|| rec.members.some((m) => p.members.indexOf(m) === -1)) {
			settleStoryStart(rec, false, 'partyChanged', []);
			return;
		}
		const bad = [];
		for (const m of rec.members) {
			const a = rec.answers[m];
			if (!a) { bad.push(m); continue; }
			if (!a.available || (!a.active && !a.solved)) bad.push(m);
		}
		if (bad.length) { settleStoryStart(rec, false, 'membersNotReady', bad); return; }
		const leaderAnswer = rec.answers[rec.leader];
		if (!leaderAnswer || !leaderAnswer.active) { settleStoryStart(rec, false, 'leaderNotActive', []); return; }
		settleStoryStart(rec, true, '', []);
	});

	socket.on('storySyncState', function (data) {
		if (dropIfNotAuthed('storySyncState')) return;
		if (rateLimited('storySyncState', 10)) return;
		const partyId = party.partyOf(username);
		const p = partyId && party.getParty(partyId);
		const sync = p && p.storySync;
		if (!sync || sync.leader !== username) return;
		const state = sanitizeStoryQuestState(data && data.state);
		if (!state || state.id !== sync.quest) return;
		emitToParty(partyId, 'storySyncState', {
			from: username,
			quest: sync.quest,
			state,
			map: (data && typeof data.map === 'string' && data.map.length <= 64) ? data.map : '',
		}, username);
	});

	socket.on('storySyncEvent', function (data) {
		if (dropIfNotAuthed('storySyncEvent')) return;
		if (rateLimited('storySyncEvent', 5)) return;
		const partyId = party.partyOf(username);
		const p = partyId && party.getParty(partyId);
		const sync = p && p.storySync;
		if (!sync || sync.leader !== username) return;
		if (!data || data.quest !== sync.quest) return;
		const map = (typeof data.map === 'string' && data.map.length <= 96) ? data.map : '';
		const key = (typeof data.key === 'string' && /^[A-Za-z0-9_.-]{1,48}$/.test(data.key)) ? data.key : '';
		const kind = data.kind === 'location' ? 'location' : 'trigger';
		const type = Number(data.type);
		if (!map || !key || !isFinite(type) || type < 1 || type > 5) return;
		const seq = (sync.eventSeq || 0) + 1;
		sync.eventSeq = seq;
		sync.vote = null; // a fresh story event invalidates any open skip vote
		emitToParty(partyId, 'storySyncEvent', {
			from: username, quest: sync.quest, map, key, kind, type, seq,
		});
		console.log('[story-sync] event seq=' + seq + ' kind=' + kind + ' key=' + key + ' map=' + map + ' by=' + username);
	});

	// The leader's engine event finished: abort any OPEN skip vote so a
	// no-timeout vote modal on an off-map/afk member can't linger after the
	// animation it was voting about is already over.
	socket.on('storySyncEventEnd', function (data) {
		if (dropIfNotAuthed('storySyncEventEnd')) return;
		if (rateLimited('storySyncEventEnd', 5)) return;
		const seq = Number(data && data.seq);
		const partyId = party.partyOf(username);
		const p = partyId && party.getParty(partyId);
		const sync = p && p.storySync;
		if (!sync || sync.leader !== username || !isFinite(seq) || seq !== (sync.eventSeq || 0)) return;
		if (sync.vote && sync.vote.seq === seq) {
			sync.vote = null;
			emitToParty(partyId, 'storySyncSkipResult', { seq, pass: false, reason: 'eventEnded' });
		}
	});

	socket.on('storySyncCancel', function (data) {
		if (dropIfNotAuthed('storySyncCancel')) return;
		if (rateLimited('storySyncCancel', 2)) return;
		const partyId = party.partyOf(username);
		const p = partyId && party.getParty(partyId);
		const sync = p && p.storySync;
		if (!sync || sync.leader !== username) return;
		if (data && data.quest && data.quest !== sync.quest) return;
		abortStoryVote(partyId, sync);
		p.storySync = null;
		const quest = sync.quest;
		emitToParty(partyId, 'storySyncEnd', { quest, reason: 'cancel', by: username });
		console.log('[story-sync] cancelled in ' + partyId + ' quest=' + quest + ' by=' + username);
	});

	socket.on('storySyncComplete', function (data) {
		if (dropIfNotAuthed('storySyncComplete')) return;
		if (rateLimited('storySyncComplete', 5)) return;
		const partyId = party.partyOf(username);
		const p = partyId && party.getParty(partyId);
		const sync = p && p.storySync;
		if (!sync || sync.leader !== username) return;
		const state = sanitizeStoryQuestState(data && data.state);
		if (!state || state.id !== sync.quest) return;
		abortStoryVote(partyId, sync);
		p.storySync = null;
		const quest = sync.quest;
		emitToParty(partyId, 'storySyncEnd', { quest, reason: 'complete', state, by: username });
		console.log('[story-sync] complete in ' + partyId + ' quest=' + quest + ' by=' + username);
	});

	// Skip consensus: any member may request a skip for the current relayed event
	// (seq). The server collects votes — no timeout by design (user decision); a
	// departure/leave/new-event/cancel interrupts the vote as "no".
	socket.on('storySyncSkipVote', function (data) {
		if (dropIfNotAuthed('storySyncSkipVote')) return;
		if (rateLimited('storySyncSkipVote', 4)) return;
		const seq = Number(data && data.seq);
		const partyId = party.partyOf(username);
		const p = partyId && party.getParty(partyId);
		const sync = p && p.storySync;
		if (!sync || !isFinite(seq) || seq !== (sync.eventSeq || 0)) return;
		if (sync.vote && sync.vote.seq !== seq) abortStoryVote(partyId, sync);
		if (sync.vote) return; // duplicate request while the vote is open -> ignore
		sync.vote = { seq, from: username, answers: Object.create(null) };
		sync.vote.answers[username] = true;
		emitToParty(partyId, 'storySyncSkipVote', { seq, from: username }, username);
		console.log('[story-sync] skip vote seq=' + seq + ' by=' + username);
	});

	socket.on('storySyncSkipAnswer', function (data) {
		if (dropIfNotAuthed('storySyncSkipAnswer')) return;
		if (rateLimited('storySyncSkipAnswer', 4)) return;
		const seq = Number(data && data.seq);
		const yes = !!data && data.yes === true;
		const partyId = party.partyOf(username);
		const p = partyId && party.getParty(partyId);
		const sync = p && p.storySync;
		const vote = sync && sync.vote;
		if (!vote || vote.seq !== seq || p.members.indexOf(username) === -1) return;
		if (vote.answers[username] !== undefined && vote.answers[username] !== yes) {
			// A changed mind is simply recorded; the first no still kills the vote.
		}
		if (!yes) {
			sync.vote = null;
			emitToParty(partyId, 'storySyncSkipResult', { seq, pass: false, from: username, reason: 'declined' });
			console.log('[story-sync] skip vote seq=' + seq + ' declined by=' + username);
			return;
		}
		vote.answers[username] = true;
		for (const m of p.members) {
			if (vote.answers[m] !== true) return; // still waiting
		}
		sync.vote = null;
		emitToParty(partyId, 'storySyncSkipResult', { seq, pass: true, from: username });
		console.log('[story-sync] skip vote seq=' + seq + ' passed unanimously');
	});

	socket.on('storySyncNudge', function (data) {
		if (dropIfNotAuthed('storySyncNudge')) return;
		if (rateLimited('storySyncNudge', 2)) return;
		const partyId = party.partyOf(username);
		const p = partyId && party.getParty(partyId);
		const sync = p && p.storySync;
		if (!sync) return;
		if (data && data.quest && data.quest !== sync.quest) return;
		emitToParty(partyId, 'storySyncNudge', {
			from: username,
			quest: sync.quest,
			to: Array.isArray(data && data.to) ? data.to.slice(0, 8)
				.filter((x) => typeof x === 'string' && x.length <= 32) : [],
		}, username);
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
		// 1.70.61: exit story sync BEFORE removing ourselves from the party.
		storySyncOnDeparture(partyId, username, 'left');
		const updated = party.removeMember(username);
		socket.emit('partySelfEvent', { event: 'leave' });
		socket.emit('partyUpdate', null);
		if (updated) {
			// Round 23 wave 3: the leaver's manner rides the roster broadcast.
			pushPartyUpdate(updated.id, { name: username, reason: 'left' });
		} else {
			// Party disbanded (2-person party lost a member) -> tell the survivor too.
			for (const m of others) {
				const s = accounts.getSocket(m);
				if (s) {
					pushPartyMemberLeft(s, username, 'left');
					s.emit('partyUpdate', null);
				}
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
		// Round 27 (item 2): `maps` tags each bot with the HOST's map so member HUDs
		// can hide a bot's HP/SP/EXP bars + grey its net diamond while the bot (its
		// owner) is off the member's map. Sanitized to {botName: mapName}. Cached on
		// the instance so the replayed (late-joiner) broadcast keeps the maps.
		let maps = {};
		if (data && data.maps && typeof data.maps === 'object') {
			for (const k in data.maps) {
				if (typeof data.maps[k] === 'string' && data.maps[k].length <= 64) maps[k] = data.maps[k];
			}
		}
		const inst = world.getInstance(instanceId);
		if (inst) { inst.bots = bots; inst.botMaps = maps; }
		world.broadcastToInstance(ctx, username, 'partyBots', { bots: bots, maps: maps });
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

	// ---- round 27 (item 2): a member publishes THEIR current map to the party ----
	// Teammates' HUDs hide an off-map member's HP/SP/EXP bars + grey the net diamond.
	// Like botState this is NOT host-gated (any member reports their own map) — the
	// payload is rebuilt field-by-field and relayed with `from` = the sender. The
	// member's map is also cached on the instance so late joiners could replay it.
	socket.on('memberMap', function (data) {
		if (dropIfNotAuthed('memberMap')) return;
		if (rateLimited('memberMap', 5)) return;
		const map = (data && typeof data.map === 'string') ? data.map.slice(0, 64) : '';
		const inst = world.getInstance(world.instanceOf(username));
		if (inst) { if (!inst.memberMaps) inst.memberMaps = {}; inst.memberMaps[username] = map; }
		world.broadcastToInstance(ctx, username, 'memberMap', { from: username, map: map });
		// ROUND 30 (item 5): cross-instance map relay. broadcastToInstance only reaches
		// members who share the sender's instance — once a member teleports to another
		// map they STOP receiving the stayer's packets, so the stayer's HUD never
		// learns they left (stale memberMapByName -> off-map bars keep showing). Relay
		// the map to every ONLINE PARTY member (any party) regardless of instance; the
		// client keys by name and compares against its own map, so a relay from
		// another instance simply marks that member off-map. Also sent to the sender
		// (they broadcast to their own instance via a direct emit on top).
		if (map) {
			const partyId = party.partyOf(username);
			const p = partyId ? party.getParty(partyId) : null;
			if (p && p.members) {
				for (const m of p.members) {
					if (m === username) continue;
					const s = ctx.getSocket(m);
					if (s) s.emit('memberMap', { from: username, map: map });
				}
			}
			socket.emit('memberMap', { from: username, map: map });
		}
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
		// 1.70.61: the kicked member leaves the sync alone; the rest continue.
		storySyncOnDeparture(partyId, target, 'kicked');
		const others = p.members.filter((m) => m !== username && m !== target);
		const updated = party.removeMember(target);
		// The kicked player loses their party exactly like a leave.
		const tSock = accounts.getSocket(target);
		if (tSock) {
			tSock.emit('partySelfEvent', { event: 'kicked' });
			tSock.emit('partyUpdate', null);
		}
		if (updated) {
			// Round 23 wave 3: the kicked member's manner rides the roster broadcast.
			pushPartyUpdate(updated.id, { name: target, reason: 'kicked' });
		} else {
			// Party disbanded (kick dropped it to one person): tell the kicker and
			// any survivors their party is gone too.
			pushPartyMemberLeft(socket, target, 'kicked');
			socket.emit('partyUpdate', null);
			for (const m of others) {
				const s = accounts.getSocket(m);
				if (s) {
					pushPartyMemberLeft(s, target, 'kicked');
					s.emit('partyUpdate', null);
				}
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

	// ---- round 23 wave 4 + ROUND 93: WORLD / PARTY / PRIVATE CHAT ----
	// One `chat` event now routes by `channel`:
	//   world   — relayed to EVERY authed online player on the server (global
	//             world channel, 1/s per socket so one player can't spam the room).
	//   party   — relayed to every OTHER party member REGARDLESS of map/instance
	//             (team chat is a private line, not proximity chat).
	//   private — relayed to exactly one named online player (direct message).
	// The sender never receives an echo; each client renders its own message
	// locally. Invalid/unroutable sends get a `chatError` back to the SENDER so
	// the new bottom-left chat panel can show a system line instead of failing
	// silently.
	socket.on('chat', function (data) {
		if (dropIfNotAuthed('chat')) return;
		if (!data || typeof data.text !== 'string') return;
		const text = data.text.trim();
		if (text.length < 1 || text.length > 200) return;
		// Backwards-compatible default for a pre-channel client: party.
		const channel = data.channel === 'world' || data.channel === 'party' || data.channel === 'private'
			? data.channel : 'party';
		// World chat is a global amplifier: keep it at 1/s; party/private stay at
		// the old 2/s (plenty for human typing, stops a flood).
		const maxPerSec = channel === 'world' ? 1 : 2;
		if (rateLimited('chat.' + channel, maxPerSec)) {
			socket.emit('chatError', { reason: 'rate', channel });
			return;
		}

		if (channel === 'world') {
			for (const name of accounts.onlineNames()) {
				if (name === username) continue; // no echo to the sender
				const s = accounts.getSocket(name);
				if (s) s.emit('chat', { from: username, text, channel: 'world' });
			}
			return;
		}

		if (channel === 'party') {
			const partyId = party.partyOf(username);
			const p = partyId && party.getParty(partyId);
			if (!p || p.members.length <= 1) {
				socket.emit('chatError', { reason: 'notInParty', channel: 'party' });
				return;
			}
			for (const m of p.members) {
				if (m === username) continue; // no echo to the sender
				if (!accounts.isOnline(m)) continue; // authed + connected
				const s = accounts.getSocket(m);
				if (s) s.emit('chat', { from: username, text, channel: 'party' });
			}
			return;
		}

		// private
		const target = typeof data.target === 'string' ? data.target : '';
		if (!isValidName(target) || target === username) {
			socket.emit('chatError', { reason: 'invalidTarget', channel: 'private' });
			return;
		}
		const targetSocket = accounts.getSocket(target);
		if (!targetSocket) {
			socket.emit('chatError', { reason: 'offline', channel: 'private', target });
			return;
		}
		targetSocket.emit('chat', { from: username, text, channel: 'private' });
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

	// ---- round 23: chunked, rate-limited save UPLOAD (saveChunk) ----
	// The client splits a save into 8192-char parts and streams them paced at ~512
	// kb/s (well under the cap). We enforce the per-socket upload cap
	// (config.saveUploadKbS, default 1024 kb/s) with a token bucket, reassemble parts
	// in order, sanitize + persist on the LAST part, then confirm with `saveSaved`.
	// The generation counter lets rapid map switches abort an in-flight upload (a
	// stale gen is dropped; only the newest save wins). AREA saves ride a change-storm
	// gate so a player churning maps can't spam disk writes (see changeMap tracking).
	function saveBucketConsume(bytes) {
		// 1024 kb/s = 128 KB/s: kb/s is kilobits (bits), so divide by 8 to get bytes/s.
		// Same unit convention as the client's saveUploadQueue pace (~512 kb/s = 64
		// KB/s) and the saveDownload pacing below (part*8/(saveDownloadKbS*1024)).
		const cap = config.saveUploadKbS * 1024 / 8; // bytes/second
		const b = socket._mpSaveBucket || (socket._mpSaveBucket = { tokens: cap, last: Date.now() });
		const now = Date.now();
		// Refill continuously at `cap` bytes/s, capped at a full bucket.
		b.tokens = Math.min(cap, b.tokens + (now - b.last) / 1000 * cap);
		b.last = now;
		if (b.tokens < bytes) return false;
		b.tokens -= bytes;
		return true;
	}
	socket.on('saveChunk', function (data) {
		if (dropIfNotAuthed('saveChunk')) return;
		if (!data || typeof data !== 'object') return;
		// ---- validate shape ----
		const slot = String(data.slot);
		if (!isValidSlotKey(slot)) return;
		const total = data.total;
		const seq = data.seq;
		const gen = data.gen;
		if (!Number.isInteger(total) || total < 1 || total > 256) return;
		if (!Number.isInteger(seq) || seq < 0 || seq >= total) return;
		if (typeof data.part !== 'string' || data.part.length > 65536) return;
		if (!Number.isInteger(gen) || gen < 0) return;
		const reason = (typeof data.reason === 'string' && data.reason.length <= 16) ? data.reason : 'other';
		const now = Date.now();
		// 30s staleness sweep: a stream that stopped mid-way (or was aborted) must not
		// accidentally complete later against a fresh one.
		if (socket._mpSaveStream && now - socket._mpSaveStream.lastAt > 30000) socket._mpSaveStream = null;
		// ---- token bucket (≤config.saveUploadKbS kb/s) ----
		if (!saveBucketConsume(data.part.length)) {
			// Over the cap: discard the in-flight stream. The client re-sends the whole
			// save on its next trigger — tell it so it can log/retry.
			socket._mpSaveStream = null;
			socket.emit('saveFailed', { slot, reason: 'rate' });
			return;
		}
		// ---- generation + assembly ----
		const cur = socket._mpSaveStream;
		if (cur && gen < cur.gen) return; // stale (aborted) upload — drop silently
		if (!cur || gen > cur.gen || cur.slot !== slot || cur.total !== total) {
			socket._mpSaveStream = { gen, slot, total, parts: [], reason, lastAt: now };
		}
		const stream = socket._mpSaveStream;
		stream.reason = reason;
		stream.lastAt = now;
		// Order validation: seq must equal the parts count received so far.
		if (seq !== stream.parts.length) {
			// Out-of-order/corrupt stream — discard; the client re-uploads on its next
			// trigger (a save is never persisted partially).
			socket._mpSaveStream = null;
			socket.emit('saveFailed', { slot, reason: 'corrupt' });
			return;
		}
		stream.parts.push(data.part);
		if (stream.parts.length === stream.total) {
			const payload = stream.parts.join('');
			socket._mpSaveStream = null;
			// ---- area-change anti-spam ----
			// A player who switched maps 5+ times in the last 3s is suppressed until 5s
			// after the LAST switch. Non-area reasons bypass this entirely.
			if (stream.reason === 'area') {
				const times = socket._mpChangeTimes || [];
				const cutoff = now - 3000;
				while (times.length && times[0] < cutoff) times.shift();
				const stormActive = times.length >= 5;
				const until = socket._mpSaveSuppressUntil || 0;
				if (stormActive || now < until) {
					// Set to LAST SWITCH + 5s: while the storm is active the last switch
					// keeps sliding forward (suppression continues); after it ends the
					// window lapses naturally 5s after the final switch.
					socket._mpSaveSuppressUntil = (socket._mpLastChangeMapAt || now) + 5000;
					socket.emit('saveFailed', { slot: stream.slot, reason: 'suppressed' });
					return;
				}
			}
			persistence.saveGame(username, stream.slot, sanitizeSaveParty(payload));
			socket.emit('saveSaved', { slot: stream.slot, bytes: payload.length });
		}
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
