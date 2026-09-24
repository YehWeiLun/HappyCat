import * as THREE from 'three';
import {GLTFLoader} from 'three/addons/loaders/GLTFLoader.js';
import * as maplibregl from 'maplibre-gl';
import {buildFootprints, findSafePosition, isBlocked, moveAroundBuildings} from '../building-collision.mjs';

const START = [121.4870872, 24.9968507]; // [lng, lat]
const MODEL_URL = new URL('../assets/cat_v01.glb', import.meta.url).href;
const STYLE_URL = 'https://tiles.openfreemap.org/styles/liberty';
const NLSC_WMTS = 'https://wmts.nlsc.gov.tw/wmts';
const MAP_BASES = ['streets', 'emap', 'photo'];
const SAVE_KEY = 'happycat.state.v1';
const CLIPS = ['Idle','Walk','Run','JumpStart','JumpLoop','JumpLand','LieDown','LieIdle','StandUp'];
const LOOPING = new Set(['Idle','Walk','Run','JumpLoop','LieIdle']);
const GROUND = new Set(['Idle','Walk','Run']);
const LABELS = {Idle:'待機',Walk:'走路',Run:'跑步',JumpStart:'起跳',JumpLoop:'空中',JumpLand:'落地',LieDown:'趴下中',LieIdle:'休息中',StandUp:'起身中'};
// The model is about the size of a real house cat, so it is shown at 1:1 scale.
const scale = 1;
const RUN_BOOST = 6;      // run is 6× the clip's stride-matched speed (≈ 5.8 m/s)
const RUN_ANIM_RATE = 2;  // play the gallop faster so the legs keep up with the boost
// Pitch is MapLibre's: 0° looks straight down, 90° looks at the horizon.
const VIEWS = {
  third: {fov: 40, minPitch: 20, maxPitch: 82, pitch: 62},
  first: {fov: 60, minPitch: 35, maxPitch: 82, pitch: 76},
};
const DIST = {min: .9, max: 8, initial: 2.4};
const DEG = Math.PI / 180;
const MAX_ZOOM = 25; // MapLibre tile IDs stop at z25
const CAT_RADIUS = .22;
const COLLISION_RANGE = 220;
const COLLISION_REFRESH_DISTANCE = 8;
const COLLISION_SAFE_DISTANCE = 32;
const isTouch = matchMedia('(hover:none) and (pointer:coarse)').matches;

const $ = s => document.querySelector(s);
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const wrapAngle = a => Math.atan2(Math.sin(a), Math.cos(a));
const isNum = v => typeof v === 'number' && Number.isFinite(v);

function fail(message) {
  $('#error').hidden = false;
  $('#error').textContent = message;
}

// Local Three.js frame in meters: X east, Y up, Z south. The cat model faces +Z.
const originMerc = maplibregl.MercatorCoordinate.fromLngLat(START, 0);
const meter = originMerc.meterInMercatorCoordinateUnits();
const localMatrix = new THREE.Matrix4()
  .makeTranslation(originMerc.x, originMerc.y, originMerc.z)
  .scale(new THREE.Vector3(meter, -meter, meter))
  .multiply(new THREE.Matrix4().makeRotationX(Math.PI / 2));
const toLngLat = (x, z) => new maplibregl.MercatorCoordinate(originMerc.x + x * meter, originMerc.y + z * meter, 0).toLngLat();
function fromLngLat(lng, lat) {
  const m = maplibregl.MercatorCoordinate.fromLngLat([lng, lat], 0);
  return {x: (m.x - originMerc.x) / meter, z: (m.y - originMerc.y) / meter};
}

