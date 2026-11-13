#!/usr/bin/env node
// Saltline LAN server (co-op and versus rooms). No dependencies: `node server.js [port]`
// - serves original.html with a few small patches + multiplayer.js
// - relays WebSocket messages between players on the same network
'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const operators = require('./operators');
const ZH = require('./i18n-zh');

const PORT = +(process.argv[2] || process.env.PORT || 8080);
const MAX_PLAYERS = 8;
const DIR = __dirname;

// ---------------------------------------------------------------- game patching
// The game is a minified bundle; these are the only places it is touched.
// Each anchor must match exactly once, otherwise the server refuses to start.
const PATCHES = [
  { // expose start / cut-relay / extract on the game object
    find: 'debugCut(){',
    put: 'netStart(P){U(P||{})},netCut(P){P&&!P.cut&&me(P)},netExtract(){(_.state==="playing"||_.state==="paused")&&ee()},' +
      // back to the title screen (versus returns everyone to the lobby after a round)
      'netTitle(){_.state!=="title"&&(r.setGameplay&&r.setGameplay(!1),r.exitLock(),o.setPrompt&&o.setPrompt(null),o.clearRadio&&o.clearRadio(),o.show(!1),' +
      'a(i.enemies,"clear"),a(i.fx,"clear"),a(i.weapon,"setVisible",!1),a(i.audio,"setPaused",!1),a(i.audio,"setIntensity",.15),' +
      'n.enabled=!1,e.saturation=t,E.t=0,l.locationCard(!1),l.show("title"),M("title"))},debugCut(){',
  },
  { // enemy bolts can hit any player, not just the local one
    find: 'if(D&&D.alive!==!1&&(oM.copy(j.pos).addScaledVector(j.dir,K),cM.set(D.pos.x,D.pos.y+.35,D.pos.z),uM.set(D.pos.x,D.pos.y+(D.crouching?1:1.5),D.pos.z),HC(j.pos,oM,cM,uM)<.36*.36&&(ie=!0)),ie){',
    put: 'for(let T1 of(i.net&&i.net.boltTargets&&i.net.boltTargets()||[D]))if(T1&&T1.alive!==!1&&(oM.copy(j.pos).addScaledVector(j.dir,K),cM.set(T1.pos.x,T1.pos.y+.35,T1.pos.z),uM.set(T1.pos.x,T1.pos.y+(T1.crouching?1:1.5),T1.pos.z),HC(j.pos,oM,cM,uM)<.36*.36)){ie=!0;D=T1;break}if(ie){',
  },
  { // per-frame network hook
    find: 'u("input",p);let d=!1;',
    put: 'u("input",p);if(t.net&&t.net.frame)try{t.net.frame(p)}catch(v){u.err.net||(u.err.net=1,console.error("[loop] net.frame threw: "+(v&&v.stack||v)))}let d=!1;',
  },
  { // a paused player must not freeze the shared world
    find: 'd=t.game.update(p)!==!1&&t.game.state!=="title"&&t.game.state!=="paused"',
    put: 'd=(t.game.update(p)!==!1&&t.game.state!=="title"&&t.game.state!=="paused")||!!(t.net&&t.net.live&&t.game.state==="paused")',
  },
  {
    find: 't.game.state!=="paused"&&(u("fx",p)',
    put: '(t.game.state!=="paused"||t.net&&t.net.live)&&(u("fx",p)',
  },
  // F aims (trackpads cannot hold the right button, and Edge's mouse gestures swallow it); V keeps melee
  { find: 'KeyF:"melee"', put: 'KeyF:"ads"' },
  { find: '<span><kbd>RMB</kbd> Aim</span>', put: '<span><kbd>RMB</kbd><kbd>F</kbd> Aim</span>' },
  { find: '<div><dt>Aim</dt><dd>Right button</dd></div>', put: '<div><dt>Aim</dt><dd>Right button, or tap <kbd>F</kbd></dd></div>' },
  { find: '<div><dt>Melee</dt><dd><kbd>F</kbd></dd></div>', put: '<div><dt>Melee</dt><dd><kbd>V</kbd></dd></div>' },
];

function buildPage() {
  let html = fs.readFileSync(path.join(DIR, 'original.html'), 'utf8');
  for (const p of PATCHES) {
    const n = html.split(p.find).length - 1;
    if (n !== 1) throw new Error(`patch anchor matched ${n} times (expected 1): ${p.find.slice(0, 60)}...`);
    html = html.replace(p.find, () => p.put);
  }
  const tail = html.lastIndexOf('</script>');
  if (tail < 0) throw new Error('no </script> in original.html');
  const at = tail + '</script>'.length;
  const scripts = ['operators.js', 'operators/three-gltf.js', 'operator-rig.js', 'spawn-points.js', 'mp-strings.js', 'multiplayer.js']
    .map(file => '<script src="/' + file + '"></script>').join('\n');
  return (html.slice(0, at) + '\n' + scripts + html.slice(at))
    .replace('<head>', '<head><link rel="stylesheet" href="/multiplayer.css">');
}

