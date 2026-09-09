// 1.80.x (admin stats): engine.io-level byte meter for the whole server.
// server.js attach()es it to `io` once at boot; admin.js reads sample() to fill
// the admin sidebar's live traffic row (and its 1-minute-average tooltip).
//
// What it counts: engine.io packet payloads in BOTH directions — every socket.io
// event payload plus ping/pong heartbeats. TCP/TLS/WebSocket framing is not
// visible at this layer, so treat the numbers as close approximations of the
// wire rate, not exact truth.
'use strict';

let upWin = 0;   // server -> clients bytes in the current 1s window (upload)
let downWin = 0; // clients -> server bytes in the current 1s window (download)
let curUp = 0;   // last folded per-second rates (what the sidebar shows)
let curDown = 0;
const ring = []; // last <=60 per-second samples { up, down } for the 1-minute average
const RING_MAX = 60;
let attached = false;

// engine.io wire packet ≈ 1 type char + payload (payload may be absent, e.g. ping)
function packetBytes(packet) {
	const d = packet && packet.data;
	if (d == null) return 1;
	if (typeof d === 'string') return 1 + Buffer.byteLength(d);
	return 1 + (d.length || 0); // Buffer / ArrayBufferView binary attachments
}

function attach(io) {
	if (attached || !io || !io.engine || typeof io.engine.on !== 'function') return;
	attached = true;
	io.engine.on('connection', function (sock) {
		// 'packet' fires for every decoded INBOUND packet; 'packetCreate' for
		// every OUTBOUND packet queued (sendPacket covers pong heartbeats too).
		sock.on('packet', function (p) { downWin += packetBytes(p); });
		sock.on('packetCreate', function (p) { upWin += packetBytes(p); });
	});
	const timer = setInterval(function () {
		curUp = upWin; upWin = 0;
		curDown = downWin; downWin = 0;
		ring.push({ up: curUp, down: curDown });
		if (ring.length > RING_MAX) ring.shift();
	}, 1000);
	if (timer.unref) timer.unref(); // never keep the process alive for stats
}

function sample() {
	let upSum = 0, downSum = 0;
	for (let i = 0; i < ring.length; i++) { upSum += ring[i].up; downSum += ring[i].down; }
	const n = ring.length || 1; // before the first minute, average what we have
	return {
		upBps: curUp,
		downBps: curDown,
		upAvgBps: upSum / n,
		downAvgBps: downSum / n,
	};
}

module.exports = { attach, sample };