// ---------- Cat state machine (cat-sized units; world position is scaled) ----------
class Cat {
  constructor(durations, onState) {
    this.d = durations;
    this.onState = onState;
    this.walkSpeed = .16 / (.7 * durations.Walk); // stride length / stance time, matches the clip
    this.runSpeed = RUN_BOOST * .27 / (.42 * durations.Run);
    this.running = false;
    this.reset();
  }
  reset() {
    this.x = this.z = this.y = 0; this.vx = this.vz = this.vy = 0;
    this.heading = this.targetHeading = Math.PI; // facing north
    this.intent = {x: 0, z: 0}; this.pendingLie = false;
    this.state = null; this.transition('Idle');
  }
  transition(name) {
    if (name === this.state) return;
    const old = this.state; this.state = name; this.elapsed = 0; this.onState(name, old);
  }
  get moving() { return this.intent.x !== 0 || this.intent.z !== 0; }
  get lying() { return this.pendingLie || this.state === 'LieDown' || this.state === 'LieIdle'; }
  groundClip() { return this.moving ? (this.running ? 'Run' : 'Walk') : 'Idle'; }
  setIntent(x, z) { const m = Math.hypot(x, z); this.intent = m ? {x: x / m, z: z / m} : {x: 0, z: 0}; }
  jump() { if (GROUND.has(this.state) && !this.pendingLie) this.transition('JumpStart'); }
  toggleLie() {
    if (this.state === 'LieIdle') this.transition('StandUp');
    else if (GROUND.has(this.state)) this.pendingLie = !this.pendingLie;
  }
  approach(tx, tz, dt, rate) { const a = 1 - Math.exp(-dt * rate); this.vx += (tx - this.vx) * a; this.vz += (tz - this.vz) * a; }
  step(dt, scale, blocked) {
    this.elapsed += dt;
    if (this.state === 'LieIdle' && this.moving) this.transition('StandUp');
    if (GROUND.has(this.state)) {
      const clip = this.pendingLie ? 'Idle' : this.groundClip();
      this.transition(clip);
      const speed = clip === 'Run' ? this.runSpeed : clip === 'Walk' ? this.walkSpeed : 0;
      this.approach(this.intent.x * speed, this.intent.z * speed, dt, 10);
      if (clip !== 'Idle') this.targetHeading = Math.atan2(this.intent.x, this.intent.z);
      if (this.pendingLie && Math.hypot(this.vx, this.vz) < .01) { this.vx = this.vz = 0; this.pendingLie = false; this.transition('LieDown'); }
    }
    if (this.state === 'JumpStart' && this.elapsed >= this.d.JumpStart) { this.vy = 2.8; this.transition('JumpLoop'); }
    if (this.state === 'JumpLoop') {
      this.vy -= 9.8 * dt; this.y += this.vy * dt;
      if (this.y <= 0 && this.vy < 0) { this.y = this.vy = 0; this.transition('JumpLand'); }
    }
    if (this.state === 'JumpLand') this.approach(0, 0, dt, 6);
    if ((this.state === 'JumpLand' || this.state === 'StandUp') && this.elapsed >= this.d[this.state]) this.transition(this.groundClip());
    if (this.state === 'LieDown' && this.elapsed >= this.d.LieDown) this.transition('LieIdle');
    if (this.state === 'LieDown' || this.state === 'LieIdle' || this.state === 'StandUp') this.vx = this.vz = 0;
    if (GROUND.has(this.state) || this.state === 'JumpStart') {
      const turn = 10 * dt;
      this.heading = wrapAngle(this.heading + clamp(wrapAngle(this.targetHeading - this.heading), -turn, turn));
    }
    const next = moveAroundBuildings(blocked, this.x, this.z, this.x + this.vx * scale * dt, this.z + this.vz * scale * dt, CAT_RADIUS);
    if (next.x === this.x) this.vx = 0;
    if (next.z === this.z) this.vz = 0;
    this.x = next.x;
    this.z = next.z;
  }
  update(dt, scale, blocked) {
    let left = clamp(dt, 0, .1);
    while (left > 1e-8) { const s = Math.min(left, 1 / 120); this.step(s, scale, blocked); left -= s; }
  }
}

