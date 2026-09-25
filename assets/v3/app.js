import * as THREE from 'three';
import {GLTFLoader} from 'three/addons/loaders/GLTFLoader.js';
import {RoomEnvironment} from 'three/addons/environments/RoomEnvironment.js';
import {Reflector} from 'three/addons/objects/Reflector.js';
import {HOUSE, TownhouseWorld, moveCharacter} from './townhouse-navigation.mjs';
import {addFur} from '../shared/cat-fur.mjs';

// Switchable cat models (C key / HUD button). They share the clip contract
// (names, lengths, stride), so the state machine and speeds carry over.
const CAT_MODELS = {
  v01: {url: new URL('../shared/cat_v01.glb', import.meta.url).href, label: '細臉版'},
  v02: {url: new URL('../shared/cat_v02.glb', import.meta.url).href, label: '短頸版'},
};
const HOUSE_URL = new URL('./townhouse_30x15_3floors_v2.glb', import.meta.url).href;
// Bumped when the floor plan changes, so an old save can't drop the cat into a
// spot that is now inside a wall or a closed-off stair base.
const SAVE_KEY = 'happycat.state.v3.house2';
const CLIPS = ['Idle','Walk','Run','JumpStart','JumpLoop','JumpLand','LieDown','LieIdle','StandUp'];
const LOOPING = new Set(['Idle','Walk','Run','JumpLoop','LieIdle']);
const GROUND = new Set(['Idle','Walk','Run']);
const LABELS = {Idle:'待機',Walk:'走路',Run:'跑步',JumpStart:'起跳',JumpLoop:'空中',JumpLand:'落地',LieDown:'趴下中',LieIdle:'休息中',StandUp:'起身中'};
const RUN_BOOST = 6;      // run is 6× the clip's stride-matched speed (≈ 5.8 m/s)
const RUN_ANIM_RATE = 2;  // play the gallop faster so the legs keep up with the boost
// Pitch: 0° looks straight down, 90° looks at the horizon, >90° looks up.
const VIEWS = {
  third: {fov: 40, minPitch: 15, maxPitch: 95, pitch: 72},
  first: {fov: 60, minPitch: 15, maxPitch: 125, pitch: 88},
};
const DIST = {min: .9, max: 8, initial: 2.4};
const DEG = Math.PI / 180;
const SKY = 0xa9cff2;
const isTouch = matchMedia('(hover:none) and (pointer:coarse)').matches;

const $ = s => document.querySelector(s);
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const wrapAngle = a => Math.atan2(Math.sin(a), Math.cos(a));
const isNum = v => typeof v === 'number' && Number.isFinite(v);

function fail(message) {
  $('#error').hidden = false;
  $('#error').textContent = message;
}

// World frame in meters: X east, Y up, Z south. The cat model faces +Z.
// ---------- Cat state machine ----------
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
    this.grounded = true;
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
  jump() { if (this.grounded && GROUND.has(this.state) && !this.pendingLie) this.transition('JumpStart'); }
  toggleLie() {
    if (this.state === 'LieIdle') this.transition('StandUp');
    else if (GROUND.has(this.state)) this.pendingLie = !this.pendingLie;
  }
  approach(tx, tz, dt, rate) { const a = 1 - Math.exp(-dt * rate); this.vx += (tx - this.vx) * a; this.vz += (tz - this.vz) * a; }
  step(dt, blocked) {
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
    if (this.state === 'JumpStart' && this.elapsed >= this.d.JumpStart) { this.vy = 2.8; this.grounded = false; this.transition('JumpLoop'); }
    if (this.state === 'JumpLand') this.approach(0, 0, dt, 6);
    if ((this.state === 'JumpLand' || this.state === 'StandUp') && this.elapsed >= this.d[this.state]) this.transition(this.groundClip());
    if (this.state === 'LieDown' && this.elapsed >= this.d.LieDown) this.transition('LieIdle');
    if (this.state === 'LieDown' || this.state === 'LieIdle' || this.state === 'StandUp') this.vx = this.vz = 0;
    if (GROUND.has(this.state) || this.state === 'JumpStart') {
      const turn = 10 * dt;
      this.heading = wrapAngle(this.heading + clamp(wrapAngle(this.targetHeading - this.heading), -turn, turn));
    }
    const oldX = this.x, oldZ = this.z;
    moveCharacter(this, this.vx * dt, this.vz * dt, dt, houseWorld, blocked);
    if (this.x === oldX) this.vx = 0;
    if (this.z === oldZ) this.vz = 0;
    if (this.grounded && this.state === 'JumpLoop') this.transition('JumpLand');
    else if (!this.grounded && GROUND.has(this.state)) this.transition('JumpLoop');
  }
  update(dt, blocked) {
    let left = clamp(dt, 0, .1);
    while (left > 1e-8) { const s = Math.min(left, 1 / 120); this.step(s, blocked); left -= s; }
  }
}