// The Chinese page is the patched page with every piece of the game's own text replaced.
function translate(html) {
  for (const [find, put, count = 1] of ZH) {
    const n = html.split(find).length - 1;
    if (n !== count) throw new Error(`translation matched ${n} times (expected ${count}): ${find.slice(0, 70)}`);
    html = html.split(find).join(put);
  }
  return html;
}

const pages = {};
try {
  const en = buildPage();
  pages.en = Buffer.from(en);
  pages.zh = Buffer.from(translate(en));
} catch (e) {
  console.error('Could not prepare the game page: ' + e.message);
  process.exit(1);
}

function lanAddresses() {
  const out = [];
  for (const [name, list] of Object.entries(os.networkInterfaces())) {
    if (/^(bridge|vmnet|vmenet|utun|docker|veth|vboxnet|br-|llw|awdl)/i.test(name)) continue; // virtual adapters
    for (const a of list || []) if (a.family === 'IPv4' && !a.internal && !a.address.endsWith('.0')) out.push(a.address);
  }
  return out;
}

// ---------------------------------------------------------------- http
const assets = new Map([
  ['/operators.js', 'text/javascript; charset=utf-8'],
  ['/spawn-points.js', 'text/javascript; charset=utf-8'],
  ['/multiplayer.js', 'text/javascript; charset=utf-8'],
  ['/mp-strings.js', 'text/javascript; charset=utf-8'],
  ['/multiplayer.css', 'text/css; charset=utf-8'],
  ['/operators/three-gltf.js', 'text/javascript; charset=utf-8'],
  ['/operator-rig.js', 'text/javascript; charset=utf-8'],
  ...operators.catalog.map(model => ['/operators/' + model.id + '.png', 'image/png']),
  ...operators.catalog.map(model => ['/operators/' + model.id + '.glb', 'model/gltf-binary']),
]);
// ?lang= wins, then the choice remembered in the cookie; Chinese unless English was chosen
function pageLanguage(req) {
  const asked = /[?&]lang=(zh|en)\b/.exec(req.url) || /(?:^|;\s*)saltline\.lang=(zh|en)\b/.exec(req.headers.cookie || '');
  return asked ? asked[1] : 'zh';
}
const server = http.createServer((req, res) => {
  const url = req.url.split('?')[0];
  if (url === '/' || url === '/index.html') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', Vary: 'Cookie' });
    res.end(pages[pageLanguage(req)]);
  } else if (assets.has(url)) {
    fs.readFile(path.join(DIR, url.slice(1)), (err, buf) => {
      if (err) { res.writeHead(404); res.end('not found'); return; }
      res.writeHead(200, { 'Content-Type': assets.get(url), 'Cache-Control': 'no-cache' });
      res.end(buf);
    });
  } else {
    res.writeHead(404); res.end('not found');
  }
});

// ---------------------------------------------------------------- websocket (RFC 6455, text frames)
const clients = new Map(); // id -> client
const MODES = ['coop', 'versus']; // two rooms that never see each other
const hosts = { coop: 0, versus: 0 };
const roomOf = (mode) => [...clients.values()].filter((c) => c.mode === mode);
let nextId = 1;

function frame(str, opcode = 1) {
  const data = Buffer.from(str);
  const n = data.length;
  let head;
  if (n < 126) head = Buffer.from([0x80 | opcode, n]);
  else if (n < 65536) { head = Buffer.alloc(4); head[0] = 0x80 | opcode; head[1] = 126; head.writeUInt16BE(n, 2); }
  else { head = Buffer.alloc(10); head[0] = 0x80 | opcode; head[1] = 127; head.writeBigUInt64BE(BigInt(n), 2); }
  return Buffer.concat([head, data]);
}
function sendRaw(c, buf) {
  if (c.socket.destroyed) return;
  if (c.socket.writableLength > 4e6) return; // hopelessly behind: drop rather than balloon
  c.socket.write(buf);
}
const send = (c, obj) => sendRaw(c, frame(JSON.stringify(obj)));
function broadcast(obj, from, includeSender) {
  const buf = frame(JSON.stringify(obj));
  for (const c of clients.values()) if (c.mode === from.mode && (includeSender || c !== from)) sendRaw(c, buf);
}

function drop(c) {
  if (!clients.has(c.id)) return;
  clients.delete(c.id);
  c.socket.destroy();
  const room = roomOf(c.mode);
  console.log(`- ${c.name} (#${c.id}) left ${c.mode} · ${room.length} in room`);
  broadcast({ t: 'leave', id: c.id }, c);
  if (c.id === hosts[c.mode]) {
    hosts[c.mode] = room.length ? Math.min(...room.map((q) => q.id)) : 0;
    if (hosts[c.mode]) { broadcast({ t: 'host', id: hosts[c.mode] }, c); console.log(`  ${c.mode} host is now #${hosts[c.mode]}`); }
  }
}