// ---------- Three.js scene ----------
const scene = new THREE.Scene();
scene.add(new THREE.HemisphereLight(0xffffff, 0x6c8060, 2.4));
const sun = new THREE.DirectionalLight(0xffeddb, 3.1); sun.position.set(2, 4, 2); scene.add(sun);
const fill = new THREE.DirectionalLight(0xd7e5ff, 1.3); fill.position.set(-3, 2, -2); scene.add(fill);
const actor = new THREE.Group(); scene.add(actor);
const shadow = new THREE.Group();
const shadowMesh = new THREE.Mesh(new THREE.CircleGeometry(1, 40), new THREE.MeshBasicMaterial({color: 0x000000, transparent: true, opacity: .18, depthWrite: false}));
shadowMesh.rotation.x = -Math.PI / 2; shadowMesh.scale.set(.15, .38, 1); shadowMesh.position.z = -.02;
shadow.add(shadowMesh); scene.add(shadow);
const camera = new THREE.Camera();
let renderer;

let cat, mixer, actions = {}, active = null, fades = [], headBone;
let mapBase = 'photo', mapBaseChosen = false, showBuildingFrames = true;
function play(name) {
  const next = actions[name]; if (!next) return;
  next.reset().setEffectiveTimeScale(name === 'Run' ? RUN_ANIM_RATE : 1).setEffectiveWeight(1).play();
  const previous = active; active = next;
  fades = fades.filter(f => f.action !== next);
  if (previous && previous !== next) {
    const t = name === 'JumpLoop' || name === 'JumpLand' ? .06 : .18;
    previous.fadeOut(t); next.fadeIn(t); fades.push({action: previous, left: t});
  }
  $('#st-state').textContent = LABELS[name];
}

// ---------- Map ----------
const map = new maplibregl.Map({
  container: 'map', style: STYLE_URL, center: START, zoom: 21, pitch: 60, bearing: 0,
  maxZoom: MAX_ZOOM, maxPitch: 85, interactive: false,
  pixelRatio: Math.min(devicePixelRatio, 2),
  attributionControl: {compact: true},
  canvasContextAttributes: {antialias: true},
});
map.on('error', e => console.warn(e.error || e));

let collisionFootprints = [], collisionCenter = null, collisionDirty = true, placingCat = false;
map.on('sourcedata', e => { if (e.sourceId === 'openmaptiles') collisionDirty = true; });

function refreshCollisionFootprints() {
  if (!cat || !map.isSourceLoaded('openmaptiles')) return false;
  const features = map.querySourceFeatures('openmaptiles', {sourceLayer: 'building'});
  collisionFootprints = buildFootprints(features, fromLngLat, cat, COLLISION_RANGE);
  collisionCenter = {x: cat.x, z: cat.z};
  collisionDirty = false;
  return true;
}

const buildingBlocks = (x, z) => placingCat || !collisionCenter || !map.isSourceLoaded('openmaptiles') ||
  Math.hypot(x - collisionCenter.x, z - collisionCenter.z) > COLLISION_SAFE_DISTANCE ||
  isBlocked(collisionFootprints, x, z, CAT_RADIUS);

function waitForBuildingTiles() {
  if (map.isSourceLoaded('openmaptiles')) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { map.off('sourcedata', check); reject(new Error('建物資料載入逾時')); }, 15000);
    const check = e => {
      if (e.sourceId !== 'openmaptiles' || !map.isSourceLoaded('openmaptiles')) return;
      clearTimeout(timer); map.off('sourcedata', check); resolve();
    };
    map.on('sourcedata', check);
  });
}

async function placeCatOutsideBuildings() {
  placingCat = true;
  try {
    for (let attempt = 0; attempt < 4; attempt++) {
      map.jumpTo({center: toLngLat(cat.x, cat.z), zoom: 21, pitch: 60});
      map.triggerRepaint();
      await new Promise(resolve => map.once('render', resolve));
      await waitForBuildingTiles();
      refreshCollisionFootprints();
      const safe = findSafePosition(collisionFootprints, cat.x, cat.z, CAT_RADIUS);
      if (!safe) throw new Error('附近找不到可站立的建物外位置');
      if (Math.hypot(safe.x - cat.x, safe.z - cat.z) < .01) return;
      cat.x = safe.x; cat.z = safe.z;
    }
    throw new Error('無法確認建物外的出生位置');
  } finally {
    placingCat = false;
  }
}

