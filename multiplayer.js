// Saltline LAN client: a co-op room and a versus room.
// Loaded after the game bundle by server.js. Co-op is host-authoritative: the host simulates the machines
// and the mission flow; every player simulates their own movement and shooting. Versus is a free-for-all
// without machines: the shooter decides hits on other players, the host keeps the round clock and score. Opened without the server
// (file://) or with ?solo=1 the game stays single-player.
(() => {
  'use strict';

  // F aims (server.js maps KeyF to the game's aim action). A short tap latches the aim until the next
  // tap; holding it aims only while held. The latch works by keeping the key-up from the game.
  const aim = { latched: false, closing: false, downAt: 0, hooked: false };
  const aimClear = () => { aim.latched = aim.closing = false; };
  function aimRelease() { // let go of a latched aim
    if (!aim.latched) return;
    aimClear();
    dispatchEvent(new KeyboardEvent('keyup', { code: 'KeyF' }));
  }
  const typing = (ev) => ev.target && /^(INPUT|SELECT|TEXTAREA)$/.test(ev.target.tagName);
  addEventListener('keydown', (ev) => {
    if (ev.code !== 'KeyF' || ev.repeat || typing(ev)) return;
    const G = window.__G;
    if (!G || !G.game || G.game.state !== 'playing') return;
    if (!aim.hooked) { aim.hooked = true; G.events.on('game:state', (e) => { if (e && e.state !== 'playing') aimClear(); }); } // the game drops held keys itself
    if (aim.latched) aim.closing = true; else aim.downAt = performance.now();
  }, true);
  addEventListener('keyup', (ev) => {
    if (ev.code !== 'KeyF' || !ev.isTrusted) return;
    if (aim.closing) { aimClear(); return; }
    const G = window.__G;
    if (G && G.game && G.game.state === 'playing' && performance.now() - aim.downAt < 250) { aim.latched = true; ev.stopImmediatePropagation(); }
  }, true);
  addEventListener('blur', aimClear);

  if (!/^https?:$/.test(location.protocol) || /[?&]solo=1/.test(location.search)) return;

  const boot = () => {
    const G = window.__G;
    if (window.__fatal) return;
    if (G && G.game && G.game.netStart && G.enemies && G.enemies.debug && G.hud && G.player && window.__ready) {
      if (!G.showcase && !G.bench) init(G);
    } else setTimeout(boot, 100);
  };
  boot();

  function init(G) {
    const T = G.THREE;
    const operators = window.SaltlineOperators;
    const { t, lang, setLanguage } = window.SaltlineText;
    const V3 = T.Vector3;
    const P = G.player; // the real local player; G.player is swapped temporarily while machines think
    const ctx = G.enemies.debug.ctx;
    const pool = [...G.enemies.debug.gulls, ...G.enemies.debug.hounds];
    const MODES = ['patrol', 'investigate', 'search', 'engage'];
    const ES = ['move', 'aim', 'cool', 'tele', 'burst', 'wind', 'lunge', 'recover'];
    const LUNGE = new Set(['wind', 'lunge', 'recover']);
    const COLORS = [0xffb347, 0x5ec8e0, 0x9be36a, 0xe07ac8, 0xe0d25e, 0x8f9cff, 0xff7a5e, 0x6ee0b4];
    const RESPAWN_SECONDS = 8;
    const VS_ROUND_SECONDS = 120, VS_BREAK_SECONDS = 8, VS_RESPAWN_SECONDS = 3, VS_COUNT_SECONDS = 3;

    const peers = new Map();
    const byNid = new Map();
    let ws = null, connected = false, nid = 0, killer = null, applying = false, allowSpawn = false;
    let status = '', urls = [], myName = '', preferredName = '', myModel = operators.modelId();
    let entered = false, pickSpawn = null, spawnCheck = false, myReady = false, drop = null;
    let mode = /[?&]mode=versus\b/.test(location.search) ? 'versus' : /[?&]mode=coop\b/.test(location.search) ? 'coop' : '';
    try {
      if (!mode) mode = localStorage.getItem('saltline.mode') === 'versus' ? 'versus' : 'coop';
      preferredName = operators.displayName(localStorage.getItem('saltline.name'));
      myModel = operators.modelId(localStorage.getItem('saltline.model'));
    } catch {}

    const net = {
      id: 0, hostId: 0, down: false, downT: 0, peers,
      get isHost() { return net.id !== 0 && net.id === net.hostId; },
      get live() { return mp(); },
      frame, boltTargets,
    };
    G.net = net;

    const vs = () => mode === 'versus';
    const mp = () => connected && (peers.size > 0 || vs());
    const st = () => G.game.state;
    const inGame = (s) => s === 'intro' || s === 'playing' || s === 'paused';
    const inPlay = (s) => s === 'playing' || s === 'paused';
    const r2 = (v) => Math.round(v * 100) / 100;
    const arr = (v) => [r2(v.x), r2(v.y), r2(v.z)];
    const vec = (a) => new V3(a[0], a[1], a[2]);
    const angDiff = (a, b) => { let d = (a - b) % (Math.PI * 2); return d > Math.PI ? d - Math.PI * 2 : d < -Math.PI ? d + Math.PI * 2 : d; };
    const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
    const call = (o, f, ...a) => { try { if (o && typeof o[f] === 'function') return o[f](...a); } catch (e) { console.error('[net] ' + f, e); } };
    const send = (m) => { if (connected && ws.readyState === 1) ws.send(JSON.stringify(m)); };

    // ------------------------------------------------------------ stand-ins for "the player" seen by machines
    const localNoDmg = Object.create(P); // live view of the local player that machines cannot hurt
    localNoDmg.damage = () => {};
    const nobody = Object.create(P);
    nobody.alive = false;
    nobody.damage = () => {};

    function withPlayer(p, fn) {
      const keep = G.player;
      G.player = p;
      try { return fn(); } finally { G.player = keep; }
    }

    // ------------------------------------------------------------ peers + avatars
    function setPeerModel(peer, requested) {
      const model = operators.modelId(requested);
      if (peer.model === model && peer.av) return;
      const avatar = operators.makeModel(T, model, COLORS[(peer.id - 1) % COLORS.length]);
      avatar.root.visible = false;
      peer.av?.dispose();
      G.scene.add(avatar.root);
      peer.model = model;
      peer.av = avatar;
      // The lofted figure stands in until the skinned operator has loaded (or for good if it cannot).
      const rigs = window.SaltlineRigs;
      if (!rigs) return;
      rigs.load(T, model).then((makeRig) => {
        if (peers.get(peer.id) !== peer || peer.model !== model || peer.av !== avatar) return;
        const rig = makeRig();
        rig.root.visible = false;
        rig.lie = avatar.lie; rig.kick = avatar.kick;
        avatar.dispose();
        G.scene.add(rig.root);
        peer.av = rig;
      }).catch((e) => console.warn('[net] operator model ' + model + ' unavailable', e));
    }

    function addPeer(id, name, model) {
      if (peers.has(id) || id === net.id) return peers.get(id);
      const pos = new V3(0, -50, 0);
      const p = {
        id, name: name || t('autoName', id), pos, tpos: pos.clone(), vel: new V3(), yaw: 0, pitch: 0, ready: false,
        crouch: false, sprint: false, down: false, hp: 100, state: 'title', t: 0, fresh: true, shots: 0, heard: 0,
        label: document.createElement('div'),
      };
      p.proxy = {
        pos, eye: new V3(), vel: p.vel, alive: false, crouching: false, speed: 0, health: 100, maxHealth: 100,
        damage(a, from) { if (net.isHost && a > 0) send({ t: 'dmg', to: id, a: r2(a), p: from ? arr(from) : null }); },
        addShake() {}, addRecoil() {}, heal() {},
      };
      p.label.className = 'mp-label';
      setPeerModel(p, model);
      labels.appendChild(p.label);
      peers.set(id, p);
      return p;
    }
    function removePeer(id) {
      const p = peers.get(id);
      if (!p) return;
      p.av.dispose();
      p.label.remove();
      peers.delete(id);
    }

    const tmp = new V3(), tmp2 = new V3();
    function updatePeers(dt) {
      const now = performance.now();
      const cam = G.camera;
      const showLabels = st() !== 'title';
      for (const p of peers.values()) {
        const age = Math.min(0.25, (now - p.t) / 1000);
        tmp.copy(p.tpos).addScaledVector(p.vel, age);
        if (p.fresh || p.pos.distanceToSquared(tmp) > 25) { p.pos.copy(tmp); p.fresh = false; } else p.pos.lerp(tmp, 1 - Math.exp(-14 * dt));
        const active = inPlay(p.state) && !p.down && now - p.t < 3000;
        const px = p.proxy;
        px.alive = active;
        px.crouching = p.crouch;
        px.eye.set(p.pos.x, p.pos.y + (p.crouch ? 1.0 : 1.6), p.pos.z);
        px.speed = Math.hypot(p.vel.x, p.vel.z);

        const a = p.av;
        const visible = p.state !== 'title' && p.state !== 'intro' && now - p.t < 5000;
        a.root.visible = visible;
        if (visible) {
          a.root.position.copy(p.pos);
          a.root.rotation.y = p.yaw;
        }
        if (visible && a.update) {
          a.kick = Math.max(0, a.kick - dt * 9);
          a.update(dt, { speed: px.speed, pitch: p.pitch, crouch: p.crouch, lying: p.down || p.state === 'dead', sprint: p.sprint, camera: cam });
        } else if (visible) {
          const lying = p.down || p.state === 'dead' ? 1 : 0;
          a.lie += (lying - a.lie) * (1 - Math.exp(-6 * dt));
          const sq = p.crouch && !lying ? 0.68 : 1;
          a.body.scale.y += (sq - a.body.scale.y) * (1 - Math.exp(-12 * dt));
          a.body.rotation.x = a.lie * (Math.PI / 2 - 0.08);
          a.body.position.y = a.lie * 0.16;
          const sp = lying ? 0 : px.speed;
          a.walk += sp * dt * 2.4;
          const sw = Math.sin(a.walk) * 0.65 * Math.min(1, sp / 2.5);
          a.legs[0].rotation.x = sw;
          a.legs[1].rotation.x = -sw;
          a.knees[0].rotation.x = -Math.max(0, sw) * 0.8;
          a.knees[1].rotation.x = -Math.max(0, -sw) * 0.8;
          a.kick = Math.max(0, a.kick - dt * 9);
          a.arms.rotation.x = (lying ? 0 : p.pitch * 0.75) + a.kick * 0.06;
          a.upper.rotation.x = lying ? 0 : p.pitch * 0.25;
        }

        let on = false;
        if (visible && showLabels && (!vs() || (active && aimedAt(p, cam)))) {
          tmp.set(p.pos.x, p.pos.y + (p.crouch ? 1.55 : 2.05) * (1 - a.lie * 0.6), p.pos.z).project(cam);
          if (tmp.z < 1 && Math.abs(tmp.x) < 1.05 && Math.abs(tmp.y) < 1.05) {
            on = true;
            const x = Math.round((tmp.x * 0.5 + 0.5) * innerWidth), y = Math.round((-tmp.y * 0.5 + 0.5) * innerHeight);
            const key = x + ',' + y;
            if (key !== p.lk) { p.lk = key; p.label.style.transform = `translate3d(${x}px,${y}px,0) translate(-50%,-100%)`; }
            const hp = Math.max(0, Math.round(p.hp));
            const text = p.name + '|' + (p.down ? 'd' : hp);
            if (text !== p.lt) {
              p.lt = text;
              p.label.innerHTML = `<b>${esc(p.name)}</b>` + (vs() ? '' : p.down ? `<em>${t('labelDown')}</em>` : `<i><u style="width:${hp}%"></u></i>`);
              p.label.classList.toggle('down', p.down);
            }
          }
        }
        if (on !== p.lon) { p.lon = on; p.label.classList.toggle('on', on); }
      }
    }

    // versus: an opponent's name shows only under the crosshair and in plain sight
    const aimV = new V3(), aimF = new V3(), aimC = new V3();
    function aimedAt(p, cam) {
      cam.getWorldPosition(aimC);
      aimV.set(p.pos.x, p.pos.y + (p.crouch ? 0.8 : 1.2), p.pos.z).sub(aimC);
      const d = aimV.length();
      if (d < 0.5 || d > 70) return false;
      if (aimV.dot(cam.getWorldDirection(aimF)) / d < 0.9975) return false; // about 4 degrees
      aimV.add(aimC);
      return !!G.physics.lineOfSight(aimC, aimV);
    }

    function muzzleOf(p, out) {
      if (p.av.root.visible) return p.av.muzzle.getWorldPosition(out);
      const s = Math.sin(p.yaw), c = Math.cos(p.yaw);
      // avatar faces -Z at yaw 0; gun sits right of centre
      return out.set(p.pos.x - s * 0.75 + c * 0.14, p.pos.y + (p.crouch ? 0.95 : 1.38), p.pos.z - c * 0.75 - s * 0.14);
    }

    // ------------------------------------------------------------ machines: host targeting + client puppets
    function candidates() {
      const out = [];
      if (P.alive && !net.down && inPlay(st())) out.push({ id: net.id, obj: P });
      for (const p of peers.values()) if (p.proxy.alive) out.push({ id: p.id, obj: p.proxy });
      return out;
    }
    function pickTarget(e, dt) {
      const list = candidates();
      e._tgT = (e._tgT || 0) - dt;
      if (e._tgT > 0) {
        const cur = list.find((c) => c.id === e._tg);
        if (cur) return cur.obj;
      }
      e._tgT = 1 + Math.random();
      let best = null, bd = 1e9;
      for (const c of list) {
        const d = Math.hypot(c.obj.pos.x - e.pos.x, c.obj.pos.z - e.pos.z) * (c.id === e._tg ? 0.7 : 1);
        if (d < bd) { bd = d; best = c; }
      }
      e._tg = best ? best.id : null;
      return best ? best.obj : nobody;
    }
    const proxyFor = (id) => (id === net.id ? localNoDmg : (peers.get(id) && peers.get(id).proxy) || nobody);

    function puppet(e, dt, orig) {
      const s = e._ns;
      if (!e.alive || !s) return withPlayer(localNoDmg, () => orig(dt));
      const tgt = proxyFor(s[8]);
      const k = (r) => 1 - Math.exp(-r * dt);
      const age = Math.min(0.3, (performance.now() - e._nsT) / 1000);
      e.mode = MODES[s[6]] || 'patrol';
      e.hp = s[7];
      e.lastKnown.set(s[9], s[10], s[11]);
      e.los = !!s[12];
      e.noSeeT = s[13];
      e.cool = 99; // attacks only ever come from the host
      if (e.type === 'gull') {
        e.flipT = 99;
        if (s[25]) e.flare = Math.min(1, e.flare + dt * 6);
        withPlayer(tgt, () => orig(dt));
        if (!e.alive) return;
        tmp.set(s[2] + s[14] * age, s[3] + s[15] * age, s[4] + s[16] * age).sub(e.pos);
        if (tmp.lengthSq() > 64) e.pos.add(tmp); else e.pos.addScaledVector(tmp, k(5));
        e.vel.lerp(tmp2.set(s[14], s[15], s[16]), k(5));
        e.yaw += angDiff(s[5], e.yaw) * k(5);
      } else {
        e.lungeCd = 99;
        const hes = ES[s[15]] || 'move';
        const hx = s[2] + Math.sin(s[5]) * s[14] * age, hz = s[4] + Math.cos(s[5]) * s[14] * age;
        const follow = () => {
          const lead = s[14] > 0.3 ? 0.8 : 0;
          tmp.set(hx + Math.sin(s[5]) * lead, s[3], hz + Math.cos(s[5]) * lead);
          if (Math.hypot(tmp.x - e.pos.x, tmp.z - e.pos.z) > 0.5) {
            if (!e.hasGoal) e.planT = 0;
            e.goal.copy(tmp);
            e.hasGoal = true;
          }
        };
        if (e.mode === 'engage') {
          if (hes === 'wind' && e._hes !== 'wind') { e.es = 'wind'; e.esT = 0.28; }
          else if (LUNGE.has(e.es)) { /* let the local lunge play out */ }
          else if (hes === 'move') { e.es = 'move'; e.moveT = 0; e.firePlayer.copy(tgt.pos); follow(); }
          else {
            e.es = 'aim'; e.esT = 0; e.noSeeT = 0;
            if (hes === 'tele' || hes === 'burst') e.flare = Math.min(1, e.flare + dt * 7);
          }
        } else if (e.mode === 'patrol') { e.waitT = 5; follow(); }
        e._hes = hes;
        withPlayer(tgt, () => orig(dt));
        if (!e.alive) return;
        const ex = hx - e.pos.x, ez = hz - e.pos.z, d = Math.hypot(ex, ez);
        if (d > 7) { e.pos.x = hx; e.pos.z = hz; } else if (d > 0.05) { e.pos.x += ex * k(2.5); e.pos.z += ez * k(2.5); }
        if (s[14] < 0.3 && e.mode !== 'engage') e.yaw += angDiff(s[5], e.yaw) * k(4);
      }
    }

    for (const e of pool) {
      const update = e._update, damage = e.damage;
      e._origDamage = damage;
      e._update = (dt) => {
        if (!mp()) return update(dt);
        if (!net.isHost) return puppet(e, dt, update);
        if (!e.alive) return update(dt);
        return withPlayer(pickTarget(e, dt), () => update(dt));
      };
      e.damage = (amt, point, dir, part) => {
        if (!mp()) return damage(amt, point, dir, part);
        if (net.isHost) {
          e._ldir = dir || null;
          e._by = killer == null ? net.id : killer;
          return damage(amt, point, dir, part);
        }
        if (e.alive && e._nid) send({ t: 'hit', to: net.hostId, e: e._nid, a: r2(amt), d: dir ? arr(dir) : null, k: part === 'weak' ? 1 : 0 });
        return false;
      };
    }

    const clientOnly = () => mp() && !net.isHost;
    for (const name of ['think', 'provoke', 'rally']) {
      const orig = ctx[name];
      ctx[name] = (...a) => { if (!clientOnly()) return orig(...a); };
    }
    {
      const spawn = G.enemies.spawn, alert = G.enemies.alert, clear = G.enemies.clear, explode = G.combat.explode;
      G.enemies.spawn = (type, pos, opts) => {
        if (vs() || (clientOnly() && !allowSpawn)) return null; // versus has no machines
        const e = spawn(type, pos, opts);
        if (e) { e._ns = null; e._tg = null; e._tgT = 0; e._hes = ''; e._ldir = null; e._by = 0; e._nid = allowSpawn ? 0 : ++nid; if (e._nid) byNid.set(e._nid, e); }
        return e;
      };
      G.enemies.alert = (pos, r) => { if (!clientOnly()) return alert(pos, r); };
      G.enemies.clear = () => { byNid.clear(); return clear(); };
      G.combat.explode = (pos, radius = 5, dmg = 80, from = 'player') => {
        if (!mp()) return explode(pos, radius, dmg, from);
        if (!net.isHost) return;
        killer = 0;
        try { explode(pos, radius, dmg, from); } finally { killer = null; }
        for (const p of peers.values()) {
          if (!p.proxy.alive) continue;
          tmp.set(p.pos.x, p.pos.y + 1, p.pos.z);
          const d = tmp.distanceTo(pos);
          if (d < radius && G.physics.lineOfSight(pos, tmp)) p.proxy.damage(dmg * 0.5 * (1 - d / radius), pos);
        }
      };
    }

    function boltTargets() {
      if (!mp()) return null;
      const out = [net.isHost ? P : localNoDmg];
      for (const p of peers.values()) if (p.proxy.alive) out.push(p.proxy);
      return out;
    }

    // ---- host -> clients: machine state
    function snapshot() {
      const list = [];
      for (const e of G.enemies.list) {
        if (!e.alive) continue;
        if (!e._nid) { e._nid = ++nid; byNid.set(e._nid, e); }
        const base = [e._nid, e.type === 'gull' ? 0 : 1, r2(e.pos.x), r2(e.pos.y), r2(e.pos.z), r2(e.yaw), Math.max(0, MODES.indexOf(e.mode)), Math.round(e.hp),
          e._tg || 0, r2(e.lastKnown.x), r2(e.lastKnown.y), r2(e.lastKnown.z), e.los ? 1 : 0, r2(Math.min(9, e.noSeeT))];
        if (e.type === 'gull')
          base.push(r2(e.vel.x), r2(e.vel.y), r2(e.vel.z), r2(e.orbitA), r2(e.orbitR), e.orbitDir, r2(e.alt), r2(e.home.x), r2(e.home.y), r2(e.home.z), r2(e.patrolR || 0), e.atk === 'idle' ? 0 : 1);
        else base.push(r2(e.speed), Math.max(0, ES.indexOf(e.es)));
        list.push(base);
      }
      const run = G.game.run;
      send({ t: 's', e: list, rc: run.relays.filter((r) => r.cut).map((r) => r.id), n: nid });
    }

    function applySnapshot(m) {
      if (m.n > nid) nid = m.n;
      const s = st();
      if (s === 'title') return;
      const now = performance.now();
      const seen = new Set();
      for (const rec of m.e) {
        const id = rec[0];
        seen.add(id);
        let e = byNid.get(id);
        if (e && (!e.active || e._nid !== id)) { byNid.delete(id); e = null; }
        if (!e) {
          allowSpawn = true;
          try { e = G.enemies.spawn(rec[1] ? 'hound' : 'gull', new V3(rec[2], rec[3], rec[4]), { state: rec[6] ? 'alert' : undefined, yaw: rec[5] }); } finally { allowSpawn = false; }
          if (!e) continue;
          e._nid = id;
          byNid.set(id, e);
        }
        if (!e.alive) continue;
        e._ns = rec;
        e._nsT = now;
        if (e.type === 'gull') {
          e.orbitA = rec[17]; e.orbitR = rec[18]; e.orbitDir = rec[19]; e.alt = rec[20];
          e.home.set(rec[21], rec[22], rec[23]); e.patrolR = rec[24];
        }
      }
      for (const e of [...G.enemies.list]) if (e.alive && !seen.has(e._nid)) { byNid.delete(e._nid); ctx.retire(e); }
      if (inPlay(s)) for (const id of m.rc) cutRelay(id);
      // The landing site was chosen before the host's machines were known here: move away if one is close.
      if (spawnCheck && s === 'intro') {
        spawnCheck = false;
        if (G.enemies.list.some((e) => e.alive && Math.hypot(e.pos.x - P.pos.x, e.pos.z - P.pos.z) < 12)) P.reset(G.level.playerStart);
      }
    }

    function cutRelay(id) {
      const r = G.game.run.relays.find((x) => x.id === id);
      if (!r || r.cut) return;
      applying = true;
      try { G.game.netCut(r); } finally { applying = false; }
    }

    // ---- replay a machine's shot that the host fired
    function enemyFire(m) {
      const e = byNid.get(m.e);
      if (!e || !e.alive || st() === 'title') return;
      const pos = vec(m.p), dir = vec(m.d);
      e.flare = 1;
      if (e.type === 'gull') {
        ctx.fireBolt(pos, dir, e);
        call(G.fx, 'muzzleFlash', pos, dir, { scale: 0.55 });
      } else {
        const hit = G.physics.raycast(pos, dir, 200);
        let dist = hit ? hit.dist : 90, blocked = false;
        for (const t of boltTargets() || []) {
          if (t.alive === false) continue;
          const along = tmp.set(t.pos.x, t.pos.y + 1, t.pos.z).sub(pos).dot(dir);
          if (along <= 0 || along >= dist) continue;
          tmp2.copy(pos).addScaledVector(dir, along);
          if (Math.hypot(tmp2.x - t.pos.x, tmp2.z - t.pos.z) < 0.38 && Math.abs(tmp2.y - (t.pos.y + 0.95)) < 0.95) { dist = along; blocked = true; }
        }
        const end = pos.clone().addScaledVector(dir, dist);
        call(G.fx, 'tracer', pos, end, { color: 16760944, speed: 260, width: 0.035 });
        call(G.fx, 'muzzleFlash', pos, dir, { scale: 0.9 });
        call(G.render && G.render.lightPool, 'flash', pos, 16756832, 22, 7, 0.05);
        if (hit && !blocked) G.events.emit('impact', { point: hit.point, normal: hit.normal, dist: hit.dist, surface: hit.surface, enemy: null, dir, from: 'enemy' });
        e.sP.v += 1.1;
        e.sY.v -= 0.25;
      }
      G.events.emit('enemy:fire', { enemy: e, pos, dir, type: e.type });
    }

    // ---- a teammate's shot
    function mateFire(m) {
      const p = peers.get(m.f);
      if (!p || st() === 'title') return;
      const dir = vec(m.d);
      const muzzle = muzzleOf(p, new V3());
      const end = m.h ? vec(m.h.p) : vec(m.o).addScaledVector(dir, 300);
      p.av.kick = 1;
      call(G.fx, 'tracer', muzzle, end);
      call(G.fx, 'muzzleFlash', muzzle, dir, { scale: 0.8 });
      call(G.render && G.render.lightPool, 'flash', muzzle, 16756832, 45, 9, 0.05);
      call(G.audio, 'play', 'rifle_shot', { pos: { x: muzzle.x, y: muzzle.y, z: muzzle.z }, variant: p.shots++ & 3, gain: 1, jitter: 0.012 });
      if (m.h) G.events.emit('impact', { point: end, normal: vec(m.h.n), dist: 0, surface: m.h.s, enemy: m.h.e ? {} : null, part: m.h.e === 2 ? 'weak' : 'body', dir, from: 'mate' });
      const now = performance.now();
      if (net.isHost && now - p.heard > 300) { p.heard = now; G.enemies.alert(vec(m.o), G.enemies.TUNE.hearRadius); }
    }

    // ------------------------------------------------------------ local events -> network
    let lastImpact = null;
    G.events.on('impact', (ev) => { if (ev && ev.from === 'player') lastImpact = ev; });
    G.events.on('weapon:fire', (ev) => {
      const h = lastImpact;
      lastImpact = null;
      if (!mp() || !ev || !ev.origin) return;
      send({ t: 'fire', o: arr(ev.origin), d: [+ev.dir.x.toFixed(4), +ev.dir.y.toFixed(4), +ev.dir.z.toFixed(4)],
        h: h && h.point ? { p: arr(h.point), n: arr(h.normal || ev.dir), s: h.surface, e: h.enemy ? (h.part === 'weak' ? 2 : 1) : 0 } : null });
    });
    G.events.on('enemy:fire', (ev) => {
      if (mp() && net.isHost && ev && ev.enemy && ev.enemy._nid) send({ t: 'ef', e: ev.enemy._nid, p: arr(ev.pos), d: [+ev.dir.x.toFixed(4), +ev.dir.y.toFixed(4), +ev.dir.z.toFixed(4)] });
    });
    G.events.on('enemy:alert', (ev) => {
      if (mp() && net.isHost && !applying && ev && ev.enemy && ev.enemy._nid) send({ t: 'ea', e: ev.enemy._nid });
    });
    G.events.on('enemy:killed', (ev) => {
      const e = ev && ev.enemy;
      if (!e) return;
      if (mp() && net.isHost && e._nid) send({ t: 'ek', e: e._nid, d: e._ldir ? arr(e._ldir) : null, by: e._by || 0 });
      byNid.delete(e._nid);
    });
    G.events.on('objective:done', (ev) => { if (mp() && !applying && ev) send({ t: 'cut', id: ev.id }); });
    G.events.on('extraction:reached', () => { if (mp() && !applying) send({ t: 'extract' }); });
    G.events.on('game:state', (ev) => {
      if (ev && !inPlay(ev.state)) { net.down = false; }
      sendPresence();
      renderPanel();
    });

    // ------------------------------------------------------------ versus: player-on-player hits, score, rounds
    const round = { phase: 'idle', left: 0 }; // idle (lobby) | count (all ready) | play | end (results)
    const scores = new Map(); // player id -> { k, d }
    const scoreOf = (id) => { let x = scores.get(id); if (!x) { x = { k: 0, d: 0 }; scores.set(id, x); } return x; };
    const nameOf = (id) => (id === net.id ? myName || t('me') : (peers.get(id) && peers.get(id).name) || t('player', id));
    let lastHit = null, accVs = 0, tabHeld = false, aloneT = 0;
    net.versus = { round, scores, get on() { return vs(); }, get ready() { return myReady; } };

    // nearest opponent the ray meets before `maxDist`: an upright cylinder for the body, a sphere for the head above it
    const hv = new V3();
    function vsHitTest(origin, dir, maxDist) {
      let best = null;
      for (const p of peers.values()) {
        if (!p.proxy.alive) continue;
        const top = p.crouch ? 0.88 : 1.46, headY = p.crouch ? 1.05 : 1.63, R = 0.34, HR = 0.17; // body ends at the shoulders
        let t = Infinity, head = false;
        hv.set(p.pos.x, p.pos.y + headY, p.pos.z).sub(origin);
        const along = hv.dot(dir), miss2 = hv.lengthSq() - along * along;
        if (along > 0 && miss2 < HR * HR) { t = along - Math.sqrt(HR * HR - miss2); head = true; }
        const ox = origin.x - p.pos.x, oz = origin.z - p.pos.z;
        const a = dir.x * dir.x + dir.z * dir.z, b = 2 * (ox * dir.x + oz * dir.z), c = ox * ox + oz * oz - R * R;
        const disc = b * b - 4 * a * c;
        if (a > 1e-8 && disc > 0) {
          const q = Math.sqrt(disc), t0 = (-b - q) / (2 * a), t1 = (-b + q) / (2 * a);
          for (const tc of [t0, t1]) { // side wall, entering or (when shooting from above) leaving
            const y = origin.y + dir.y * tc - p.pos.y;
            if (tc > 0 && y >= 0 && y <= top && tc < t) { t = tc; head = false; break; }
          }
        }
        if (t < maxDist && (!best || t < best.dist)) best = { peer: p, dist: t, head, point: origin.clone().addScaledVector(dir, t) };
      }
      return best;
    }

    const playerShot = G.combat.playerShot;
    G.combat.playerShot = (origin, dir, opts) => {
      if (!vs() || !connected) return playerShot(origin, dir, opts);
      const o = opts || {}, range = o.range == null ? 300 : o.range;
      const wall = G.physics.raycast(origin, dir, range);
      const hit = vsHitTest(origin, dir, wall ? wall.dist : range);
      if (!hit) return playerShot(origin, dir, opts);
      const stats = G.combat.stats;
      if (stats) { stats.shots++; stats.hits++; }
      if (round.phase === 'play') send({ t: 'pd', to: hit.peer.id, a: r2((o.damage == null ? 28 : o.damage) * (hit.head ? 2.2 : 1)), k: hit.head ? 1 : 0, p: arr(origin) });
      const f = { point: hit.point, normal: dir.clone().negate(), dist: hit.dist, surface: 'enemy', enemy: {}, part: hit.head ? 'weak' : 'body', dir, from: 'player', killed: false };
      G.events.emit('impact', f);
      G.events.emit('player:hitEnemy', { enemy: f.enemy, part: f.part, killed: false, weak: hit.head });
      return f;
    };

    function onKill(victim, by, head) {
      if (round.phase !== 'play') return;
      scoreOf(victim).d++;
      const scored = by && by !== victim;
      if (scored) scoreOf(by).k++;
      call(G.hud, 'feed', scored ? t('kill', esc(nameOf(by)), esc(nameOf(victim)), head) : t('fell', esc(nameOf(victim))));
      if (scored && by === net.id) G.events.emit('player:hitEnemy', { enemy: {}, part: head ? 'weak' : 'body', killed: true, weak: false });
      renderVs();
    }
    function sendVs() {
      send({ t: 'vs', ph: round.phase, l: r2(round.left), sc: [...scores].map(([id, x]) => [id, x.k, x.d]) });
    }
    function setPhase(phase, left) {
      const was = round.phase;
      round.phase = phase;
      round.left = left;
      if (phase === 'end' && was !== 'end') P.invulnerable = true; // nobody scores during the break
      if (phase === 'idle' && (was === 'play' || was === 'end')) toLobby();
      if (phase !== was) { aloneT = 0; renderPanel(); }
      renderVs();
    }
    // after the results everyone goes back to the lobby and has to ready up again
    function toLobby() {
      myReady = false;
      net.down = false;
      lastHit = null;
      aimRelease();
      if (st() !== 'title') G.game.netTitle();
      sendPresence();
    }
    function beginRound() {
      scores.clear();
      setPhase('play', VS_ROUND_SECONDS);
      sendVs();
    }
    // a match starts only when the room has two or more players, all in the lobby and all ready
    function waitingOn() {
      const now = performance.now(), out = [];
      if (!myReady || st() !== 'title') out.push(net.id);
      for (const p of peers.values()) if (!p.ready || p.state !== 'title' || now - p.t > 3000) out.push(p.id);
      return out;
    }
    const allReady = () => peers.size > 0 && waitingOn().length === 0;
    function vsTick(dt, s) {
      if (net.isHost) {
        if (round.phase === 'idle') { if (allReady()) { setPhase('count', VS_COUNT_SECONDS); sendVs(); } }
        else if (round.phase === 'count') {
          if (!allReady()) { setPhase('idle', 0); sendVs(); }
          else if ((round.left -= dt) <= 0) startAll(true);
        } else if (round.phase === 'play') {
          round.left -= dt;
          const now = performance.now();
          const fighting = (inGame(s) ? 1 : 0) + [...peers.values()].filter((p) => inGame(p.state) && now - p.t < 3000).length;
          aloneT = fighting < 2 ? aloneT + dt : 0; // nobody left to fight: settle the round early
          if (round.left <= 0 || aloneT > 2) { setPhase('end', VS_BREAK_SECONDS); sendVs(); }
        } else if ((round.left -= dt) <= 0) { setPhase('idle', 0); sendVs(); }
        accVs += dt;
        if (accVs >= 1) { accVs = 0; sendVs(); }
      } else round.left = Math.max(0, round.left - dt);
      // the mission's relays and boat play no part here
      const run = G.game.run;
      if (run && run.relays.some((r) => !r.cut)) { for (const r of run.relays) r.cut = true; call(G.hud, 'setMarkers', []); call(G.hud, 'setPrompt', null); }
    }

    // ------------------------------------------------------------ going down instead of dying
    const pDamage = P.damage;
    P.damage = (amt, from) => {
      if (!mp() || !inPlay(st())) return pDamage(amt, from);
      if (!P.alive || P.invulnerable || !(amt > 0)) return;
      if (P.health - amt > 0) return pDamage(amt, from);
      pDamage(Math.max(0.01, P.health - 0.5), from); // hit feedback without the game's own death
      P.health = 0;
      P.alive = false;
      P.sprinting = false;
      net.down = true;
      net.downT = vs() ? VS_RESPAWN_SECONDS : RESPAWN_SECONDS;
      call(G.hud, 'setPrompt', null);
      aimRelease();
      if (vs()) {
        const h = lastHit && performance.now() - lastHit.t < 5000 ? lastHit : null;
        lastHit = null;
        send({ t: 'pk', by: h ? h.by : 0, k: h && h.head ? 1 : 0 });
        onKill(net.id, h ? h.by : 0, !!(h && h.head));
      } else call(G.hud, 'feed', t('youDown'));
      sendPresence();
    };

    // All mission entries (including the first player alone, retries and drop-ins) pass through reset.
    // Calling the game's reset with the chosen point also sets eye, camera, velocity and lastSafe.
    const resetPlayer = P.reset.bind(P);
    P.reset = function (start) {
      if (connected && pickSpawn && start === G.level.playerStart) {
        if (vs() && drop) { // a match is starting for everyone at once: take this player's share of the spread
          const plan = drop, rank = plan.ids.indexOf(net.id);
          drop = null;
          const site = rank >= 0 && pickSpawn.spread(plan.seed, rank, plan.ids.length);
          if (site) return resetPlayer(site);
        }
        const now = performance.now();
        const others = [...peers.values()].filter(p => inGame(p.state) && now - p.t < 3000).map(p => p.tpos);
        const enemies = G.enemies.list.filter(e => e.alive).map(e => e.pos);
        // versus: everyone else is someone to land well away from
        return resetPlayer(vs() ? pickSpawn([], others, P.alive ? null : P.pos) : pickSpawn(others, enemies, P.alive ? null : P.pos));
      }
      return resetPlayer(start);
    };

    function respawn() {
      net.down = false;
      P.reset(G.level.playerStart);
      call(G.weapon, 'reset');
      call(G.weapon, 'setVisible', true);
      P.invulnerable = true;
      setTimeout(() => { if (inPlay(st()) && !net.down) P.invulnerable = false; }, 2500);
      call(G.hud, 'message', t('backInFight'), 2);
      sendPresence();
    }

    function wipe() {
      if (!inPlay(st())) return;
      net.down = false;
      if (P.alive) { P.health = 0; P.alive = false; }
      G.events.emit('player:dead', {});
    }

    // ------------------------------------------------------------ mission flow
    let baseFlow = null;
    function scaleWaves() {
      const flow = G.game.flow;
      if (!baseFlow) baseFlow = { waves: flow.waves.map((w) => ({ ...w })), maxAlive: flow.maxAlive };
      const n = peers.size + 1, k = 1 + 0.5 * (n - 1);
      flow.waves = baseFlow.waves.map((w) => ({ gull: Math.min(8, Math.round(w.gull * k)), hound: Math.min(6, Math.round(w.hound * k)) }));
      flow.maxAlive = Math.min(14, baseFlow.maxAlive + 2 * (n - 1));
    }
    function localStart(quick, gesture) {
      if (profileDialog.open) profileDialog.close();
      net.down = false;
      status = '';
      call(G.audio, 'resume');
      if (gesture) call(G.input, 'requestLock');
      if (net.isHost && !vs()) scaleWaves();
      spawnCheck = !net.isHost && !vs();
      G.game.netStart({ quick: !!quick || vs(), keepRetries: !!quick || vs() });
      drop = null; // only the reset inside netStart may use it
      if (vs()) {
        P.invulnerable = false;
        lastHit = null;
        myReady = false;
      }
      renderPanel();
    }
    function startAll(quick) {
      const plan = vs() ? { seed: Math.floor(Math.random() * 1e6), ids: [net.id, ...peers.keys()].sort((a, b) => a - b) } : null;
      send({ t: 'start', q: quick ? 1 : 0, sd: plan && plan.seed, ids: plan && plan.ids });
      drop = plan;
      localStart(quick, true);
      if (vs()) beginRound();
    }
    function hostPeer() { return peers.get(net.hostId); }

    function menuAction(act) {
      // returns true when the multiplayer layer handled the button
      if (entered && !net.id && ws && ws.readyState < 2) {
        status = t('connecting');
        renderPanel();
        return true;
      }
      if (vs()) { // nobody starts a match alone: ready up, or drop into the round that is running
        if (!connected || act !== 'deploy') return true;
        call(G.audio, 'resume');
        if (round.phase === 'play') localStart(true, true);
        else if (round.phase !== 'end') { myReady = !myReady; sendPresence(); }
        renderPanel();
        return true;
      }
      if (!mp()) return false;
      call(G.audio, 'resume');
      if (net.isHost) { startAll(act !== 'deploy'); return true; }
      const h = hostPeer();
      if (act === 'deploy' && h && inGame(h.state)) { localStart(true, true); return true; }
      status = act === 'restart' ? t('onlyHostRestart') : t('waitingFor', h ? h.name : t('hostWord'));
      renderPanel();
      return true;
    }
    G.game.menus.root.addEventListener('click', (ev) => {
      const b = ev.target.closest && ev.target.closest('button');
      const act = b && b.dataset.act;
      if (!['deploy', 'retry', 'restart', 'redeploy'].includes(act)) return;
      if (menuAction(act)) { ev.stopPropagation(); ev.preventDefault(); G.events.emit('ui:click', {}); }
    }, true);
    addEventListener('keydown', (ev) => {
      if (ev.code !== 'Enter' && ev.code !== 'NumpadEnter') return;
      if (profileDialog.open || ev.isComposing) return;
      if (st() !== 'title' || G.game.menus.panelOpen || (ev.target && ev.target.tagName === 'BUTTON')) return;
      if (menuAction('deploy')) ev.stopImmediatePropagation();
    }, true);
    // players started by the host have not clicked anything yet: wake audio on their first input
    const wake = () => { if (mp() && inGame(st())) call(G.audio, 'resume'); };
    addEventListener('pointerdown', wake, true);
    addEventListener('keydown', wake, true);

    // ------------------------------------------------------------ presence + frame loop
    function sendPresence() {
      if (!connected) return;
      send({ t: 'p', p: arr(P.pos), v: arr(P.vel), y: r2(P.yaw), x: r2(P.pitch), c: P.crouching ? 1 : 0, r: P.sprinting ? 1 : 0, d: net.down ? 1 : 0, h: Math.round(P.health), s: st(), rd: myReady ? 1 : 0 });
    }

    let accP = 0, accS = 0, accUi = 0, lastDownShown = -1, hostQuiet = false;
    function frame(dt) {
      if (!connected) { if (!mini.hidden) mini.hidden = true; return; }
      updatePeers(dt);
      updateMap(dt);
      const s = st();
      accP += dt;
      if (accP >= (inGame(s) ? 1 / 15 : 0.5)) { accP = 0; sendPresence(); }
      if (!mp()) {
        if (net.down) respawn();
        return;
      }
      if (net.isHost) {
        accS += dt;
        if (accS >= 1 / 12 && s !== 'title' && !vs()) { accS = 0; snapshot(); }
        if (!vs() && (inPlay(s) || [...peers.values()].some((p) => inPlay(p.state)))) {
          const team = [];
          if (inPlay(s)) team.push(net.down);
          for (const p of peers.values()) if (inPlay(p.state)) team.push(p.down);
          if (team.length && team.every(Boolean)) { send({ t: 'wipe' }); wipe(); }
        }
      }
      if (vs()) vsTick(dt, s);
      if (net.down) {
        net.downT -= dt;
        const left = Math.ceil(net.downT);
        if (left !== lastDownShown) { lastDownShown = left; call(G.hud, 'message', t('downCount', Math.max(0, left)), 1.4); }
        if (net.downT <= 0) respawn();
      } else lastDownShown = -1;
      accUi += dt;
      if (accUi > 0.4) {
        accUi = 0;
        const h = hostPeer();
        const quiet = !vs() && !!h && inGame(s) && performance.now() - h.t > 2500;
        if (quiet && !hostQuiet) call(G.hud, 'warn', t('hostQuiet', h.name), 4);
        hostQuiet = quiet;
        renderPanel();
        renderVs();
      }
    }

    // ------------------------------------------------------------ messages
    function onMessage(m) {
      const p = m.f ? peers.get(m.f) : null;
      const fromHost = m.f === net.hostId;
      switch (m.t) {
        case 'welcome':
          net.id = m.id; net.hostId = m.host; urls = m.urls || [];
          if (m.mode) setMode(m.mode);
          pickSpawn = window.makeSaltlineSpawnPicker(G, m.spawnSlot ?? (m.id - 1) % 8, m.spawnSlots || 8);
          for (const q of m.peers) addPeer(q.id, q.name, q.model);
          myName = preferredName || m.name;
          if (myName !== m.name || myModel !== m.model) send({ t: 'name', name: myName, model: myModel });
          sendPresence();
          renderPanel();
          break;
        case 'join':
          addPeer(m.id, m.name, m.model);
          call(G.hud, 'feed', t('joined', esc(m.name)));
          sendPresence();
          if (vs() && net.isHost) sendVs(); // the newcomer needs the clock and the score
          renderPanel();
          break;
        case 'leave': {
          const q = peers.get(m.id);
          if (q) call(G.hud, 'feed', t('left', esc(q.name)));
          removePeer(m.id);
          scores.delete(m.id);
          renderPanel();
          break;
        }
        case 'name': {
          const q = peers.get(m.id);
          if (q) {
            q.name = m.name; q.lt = '';
            if (m.model != null) setPeerModel(q, m.model);
          } else if (m.id === net.id) {
            myName = m.name;
          }
          renderPanel();
          break;
        }
        case 'host':
          net.hostId = m.id;
          if (net.isHost) {
            // machines were puppets until now: hand them back their own timers
            for (const e of G.enemies.list) { e.cool = 1 + Math.random() * 1.5; if (e.type === 'hound') e.lungeCd = 1; else e.flipT = 3; e._tgT = 0; if (!e._nid) e._nid = ++nid; }
            call(G.hud, 'feed', t('nowHost'));
            if (!vs() && !inGame(st()) && [...peers.values()].some((q) => inGame(q.state))) localStart(true, false);
          }
          renderPanel();
          break;
        case 'p':
          if (!p) break;
          if (p.down && !m.d) p.fresh = true;
          p.tpos.set(m.p[0], m.p[1], m.p[2]); p.vel.set(m.v[0], m.v[1], m.v[2]);
          p.yaw = m.y; p.pitch = m.x; p.crouch = !!m.c; p.sprint = m.r != null ? !!m.r : Math.hypot(m.v[0], m.v[2]) > 5.4; p.down = !!m.d; p.hp = m.h; p.ready = !!m.rd;
          if (p.state !== m.s && (p.state === 'title' || p.state === 'intro')) p.fresh = true;
          p.state = m.s; p.t = performance.now();
          break;
        case 's': if (fromHost && !net.isHost) applySnapshot(m); break;
        case 'ef': if (fromHost) enemyFire(m); break;
        case 'ea':
          if (fromHost && st() !== 'title') { applying = true; try { G.events.emit('enemy:alert', { enemy: byNid.get(m.e) || {} }); } finally { applying = false; } }
          break;
        case 'ek': {
          if (!fromHost) break;
          const e = byNid.get(m.e);
          if (!e || !e.alive) break;
          withPlayer(localNoDmg, () => e._origDamage(1e5, e.pos, m.d ? vec(m.d) : null, 'body'));
          if (m.by === net.id) G.events.emit('player:hitEnemy', { enemy: e, part: 'body', killed: true, weak: false });
          break;
        }
        case 'hit': {
          if (!net.isHost || !p) break;
          const e = byNid.get(m.e);
          if (!e || !e.alive) break;
          e._tg = p.id; e._tgT = 2.5; // whoever shoots it gets its attention
          killer = p.id;
          try { withPlayer(p.proxy, () => e.damage(Math.min(200, +m.a || 0), e.pos, m.d ? vec(m.d) : null, m.k ? 'weak' : 'body')); } finally { killer = null; }
          break;
        }
        case 'dmg':
          if (fromHost && !net.down && inPlay(st())) P.damage(+m.a || 0, m.p ? vec(m.p) : null);
          break;
        case 'fire': mateFire(m); break;
        case 'start':
          if (!fromHost || (vs() && st() !== 'title')) break;
          drop = vs() && Array.isArray(m.ids) ? { seed: +m.sd || 0, ids: m.ids } : null;
          localStart(!!m.q, false);
          break;
        case 'cut': if (inPlay(st())) cutRelay(m.id); break;
        case 'extract':
          if (inPlay(st())) {
            net.down = false;
            applying = true;
            try { if (st() === 'paused') G.game.resume(); G.game.netExtract(); } finally { applying = false; }
          }
          break;
        case 'wipe': if (fromHost && !vs()) wipe(); break;
        case 'pd': // an opponent's shot landed on us
          if (vs() && p && round.phase === 'play' && !net.down && P.alive && !P.invulnerable && inPlay(st())) {
            lastHit = { by: p.id, head: !!m.k, t: performance.now() };
            P.damage(Math.min(200, +m.a || 0), m.p ? vec(m.p) : null);
          }
          break;
        case 'pk': if (vs() && p) onKill(p.id, +m.by || 0, !!m.k); break;
        case 'vs':
          if (vs() && fromHost && !net.isHost) {
            scores.clear();
            for (const [id, k, d] of m.sc || []) scores.set(id, { k, d });
            setPhase(m.ph, +m.l || 0);
          }
          break;
      }
    }

    function connect() {
      const profile = new URLSearchParams({ name: preferredName, model: myModel, mode, lang });
      ws = new WebSocket((location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host + '/ws?' + profile);
      ws.onopen = () => { connected = true; status = ''; };
      ws.onmessage = (ev) => {
        let m;
        try { m = JSON.parse(ev.data); } catch { return; }
        try { onMessage(m); } catch (e) { console.error('[net] message ' + (m && m.t), e); }
      };
      ws.onclose = () => {
        const was = connected;
        connected = false;
        pickSpawn = null;
        for (const id of [...peers.keys()]) removePeer(id);
        net.id = net.hostId = 0;
        if (net.down) respawn();
        myReady = false;
        if (vs()) { round.phase = 'idle'; round.left = 0; if (st() !== 'title') G.game.netTitle(); } // no match without the room
        status = t((was ? 'reconnecting' : 'unreachable') + (vs() ? 'Vs' : ''));
        renderPanel();
        setTimeout(connect, 3000);
      };
    }

    // ------------------------------------------------------------ UI
    const ui = document.getElementById('ui'), app = document.getElementById('app');
    const labels = document.createElement('div');
    labels.className = 'mp-labels';
    ui.insertBefore(labels, ui.firstChild);
    const panel = document.createElement('div');
    panel.className = 'mp-panel';
    panel.innerHTML = '<h4><em data-m="mode"></em> <span data-m="count"></span></h4><ul data-m="list"></ul>' +
      `<button type="button" class="mp-edit">${t('editProfile')}</button><button type="button" class="mp-edit mp-home">${t('changeMode')}</button>` +
      '<p class="st" data-m="status"></p><p class="st mp-last" data-m="last"></p>' +
      `<div class="mp-invite" data-m="invite" hidden><label for="mp-link">${t('invite')}</label><select data-m="host" hidden></select>` +
      `<input id="mp-link" data-m="link" readonly spellcheck="false"><button type="button" data-m="copy">${t('copyInvite')}</button></div>` +
      `<p class="mp-tip" data-m="edge" hidden><span>${t('edgeTip')}</span><button type="button" data-m="dismiss">${t('dismiss')}</button></p>`;
    app.appendChild(panel);
    const $m = (k) => panel.querySelector(`[data-m="${k}"]`);
    for (const type of ['keydown', 'keyup', 'keypress']) $m('invite').addEventListener(type, (ev) => ev.stopPropagation());

    // ---- invite: a link that opens this room, on an address other devices on the network can reach
    const localHost = /^(localhost|127\.|\[?::1\]?$)/.test(location.hostname);
    let inviteBase = '';
    function inviteLink() {
      const bases = localHost ? urls : [location.origin];
      if (!bases.includes(inviteBase)) inviteBase = bases[0] || location.origin;
      return { bases, link: inviteBase + '/?mode=' + mode };
    }
    $m('host').addEventListener('change', (ev) => { inviteBase = ev.target.value; panelSig = ''; renderPanel(); });
    $m('link').addEventListener('focus', (ev) => ev.target.select());
    function copyText(text) {
      // pages opened by LAN address are not a secure context, so the async clipboard may be missing
      if (navigator.clipboard && window.isSecureContext) return navigator.clipboard.writeText(text);
      return new Promise((resolve, reject) => {
        const box = document.createElement('textarea');
        box.value = text;
        box.style.cssText = 'position:fixed;left:-99px;top:0;opacity:0';
        panel.appendChild(box);
        box.select();
        let ok = false;
        try { ok = document.execCommand('copy'); } catch {}
        box.remove();
        if (ok) resolve(); else reject(new Error('copy refused'));
      });
    }
    let copyNote = '', copyTimer = 0;
    $m('copy').addEventListener('click', () => {
      const text = t(vs() ? 'inviteVersus' : 'inviteCoop', inviteLink().link);
      net.lastInvite = text;
      const done = (key) => {
        copyNote = t(key);
        if (key === 'copyFailed') $m('link').select();
        clearTimeout(copyTimer);
        copyTimer = setTimeout(() => { copyNote = ''; panelSig = ''; renderPanel(); }, 2500);
        panelSig = '';
        renderPanel();
      };
      copyText(text).then(() => done('copied'), () => done('copyFailed'));
    });

    // ---- Edge on a desktop: its mouse gestures swallow the held right button
    const isEdge = ((navigator.userAgentData && navigator.userAgentData.brands) || []).some((b) => b.brand === 'Microsoft Edge') || /\bEdg\//.test(navigator.userAgent);
    let edgeTip = isEdge;
    try { if (localStorage.getItem('saltline.edgeTip') === 'off') edgeTip = false; } catch {}
    $m('dismiss').addEventListener('click', () => {
      edgeTip = false;
      try { localStorage.setItem('saltline.edgeTip', 'off'); } catch {}
      panelSig = '';
      renderPanel();
    });
    const profileDialog = document.createElement('dialog');
    profileDialog.className = 'mp-profile';
    profileDialog.setAttribute('aria-labelledby', 'mp-profile-title');
    const cards = operators.catalog.map(model => `
      <label class="mp-operator">
        <input type="radio" name="model" value="${model.id}" required>
        <span class="mp-card"><img src="/operators/${model.id}.png" alt="" width="280" height="350">
          <strong>${t(model.id)}</strong></span>
      </label>`).join('');
    // the two language names are each written in their own language so either reader can find theirs
    profileDialog.innerHTML = `<form>
      <div class="mp-lang" data-lang role="group" aria-label="${t('language')}">
        <button type="button" data-set="zh" aria-pressed="${lang === 'zh'}">中文</button><button type="button" data-set="en" aria-pressed="${lang === 'en'}">English</button>
      </div>
      <h2 id="mp-profile-title"></h2>
      <fieldset class="mp-modes" data-modes><legend>${t('modeLegend')}</legend><div class="mp-mode-cards">
        <label class="mp-mode"><input type="radio" name="mode" value="coop"><span><strong>${t('coopName')}</strong><em>${t('coopDesc')}</em></span></label>
        <label class="mp-mode"><input type="radio" name="mode" value="versus"><span><strong>${t('versusName')}</strong><em>${t('versusDesc')}</em></span></label>
      </div></fieldset>
      <label class="mp-field" for="mp-name">${t('nameLabel')}</label>
      <input id="mp-name" name="name" maxlength="16" autocomplete="nickname" spellcheck="false" placeholder="${t('namePlaceholder')}">
      <fieldset><legend>${t('look')}</legend><div class="mp-cards">${cards}</div></fieldset>
      <div class="mp-actions"><a href="?solo=1" data-solo>${t('solo')}</a>
        <button type="button" data-cancel>${t('cancel')}</button><button type="submit" class="mp-confirm"></button></div>
    </form>`;
    app.appendChild(profileDialog);
    const form = profileDialog.querySelector('form');
    const nameInput = form.elements.namedItem('name');
    const modelInputs = form.elements.namedItem('model');
    const modeInputs = form.elements.namedItem('mode');
    function setMode(next) {
      mode = next === 'versus' ? 'versus' : 'coop';
      app.classList.toggle('mp-versus', vs());
    }
    let composing = false;
    function openProfile() {
      composing = false;
      nameInput.value = preferredName || (entered ? myName : '');
      modelInputs.value = myModel;
      modeInputs.value = mode;
      form.querySelector('[data-modes]').hidden = entered;
      form.querySelector('[data-lang]').hidden = entered; // the language is chosen on the first screen
      form.querySelector('h2').textContent = t(entered ? 'titleEdit' : 'titleJoin');
      form.querySelector('[data-cancel]').hidden = !entered;
      form.querySelector('[data-solo]').hidden = entered;
      form.querySelector('[type=submit]').textContent = t(entered ? 'save' : 'enter');
      profileDialog.showModal();
    }
    panel.querySelector('.mp-edit').addEventListener('click', openProfile);
    form.querySelector('[data-lang]').addEventListener('click', (ev) => {
      const next = ev.target.dataset && ev.target.dataset.set;
      if (!next || next === lang) return;
      // keep what was already chosen on this screen across the reload
      try {
        localStorage.setItem('saltline.name', operators.displayName(nameInput.value));
        localStorage.setItem('saltline.model', operators.modelId(modelInputs.value));
        localStorage.setItem('saltline.mode', modeInputs.value === 'versus' ? 'versus' : 'coop');
      } catch {}
      setLanguage(next);
    });
    // the mode is fixed for a connection: going back to the first screen is a reload
    panel.querySelector('.mp-home').addEventListener('click', () => { location.href = location.pathname; });
    form.querySelector('[data-cancel]').addEventListener('click', () => profileDialog.close());
    profileDialog.addEventListener('cancel', ev => { if (!entered) ev.preventDefault(); });
    nameInput.addEventListener('compositionstart', () => { composing = true; });
    nameInput.addEventListener('compositionend', () => { composing = false; });
    // Keep typing, radio arrows and the form's Enter key out of the game's global input handlers.
    for (const type of ['keydown', 'keyup', 'keypress']) profileDialog.addEventListener(type, ev => ev.stopPropagation());
    form.addEventListener('submit', ev => {
      ev.preventDefault();
      if (composing) return;
      preferredName = operators.displayName(nameInput.value);
      myName = preferredName || (net.id ? t('autoName', net.id) : '');
      myModel = operators.modelId(modelInputs.value);
      if (!entered) setMode(modeInputs.value);
      try {
        localStorage.setItem('saltline.name', preferredName);
        localStorage.setItem('saltline.model', myModel);
        localStorage.setItem('saltline.mode', mode);
      } catch {}
      profileDialog.close();
      if (entered) {
        send({ t: 'name', name: myName, model: myModel });
      } else {
        entered = true;
        status = t('connecting');
        connect();
      }
      renderPanel();
    });


    // ------------------------------------------------------------ minimap: whole site, north up, teammates as dots
    const mini = document.createElement('canvas');
    mini.className = 'mp-map';
    mini.hidden = true;
    ui.appendChild(mini);
    const mapCtx = mini.getContext('2d');
    const hex = (n) => '#' + n.toString(16).padStart(6, '0');
    let mapBase = null, mapView = null, accMap = 0;
    net.minimap = { view: null, dots: [] }; // what was drawn last, in canvas pixels

    function buildMap(size) {
      const { bounds, nav, boxes } = G.physics;
      let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity;
      for (let z = bounds.min.z; z <= bounds.max.z; z++) {
        for (let x = bounds.min.x; x <= bounds.max.x; x++) {
          if (!nav.isWalkable(x, z)) continue;
          x0 = Math.min(x0, x); x1 = Math.max(x1, x); z0 = Math.min(z0, z); z1 = Math.max(z1, z);
        }
      }
      if (!(x1 > x0 && z1 > z0)) return false;
      const pad = 4, span = Math.max(x1 - x0, z1 - z0) + pad * 2, s = size / span;
      // compass north is -Z and east is +X, so world x/z map straight onto canvas x/y
      mapView = { s, ox: size / 2 - (x0 + x1) / 2 * s, oy: size / 2 - (z0 + z1) / 2 * s, size };
      mapBase = document.createElement('canvas');
      mapBase.width = mapBase.height = size;
      const c = mapBase.getContext('2d');
      c.fillStyle = 'rgba(232,228,218,.13)';
      const step = 2;
      for (let py = 0; py < size; py += step) {
        for (let px = 0; px < size; px += step) {
          if (nav.isWalkable((px + step / 2 - mapView.ox) / s, (py + step / 2 - mapView.oy) / s)) c.fillRect(px, py, step, step);
        }
      }
      c.fillStyle = 'rgba(232,228,218,.34)';
      for (const b of boxes) {
        if (b.bulletOnly || b.max.y - b.min.y < 1.2 || b.min.y > 1) continue; // only things that block the way
        const w = (b.max.x - b.min.x) * s, h = (b.max.z - b.min.z) * s;
        if (w < 1 && h < 1) continue;
        c.fillRect(b.min.x * s + mapView.ox, b.min.z * s + mapView.oy, Math.max(1, w), Math.max(1, h));
      }
      net.minimap.view = mapView;
      return true;
    }

    function drawMap() {
      const c = mapCtx, v = mapView, u = Math.min(2, devicePixelRatio || 1); // u: one design pixel
      const X = (x) => v.ox + x * v.s, Y = (z) => v.oy + z * v.s;
      const dots = [];
      c.clearRect(0, 0, v.size, v.size);
      c.drawImage(mapBase, 0, 0);
      const run = G.game.run;
      for (const r of (!vs() && run && run.relays) || []) {
        const pos = r.o && r.o.pos;
        if (!pos) continue;
        const x = X(pos.x), y = Y(pos.z), d = 4.5 * u;
        c.beginPath();
        c.moveTo(x, y - d); c.lineTo(x + d, y); c.lineTo(x, y + d); c.lineTo(x - d, y); c.closePath();
        c.lineWidth = 1.5 * u;
        c.strokeStyle = r.cut ? 'rgba(232,228,218,.35)' : '#ffb347';
        if (!r.cut) { c.fillStyle = 'rgba(255,179,71,.35)'; c.fill(); }
        c.stroke();
      }
      if (run && run.allCut && G.level.extraction) {
        const e = G.level.extraction.pos, x = X(e.x), y = Y(e.z), d = 4 * u;
        c.fillStyle = '#e8e4da';
        c.fillRect(x - d, y - d, d * 2, d * 2);
        c.fillStyle = '#0b0d0f';
        c.font = `700 ${6 * u}px sans-serif`;
        c.textAlign = 'center'; c.textBaseline = 'middle';
        c.fillText(t('mapExit'), x, y + 0.5 * u);
      }
      const now = performance.now();
      c.font = `600 ${8.5 * u}px sans-serif`;
      c.textBaseline = 'middle';
      c.lineJoin = 'round';
      for (const p of peers.values()) {
        if (vs() || p.state === 'title' || p.state === 'intro' || now - p.t > 5000) continue; // no opponents on the map
        const x = Math.max(4 * u, Math.min(v.size - 4 * u, X(p.pos.x))), y = Math.max(4 * u, Math.min(v.size - 4 * u, Y(p.pos.z)));
        const color = hex(COLORS[(p.id - 1) % COLORS.length]), out = p.down || p.state === 'dead';
        c.lineWidth = 1.5 * u;
        if (!out) {
          c.strokeStyle = color;
          c.beginPath(); c.moveTo(x, y); c.lineTo(x - Math.sin(p.yaw) * 8 * u, y - Math.cos(p.yaw) * 8 * u); c.stroke();
        }
        c.beginPath(); c.arc(x, y, 3.5 * u, 0, Math.PI * 2);
        c.fillStyle = out ? 'rgba(11,13,15,.8)' : color;
        c.fill();
        c.strokeStyle = out ? color : 'rgba(11,13,15,.9)';
        c.lineWidth = u;
        c.stroke();
        const label = [...p.name].slice(0, 6).join(''), left = x > v.size * 0.62;
        c.textAlign = left ? 'right' : 'left';
        c.lineWidth = 2.5 * u;
        c.strokeStyle = 'rgba(11,13,15,.85)';
        c.strokeText(label, x + (left ? -7 : 7) * u, y);
        c.fillStyle = out ? 'rgba(232,228,218,.6)' : '#e8e4da';
        c.fillText(label, x + (left ? -7 : 7) * u, y);
        dots.push({ id: p.id, x, y, down: out });
      }
      // the local player: an arrow pointing where they look
      const x = X(P.pos.x), y = Y(P.pos.z);
      c.save();
      c.translate(x, y);
      c.rotate(-P.yaw);
      c.beginPath();
      c.moveTo(0, -7 * u); c.lineTo(4.5 * u, 5 * u); c.lineTo(0, 2.5 * u); c.lineTo(-4.5 * u, 5 * u); c.closePath();
      c.fillStyle = net.down ? 'rgba(232,228,218,.45)' : '#ffffff';
      c.strokeStyle = 'rgba(11,13,15,.9)';
      c.lineWidth = 1.2 * u;
      c.fill(); c.stroke();
      c.restore();
      dots.push({ id: net.id, x, y, me: true });
      net.minimap.dots = dots;
    }

    function updateMap(dt) {
      const show = entered && connected && st() === 'playing';
      if (mini.hidden === show) mini.hidden = !show;
      if (!show) return;
      const size = Math.round(mini.clientWidth * Math.min(2, devicePixelRatio || 1));
      if (!size) return;
      if (!mapBase || mini.width !== size) {
        mini.width = mini.height = size;
        if (!buildMap(size)) { mapBase = null; mini.hidden = true; return; }
        accMap = 1;
      }
      accMap += dt;
      if (accMap < 1 / 12) return;
      accMap = 0;
      drawMap();
    }

    const STATE_TEXT = { title: 'stTitle', intro: 'stIntro', playing: 'stPlaying', paused: 'stPaused', dead: 'stDead', complete: 'stComplete' };
    const deployButton = G.game.menus.root.querySelector('[data-act="deploy"]');
    let panelSig = '';
    function renderPanel() {
      const s = st();
      // versus has one button on the title screen: ready up, or join the round that is running
      const action = t(!vs() ? 'deploy' : round.phase === 'play' ? 'joinMatch' : myReady ? 'unready' : 'ready');
      if (deployButton && deployButton.textContent !== action) deployButton.textContent = action;
      const show = entered && ['title', 'paused', 'dead', 'complete'].includes(s);
      panel.hidden = !show;
      if (!show) return;
      const rows = [{ id: net.id, name: myName || t('me'), model: myModel, state: s, down: net.down, ready: myReady, me: true },
        ...[...peers.values()].map(p => ({ id: p.id, name: p.name, model: p.model, state: p.state, down: p.down, ready: p.ready }))].sort((a, b) => a.id - b.id);
      const h = hostPeer();
      let hint = status, last = '';
      if (connected && !status && vs()) {
        if (s !== 'title') hint = '';
        else if (round.phase === 'play') hint = t('vsJoin');
        else if (round.phase === 'end') hint = t('vsOver');
        else if (peers.size === 0) hint = t('vsNeedTwo');
        else if (round.phase === 'count') hint = t('vsCount', Math.max(1, Math.ceil(round.left)));
        else {
          const others = waitingOn().filter((id) => id !== net.id).map(nameOf);
          hint = !myReady ? t('vsPressReady') : others.length ? t('vsWaitingOn', others.join(lang === 'zh' ? '、' : ', ')) : '';
        }
        if (s === 'title' && (round.phase === 'idle' || round.phase === 'count') && scores.size) {
          const top = standings(), tie = top.length > 1 && top[0].k === top[1].k && top[0].d === top[1].d;
          last = tie || !top[0].k ? t('lastDraw') : t('lastWin', top[0].name, top[0].k);
        }
      } else if (connected && !status) {
        hint = peers.size === 0 ? t('coopAlone')
          : s !== 'title' ? '' : net.isHost ? t('coopHost') : h && inGame(h.state) ? t('coopJoin') : t('coopWait');
      }
      const invite = connected ? inviteLink() : null;
      const sig = JSON.stringify([rows, hint, last, invite, copyNote, edgeTip, net.hostId, connected, mode, round.phase]);
      if (sig === panelSig) return;
      panelSig = sig;
      $m('mode').textContent = t(vs() ? 'lobbyVersus' : 'lobbyCoop');
      $m('count').textContent = connected ? t('count', rows.length) : t('offline');
      $m('list').innerHTML = connected ? rows.map(r => {
        const tag = r.down ? t('stDead') : vs() && r.state === 'title' ? t(r.ready ? 'tagReady' : 'tagNotReady') : t(STATE_TEXT[r.state] || 'stTitle');
        return `<li class="${(r.me ? 'me' : '') + (vs() && r.state === 'title' && r.ready ? ' ready' : '')}"><b>${esc(r.name)}${r.id === net.hostId && !vs() ? ' ★' : ''}</b><span>${t(r.model)} · ${tag}</span></li>`;
      }).join('') : '';
      $m('status').textContent = hint;
      $m('last').textContent = last;
      $m('invite').hidden = !invite;
      if (invite) {
        const pick = $m('host');
        pick.hidden = invite.bases.length < 2;
        const options = invite.bases.map((b) => `<option value="${esc(b)}">${esc(b.replace(/^https?:\/\//, ''))}</option>`).join('');
        if (pick.dataset.options !== options) { pick.dataset.options = options; pick.innerHTML = options; }
        pick.value = inviteBase;
        if ($m('link').value !== invite.link) $m('link').value = invite.link;
        $m('copy').textContent = copyNote || t('copyInvite');
      }
      $m('edge').hidden = !(edgeTip && !G.input.touch);
    }

    // ------------------------------------------------------------ versus HUD: clock, own tally, scoreboard
    const vsHud = document.createElement('div');
    vsHud.className = 'mp-vs';
    vsHud.hidden = true;
    vsHud.innerHTML = '<b></b><span></span>';
    ui.appendChild(vsHud);
    const board = document.createElement('div');
    board.className = 'mp-board';
    board.hidden = true;
    board.innerHTML = `<h4></h4><table><thead><tr><th></th><th>${t('thPlayer')}</th><th>${t('thKills')}</th><th>${t('thDeaths')}</th></tr></thead><tbody></tbody></table><p></p>`;
    ui.appendChild(board);
    const clock = (t) => { const n = Math.max(0, Math.ceil(t)); return Math.floor(n / 60) + ':' + String(n % 60).padStart(2, '0'); };
    function standings() {
      return [net.id, ...peers.keys()].map((id) => ({ id, name: nameOf(id), ...scoreOf(id) })).sort((a, b) => b.k - a.k || a.d - b.d || a.id - b.id);
    }
    net.versus.standings = standings;
    let vsSig = '';
    function renderVs() {
      const on = vs() && connected && inGame(st()) && (round.phase === 'play' || round.phase === 'end');
      const showBoard = on && (round.phase === 'end' || tabHeld);
      if (vsHud.hidden === on) vsHud.hidden = !on;
      if (board.hidden === showBoard) board.hidden = !showBoard;
      if (!on) return;
      const rows = standings(), mine = scoreOf(net.id), ended = round.phase === 'end';
      const sig = JSON.stringify([rows, clock(round.left), ended, showBoard]);
      if (sig === vsSig) return;
      vsSig = sig;
      vsHud.firstChild.textContent = ended ? t('roundOver') : clock(round.left);
      vsHud.classList.toggle('late', !ended && round.left <= 10);
      vsHud.lastChild.textContent = t('tally', mine.k, mine.d);
      if (!showBoard) return;
      const tie = rows.length > 1 && rows[0].k === rows[1].k && rows[0].d === rows[1].d;
      board.querySelector('h4').textContent = !ended ? t('board') : tie || !rows[0].k ? t('draw') : t('wins', rows[0].name);
      board.querySelector('tbody').innerHTML = rows.map((r, i) =>
        `<tr class="${r.id === net.id ? 'me' : ''}"><td>${i + 1}</td><td>${esc(r.name)}</td><td>${r.k}</td><td>${r.d}</td></tr>`).join('');
      board.querySelector('p').textContent = ended ? t('backIn', Math.max(0, Math.ceil(round.left))) : '';
    }
    for (const type of ['keydown', 'keyup']) addEventListener(type, (ev) => {
      if (ev.code !== 'Tab' || !vs() || !inGame(st()) || profileDialog.open) return;
      ev.preventDefault();
      tabHeld = type === 'keydown';
      renderVs();
    }, true);

    setMode(mode);
    renderPanel();
    openProfile();
  }
})();
