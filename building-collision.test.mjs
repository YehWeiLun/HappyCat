import test from 'node:test';
import assert from 'node:assert/strict';
import {buildFootprints, findSafePosition, isBlocked, moveAroundBuildings} from './building-collision.mjs';

const rectangle = (x1, z1, x2, z2) => [[x1, z1], [x2, z1], [x2, z2], [x1, z2], [x1, z1]];
const feature = coordinates => ({geometry: {type: 'Polygon', coordinates}});
const local = (x, z) => ({x, z});

test('walls block the cat while leaving courtyards open', () => {
  const buildings = buildFootprints([feature([rectangle(0, 0, 10, 10), rectangle(3, 3, 7, 7)])], local, {x: 5, z: 5}, 20);
  assert.equal(isBlocked(buildings, 1, 1, .2), true);
  assert.equal(isBlocked(buildings, 5, 5, .2), false);
  assert.equal(isBlocked(buildings, 5, 3.1, .2), true);
  assert.equal(isBlocked(buildings, -1, 5, .2), false);
});

test('diagonal movement slides along a building wall', () => {
  const buildings = buildFootprints([feature([rectangle(0, 0, 10, 10)])], local, {x: 0, z: 0}, 20);
  const blocked = (x, z) => isBlocked(buildings, x, z, .2);
  assert.deepEqual(moveAroundBuildings(blocked, -1, 5, .1, 5.5, .2), {x: -1, z: 5.5});
  assert.deepEqual(moveAroundBuildings(blocked, -1, 5, 11, 5, .2), {x: -1, z: 5});
});

test('a saved spawn inside a building moves outside, including a split tile footprint', () => {
  const buildings = buildFootprints([
    feature([rectangle(0, 0, 5, 10)]),
    feature([rectangle(5, 0, 10, 10)]),
  ], local, {x: 4.8, z: 5}, 20);
  const safe = findSafePosition(buildings, 4.8, 5, .2);
  assert.ok(safe);
  assert.equal(isBlocked(buildings, safe.x, safe.z, .2), false);
  assert.ok(Math.hypot(safe.x - 4.8, safe.z - 5) < 6);
});
