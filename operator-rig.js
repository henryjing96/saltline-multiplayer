// Skinned operators: loads operators/<id>.glb once per character, then gives every player their own
// skeleton, locomotion blend, rifle hold and arm IK. The avatar faces -Z with feet at Y=0, like operators.js.
(() => {
  'use strict';
  const cache = new Map();
  let lib = null;
  const ARM = /^(Left|Right)(Shoulder|Arm|ForeArm|Hand)/;
  const HEIGHT = { scout: 1.69, diver: 1.81, bulwark: 1.85 }; // metres to the top of the head or helmet
  // speed (m/s) -> clip weights and distance covered per animation cycle
  const GAIT = [
    { v: 0, clip: 'idle', stride: 2.0 }, { v: 1.6, clip: 'walk', stride: 2.0 },
    { v: 3.9, clip: 'jog', stride: 3.3 }, { v: 6.4, clip: 'sprint', stride: 4.4 },
  ];

  function load(T, id) {
    if (!cache.has(id)) {
      const pending = new Promise((resolve, reject) => {
        lib = lib || window.saltlineGltfLibrary(T);
        new lib.GLTFLoader().load('/operators/' + id + '.glb', (gltf) => {
          gltf.scene.traverse((o) => {
            if (!o.isMesh) return;
            o.castShadow = o.receiveShadow = true;
            if (o.isSkinnedMesh) o.frustumCulled = false; // the bind-pose bounds do not follow the pose
            const m = o.material;
            if (m && (m.transparent || m.alphaTest > 0)) { m.transparent = false; m.alphaTest = 0.45; m.depthWrite = true; m.side = T.DoubleSide; }
          });
          const clips = {};
          for (const clip of gltf.animations) {
            // arms are posed by the rifle hold, except when lying down
            if (clip.name !== 'down') clip.tracks = clip.tracks.filter((t) => !ARM.test(t.name));
            clips[clip.name] = clip;
          }
          // generated bodies come out at different statures: bring each to a believable standing height
          let top = 0;
          gltf.scene.updateMatrixWorld(true);
          gltf.scene.traverse((o) => {
            if (!o.isSkinnedMesh) return;
            o.computeBoundingBox(); // skinned bounds: raw geometry may be stored quantized
            top = Math.max(top, o.boundingBox.max.y);
          });
          const scale = top > 0.5 ? (HEIGHT[id] || 1.78) / top : 1;
          resolve({ scene: gltf.scene, clips, scale });
        }, undefined, reject);
      });
      pending.catch(() => cache.delete(id));
      cache.set(id, pending);
    }
    return cache.get(id);
  }

  function make(T, tpl, id) {
    const V = () => new T.Vector3(), Q = () => new T.Quaternion();
    const root = new T.Group();
    root.name = id;
    const model = lib.clone(tpl.scene);
    model.rotation.y = Math.PI; // glTF front is +Z
    model.scale.setScalar(tpl.scale);
    root.add(model);
    const bones = {}, near = [], far = [], fingers = [];
    model.traverse((o) => {
      if (o.isBone) { bones[o.name] = o; if (/Hand(Index|Middle|Ring|Pinky)\d/.test(o.name)) fingers.push(o); }
      else if (o.name.startsWith('Near_')) near.push(o);
      else if (o.name.startsWith('Far_')) far.push(o);
    });
    for (const o of far) o.visible = false;
    // every mesh of one operator is deformed by the same bones: one skeleton (and bone texture) per player
    const shared = new Map();
    model.traverse((o) => {
      if (!o.isSkinnedMesh) return;
      const key = o.skeleton.bones.map((b) => b.uuid).join();
      if (shared.has(key)) o.bind(shared.get(key), o.bindMatrix); else shared.set(key, o.skeleton);
    });
    const hold = new T.Group();
    hold.rotation.order = 'YXZ';
    root.add(hold);
    const gun = model.getObjectByName('Carbine');
    hold.add(gun);
    gun.position.set(0, 0, 0);
    gun.rotation.set(0, Math.PI, 0);
    const muzzle = gun.getObjectByName('Muzzle'), gripR = gun.getObjectByName('RightGrip'), gripL = gun.getObjectByName('LeftGrip');
    const fingerRest = fingers.map((b) => b.quaternion.clone());

    const mixer = new T.AnimationMixer(model);
    const act = {}, weight = {};
    for (const name of Object.keys(tpl.clips)) {
      const a = mixer.clipAction(tpl.clips[name]);
      a.play();
      a.setEffectiveWeight(name === 'idle' ? 1 : 0);
      weight[name] = name === 'idle' ? 1 : 0;
      act[name] = a;
    }
    act.down.setLoop(T.LoopOnce, 1);
    act.down.clampWhenFinished = true;

    const a0 = V(), b0 = V(), c0 = V(), t0 = V(), d0 = V(), e0 = V(), pole = V(), axis = V();
    const q0 = Q(), q1 = Q(), q2 = Q();
    // turn `bone` (about its own origin) so that the point `from` moves onto the ray towards `to`
    function swing(bone, from, to) {
      bone.getWorldPosition(a0);
      d0.copy(from).sub(a0).normalize();
      e0.copy(to).sub(a0).normalize();
      q0.setFromUnitVectors(d0, e0);
      turn(bone, q0);
    }
    function turn(bone, worldRotation) {
      bone.getWorldQuaternion(q1);
      bone.parent.getWorldQuaternion(q2);
      bone.quaternion.copy(q2.invert()).multiply(worldRotation).multiply(q1);
      bone.updateWorldMatrix(false, true);
    }
    function reach(side, target, poleLocal) {
      const upper = bones[side + 'Arm'], lower = bones[side + 'ForeArm'], hand = bones[side + 'Hand'];
      upper.getWorldPosition(a0); lower.getWorldPosition(b0); hand.getWorldPosition(c0);
      const l1 = a0.distanceTo(b0), l2 = b0.distanceTo(c0);
      t0.copy(target).sub(a0);
      const dist = Math.min(Math.max(t0.length(), Math.abs(l1 - l2) + 0.01), l1 + l2 - 0.005);
      t0.normalize();
      const along = (l1 * l1 - l2 * l2 + dist * dist) / (2 * dist), out = Math.sqrt(Math.max(0, l1 * l1 - along * along));
      pole.copy(poleLocal).applyQuaternion(root.quaternion);
      pole.addScaledVector(t0, -pole.dot(t0)).normalize();
      const elbow = e0.copy(a0).addScaledVector(t0, along).addScaledVector(pole, out).clone();
      const wrist = a0.clone().addScaledVector(t0, dist);
      swing(upper, b0, elbow);
      hand.getWorldPosition(c0);
      swing(lower, c0, wrist);
    }

    const state = { phase: 0, idleT: 0, crouchT: 0, downT: 0, ready: 0, lod: 0, wasLying: false };
    const POLE_R = new T.Vector3(0.75, -1, 0.25), POLE_L = new T.Vector3(-0.8, -1, 0.1);
    const X = new T.Vector3(1, 0, 0);
    const avatar = {
      root, muzzle, skinned: true, lie: 0, kick: 0,
      // s: { speed, pitch, crouch, lying, sprint, camera }
      update(dt, s) {
        const k = (r) => 1 - Math.exp(-r * dt);
        avatar.lie += ((s.lying ? 1 : 0) - avatar.lie) * k(6);
        // ---- which clips, how much
        const want = {};
        const speed = s.speed;
        if (s.lying) want.down = 1;
        else if (s.crouch) { const m = Math.min(1, speed / 1.2); want.crouch_idle = 1 - m; want.crouch_walk = m; }
        else {
          let i = 0;
          while (i < GAIT.length - 2 && speed > GAIT[i + 1].v) i++;
          const m = Math.min(1, Math.max(0, (speed - GAIT[i].v) / (GAIT[i + 1].v - GAIT[i].v)));
          want[GAIT[i].clip] = 1 - m;
          want[GAIT[i + 1].clip] = (want[GAIT[i + 1].clip] || 0) + m;
        }
        let total = 0;
        for (const name in act) { weight[name] += ((want[name] || 0) - weight[name]) * k(s.lying || state.wasLying ? 7 : 10); total += weight[name]; }
        for (const name in act) act[name].setEffectiveWeight(weight[name] / (total || 1));
        // ---- clip time: strides follow the ground covered, so feet do not skate
        let stride = 2.0;
        if (!s.crouch) {
          let i = 0;
          while (i < GAIT.length - 2 && speed > GAIT[i + 1].v) i++;
          const m = Math.min(1, Math.max(0, (speed - GAIT[i].v) / (GAIT[i + 1].v - GAIT[i].v)));
          stride = GAIT[i].stride + (GAIT[i + 1].stride - GAIT[i].stride) * m;
        }
        state.phase = (state.phase + dt * Math.max(speed, 0.6) / stride) % 1;
        state.idleT += dt; state.crouchT += dt;
        for (const name of ['walk', 'jog', 'sprint', 'crouch_walk']) act[name].time = state.phase * act[name].getClip().duration;
        act.idle.time = state.idleT % act.idle.getClip().duration;
        act.crouch_idle.time = state.crouchT % act.crouch_idle.getClip().duration;
        if (s.lying && !state.wasLying) state.downT = 0;
        if (!s.lying && state.wasLying) { state.downT = 0; for (const name in act) weight[name] = name === 'idle' ? 1 : 0; }
        state.wasLying = s.lying;
        state.downT = Math.min(act.down.getClip().duration - 0.02, state.downT + dt);
        act.down.time = state.downT;
        mixer.update(0);

        const up = 1 - Math.min(1, avatar.lie * 3); // 1 while standing, 0 once falling
        gun.visible = up > 0;
        // ---- lean the chest with the aim, then shoulder the rifle and put both hands on it
        const pitch = s.pitch * up;
        root.updateMatrixWorld(true);
        axis.copy(X).applyQuaternion(root.quaternion);
        q0.setFromAxisAngle(axis, pitch * 0.22);
        const lean = q0.clone();
        turn(bones.Spine1, lean); turn(bones.Spine2, lean); turn(bones.Head, lean);
        if (up > 0) {
          const low = s.sprint && !s.crouch ? 1 : 0;
          state.ready += (low - state.ready) * k(8);
          bones.RightArm.getWorldPosition(t0);
          root.worldToLocal(t0);
          hold.position.set(t0.x - 0.055, t0.y - 0.035 - state.ready * 0.06, t0.z - 0.02);
          hold.rotation.set(pitch * 0.9 * (1 - state.ready) - state.ready * 0.62 + avatar.kick * 0.05, state.ready * 0.55, state.ready * 0.25);
          hold.updateMatrixWorld(true);
          for (let i = 0; i < fingers.length; i++) fingers[i].quaternion.copy(fingerRest[i]);
          reach('Right', gripR.getWorldPosition(V()), POLE_R);
          reach('Left', gripL.getWorldPosition(V()), POLE_L);
        }
        // ---- distant operators use the reduced meshes
        if (s.camera) {
          const lod = s.camera.position.distanceToSquared(root.position) > 18 * 18 ? 1 : 0;
          if (lod !== state.lod) { state.lod = lod; for (const o of near) o.visible = !lod; for (const o of far) o.visible = !!lod; }
        }
      },
      dispose() { mixer.stopAllAction(); root.removeFromParent(); }, // geometry and textures are shared
    };
    return avatar;
  }

  window.SaltlineRigs = { load: (T, id) => load(T, id).then((tpl) => () => make(T, tpl, id)) };
})();