function addNlscRaster(id, code, maxzoom = 19) {
  map.addSource(id, {
    type: 'raster',
    tiles: [`${NLSC_WMTS}/${code}/default/GoogleMapsCompatible/{z}/{y}/{x}`],
    tileSize: 256, maxzoom,
    attribution: '<a href="https://maps.nlsc.gov.tw/" target="_blank" rel="noopener noreferrer">內政部國土測繪中心</a>',
  });
  map.addLayer({id, type: 'raster', source: id, layout: {visibility: 'none'}, paint: {'raster-fade-duration': 0}});
}

function syncMapLayers() {
  $('#base-map').value = mapBase;
  $('#building-frames').checked = showBuildingFrames;
  if (!map.getLayer('nlsc-emap')) return;
  for (const [id, visible] of [
    ['nlsc-emap', mapBase === 'emap'],
    ['nlsc-photo', mapBase === 'photo'],
    ['nlsc-labels', mapBase === 'photo'],
    ['nlsc-buildings', showBuildingFrames],
  ]) map.setLayoutProperty(id, 'visibility', visible ? 'visible' : 'none');
}

function setLayerPanelOpen(open) {
  $('#map-layers').hidden = !open;
  $('#map-layer-toggle').setAttribute('aria-expanded', String(open));
}
$('#map-layer-toggle').addEventListener('click', () => setLayerPanelOpen($('#map-layers').hidden));
document.addEventListener('pointerdown', e => {
  if (!$('#map-layers').hidden && !e.target.closest('#map-layers, #map-layer-toggle')) setLayerPanelOpen(false);
});
document.addEventListener('keydown', e => { if (e.code === 'Escape') setLayerPanelOpen(false); });
$('#base-map').addEventListener('change', e => { mapBase = e.target.value; mapBaseChosen = true; syncMapLayers(); saveState(); setLayerPanelOpen(false); });
$('#building-frames').addEventListener('change', e => { showBuildingFrames = e.target.checked; syncMapLayers(); saveState(); setLayerPanelOpen(false); });

const catLayer = {
  id: 'cat', type: 'custom', renderingMode: '3d',
  onAdd(m, gl) {
    renderer = new THREE.WebGLRenderer({canvas: m.getCanvas(), context: gl, antialias: true});
    renderer.autoClear = false;
    renderer.outputColorSpace = THREE.SRGBColorSpace;
  },
  render(gl, args) {
    camera.projectionMatrix.fromArray(args.defaultProjectionData.mainMatrix).multiply(localMatrix);
    camera.projectionMatrixInverse.copy(camera.projectionMatrix).invert();
    renderer.resetState();
    renderer.render(scene, camera);
  },
};

const mapReady = new Promise((resolve, reject) => {
  map.once('load', resolve);
  map.once('error', e => { if (!map.isStyleLoaded()) reject(e.error || e); });
});
map.on('style.load', () => {
  // Prefer Traditional Chinese names, fall back to the local name.
  for (const layer of map.getStyle().layers) {
    if (layer.type !== 'symbol') continue;
    const field = map.getLayoutProperty(layer.id, 'text-field');
    if (field && JSON.stringify(field).includes('name')) map.setLayoutProperty(layer.id, 'text-field', ['coalesce', ['get', 'name:zh-Hant'], ['get', 'name']]);
  }
  map.setSky({'sky-color': '#7fb4ec', 'horizon-color': '#dcebf7', 'fog-color': '#e6eef4', 'sky-horizon-blend': .6, 'horizon-fog-blend': .7, 'fog-ground-blend': .8, 'atmosphere-blend': 0});
  addNlscRaster('nlsc-emap', 'EMAP');
  addNlscRaster('nlsc-photo', 'PHOTO2');
  addNlscRaster('nlsc-labels', 'EMAP2');
  addNlscRaster('nlsc-buildings', 'BUILDX');
  syncMapLayers();
  if (!map.getLayer('cat')) map.addLayer(catLayer);
});