function onMessage(c, text) {
  let m;
  try { m = JSON.parse(text); } catch { return; }
  if (!m || typeof m !== 'object' || typeof m.t !== 'string') return;
  if (m.t === 'name') {
    c.name = operators.displayName(m.name) || c.name;
    if (m.model != null) c.model = operators.modelId(m.model);
    broadcast({ t: 'name', id: c.id, name: c.name, model: c.model }, c, true);
    return;
  }
  if (['welcome', 'join', 'leave', 'host'].includes(m.t)) return; // server-only types
  m.f = c.id;
  if (m.to != null) {
    const dst = clients.get(+m.to);
    if (dst && dst !== c && dst.mode === c.mode) send(dst, m);
  } else broadcast(m, c);
}

function onData(c, chunk) {
  c.buf = c.buf.length ? Buffer.concat([c.buf, chunk]) : chunk;
  for (;;) {
    const b = c.buf;
    if (b.length < 2) return;
    const fin = b[0] & 0x80, op = b[0] & 0x0f, masked = b[1] & 0x80;
    let len = b[1] & 0x7f, off = 2;
    if (len === 126) { if (b.length < 4) return; len = b.readUInt16BE(2); off = 4; }
    else if (len === 127) { if (b.length < 10) return; len = Number(b.readBigUInt64BE(2)); off = 10; }
    if (!masked || len > 1 << 20) return drop(c);
    if (b.length < off + 4 + len) return;
    const mask = b.subarray(off, off + 4);
    const payload = Buffer.allocUnsafe(len);
    for (let i = 0; i < len; i++) payload[i] = b[off + 4 + i] ^ mask[i & 3];
    c.buf = b.subarray(off + 4 + len);
    if (op === 8) return drop(c);
    if (op === 9) { sendRaw(c, frame(payload, 10)); continue; }
    if (op === 10) { c.alive = true; continue; }
    if (op === 1 || op === 0) {
      c.parts.push(payload);
      c.partsLen += len;
      if (c.partsLen > 1 << 20) return drop(c); // a message split into fragments gets the same 1 MB cap
      if (fin) {
        const text = Buffer.concat(c.parts).toString('utf8');
        c.parts = [];
        c.partsLen = 0;
        c.alive = true;
        onMessage(c, text);
      }
    }
  }
}

server.on('upgrade', (req, socket) => {
  const key = req.headers['sec-websocket-key'];
  if (req.url.split('?')[0] !== '/ws' || !key) { socket.destroy(); return; }
  // a browser page may only connect to the server it was loaded from, so another website cannot join the room
  const origin = req.headers.origin;
  if (origin && origin.replace(/^https?:\/\//, '') !== req.headers.host) { socket.end('HTTP/1.1 403 Forbidden\r\n\r\n'); return; }
  const params = new URLSearchParams(req.url.split('?')[1]);
  const mode = MODES.includes(params.get('mode')) ? params.get('mode') : 'coop';
  const room = roomOf(mode);
  if (room.length >= MAX_PLAYERS) { socket.end('HTTP/1.1 503 Server Full\r\n\r\n'); return; }
  const accept = crypto.createHash('sha1').update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
  socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ' + accept + '\r\n\r\n');
  socket.setNoDelay(true);
  const taken = new Set(room.map(player => player.spawnSlot));
  const freeSlots = Array.from({ length: MAX_PLAYERS }, (_, slot) => slot).filter(slot => !taken.has(slot));
  const spawnSlot = freeSlots[crypto.randomInt(freeSlots.length)];
  const id = nextId++;
  const c = { id, name: operators.displayName(params.get('name')) || (params.get('lang') === 'zh' ? '队员 ' : 'Breacher ') + id,
    model: operators.modelId(params.get('model')), mode, spawnSlot, socket, buf: Buffer.alloc(0), parts: [], partsLen: 0, alive: true };
  if (!hosts[mode]) hosts[mode] = c.id;
  send(c, {
    t: 'welcome', id: c.id, host: hosts[mode], mode, name: c.name, model: c.model, spawnSlot, spawnSlots: MAX_PLAYERS,
    peers: room.map(p => ({ id: p.id, name: p.name, model: p.model })),
    urls: lanAddresses().map((a) => `http://${a}:${PORT}`),
  });
  clients.set(c.id, c);
  broadcast({ t: 'join', id: c.id, name: c.name, model: c.model }, c);
  console.log(`+ ${c.name} (#${c.id}) joined ${mode} from ${socket.remoteAddress} · ${room.length + 1} in room`);
  socket.on('data', (d) => { try { onData(c, d); } catch (e) { console.error(e); drop(c); } });
  socket.on('close', () => drop(c));
  socket.on('error', () => drop(c));
});

setInterval(() => {
  for (const c of [...clients.values()]) {
    if (!c.alive) { drop(c); continue; }
    c.alive = false;
    sendRaw(c, frame('', 9));
  }
}, 10000);

server.on('error', (e) => {
  console.error(e.code === 'EADDRINUSE' ? `Port ${PORT} is already in use. Try: node server.js ${PORT + 1}` : e);
  process.exit(1);
});
server.listen(PORT, '0.0.0.0', () => {
  console.log('Saltline LAN server running (co-op and versus rooms).\n');
  console.log(`  This computer:   http://localhost:${PORT}`);
  for (const a of lanAddresses()) console.log(`  Other devices:   http://${a}:${PORT}`);
  console.log('\nThe first player in each room is its host. Ctrl+C to stop.\n');
});