// ---------- Three.js scene ----------
const canvas = $('#scene');
const renderer = new THREE.WebGLRenderer({canvas, antialias: true});
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.outputColorSpace = THREE.SRGBColorSpace;
// Neutral tone mapping keeps base colours but rolls off highlights, so pale
// tiles and plaster indoors no longer clip to flat white.
renderer.toneMapping = THREE.NeutralToneMapping;
const scene = new THREE.Scene();
scene.background = new THREE.Color(SKY);
scene.fog = new THREE.Fog(SKY, 60, 260);
// Warm ground bounce: a green (lawn) tint turned every indoor ceiling olive.
const hemi = new THREE.HemisphereLight(0xffffff, 0x9a8d7c); scene.add(hemi);
// A soft room environment gives metals and mirrors something to reflect;
// without it fully metallic surfaces render black.
scene.environment = new THREE.PMREMGenerator(renderer).fromScene(new RoomEnvironment(), .04).texture;
const sun = new THREE.DirectionalLight(0xffeddb, 3.1); sun.position.set(2, 4, 2); scene.add(sun);
const fill = new THREE.DirectionalLight(0xd7e5ff); fill.position.set(-3, 2, -2); scene.add(fill);
// Without shadows the sun reaches every room, so frame() blends to the indoor
// set while the camera is inside the house. Indoors trims the even ambient and
// fill light but keeps the sun: faces toward it stay bright while the rest
// darken, so rooms read dimmer without going flat. Exposure scales every lit
// surface; sky and fog colours are unaffected.
const LIGHTING = {
  outdoor: {exposure: 1, hemi: 2.1, fill: 1.3, env: .35},
  indoor: {exposure: .9, hemi: 1.2, fill: .6, env: .2},
};
let indoorMix = 0;
function setLighting(t) {
  const mix = key => THREE.MathUtils.lerp(LIGHTING.outdoor[key], LIGHTING.indoor[key], t);
  renderer.toneMappingExposure = mix('exposure');
  hemi.intensity = mix('hemi');
  fill.intensity = mix('fill');
  scene.environmentIntensity = mix('env');
}
setLighting(indoorMix);
const lawn = new THREE.Mesh(new THREE.PlaneGeometry(600, 600), new THREE.MeshStandardMaterial({color: 0x8fae6b, roughness: 1}));
lawn.rotation.x = -Math.PI / 2; lawn.position.set(HOUSE.x, -.03, HOUSE.z); scene.add(lawn);
const actor = new THREE.Group(); scene.add(actor);
const shadow = new THREE.Group();
const shadowMesh = new THREE.Mesh(new THREE.CircleGeometry(1, 40), new THREE.MeshBasicMaterial({color: 0x000000, transparent: true, opacity: .18, depthWrite: false}));
shadowMesh.rotation.x = -Math.PI / 2; shadowMesh.scale.set(.15, .38, 1); shadowMesh.position.z = -.02;
shadow.add(shadowMesh); scene.add(shadow);
const camera = new THREE.PerspectiveCamera(VIEWS.third.fov, 1, .025, 400);
let houseWorld = null;
// The cat stays on the yard around the house.
const yardBlocks = (x, z) => !houseWorld.contains(x, z, -HOUSE.radius);