// ---------- Camera & input ----------
let view = 'third', yaw = 0, thirdDist = DIST.initial, eyeOffset = null;
const pitchOf = {third: VIEWS.third.pitch, first: VIEWS.first.pitch};
const held = new Set();
const stick = {x: 0, y: 0};
const canvas = map.getCanvas();

function setView(next) {
  view = next;
  map.setVerticalFieldOfView(VIEWS[view].fov);
  eyeOffset = null;
  $('#st-view').textContent = view === 'first' ? '第一人稱' : '第三人稱';
  $('#crosshair').hidden = view !== 'first';
  $('#btn-view').classList.toggle('on', view === 'first');
}
function toggleRun() {
  cat.running = !cat.running;
  syncGait();
}
function syncGait() {
  $('#st-gait').textContent = cat.running ? '跑步' : '走路';
  $('#btn-run').classList.toggle('on', cat.running);
}

function look(dx, dy) {
  yaw = (yaw + dx * .15 + 360) % 360;
  const v = VIEWS[view];
  pitchOf[view] = clamp(pitchOf[view] - dy * .12, v.minPitch, v.maxPitch);
}

function applyInput() {
  const f = (held.has('KeyW') || held.has('ArrowUp') ? 1 : 0) - (held.has('KeyS') || held.has('ArrowDown') ? 1 : 0) + stick.y;
  const r = (held.has('KeyD') || held.has('ArrowRight') ? 1 : 0) - (held.has('KeyA') || held.has('ArrowLeft') ? 1 : 0) + stick.x;
  const b = yaw * DEG; // forward = (sin b, -cos b), right = (cos b, sin b) in local X/Z
  cat.setIntent(f * Math.sin(b) + r * Math.cos(b), -f * Math.cos(b) + r * Math.sin(b));
}

// Shortest camera-to-ground-center distance (m) that stays under MAX_ZOOM.
function minCenterDistance() {
  const ctc = canvas.clientHeight / 2 / Math.tan(VIEWS[view].fov / 2 * DEG);
  return ctc / (512 * 2 ** (MAX_ZOOM - .1) * meter);
}

const headPos = new THREE.Vector3();
function updateCamera(dt) {
  const b = yaw * DEG, minDist = minCenterDistance();
  let cx, cy, cz, pitch = pitchOf[view];
  if (view === 'first') {
    // Very close to the ground the look-down angle is limited by the zoom cap.
    const eyeY = (eyeOffset?.y ?? .5 * scale);
    pitch = pitchOf.first = clamp(pitch, Math.max(VIEWS.first.minPitch, Math.acos(Math.min(1, eyeY / minDist)) / DEG), VIEWS.first.maxPitch);
  }
  const p = pitch * DEG;
  if (view === 'third') {
    const ty = (cat.y + .35) * scale;
    const d = Math.max(thirdDist * scale, minDist - ty / Math.cos(p));
    cx = cat.x - d * Math.sin(p) * Math.sin(b);
    cz = cat.z + d * Math.sin(p) * Math.cos(b);
    cy = ty + d * Math.cos(p);
  } else {
    // Eye just in front of the head bone, smoothed so walk bobbing doesn't shake the view.
    headBone.getWorldPosition(headPos);
    const fwd = .09 * scale;
    const target = new THREE.Vector3(headPos.x + Math.sin(cat.heading) * fwd - cat.x, headPos.y + .05 * scale, headPos.z + Math.cos(cat.heading) * fwd - cat.z);
    if (!eyeOffset) eyeOffset = target; else eyeOffset.lerp(target, 1 - Math.exp(-dt * 10));
    cx = cat.x + eyeOffset.x; cy = eyeOffset.y; cz = cat.z + eyeOffset.z;
  }
  map.jumpTo(map.calculateCameraOptionsFromCameraLngLatAltRotation(toLngLat(cx, cz), Math.max(cy, .05), yaw, pitch));
}

