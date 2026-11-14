#!/usr/bin/env node
// Packs the whole game into one file: `node tools/bundle.js` writes dist/saltline.js.
// Whoever hosts then needs only that file and Node: `node saltline.js [port]`.
// The bundle carries every runtime file; on start it unpacks them into a temp folder and runs server.js there.
'use strict';
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const crypto = require('crypto');

const ROOT = path.join(__dirname, '..');
const FILES = [
  'server.js', 'original.html', 'i18n-zh.js', 'mp-strings.js', 'multiplayer.js', 'multiplayer.css',
  'operators.js', 'operator-rig.js', 'spawn-points.js',
  'operators/three-gltf.js', 'operators/scout.glb', 'operators/diver.glb', 'operators/bulwark.glb',
  'operators/scout.png', 'operators/diver.png', 'operators/bulwark.png',
  'LICENSE', 'operators/SOURCES.md', 'operators/THREE-LICENSE.txt',
];

const hash = crypto.createHash('sha256');
const entries = FILES.map((name) => {
  const raw = fs.readFileSync(path.join(ROOT, name));
  hash.update(name).update(raw);
  const packed = /\.(glb|png)$/.test(name) ? null : zlib.gzipSync(raw, { level: 9 }); // images and models are already compressed
  return `  [${JSON.stringify(name)}, ${packed ? 1 : 0}, "${(packed || raw).toString('base64')}"],`;
});
const id = hash.digest('hex').slice(0, 12);

const out = `#!/usr/bin/env node
// Saltline LAN multiplayer, single-file build ${id}.   Run:  node saltline.js [port]
// Source, licences and notices: https://github.com/henryjing96/saltline-multiplayer
// Multiplayer code: MIT. Operator models: built from CC0 / CC BY 4.0 / MIT assets (see operators/SOURCES.md, unpacked next to the game).
// original.html (the single-player game Saltline) is not the work of this project and is included unmodified.
'use strict';
const fs = require('fs'), path = require('path'), os = require('os'), zlib = require('zlib');
const dir = path.join(os.tmpdir(), 'saltline-${id}');
const FILES = [
${entries.join('\n')}
];
for (const [name, gz, data] of FILES) {
  const file = path.join(dir, name);
  const buf = gz ? zlib.gunzipSync(Buffer.from(data, 'base64')) : Buffer.from(data, 'base64');
  if (fs.existsSync(file) && fs.statSync(file).size === buf.length) continue;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, buf);
}
require(path.join(dir, 'server.js'));
`;

const dist = path.join(ROOT, 'dist');
fs.mkdirSync(dist, { recursive: true });
fs.writeFileSync(path.join(dist, 'saltline.js'), out);
console.log(`dist/saltline.js  ${(out.length / 1048576).toFixed(1)} MB  (build ${id}, ${FILES.length} files)`);