// ---------- Mirrors ----------
// Mirror glass in the house GLB carries a `mirror` extra ('rect' or 'round').
// The nearest mirror facing the camera shows a live reflection; the others keep
// their PBR mirror material, which reflects the room environment.
const mirrors = [];
function setupMirrors(model) {
  model.updateMatrixWorld(true);
  const size = isTouch ? 512 : 1024;
  model.traverse(mesh => {
    if (!mesh.isMesh || !mesh.userData.mirror) return;
    const box = new THREE.Box3().setFromObject(mesh);
    const center = box.getCenter(new THREE.Vector3()), dims = box.getSize(new THREE.Vector3());
    const normal = new THREE.Vector3().fromBufferAttribute(mesh.geometry.attributes.normal, 0).transformDirection(mesh.matrixWorld);
    const width = Math.abs(normal.x) > Math.abs(normal.z) ? dims.z : dims.x;
    const geometry = mesh.userData.mirror === 'round' ? new THREE.CircleGeometry(dims.y / 2, 48) : new THREE.PlaneGeometry(width, dims.y);
    // No clip bias: the frame sits millimetres behind the glass and a biased
    // clip plane let its black back face into the reflection.
    const reflector = new Reflector(geometry, {textureWidth: size, textureHeight: size, color: 0xbcc0c3, clipBias: 0});
    reflector.position.copy(center).addScaledVector(normal, .005);
    reflector.lookAt(reflector.position.clone().add(normal));
    reflector.visible = false;
    // In first person the cat is hidden from the main camera; show it to the mirror.
    const renderReflection = reflector.onBeforeRender;
    reflector.onBeforeRender = function (...args) {
      const shown = actor.visible;
      actor.visible = shadow.visible = true;
      renderReflection.apply(this, args);
      actor.visible = shadow.visible = shown;
    };
    scene.add(reflector);
    mirrors.push({mesh, reflector, center, normal});
  });
}
const toCamera = new THREE.Vector3();
function updateMirrors() {
  let live = null, nearest = 6;
  for (const m of mirrors) {
    toCamera.subVectors(camera.position, m.center);
    const d = toCamera.length();
    if (d < nearest && toCamera.dot(m.normal) > .05 && Math.abs(toCamera.y) < 2.2) { live = m; nearest = d; }
  }
  for (const m of mirrors) { m.reflector.visible = m === live; m.mesh.visible = m !== live; }
}

function resize() {
  renderer.setSize(innerWidth, innerHeight, false);
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
}
resize();
window.addEventListener('resize', resize);

let cat, mixer, actions = {}, active = null, fades = [], headBone;
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

// ---------- Cat models ----------
// Each model is prepared once (fur, mixer, actions) and kept, so switching back is instant.
const catRigs = {};
let catModel = savedCatModel(), switching = false;
async function loadCatRig(key) {
  if (catRigs[key]) return catRigs[key];
  const gltf = await new GLTFLoader().loadAsync(CAT_MODELS[key].url);
  const durations = Object.fromEntries(gltf.animations.map(c => [c.name, c.duration]));
  const missing = CLIPS.filter(n => !(durations[n] > 0));
  if (missing.length) throw new Error(`模型缺少動畫：${missing.join(', ')}`);
  gltf.scene.traverse(o => { if (o.isMesh) o.frustumCulled = false; });
  addFur(gltf.scene, {layers: isTouch ? 8 : 12});
  const rigMixer = new THREE.AnimationMixer(gltf.scene), rigActions = {};
  for (const clip of gltf.animations) {
    const a = rigMixer.clipAction(clip), loop = LOOPING.has(clip.name);
    a.setLoop(loop ? THREE.LoopRepeat : THREE.LoopOnce, loop ? Infinity : 1);
    a.clampWhenFinished = !loop;
    rigActions[clip.name] = a;
  }
  return catRigs[key] = {scene: gltf.scene, mixer: rigMixer, actions: rigActions, head: gltf.scene.getObjectByName('head'), durations};
}
// Put a loaded model on the actor and continue the current clip where the old one was.
function mountCat(key) {
  const rig = catRigs[key], state = cat?.state, time = active?.time ?? 0;
  actor.clear();
  actor.add(rig.scene);
  ({mixer, actions} = rig);
  headBone = rig.head;
  mixer.stopAllAction();
  active = null; fades = []; eyeOffset = null;
  catModel = key;
  if (state) { play(state); active.time = Math.min(time, active.getClip().duration); }
  $('#st-cat').textContent = CAT_MODELS[key].label;
}
async function switchCat() {
  if (!cat || switching) return;
  const next = catModel === 'v01' ? 'v02' : 'v01';
  switching = true;
  $('#swap-cat').disabled = true;
  $('#st-cat').textContent = '載入中…';
  try {
    await loadCatRig(next);
    mountCat(next);
    saveState();
  } catch (e) {
    console.error(e);
    $('#st-cat').textContent = CAT_MODELS[catModel].label;
    fail(`貓咪模型載入失敗：${e?.message || e}`);
  } finally {
    switching = false;
    $('#swap-cat').disabled = false;
  }
}