let last = 0, hudClock = 0;
function frame(now) {
  const dt = last ? Math.min((now - last) / 1000, .1) : 0; last = now;
  applyInput();
  if (collisionDirty || !collisionCenter || Math.hypot(cat.x - collisionCenter.x, cat.z - collisionCenter.z) > COLLISION_REFRESH_DISTANCE) refreshCollisionFootprints();
  cat.update(dt, scale, buildingBlocks);
  mixer.update(dt);
  for (const f of fades) { f.left -= dt; if (f.left <= 0 && f.action !== active) f.action.stop(); }
  fades = fades.filter(f => f.left > 0);

  actor.position.set(cat.x, cat.y * scale, cat.z);
  actor.rotation.y = cat.heading;
  actor.scale.setScalar(scale);
  actor.visible = shadow.visible = view === 'third';
  shadow.position.set(cat.x, .005 * scale, cat.z);
  shadow.rotation.y = cat.heading;
  shadow.scale.setScalar(scale * (1 - Math.min(cat.y, .5)));
  scene.updateMatrixWorld(true);

  updateCamera(dt);
  map.triggerRepaint();

  hudClock += dt;
  if (hudClock > .15) {
    hudClock = 0;
    $('#st-speed').textContent = `${(Math.hypot(cat.vx, cat.vz) * scale).toFixed(1)} m/s`;
    $('#btn-lie').classList.toggle('on', cat.lying);
  }
  requestAnimationFrame(frame);
}

// ---------- Save / restore (localStorage) ----------
function saveState() {
  if (!cat) return;
  const {lng, lat} = toLngLat(cat.x, cat.z);
  const data = {lng, lat, heading: cat.heading, running: cat.running, lying: cat.lying, view, yaw, pitch: pitchOf, thirdDist, mapBase, mapBaseChosen, showBuildingFrames};
  try { localStorage.setItem(SAVE_KEY, JSON.stringify(data)); } catch {}
}
function restoreState() {
  let s;
  try { s = JSON.parse(localStorage.getItem(SAVE_KEY)); } catch {}
  if (!s || typeof s !== 'object') return;
  if (isNum(s.lng) && isNum(s.lat) && Math.abs(s.lat) < 85) Object.assign(cat, fromLngLat(s.lng, s.lat));
  if (isNum(s.heading)) cat.heading = cat.targetHeading = wrapAngle(s.heading);
  cat.running = s.running === true;
  if (s.lying === true) cat.transition('LieIdle');
  if (isNum(s.yaw)) yaw = ((s.yaw % 360) + 360) % 360;
  for (const v of ['third', 'first']) if (isNum(s.pitch?.[v])) pitchOf[v] = clamp(s.pitch[v], VIEWS[v].minPitch, VIEWS[v].maxPitch);
  if (isNum(s.thirdDist)) thirdDist = clamp(s.thirdDist, DIST.min, DIST.max);
  if (s.view === 'first') view = 'first';
  if (MAP_BASES.includes(s.mapBase) && (s.mapBaseChosen === true || s.mapBase !== 'streets')) {
    mapBase = s.mapBase; mapBaseChosen = true;
  }
  if (typeof s.showBuildingFrames === 'boolean') showBuildingFrames = s.showBuildingFrames;
  syncMapLayers();
}
setInterval(saveState, 1000);
window.addEventListener('pagehide', saveState);
document.addEventListener('visibilitychange', () => { if (document.hidden) saveState(); });

