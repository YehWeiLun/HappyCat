// Building geometry uses the same local X/Z meter coordinates as the cat.
const distanceToSegmentSquared = (x, z, a, b) => {
  const dx = b.x - a.x, dz = b.z - a.z;
  const t = dx || dz ? Math.max(0, Math.min(1, ((x - a.x) * dx + (z - a.z) * dz) / (dx * dx + dz * dz))) : 0;
  const px = a.x + t * dx, pz = a.z + t * dz;
  return {distance: (x - px) ** 2 + (z - pz) ** 2, x: px, z: pz, dx, dz};
};

function insideRing(ring, x, z) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const a = ring[i], b = ring[j];
    if ((a.z > z) !== (b.z > z) && x < (b.x - a.x) * (z - a.z) / (b.z - a.z) + a.x) inside = !inside;
  }
  return inside;
}

export function buildFootprints(features, toLocal, center, range) {
  const footprints = [];
  for (const feature of features) {
    const geometry = feature.geometry;
    if (!geometry || (geometry.type !== 'Polygon' && geometry.type !== 'MultiPolygon')) continue;
    for (const polygon of geometry.type === 'Polygon' ? [geometry.coordinates] : geometry.coordinates) {
      const rings = polygon.map(ring => ring.map(([lng, lat]) => toLocal(lng, lat))).filter(ring => ring.length >= 3);
      if (!rings.length) continue;
      const bounds = rings[0].reduce((box, p) => ({minX: Math.min(box.minX, p.x), minZ: Math.min(box.minZ, p.z), maxX: Math.max(box.maxX, p.x), maxZ: Math.max(box.maxZ, p.z)}), {minX: Infinity, minZ: Infinity, maxX: -Infinity, maxZ: -Infinity});
      if (bounds.maxX < center.x - range || bounds.minX > center.x + range || bounds.maxZ < center.z - range || bounds.minZ > center.z + range) continue;
      footprints.push({rings, bounds});
    }
  }
  return footprints;
}

export function isBlocked(footprints, x, z, radius) {
  const radius2 = radius * radius;
  for (const {rings, bounds} of footprints) {
    if (x < bounds.minX - radius || x > bounds.maxX + radius || z < bounds.minZ - radius || z > bounds.maxZ + radius) continue;
    if (insideRing(rings[0], x, z) && !rings.slice(1).some(ring => insideRing(ring, x, z))) return true;
    for (const ring of rings) {
      for (let i = 0; i < ring.length; i++) {
        if (distanceToSegmentSquared(x, z, ring[i], ring[(i + 1) % ring.length]).distance < radius2) return true;
      }
    }
  }
  return false;
}

export function moveAroundBuildings(blocked, x, z, nextX, nextZ, radius) {
  const pathFree = (ax, az, bx, bz) => {
    const steps = Math.max(1, Math.ceil(Math.hypot(bx - ax, bz - az) / (radius / 2)));
    for (let i = 1; i <= steps; i++) {
      const t = i / steps;
      if (blocked(ax + (bx - ax) * t, az + (bz - az) * t)) return false;
    }
    return true;
  };
  if (pathFree(x, z, nextX, nextZ)) return {x: nextX, z: nextZ};
  const xFree = pathFree(x, z, nextX, z), zFree = pathFree(x, z, x, nextZ);
  if (xFree && zFree) return Math.abs(nextX - x) >= Math.abs(nextZ - z) ? {x: nextX, z} : {x, z: nextZ};
  if (xFree) return {x: nextX, z};
  if (zFree) return {x, z: nextZ};
  return {x, z};
}

export function findSafePosition(footprints, x, z, radius) {
  const blocked = (px, pz) => isBlocked(footprints, px, pz, radius);
  if (!blocked(x, z)) return {x, z};
  const candidates = [];
  for (const {rings, bounds} of footprints) {
    if (x < bounds.minX - radius || x > bounds.maxX + radius || z < bounds.minZ - radius || z > bounds.maxZ + radius) continue;
    for (const ring of rings) {
      for (let i = 0; i < ring.length; i++) {
        const point = distanceToSegmentSquared(x, z, ring[i], ring[(i + 1) % ring.length]);
        const length = Math.hypot(point.dx, point.dz);
        if (!length) continue;
        const offset = radius + .1;
        for (const sign of [-1, 1]) {
          const px = point.x + sign * point.dz / length * offset;
          const pz = point.z - sign * point.dx / length * offset;
          candidates.push({x: px, z: pz, distance: Math.hypot(px - x, pz - z)});
        }
      }
    }
  }
  candidates.sort((a, b) => a.distance - b.distance);
  for (const p of candidates) if (!blocked(p.x, p.z)) return {x: p.x, z: p.z};
  for (const distance of [1, 2, 3, 4, 6, 8, 10, 12, 16, 20, 24, 32, 40, 50, 64, 80, 100, 128, 160, 200]) {
    for (let i = 0; i < 48; i++) {
      const angle = 2 * Math.PI * i / 48;
      const px = x + distance * Math.cos(angle), pz = z + distance * Math.sin(angle);
      if (!blocked(px, pz)) return {x: px, z: pz};
    }
  }
  return null;
}