// ---------- Camera & input ----------
let view = 'third', yaw = 0, thirdDist = DIST.initial, eyeOffset = null;
const pitchOf = {third: VIEWS.third.pitch, first: VIEWS.first.pitch};
const held = new Set();
const stick = {x: 0, y: 0};

function setView(next) {
  view = next;
  camera.fov = VIEWS[view].fov;
  camera.updateProjectionMatrix();
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
  const b = yaw * DEG; // forward = (sin b, -cos b), right = (cos b, sin b) in X/Z
  cat.setIntent(f * Math.sin(b) + r * Math.cos(b), -f * Math.cos(b) + r * Math.sin(b));
}

const headPos = new THREE.Vector3();
function updateCamera(dt) {
  const b = yaw * DEG, p = pitchOf[view] * DEG;
  let cx, cy, cz;
  if (view === 'third') {
    const target = new THREE.Vector3(cat.x, cat.y + .35, cat.z);
    const desired = new THREE.Vector3(
      cat.x - thirdDist * Math.sin(p) * Math.sin(b),
      target.y + thirdDist * Math.cos(p),
      cat.z + thirdDist * Math.sin(p) * Math.cos(b));
    const safe = houseWorld.cameraDistance(target, desired);
    desired.sub(target).setLength(safe).add(target);
    cx = desired.x; cy = Math.max(desired.y, .05); cz = desired.z;
  } else {
    // Eye just in front of the head bone, smoothed so walk bobbing doesn't shake the view.
    headBone.getWorldPosition(headPos);
    const target = new THREE.Vector3(headPos.x + Math.sin(cat.heading) * .09 - cat.x, headPos.y + .05, headPos.z + Math.cos(cat.heading) * .09 - cat.z);
    if (!eyeOffset) eyeOffset = target; else eyeOffset.lerp(target, 1 - Math.exp(-dt * 10));
    cx = cat.x + eyeOffset.x; cy = eyeOffset.y; cz = cat.z + eyeOffset.z;
  }
  camera.position.set(cx, cy, cz);
  camera.lookAt(cx + Math.sin(p) * Math.sin(b), cy - Math.cos(p), cz - Math.sin(p) * Math.cos(b));
}

let last = 0, hudClock = 0;
function frame(now) {
  const dt = last ? Math.min((now - last) / 1000, .1) : 0; last = now;
  applyInput();
  cat.update(dt, yardBlocks);
  mixer.update(dt);
  for (const f of fades) { f.left -= dt; if (f.left <= 0 && f.action !== active) f.action.stop(); }
  fades = fades.filter(f => f.left > 0);

  actor.position.set(cat.x, cat.y, cat.z);
  actor.rotation.y = cat.heading;
  actor.visible = shadow.visible = view === 'third';
  const support = houseWorld.floor(cat.x, cat.z, cat.y + .01);
  shadow.position.set(cat.x, support + .012, cat.z);   // above 5 mm rugs and bath mats
  shadow.rotation.y = cat.heading;
  shadow.scale.setScalar(1 - Math.min(Math.max(0, cat.y - support), .5));
  scene.updateMatrixWorld(true);

  updateCamera(dt);
  updateMirrors();
  // Ease between light sets so crossing the doorway reads as the eye adjusting.
  const inside = houseWorld.inside(camera.position.x, camera.position.z) ? 1 : 0;
  indoorMix += (inside - indoorMix) * (1 - Math.exp(-dt * 3));
  setLighting(indoorMix);
  renderer.render(scene, camera);

  hudClock += dt;
  if (hudClock > .15) {
    hudClock = 0;
    $('#st-speed').textContent = `${Math.hypot(cat.vx, cat.vz).toFixed(1)} m/s`;
    $('#btn-lie').classList.toggle('on', cat.lying);
    $('#st-floor').textContent = houseWorld.inside(cat.x, cat.z) ? `${Math.min(3, Math.floor(Math.max(0, cat.y - .205) / 3) + 1)} 樓 · ${cat.y.toFixed(2)} m` : '庭院';
  }
  requestAnimationFrame(frame);
}

