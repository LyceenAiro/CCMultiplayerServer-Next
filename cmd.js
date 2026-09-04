// 1.77.x: interactive server console (stdin). Commands:
//   resetmap <玩家名>  — 清空该玩家当前所在地图的持久进度变量并重载地图
//                        （救回被队友任务进度污染的存档，如新矿井#1 无法开战）
//   players            — 列出在线玩家
//   help               — 显示帮助
// Output stays quiet otherwise (the old echo-all-input debug listener is gone).

var readline = require('readline');

function start() {
	try {
		var rl = readline.createInterface({ input: process.stdin, terminal: false });
		var buf = '';
		rl.on('line', function (line) {
			var input = String(line || '').trim();
			if (!input) return;
			var sp = input.split(/\s+/);
			var cmd = sp[0].toLowerCase();
			if (cmd === 'resetmap') {
				var name = sp.slice(1).join(' ').trim();
				if (!name) { console.log('[cmd] 用法: resetmap <玩家名>'); return; }
				var admin = require('./admin');
				admin.sendCommand(name, { kind: 'resetMap' }).then(function (r) {
					console.log('[cmd] resetmap ' + name + ': ' + (r.ok ? 'OK' : '失败') + (r.msg ? ' — ' + r.msg : ''));
				});
				return;
			}
			if (cmd === 'players') {
				var accounts = require('./accounts');
				var db = require('./persistence').db;
				var names = [];
				for (var k in db.accounts) if (accounts.isOnline(k)) names.push(k);
				console.log('[cmd] 在线玩家 (' + names.length + '): ' + (names.join(', ') || '(无)'));
				return;
			}
			if (cmd === 'help' || cmd === '?') {
				console.log('[cmd] 命令: resetmap <玩家名> | players | help');
				return;
			}
			console.log('[cmd] 未知命令 "' + cmd + '"，输入 help 查看用法');
		});
		console.log('[cmd] 交互控制台已就绪（help 查看命令）');
	} catch (e) {
		console.warn('[cmd] 交互控制台不可用:', e && e.message);
	}
}

start();