// ---------- Mouse ----------
const lockPointer = () => { try { canvas.requestPointerLock()?.catch?.(() => {}); } catch {} };
let drag = null;
canvas.addEventListener('pointerdown', e => { if (e.pointerType === 'mouse' && e.button === 0) drag = {moved: 0}; });
document.addEventListener('mousemove', e => {
  if (document.pointerLockElement === canvas) look(e.movementX, e.movementY);
  else if (drag) { look(e.movementX, e.movementY); drag.moved += Math.abs(e.movementX) + Math.abs(e.movementY); }
});
window.addEventListener('pointerup', e => {
  if (e.pointerType === 'mouse' && drag && drag.moved < 4 && $('#overlay').hidden) lockPointer();
  drag = null;
});
canvas.addEventListener('contextmenu', e => e.preventDefault());
canvas.addEventListener('wheel', e => {
  e.preventDefault();
  if (view === 'third') thirdDist = clamp(thirdDist * Math.exp(e.deltaY * .0015), DIST.min, DIST.max);
}, {passive: false});
document.addEventListener('pointerlockchange', () => {
  $('#lock-hint').hidden = !!document.pointerLockElement || !$('#overlay').hidden;
});

// ---------- Touch: drag to look, pinch to zoom ----------
const touches = new Map();
let pinchDist = null;
canvas.addEventListener('pointerdown', e => {
  if (e.pointerType === 'mouse') return;
  canvas.setPointerCapture(e.pointerId);
  touches.set(e.pointerId, {x: e.clientX, y: e.clientY});
  pinchDist = null;
});
canvas.addEventListener('pointermove', e => {
  const prev = touches.get(e.pointerId);
  if (!prev) return;
  const cur = {x: e.clientX, y: e.clientY};
  touches.set(e.pointerId, cur);
  if (touches.size === 1) { look((cur.x - prev.x) * 1.8, (cur.y - prev.y) * 1.8); return; }
  const [a, b] = [...touches.values()];
  const d = Math.hypot(a.x - b.x, a.y - b.y);
  if (pinchDist && view === 'third') thirdDist = clamp(thirdDist * pinchDist / d, DIST.min, DIST.max);
  pinchDist = d;
});
const endTouch = e => { touches.delete(e.pointerId); pinchDist = null; };
canvas.addEventListener('pointerup', endTouch);
canvas.addEventListener('pointercancel', endTouch);

// Virtual joystick
const stickEl = $('#stick'), knob = $('#knob');
let stickId = null;
function moveStick(e) {
  const r = stickEl.getBoundingClientRect(), max = r.width / 2;
  let dx = e.clientX - (r.left + max), dy = e.clientY - (r.top + max);
  const len = Math.hypot(dx, dy);
  if (len > max) { dx *= max / len; dy *= max / len; }
  knob.style.transform = `translate(${dx}px, ${dy}px)`;
  const n = Math.hypot(dx, dy) / max;
  stick.x = n > .2 ? dx / max : 0;
  stick.y = n > .2 ? -dy / max : 0;
}
function releaseStick() { stickId = null; stick.x = stick.y = 0; knob.style.transform = ''; }
stickEl.addEventListener('pointerdown', e => { e.preventDefault(); stickId = e.pointerId; stickEl.setPointerCapture(e.pointerId); moveStick(e); });
stickEl.addEventListener('pointermove', e => { if (e.pointerId === stickId) moveStick(e); });
stickEl.addEventListener('pointerup', releaseStick);
stickEl.addEventListener('pointercancel', releaseStick);

// Touch action buttons (pointerdown so they react instantly)
const tap = (id, fn) => $(id).addEventListener('pointerdown', e => { e.preventDefault(); if (cat) fn(); });
tap('#btn-jump', () => cat.jump());
tap('#btn-run', toggleRun);
tap('#btn-lie', () => cat.toggleLie());
tap('#btn-view', () => setView(view === 'third' ? 'first' : 'third'));