// ---------- Save / restore (localStorage) ----------
function saveState() {
  if (!cat) return;
  const data = {x: cat.x, z: cat.z, y: houseWorld.floor(cat.x, cat.z, cat.y + .01), heading: cat.heading, running: cat.running, lying: cat.lying, view, yaw, pitch: pitchOf, thirdDist, model: catModel};
  try { localStorage.setItem(SAVE_KEY, JSON.stringify(data)); } catch {}
}
// The model is needed before boot (to know which GLB to load), ahead of restoreState().
function savedCatModel() {
  let model;
  try { model = JSON.parse(localStorage.getItem(SAVE_KEY))?.model; } catch {}
  return Object.hasOwn(CAT_MODELS, model) ? model : 'v01';
}
function restoreState() {
  let s;
  try { s = JSON.parse(localStorage.getItem(SAVE_KEY)); } catch {}
  if (!s || typeof s !== 'object') return;
  if (isNum(s.x) && isNum(s.z) && isNum(s.y) && !yardBlocks(s.x, s.z)) {
    const y = houseWorld.floor(s.x, s.z, clamp(s.y, 0, 6.225) + HOUSE.step);
    if (!houseWorld.blocked(s.x, s.z, y)) Object.assign(cat, {x: s.x, z: s.z, y});
  }
  if (isNum(s.heading)) cat.heading = cat.targetHeading = wrapAngle(s.heading);
  cat.running = s.running === true;
  if (s.lying === true) cat.transition('LieIdle');
  if (isNum(s.yaw)) yaw = ((s.yaw % 360) + 360) % 360;
  for (const v of ['third', 'first']) if (isNum(s.pitch?.[v])) pitchOf[v] = clamp(s.pitch[v], VIEWS[v].minPitch, VIEWS[v].maxPitch);
  if (isNum(s.thirdDist)) thirdDist = clamp(s.thirdDist, DIST.min, DIST.max);
  if (s.view === 'first') view = 'first';
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
    case 'KeyC': if (!e.ctrlKey && !e.metaKey) switchCat(); break;
  }
});
window.addEventListener('keyup', e => held.delete(e.code));
window.addEventListener('blur', () => { held.clear(); releaseStick(); });
document.addEventListener('visibilitychange', () => { held.clear(); releaseStick(); last = 0; });

$('#reset').addEventListener('click', e => {
  held.clear(); releaseStick();
  cat.reset(); Object.assign(cat, HOUSE.entrance);
  yaw = 0; eyeOffset = null; thirdDist = DIST.initial;
  pitchOf.third = VIEWS.third.pitch; pitchOf.first = VIEWS.first.pitch;
  saveState();
  e.currentTarget.blur();
});
$('#swap-cat').addEventListener('click', e => {
  switchCat();
  e.currentTarget.blur();
});
$('#start').addEventListener('click', () => {
  $('#overlay').hidden = true;
  if (!isTouch) { $('#lock-hint').hidden = false; lockPointer(); }
});

// ---------- Boot ----------
try {
  const [rig, house] = await Promise.all([loadCatRig(catModel), new GLTFLoader().loadAsync(HOUSE_URL)]);
  const houseModel = house.scene;
  houseModel.position.set(HOUSE.x, 0, HOUSE.z);
  const lights = [];
  houseModel.traverse(o => { if (o.isLight) lights.push(o); });
  // The shared scene's ambient lighting lights all rooms without 21 realtime lights.
  for (const light of lights) light.removeFromParent();
  scene.add(houseModel);
  houseWorld = new TownhouseWorld(houseModel);
  setupMirrors(houseModel);
  const yard = new THREE.Mesh(new THREE.PlaneGeometry(40, 28), new THREE.MeshStandardMaterial({color: 0xb9b5a4, roughness: 1}));
  yard.rotation.x = -Math.PI / 2; yard.position.set(HOUSE.x, -.012, HOUSE.z); scene.add(yard);

  mountCat(catModel);
  cat = new Cat(rig.durations, play);
  Object.assign(cat, HOUSE.entrance);
  restoreState();
  setView(view);
  syncGait();
  $('#overlay-msg').textContent = isTouch
    ? '左下搖桿移動，右下按鈕跳躍／跑步／趴下／切換視角，拖曳畫面轉動鏡頭、雙指縮放。'
    : '點「開始」後用滑鼠看方向，WASD 帶小貓從正門進屋，沿樓梯探索三層樓。';
  $('#start').disabled = false;
  requestAnimationFrame(frame);
  window.catGame = {get cat() { return cat; }, get model() { return catModel; }, get view() { return view; }, get yaw() { return yaw; }, get pitch() { return pitchOf[view]; }, houseWorld, camera};
} catch (e) {
  console.error(e);
  $('#overlay-msg').textContent = '載入失敗，請確認網路連線後重新整理。';
  fail(`載入失敗：${e?.message || e}`);
}
