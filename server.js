var app = require('express')();
var http = require('http').Server(app);
var io = require('socket.io')(http);
require('./cmd.js');
var protocol = require('./protocol.js');
var config = require('./config');

var fs = require('fs');
var path = require('path');

// A malformed/buggy client message must never take the whole server down. Log
// and keep going instead of letting an uncaughtException kill the process.
process.on('uncaughtException', function (err) {
	console.error('[server] uncaughtException (kept alive):', err && err.stack ? err.stack : err);
});
process.on('unhandledRejection', function (err) {
	console.error('[server] unhandledRejection (kept alive):', err && err.stack ? err.stack : err);
});


/*app.get(/^\/data\/maps/, function(req, res){
	if(/\.\./g.test(req.url))
		return res.status(404).end();
	
	if(!fs.existsSync('./game' + req.url))
		return res.status(404).end();
	
	if(fs.lstatSync('./game' + req.url).isDirectory())
		return res.status(404).end();
	
	var raw = fs.readFileSync('./game' + req.url);
	var data = JSON.parse(raw);
	
	data.entities = data.entities.filter(function(entity){
		return entity.type !== "Enemy"
	});
	
	res.set({
		'Access-Control-Allow-Origin': '*',
		'Content-Type': 'application/json'
		});
	res.send(JSON.stringify(data));
})*/

var gameFolder = path.resolve('./game');

app.get(['^/data/*', '^/media/*'], function(req, res){
	var file = path.resolve('./game' + req.url);

	if(file.indexOf(gameFolder) !== 0)
		return res.status(404).end();

	if(!fs.existsSync(file))
		return res.status(404).end();
	
	if(fs.lstatSync(file).isDirectory())
		return res.status(404).end();
	
	res.set({'Access-Control-Allow-Origin': '*'});
	res.sendFile(file);
});

// ROUND 79 (server-list version): the client's server browser probes this endpoint
// to show each server card's mod version (the SAME config.version the login
// handshake reports). CORS-open, tiny, no auth - the version is public information.
app.get('/version', function(req, res){
	res.set({'Access-Control-Allow-Origin': '*'});
	res.json({ version: config.version });
});

app.get(/^(?!(\/media\/|\/data\/))/g, function(req, res){
	res.status(404).end();
});

io.on('connection', function(socket){ protocol.handleConnection(socket) });

// Port resolution order: process.env.PORT (one-off override) > config.json `port`
// > the built-in default (15151, set in config.js). config.port is always a valid
// clamped number, so this never falls back to the old 1423.
const port = process.env.PORT || config.port;

http.listen(port, function(){
	// Round 17: log the server version at boot so a version mismatch with a
	// connecting client is obvious from the console before the handshake gate.
	console.log('[server] multiplayer server v' + config.version + ' listening on *:' + port);
});
