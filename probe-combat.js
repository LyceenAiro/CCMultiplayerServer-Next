// Probe: verify the combat/regroup protocol additions against a LIVE server.
// Run: node probe-combat.js
const { io } = require('socket.io-client');
const URL = 'http://127.0.0.1:1423';

function log(name, msg) { console.log('[' + new Date().toISOString().slice(11, 19) + '] ' + name + ': ' + msg); }

const TRACKED = ['partyUpdate', 'partyMove', 'partyReSync', 'partyInvite', 'partyActionResult',
	'entityState', 'playerState', 'combatHit', 'enemyDamage', 'changeMapResponse', 'onPlayerChangeMap', 'updatePlayerProfile'];

function connect(name) {
	return new Promise((resolve, reject) => {
		const s = io(URL, { transports: ['websocket'], reconnection: false });
		const p = { s, name, events: [] };
		s.on('connect', () => s.emit('handshake', { username: name }));
		s.on('handshakeResponse', (d) => {
			log(name, 'handshake ' + JSON.stringify(d).slice(0, 120));
			if (d.failed) reject(new Error(name + ' handshake failed: ' + d.failed));
			else resolve(p);
		});
		TRACKED.forEach(ev => s.on(ev, (d) => {
			p.events.push({ ev, d });
			log(name, '<- ' + ev + ' ' + (d === undefined ? '(no payload)' : JSON.stringify(d).slice(0, 160)));
		}));
	});
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
let fails = 0;
function check(ok, passMsg, failMsg) { console.log(ok ? 'PASS: ' + passMsg : 'FAIL: ' + failMsg); if (!ok) fails++; }

(async () => {
	const a = await connect('probe1');
	const b = await connect('probe2');
	await sleep(250);

	const MAP = { name: 'bergen-trail.path-1-entrance', marker: null, areaPath: 'bergen-trail.path-1', areaType: 1 };

	// Both enter the same PATH map solo (each in their own solo instance).
	a.s.emit('changeMap', MAP);
	b.s.emit('changeMap', MAP);
	await sleep(300);

	// Party up: probe1 invites, probe2 accepts.
	a.s.emit('partyInvite', { to: 'probe2' });
	await sleep(250);
	const inv = b.events.filter(e => e.ev === 'partyInvite').pop();
	if (!inv) { console.log('FAIL: no partyInvite received'); process.exit(1); }
	b.s.emit('partyAccept', { partyId: inv.d.partyId });
	await sleep(400);

	// CHECK 1: party-up must NOT auto-teleport anymore.
	const autoMoves = a.events.concat(b.events).filter(e => e.ev === 'partyMove');
	check(autoMoves.length === 0, 'no auto-teleport on partyAccept', 'partyMove emitted on accept: ' + JSON.stringify(autoMoves));
	// CHECK 2: partyReSync reaches ALL members (instance-split fix).
	const reA = a.events.filter(e => e.ev === 'partyReSync').length;
	const reB = b.events.filter(e => e.ev === 'partyReSync').length;
	check(reA > 0 && reB > 0, 'partyReSync to all members', 'partyReSync a=' + reA + ' b=' + reB);

	// Re-assert the map (what the client does on partyReSync) -> shared party instance.
	a.s.emit('changeMap', MAP);
	b.s.emit('changeMap', MAP);
	await sleep(300);
	const cmrA = a.events.filter(e => e.ev === 'changeMapResponse').pop();
	const cmrB = b.events.filter(e => e.ev === 'changeMapResponse').pop();
	console.log('  instA=' + (cmrA && cmrA.d.instanceId) + ' hostA=' + (cmrA && cmrA.d.isHost)
		+ ' | instB=' + (cmrB && cmrB.d.instanceId) + ' hostB=' + (cmrB && cmrB.d.isHost));
	check(cmrA && cmrB && cmrA.d.instanceId === cmrB.d.instanceId, 'both in ONE party instance', 'instance mismatch');
	check(cmrA && cmrA.d.isHost && cmrB && !cmrB.d.isHost, 'probe1 host, probe2 member', 'host flags wrong');

	// CHECK 3: entityState relay keeps the cb combat flag, no echo to sender.
	a.events.length = 0; b.events.length = 0;
	a.s.emit('entityState', { map: MAP.name, cb: true, e: [{ i: 4242, mi: 7, t: 'hedgehog', x: 100, y: 200, z: 0, fx: 0, fy: 1, a: 'idle', h: 100, m: 100 }] });
	await sleep(300);
	const es = b.events.filter(e => e.ev === 'entityState').pop();
	check(es && es.d.cb === true && es.d.e && es.d.e[0].i === 4242, 'entityState cb:true relayed to member', 'relay payload: ' + JSON.stringify(es && es.d).slice(0, 140));
	check(a.events.filter(e => e.ev === 'entityState').length === 0, 'no entityState echo to sender', 'sender got an echo');

	// CHECK 4: enemyDamage member -> host with authoritative attacker stamp.
	a.events.length = 0; b.events.length = 0;
	b.s.emit('enemyDamage', { uid: 4242, damage: 77 });
	await sleep(300);
	const ed = a.events.filter(e => e.ev === 'enemyDamage').pop();
	check(ed && ed.d.uid === 4242 && ed.d.damage === 77 && ed.d.attacker === 'probe2', 'enemyDamage relay + attacker stamp', 'got: ' + JSON.stringify(ed && ed.d));

	// CHECK 5: combatHit host -> named player.
	b.events.length = 0;
	a.s.emit('combatHit', { player: 'probe2', damage: 9, element: 0, critical: false });
	await sleep(300);
	const ch = b.events.filter(e => e.ev === 'combatHit').pop();
	check(ch && ch.d.player === 'probe2' && ch.d.damage === 9, 'combatHit relay', 'got: ' + JSON.stringify(ch && ch.d));

	// CHECK 5b: playerState relay keeps the death flag (mirror-despawn sync).
	a.events.length = 0;
	b.s.emit('playerState', { pos: { x: 1, y: 2, z: 0 }, face: { x: 0, y: 1 }, anim: '', dead: 1, hp: 0, maxHp: 100, sp: 1, maxSp: 1 });
	await sleep(300);
	const ps = a.events.filter(e => e.ev === 'playerState').pop();
	check(ps && ps.d.dead === 1 && ps.d.player === 'probe2', 'playerState dead:1 relayed', 'got: ' + JSON.stringify(ps && ps.d).slice(0, 120));

	// CHECK 6: partyRegroup -> partyMove to the REQUESTER only.
	a.events.length = 0; b.events.length = 0;
	b.s.emit('partyRegroup', {});
	await sleep(300);
	const mvB = b.events.filter(e => e.ev === 'partyMove').pop();
	check(mvB && mvB.d.map, 'partyRegroup -> partyMove to requester (map=' + (mvB && mvB.d.map) + ')', 'requester got: ' + JSON.stringify(mvB && mvB.d));
	check(a.events.filter(e => e.ev === 'partyMove').length === 0, 'leader NOT pulled by regroup', 'leader got partyMove');

	// CHECK 7: partyRegroup with an explicit target (leader teleporting to a member).
	a.events.length = 0; b.events.length = 0;
	a.s.emit('partyRegroup', { target: 'probe2' });
	await sleep(300);
	const mvA = a.events.filter(e => e.ev === 'partyMove').pop();
	check(mvA && mvA.d.leader === 'probe2' && mvA.d.map, 'leader can regroup to a named member', 'leader got: ' + JSON.stringify(mvA && mvA.d));
	check(b.events.filter(e => e.ev === 'partyMove').length === 0, 'target NOT pulled either', 'member got partyMove');

	// CHECK 8: profile upload is sanitized before cache + relay (no raw blob forwarding).
	a.events.length = 0; b.events.length = 0;
	b.s.emit('updatePlayerProfile', {
		level: 42, hp: 500, attack: 99, defense: 50, focus: 60, currentHp: 500, currentSp: 80, maxSp: 80,
		equip: { head: 111, rightArm: 222 },
		evil: 'payload', __proto__: { polluted: true }, hp: 1e12
	});
	await sleep(300);
	const prof = a.events.filter(e => e.ev === 'updatePlayerProfile').pop();
	const pp = prof && prof.d && prof.d.profile;
	check(pp && pp.level === 42 && pp.evil === undefined && pp.hp <= 1e7, 'profile sanitized on relay', 'got: ' + JSON.stringify(prof && prof.d).slice(0, 160));
	check(({}).polluted !== true, 'no prototype pollution from profile upload', 'Object.prototype was polluted');

	// CHECK 9: leader kicks the member (2-person party -> disbands, BOTH get partyUpdate null).
	a.events.length = 0; b.events.length = 0;
	a.s.emit('partyKick', { target: 'probe2' });
	await sleep(300);
	const puA = a.events.filter(e => e.ev === 'partyUpdate');
	const puB = b.events.filter(e => e.ev === 'partyUpdate');
	check(puB.length > 0 && puB[puB.length - 1].d === null, 'kicked member gets partyUpdate null', 'probe2 got: ' + JSON.stringify(puB.map(e => e.d)));
	check(puA.length > 0 && puA[puA.length - 1].d === null, 'kicker told party disbanded', 'probe1 got: ' + JSON.stringify(puA.map(e => e.d)));
	// And a regroup with no party must NOT produce a partyMove.
	b.events.length = 0;
	b.s.emit('partyRegroup', {});
	await sleep(250);
	check(b.events.filter(e => e.ev === 'partyMove').length === 0, 'no regroup after disband', 'probe2 got partyMove');
	// Non-leader kick is ignored: probe2 tries to kick probe1 (no party anymore anyway).
	a.events.length = 0;
	b.s.emit('partyKick', { target: 'probe1' });
	await sleep(250);
	check(a.events.filter(e => e.ev === 'partyUpdate').length === 0, 'kick without party/leader role is a no-op', 'probe1 got partyUpdate');

	a.s.disconnect(); b.s.disconnect();
	await sleep(200);
	console.log(fails === 0 ? '\nALL CHECKS PASSED' : '\n' + fails + ' CHECK(S) FAILED');
	process.exit(fails === 0 ? 0 : 1);
})().catch(e => { console.error(e); process.exit(1); });
