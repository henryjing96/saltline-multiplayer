// Each connected player gets one of eight interleaved sets of landing sites.
// Simultaneous drops are separated even before either player's first presence packet arrives.
(() => {
  'use strict';
  function makePicker(game, slot, slotCount) {
    const { physics, level, player, THREE } = game;
    const { nav, bounds } = physics;
    const start = level.playerStart;
    const stride = 3, radius = 0.4, height = player.tuning.standHeight;
    let sites, last;

    function standingRoom(point) {
      return !physics.boxes.some(box => {
        if (box.bulletOnly || box.max.y <= point.y + 0.015 || box.min.y >= point.y + height + 0.05) return false;
        const dx = Math.max(box.min.x - point.x, 0, point.x - box.max.x);
        const dz = Math.max(box.min.z - point.z, 0, point.z - box.max.z);
        return dx * dx + dz * dz < radius * radius;
      });
    }
    function findSites(assignedOnly) {
      const points = [];
      for (let row = 0, z = bounds.min.z + stride / 2; z < bounds.max.z; row++, z += stride) {
        for (let col = 0, x = bounds.min.x + stride / 2; x < bounds.max.x; col++, x += stride) {
          if (assignedOnly && (col + 3 * row) % slotCount !== slot) continue;
          if (!nav.isWalkable(x, z)) continue; // the level navigation grid also excludes the sea
          const y = physics.groundHeight(x, z, start.pos.y + 0.45);
          if (!Number.isFinite(y) || y < start.pos.y - 0.45) continue;
          const point = new THREE.Vector3(x, y, z);
          if (standingRoom(point) && nav.findPath(start.pos, point)) points.push(point);
        }
      }
      return points;
    }
    function facing(point) {
      const first = Math.random() * 2 * Math.PI;
      for (let i = 0; i < 8; i++) {
        const yaw = first + i * Math.PI / 4;
        const ahead = point.clone();
        ahead.x -= Math.sin(yaw) * 2;
        ahead.z -= Math.cos(yaw) * 2;
        if (nav.isWalkable(ahead.x, ahead.z) && nav.clearLine(point, ahead)) return yaw;
      }
      return start.yaw;
    }
    const distance = (a, b) => Math.hypot(a.x - b.x, a.z - b.z);
    function nearest(point, others) {
      let best = Infinity;
      for (const other of others) best = Math.min(best, distance(point, other));
      return best;
    }
    // Players who drop in at the same instant cannot see each other's choice. Given the same seed, every
    // client derives the same list of sites, each as far as possible from the ones before it, and takes its own.
    let everySite;
    function spread(seed, index, count) {
      if (!everySite) everySite = findSites(false);
      const free = everySite.filter(standingRoom);
      if (free.length < count) return null;
      const chosen = [free[Math.abs(seed | 0) % free.length]];
      while (chosen.length <= index) {
        let best = null, bestGap = -1;
        for (const point of free) {
          const gap = nearest(point, chosen);
          if (gap > bestGap) { bestGap = gap; best = point; }
        }
        chosen.push(best);
      }
      last = chosen[index];
      return { pos: last.clone(), yaw: facing(last) };
    }
    pick.spread = spread;
    return pick;
    function pick(teammates, enemies, previousPosition) {
      if (!sites) sites = findSites(true);
      let free = sites.filter(standingRoom);
      if (!free.length) free = findSites(false);
      if (!free.length) return { pos: start.pos.clone(), yaw: start.yaw };
      if (last && free.length > 1) free = free.filter(point => point.x !== last.x || point.z !== last.z);
      const safe = [];
      let furthest = free[0], bestClearance = -1;
      for (const point of free) {
        const clearance = Math.min(nearest(point, teammates) / 4, nearest(point, enemies) / 8,
          last ? distance(point, last) / 8 : Infinity,
          previousPosition ? distance(point, previousPosition) / 6 : Infinity);
        if (clearance >= 1) safe.push(point);
        if (clearance > bestClearance) { bestClearance = clearance; furthest = point; }
      }
      last = safe.length ? safe[Math.floor(Math.random() * safe.length)] : furthest;
      return { pos: last.clone(), yaw: facing(last) };
    }
  }

  if (typeof module !== 'undefined' && module.exports) module.exports = makePicker;
  else window.makeSaltlineSpawnPicker = makePicker;
})();