// ---------- Keyboard ----------
const MOVE_KEYS = new Set(['KeyW','KeyA','KeyS','KeyD','ArrowUp','ArrowDown','ArrowLeft','ArrowRight']);
window.addEventListener('keydown', e => {
  if (e.code === 'Tab') e.preventDefault();
  if (!cat || !$('#overlay').hidden) return;
  if (MOVE_KEYS.has(e.code)) { e.preventDefault(); held.add(e.code); return; }
  if (e.repeat) { if (e.code === 'Space') e.preventDefault(); return; }
  switch (e.code) {
    case 'Space': e.preventDefault(); cat.jump(); break;
    case 'ControlLeft': case 'ControlRight': e.preventDefault(); cat.toggleLie(); break;
    case 'Tab': setView(view === 'third' ? 'first' : 'third'); break;
    case 'KeyR': if (!e.ctrlKey && !e.metaKey) toggleRun(); break; // keep Ctrl+R reload
    case 'KeyM': mapBase = MAP_BASES[(MAP_BASES.indexOf(mapBase) + 1) % MAP_BASES.length]; mapBaseChosen = true; syncMapLayers(); saveState(); break;
    case 'KeyB': showBuildingFrames = !showBuildingFrames; syncMapLayers(); saveState(); break;
  }
});
window.addEventListener('keyup', e => held.delete(e.code));
window.addEventListener('blur', () => { held.clear(); releaseStick(); });
document.addEventListener('visibilitychange', () => { held.clear(); releaseStick(); last = 0; });

$('#reset').addEventListener('click', async e => {
  const button = e.currentTarget;
  button.disabled = true;
  const previous = {x: cat.x, z: cat.z};
  cat.reset(); yaw = 0; eyeOffset = null; thirdDist = DIST.initial;
  pitchOf.third = VIEWS.third.pitch; pitchOf.first = VIEWS.first.pitch;
  try { await placeCatOutsideBuildings(); }
  catch (error) { Object.assign(cat, previous); fail(`無法修正出生位置：${error.message}`); }
  saveState();
  button.disabled = false;
  button.blur();
});
$('#start').addEventListener('click', () => {
  $('#overlay').hidden = true;
  if (!isTouch) { $('#lock-hint').hidden = false; lockPointer(); }
});

// ---------- Boot ----------
try {
  const [gltf] = await Promise.all([new GLTFLoader().loadAsync(MODEL_URL), mapReady]);
  const durations = Object.fromEntries(gltf.animations.map(c => [c.name, c.duration]));
  const missing = CLIPS.filter(n => !(durations[n] > 0));
  if (missing.length) throw new Error(`模型缺少動畫：${missing.join(', ')}`);
  gltf.scene.traverse(o => { if (o.isMesh) o.frustumCulled = false; });
  headBone = gltf.scene.getObjectByName('head');
  actor.add(gltf.scene);
  mixer = new THREE.AnimationMixer(gltf.scene);
  for (const clip of gltf.animations) {
    const a = mixer.clipAction(clip), loop = LOOPING.has(clip.name);
    a.setLoop(loop ? THREE.LoopRepeat : THREE.LoopOnce, loop ? Infinity : 1);
    a.clampWhenFinished = !loop;
    actions[clip.name] = a;
  }
  cat = new Cat(durations, play);
  restoreState();
  setView(view);
  syncGait();
  await placeCatOutsideBuildings();
  $('#overlay-msg').textContent = isTouch
    ? '左下搖桿移動，右下按鈕跳躍／跑步／趴下／切換視角，拖曳畫面轉動鏡頭、雙指縮放。'
    : '點「開始」後用滑鼠看方向，WASD 帶小貓散步。';
  $('#start').disabled = false;
  requestAnimationFrame(frame);
  window.catGame = {get cat() { return cat; }, get view() { return view; }, get yaw() { return yaw; }, get pitch() { return pitchOf[view]; }, map};
} catch (e) {
  console.error(e);
  $('#overlay-msg').textContent = '載入失敗，請確認網路連線後重新整理。';
  fail(`載入失敗：${e?.message || e}`);
}
