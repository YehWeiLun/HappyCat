const $ = id => document.getElementById(id);
const setText = (id, value) => {
  const element = $(id);
  if (element.textContent !== value) element.textContent = value;
};
const message = text => {
  setText('message', text);
};

const compactUI = matchMedia('(max-width:640px), (max-height:520px)');
function syncCompactUI() {
  $('movement').open = !compactUI.matches;
  $('hud-extra').classList.remove('open');
  $('hud').classList.remove('expanded');
  $('hud-toggle').setAttribute('aria-expanded', 'false');
  $('hud-toggle').textContent = '顯示詳情';
}
if (compactUI.addEventListener) {
  compactUI.addEventListener('change', syncCompactUI);
} else {
  compactUI.addListener(syncCompactUI);
}
syncCompactUI();
$('hud-toggle').addEventListener('click', () => {
  const open = $('hud-extra').classList.toggle('open');
  $('hud').classList.toggle('expanded', open);
  $('hud-toggle').setAttribute('aria-expanded', String(open));
  $('hud-toggle').textContent = open ? '收起詳情' : '顯示詳情';
});

const bootTimer = setTimeout(() => {
  $('boot-error').textContent =
    '仍在載入程式，請確認網路可連線到 jsDelivr。';
}, 12000);

async function main() {
  const THREE = await import('three');
  const {GLTFLoader} =
    await import('three/addons/loaders/GLTFLoader.js');
  const {addFur} = await import('../shared/cat-fur.mjs');

  // 模型只讀取本 repository 的相對路徑，不另行上傳素材。
  const MODEL_URL = new URL('../shared/cat_v01.glb', import.meta.url).href;

  // 沿用原本專案起點。
  const START = {
    lng: 121.4870872,
    lat: 24.9968507
  };

  const EYE = 1.65;
  const SPAWN_DISTANCE = 2;
  const WAIT_MS = 3000;

  const RAD = Math.PI / 180;
  const WORLD = 40075016.68557849;
  const ZOOM = 19;
  const TILE_COUNT = 2 ** ZOOM;

  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  const finite = v => typeof v === 'number' && Number.isFinite(v);
  const wrap = v => ((v % 360) + 360) % 360;
  const bearing = d => wrap(Math.atan2(d.x, -d.z) / RAD);
  const stableTenth = (value, previous, circular = false) => {
    if (previous === null) return Math.round(value * 10) / 10;
    const difference = circular
      ? ((value - previous + 540) % 360) - 180
      : value - previous;
    return Math.abs(difference) >= .2
      ? Math.round(value * 10) / 10
      : previous;
  };

  let started = false;
  let modelReady = false;
  let mixer = null;
  let catHalfHeight = .3;

  let deadline = null;
  let lastTime = null;
  let heading = 0;
  let elevation = -25;

  let watchId = null;
  let gpsEpoch = 0;
  let accuracy = null;
  let gpsText = '定位未啟用';

  let sensorOn = false;
  let sensorSeen = false;
  let sensorSeeded = false;
  let sensorOffset = 0;
  let sensorAbsolute = false;
  let sensorCalibrated = false;
  let sensorTimer = null;
  let lastAbsolute = -Infinity;
  let sensorText = '拖曳控制';
  let sensorFilterReady = false;
  let displayedHeading = null;
  let displayedElevation = null;

  let session = null;
  let xrMode = null;
  let xrBusy = false;
  let xrTracked = false;
  let xrAligned = false;
  let savedView = null;
  let xrEntryHeading = 0;

  const supports = {ar: false, vr: false};

  const held = new Set();
  const pointers = new Map();

  const player = new THREE.Vector3(0, EYE, 0);
  const viewerPosition = new THREE.Vector3();
  const viewerForward = new THREE.Vector3();

  const rawSensor = new THREE.Quaternion();
  const sensorCorrection = new THREE.Quaternion();
  const sensorTarget = new THREE.Quaternion();
  const filteredSensor = new THREE.Quaternion();
  const sensorEuler = new THREE.Euler();
  const screenCorrection = new THREE.Quaternion();

  const yAxis = new THREE.Vector3(0, 1, 0);
  const zAxis = new THREE.Vector3(0, 0, 1);

  const deviceCorrection = new THREE.Quaternion().setFromAxisAngle(
    new THREE.Vector3(1, 0, 0),
    -Math.PI / 2
  );

  // ============================================================
  // 同一個 Three.js 場景供一般模式及 WebXR 使用。
  // ============================================================
  const sky = new THREE.Color('#a9cce4');

  const scene = new THREE.Scene();
  scene.background = sky;
  scene.fog = new THREE.Fog(sky, 100, 220);

  const rig = new THREE.Group();
  scene.add(rig);

  const camera = new THREE.PerspectiveCamera(
    70,
    innerWidth / innerHeight,
    .03,
    1200
  );
  rig.add(camera);

  const renderer = new THREE.WebGLRenderer({
    canvas: $('view'),
    antialias: true,
    alpha: true
  });

  renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
  renderer.setSize(innerWidth, innerHeight);
  renderer.outputColorSpace = THREE.SRGBColorSpace;

  renderer.xr.enabled = true;
  renderer.xr.setReferenceSpaceType('local');

  scene.add(new THREE.HemisphereLight(
    0xffffff,
    0x698265,
    2.5
  ));

  const sun = new THREE.DirectionalLight(0xffeedc, 3);
  sun.position.set(3, 5, 2);
  scene.add(sun);

  const actor = new THREE.Group();
  actor.visible = false;
  scene.add(actor);

  const ground = new THREE.Group();
  scene.add(ground);

  const base = new THREE.Mesh(
    new THREE.PlaneGeometry(10000, 10000),
    new THREE.MeshBasicMaterial({color: 0xb2c1b3})
  );
  base.rotation.x = -Math.PI / 2;
  base.position.y = -.03;
  ground.add(base);

  // ============================================================
  // WGS84 -> 局部公尺座標：X 東、Y 上、Z 南。
  // ============================================================
  function mercator(lng, lat) {
    const s = Math.sin(clamp(lat, -85, 85) * RAD);

    return {
      x: (lng + 180) / 360,
      y: .5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI)
    };
  }

  let originMerc;
  let metersPerUnit;

  function setOrigin(lng, lat) {
    originMerc = mercator(lng, lat);
    metersPerUnit = WORLD * Math.cos(lat * RAD);
  }

  function fromLngLat(lng, lat) {
    const m = mercator(lng, lat);

    return {
      x: (m.x - originMerc.x) * metersPerUnit,
      z: (m.y - originMerc.y) * metersPerUnit
    };
  }

  function toLngLat(x, z) {
    const mx = originMerc.x + x / metersPerUnit;
    const my = originMerc.y + z / metersPerUnit;

    return {
      lng: mx * 360 - 180,
      lat: Math.atan(Math.sinh(Math.PI * (1 - 2 * my))) / RAD
    };
  }

  setOrigin(START.lng, START.lat);

  // ============================================================
  // 僅使用 NLSC 圖磚，直接鋪成平面。
  // 同時最多載入 4 張，保留附近 7 × 7 張。
  // ============================================================
  const tiles = new Map();
  const queue = [];

  const tileGeometry = new THREE.PlaneGeometry(1, 1);
  const loader = new THREE.TextureLoader().setCrossOrigin('anonymous');

  let tileKey = '';
  let activeLoads = 0;
  let failedTiles = 0;

  function disposeTile(tile) {
    tile.alive = false;
    ground.remove(tile.mesh);
    tile.mesh.material.map?.dispose();
    tile.mesh.material.dispose();
  }

  function clearTiles() {
    for (const tile of tiles.values()) {
      disposeTile(tile);
    }

    tiles.clear();
    queue.length = 0;
    tileKey = '';
    failedTiles = 0;
  }

  function pumpTiles() {
    while (activeLoads < 4 && queue.length) {
      const tile = queue.shift();
      if (!tile.alive) continue;

      activeLoads++;

      loader.load(
        tile.url,

        texture => {
          activeLoads--;

          if (!tile.alive) {
            texture.dispose();
          } else {
            texture.colorSpace = THREE.SRGBColorSpace;

            texture.anisotropy = Math.min(
              8,
              renderer.capabilities.getMaxAnisotropy()
            );

            tile.mesh.material.map = texture;
            tile.mesh.material.color.set(0xffffff);
            tile.mesh.material.needsUpdate = true;
          }

          pumpTiles();
        },

        undefined,

        () => {
          activeLoads--;
          if (tile.alive) failedTiles++;
          pumpTiles();
        }
      );
    }
  }

  function updateTiles(x, z) {
    const tx = Math.floor(
      (originMerc.x + x / metersPerUnit) * TILE_COUNT
    );

    const ty = Math.floor(
      (originMerc.y + z / metersPerUnit) * TILE_COUNT
    );

    const code = $('basemap').value;
    const key = `${code}/${tx}/${ty}`;

    if (key === tileKey) return;
    tileKey = key;

    const needed = new Set();
    const add = [];
    const size = metersPerUnit / TILE_COUNT;

    for (let dy = -3; dy <= 3; dy++) {
      for (let dx = -3; dx <= 3; dx++) {
        const xx = tx + dx;
        const yy = ty + dy;

        if (
          xx < 0 || xx >= TILE_COUNT ||
          yy < 0 || yy >= TILE_COUNT
        ) continue;

        const id = `${code}/${xx}/${yy}`;
        needed.add(id);

        if (!tiles.has(id)) {
          add.push({
            xx,
            yy,
            id,
            d: dx * dx + dy * dy
          });
        }
      }
    }

    for (const [id, tile] of tiles) {
      if (!needed.has(id)) {
        disposeTile(tile);
        tiles.delete(id);
      }
    }

    // 先載入靠近使用者的圖磚。
    add.sort((a, b) => a.d - b.d);

    for (const {xx, yy, id} of add) {
      const mesh = new THREE.Mesh(
        tileGeometry,
        new THREE.MeshBasicMaterial({color: 0xb2c1b3})
      );

      mesh.rotation.x = -Math.PI / 2;
      mesh.scale.set(size, size, 1);

      mesh.position.set(
        ((xx + .5) / TILE_COUNT - originMerc.x) * metersPerUnit,
        0,
        ((yy + .5) / TILE_COUNT - originMerc.y) * metersPerUnit
      );

      ground.add(mesh);

      const tile = {
        mesh,
        alive: true,
        url:
          `https://wmts.nlsc.gov.tw/wmts/${code}` +
          `/default/GoogleMapsCompatible/${ZOOM}/${yy}/${xx}`
      };

      tiles.set(id, tile);
      queue.push(tile);
    }

    base.position.set(x, -.03, z);
    pumpTiles();
  }

  $('basemap').addEventListener('change', () => {
    clearTiles();
    updateTiles(player.x, player.z);
  });

  // ============================================================
  // 第一人稱，不依附貓或頭部骨架。
  // ============================================================
  function smoothSensor(dt) {
    if (!sensorOn || !sensorSeen) return;

    sensorTarget
      .copy(sensorCorrection.setFromAxisAngle(yAxis, sensorOffset))
      .multiply(rawSensor);

    if (!sensorFilterReady) {
      filteredSensor.copy(sensorTarget);
      sensorFilterReady = true;
    } else if (filteredSensor.angleTo(sensorTarget) > .3 * RAD) {
      filteredSensor.slerp(sensorTarget, 1 - Math.exp(-dt * 10));
    }
  }

  function applyCamera() {
    camera.position.copy(player);

    if (sensorOn && sensorSeen && sensorFilterReady) {
      camera.quaternion.copy(filteredSensor);
    } else {
      camera.quaternion.setFromEuler(
        new THREE.Euler(
          elevation * RAD,
          -heading * RAD,
          0,
          'YXZ'
        )
      );
    }

    rig.updateMatrixWorld(true);
  }

  // ============================================================
  // 按鈕模擬靜止，倒數完成時才取當下位置與方向。
  // ============================================================
  function cancelStill(text) {
    if (deadline === null) return;

    deadline = null;
    $('count').textContent = '';
    $('still').textContent = '我已靜止 · 3 秒後見貓';

    if (text) message(text);
  }

  function toggleStill() {
    if (!started || !modelReady || xrBusy) return;

    if (deadline !== null) {
      cancelStill('已取消倒數。');
      return;
    }

    if (
      session &&
      (!xrTracked || session.visibilityState !== 'visible')
    ) {
      message('XR 尚未取得可用追蹤，請先讓裝置辨識環境。');
      return;
    }

    held.clear();
    actor.visible = false;

    deadline = performance.now() + WAIT_MS;

    $('still').textContent = '取消倒數';
    $('count').textContent = '3';

    message('正在模擬靜止；倒數完成後使用當下的觀看方向。');
  }

  function placeCat() {
    actor.position
      .copy(viewerPosition)
      .addScaledVector(viewerForward, SPAWN_DISTANCE);

    // 地圖模式避免模型埋入平面。
    // AR 沒有地面高度資料，不套用此修正。
    if (xrMode !== 'immersive-ar') {
      actor.position.y = Math.max(
        catHalfHeight + .03,
        actor.position.y
      );
    }

    // 原模型正面為 +Z；出現後面向使用者。
    actor.rotation.set(
      0,
      Math.atan2(
        viewerPosition.x - actor.position.x,
        viewerPosition.z - actor.position.z
      ),
      0
    );

    // actor 是 scene 的子物件，不是 camera 的子物件。
    actor.visible = true;
    cancelStill();

    message('貓已出現，會留在目前空間位置。再次按下可重新召喚。');
  }

  $('still').addEventListener('click', toggleStill);

  $('hide').addEventListener('click', () => {
    cancelStill();
    actor.visible = false;
    message('已收起貓。');
  });

  // ============================================================
  // 桌機／觸控的備用操作。
  // ============================================================
  $('view').addEventListener('pointerdown', e => {
    if (
      !started ||
      session ||
      (e.pointerType === 'mouse' && e.button !== 0)
    ) return;

    $('view').setPointerCapture(e.pointerId);

    pointers.set(e.pointerId, {
      x: e.clientX,
      y: e.clientY
    });
  });

  $('view').addEventListener('pointermove', e => {
    const p = pointers.get(e.pointerId);
    if (!p) return;

    if (!session && !sensorOn) {
      heading = wrap(heading + (e.clientX - p.x) * .18);

      elevation = clamp(
        elevation - (e.clientY - p.y) * .15,
        -85,
        85
      );
    }

    pointers.set(e.pointerId, {
      x: e.clientX,
      y: e.clientY
    });
  });

  for (const event of [
    'pointerup',
    'pointercancel',
    'lostpointercapture'
  ]) {
    $('view').addEventListener(event, e => {
      pointers.delete(e.pointerId);
    });
  }

  $('view').addEventListener('contextmenu', e => e.preventDefault());

  const keys = {
    KeyW: 'forward',
    ArrowUp: 'forward',
    KeyS: 'back',
    ArrowDown: 'back',
    KeyA: 'left',
    ArrowLeft: 'left',
    KeyD: 'right',
    ArrowRight: 'right'
  };

  window.addEventListener('keydown', e => {
    if (
      !started ||
      session ||
      e.ctrlKey ||
      e.metaKey ||
      e.altKey ||
      e.target.closest('input,select,textarea,[contenteditable="true"]')
    ) return;

    if (keys[e.code]) {
      e.preventDefault();
      held.add(e.code);
      cancelStill();
    }

    if (
      e.code === 'Space' &&
      !e.repeat &&
      !e.target.closest('button,a,summary')
    ) {
      e.preventDefault();
      toggleStill();
    }
  });

  window.addEventListener('keyup', e => held.delete(e.code));

  for (const button of document.querySelectorAll('[data-move]')) {
    button.addEventListener('pointerdown', e => {
      e.preventDefault();
      button.setPointerCapture(e.pointerId);
      held.add(button.dataset.move);
      cancelStill();
    });

    for (const name of [
      'pointerup',
      'pointercancel',
      'lostpointercapture'
    ]) {
      button.addEventListener(name, () => {
        held.delete(button.dataset.move);
      });
    }
  }

  function movePlayer(dt) {
    if (watchId !== null || session || !started) return;

    const moves = new Set([...held].map(k => keys[k] || k));

    let f =
      Number(moves.has('forward')) -
      Number(moves.has('back'));

    let r =
      Number(moves.has('right')) -
      Number(moves.has('left'));

    if (!f && !r) return;

    cancelStill();

    const n = Math.hypot(f, r);
    f /= n;
    r /= n;

    camera.getWorldDirection(viewerForward);

    const b = bearing(viewerForward) * RAD;

    player.x += (
      f * Math.sin(b) + r * Math.cos(b)
    ) * 1.5 * dt;

    player.z += (
      -f * Math.cos(b) + r * Math.sin(b)
    ) * 1.5 * dt;
  }

  // ============================================================
  // GPS：不保存位置。
  // 進入 XR 時不把 GPS 更新混入 XR 局部座標。
  // ============================================================
  function stopGPS() {
    gpsEpoch++;

    if (watchId !== null) {
      navigator.geolocation.clearWatch(watchId);
    }

    watchId = null;
    accuracy = null;
    gpsText = '定位未啟用';

    $('gps').textContent = '啟用定位';
    $('gps').classList.remove('active');

    for (const b of document.querySelectorAll('[data-move]')) {
      b.disabled = false;
    }
  }

  $('gps').addEventListener('click', () => {
    if (watchId !== null) {
      stopGPS();
      return;
    }

    if (!isSecureContext || !navigator.geolocation) {
      message('定位需要 HTTPS 及支援的瀏覽器。');
      return;
    }

    const epoch = ++gpsEpoch;
    let firstFix = true;

    held.clear();
    cancelStill();
    gpsText = '等待 GPS';

    $('gps').textContent = '停止定位';
    $('gps').classList.add('active');

    for (const b of document.querySelectorAll('[data-move]')) {
      b.disabled = true;
    }

    watchId = navigator.geolocation.watchPosition(
      p => {
        if (
          epoch !== gpsEpoch ||
          session ||
          xrBusy ||
          document.hidden
        ) return;

        const {
          longitude: lng,
          latitude: lat
        } = p.coords;

        if (
          !finite(lng) ||
          !finite(lat) ||
          Math.abs(lat) > 85 ||
          Math.abs(lng) > 180
        ) return;

        accuracy = p.coords.accuracy;
        gpsText = 'GPS';

        const local = fromLngLat(lng, lat);

        if (
          firstFix ||
          Math.hypot(local.x, local.z) > 2000
        ) {
          cancelStill();
          actor.visible = false;

          setOrigin(lng, lat);
          player.set(0, EYE, 0);
          clearTiles();

          firstFix = false;

          message('已移到手機位置；GPS 誤差會影響畫面位置。');
        } else {
          player.x = local.x;
          player.z = local.z;
        }
      },

      error => {
        if (epoch !== gpsEpoch) return;

        message(`定位失敗：${error.message}`);

        if (error.code === 1) {
          stopGPS();
        } else {
          gpsText = 'GPS 暫無更新';
        }
      },

      {
        enableHighAccuracy: true,
        maximumAge: 1000,
        timeout: 15000
      }
    );
  });

  // ============================================================
  // 裝置方向：支援螢幕旋轉及手動北方校正。
  // ============================================================
  function onOrientation(e) {
    if (
      !sensorOn ||
      session ||
      !finite(e.alpha) ||
      !finite(e.beta) ||
      !finite(e.gamma)
    ) return;

    const apple =
      finite(e.webkitCompassHeading) &&
      e.webkitCompassHeading >= 0;

    const absolute = e.absolute === true || apple;

    // 有絕對方向資料時，避免被相對方向事件蓋掉。
    if (
      !absolute &&
      performance.now() - lastAbsolute < 1500
    ) return;

    if (absolute) lastAbsolute = performance.now();

    const alpha = (
      apple ? 360 - e.webkitCompassHeading : e.alpha
    ) * RAD;

    const screenAngle = (
      screen.orientation?.angle ??
      window.orientation ??
      0
    ) * RAD;

    rawSensor.setFromEuler(
      sensorEuler.set(
        e.beta * RAD,
        alpha,
        -e.gamma * RAD,
        'YXZ'
      )
    );

    rawSensor
      .multiply(deviceCorrection)
      .multiply(
        screenCorrection.setFromAxisAngle(
          zAxis,
          -screenAngle
        )
      );

    if (
      !sensorSeeded ||
      (!sensorAbsolute && absolute && !sensorCalibrated)
    ) {
      const b = bearing(
        new THREE.Vector3(0, 0, -1).applyQuaternion(rawSensor)
      );

      sensorOffset = absolute ? 0 : (b - heading) * RAD;
      sensorSeeded = true;
    }

    sensorSeen = true;
    sensorAbsolute = absolute;

    sensorText = absolute
      ? '指南針／仰角'
      : '相對方向（請校正北方）';
  }

  function stopSensor() {
    if (sensorOn && sensorSeen) {
      camera.getWorldDirection(viewerForward);

      heading = bearing(viewerForward);
      elevation = Math.asin(
        clamp(viewerForward.y, -1, 1)
      ) / RAD;
    }

    sensorOn = false;
    sensorSeen = false;
    sensorSeeded = false;
    sensorFilterReady = false;

    clearTimeout(sensorTimer);

    window.removeEventListener(
      'deviceorientation',
      onOrientation
    );

    window.removeEventListener(
      'deviceorientationabsolute',
      onOrientation
    );

    $('sensor').textContent = '啟用手機方向';
    $('sensor').classList.remove('active');

    sensorText = '拖曳控制';
  }

  $('sensor').addEventListener('click', async () => {
    if (sensorOn) {
      stopSensor();
      return;
    }

    if (!isSecureContext || !window.DeviceOrientationEvent) {
      message('無法使用方向感測，請用拖曳控制。');
      return;
    }

    $('sensor').disabled = true;

    try {
      if (
        typeof DeviceOrientationEvent.requestPermission === 'function'
      ) {
        const result =
          await DeviceOrientationEvent.requestPermission(true);

        if (result !== 'granted') {
          throw new Error('未取得方向感測權限');
        }
      }

      sensorOn = true;
      sensorSeen = false;
      sensorSeeded = false;
      sensorFilterReady = false;
      sensorOffset = 0;
      sensorCalibrated = false;
      lastAbsolute = -Infinity;

      window.addEventListener(
        'deviceorientationabsolute',
        onOrientation
      );

      window.addEventListener(
        'deviceorientation',
        onOrientation
      );

      $('sensor').textContent = '停止手機方向';
      $('sensor').classList.add('active');

      message('請轉動手機測試；方向不正確時，面向北方後按校正。');

      sensorTimer = setTimeout(() => {
        if (sensorOn && !sensorSeen && !session) {
          stopSensor();
          message('未收到感測資料，已恢復拖曳控制。');
        }
      }, 5000);

    } catch (e) {
      stopSensor();
      message(`方向感測失敗：${e.message}`);

    } finally {
      $('sensor').disabled = false;
    }
  });

  $('north').addEventListener('click', () => {
    if (sensorOn && sensorSeen) {
      sensorOffset = bearing(
        new THREE.Vector3(0, 0, -1).applyQuaternion(rawSensor)
      ) * RAD;

      sensorCalibrated = true;
      sensorFilterReady = false;

      message('已把目前方向設為北方；請確認手機確實面向北方。');
    } else {
      heading = 0;
      message('手動視角已朝北。');
    }
  });

  $('reset').addEventListener('click', () => {
    stopGPS();
    stopSensor();
    cancelStill();

    actor.visible = false;
    held.clear();

    setOrigin(START.lng, START.lat);
    player.set(0, EYE, 0);

    heading = 0;
    elevation = -25;

    clearTiles();
    message('已回到專案起點。');
  });

  // ============================================================
  // XR AR：實景背景。
  // XR VR：保留測繪中心地圖。
  // ============================================================
  function syncXRButtons() {
    $('ar').disabled =
      !started ||
      !modelReady ||
      !supports.ar ||
      xrBusy ||
      !!session;

    $('vr').disabled =
      !started ||
      !modelReady ||
      !supports.vr ||
      xrBusy ||
      !!session;

    $('ar').hidden = !!session;
    $('vr').hidden = !!session;
    $('exit').hidden = !session;
  }

  async function checkXR() {
    if (isSecureContext && navigator.xr) {
      [supports.ar, supports.vr] = await Promise.all(
        ['immersive-ar', 'immersive-vr'].map(mode =>
          navigator.xr
            .isSessionSupported(mode)
            .catch(() => false)
        )
      );
    }

    $('ar').textContent = supports.ar
      ? '進入 XR AR'
      : '不支援 XR AR';

    $('vr').textContent = supports.vr
      ? '進入 XR VR'
      : '不支援 XR VR';

    $('xr-status').textContent =
      supports.ar || supports.vr
        ? 'AR 顯示實景；VR 顯示地圖。無浮動介面時按控制器扳機召喚，使用裝置系統選單退出。'
        : '此裝置未提供沉浸式 XR；仍可測試地圖、方向感測與召喚貓。';

    syncXRButtons();
  }

  function restoreXR(ended) {
    if (session !== ended) return;

    session = null;
    xrMode = null;
    xrTracked = false;
    xrAligned = false;
    xrBusy = false;

    cancelStill();
    actor.visible = false;
    held.clear();

    rig.position.set(0, 0, 0);
    rig.quaternion.identity();

    if (savedView) {
      player.copy(savedView.position);
    }

    scene.background = sky;
    scene.fog = new THREE.Fog(sky, 100, 220);
    ground.visible = true;

    camera.fov = 70;
    camera.aspect = innerWidth / innerHeight;
    camera.near = .03;
    camera.far = 1200;
    camera.updateProjectionMatrix();

    renderer.setClearColor(sky, 1);
    renderer.setSize(innerWidth, innerHeight);

    $('ui').classList.remove('xr');
    lastTime = null;

    if (sensorOn && !sensorSeen) {
      stopSensor();
    }

    applyCamera();
    syncXRButtons();

    message('已離開 XR；不保留地圖與 XR 之間的貓位置。');
  }

  async function enterXR(mode) {
    if (
      xrBusy ||
      session ||
      !started ||
      !modelReady
    ) return;

    xrBusy = true;
    syncXRButtons();

    let requested = null;

    try {
      // 必須直接由使用者點擊觸發，不先 await 其他權限。
      requested = await navigator.xr.requestSession(mode, {
        optionalFeatures: ['dom-overlay'],
        domOverlay: {
          root: $('ui')
        }
      });

      camera.getWorldDirection(viewerForward);
      xrEntryHeading = bearing(viewerForward);

      savedView = {
        position: player.clone()
      };

      cancelStill();
      actor.visible = false;
      held.clear();

      session = requested;
      xrMode = mode;
      xrTracked = false;
      xrAligned = false;

      rig.position.set(0, 0, 0);
      rig.quaternion.identity();

      camera.position.set(0, 0, 0);
      camera.quaternion.identity();

      ground.visible = mode === 'immersive-vr';

      scene.background = mode === 'immersive-ar'
        ? null
        : sky;

      scene.fog = mode === 'immersive-ar'
        ? null
        : new THREE.Fog(sky, 100, 220);

      renderer.setClearColor(
        0x000000,
        mode === 'immersive-ar' ? 0 : 1
      );

      requested.addEventListener('end', () => {
        // 等 Three.js 的 end listener 完成，
        // 再調整非 XR renderer。
        queueMicrotask(() => restoreXR(requested));
      }, {once: true});

      requested.addEventListener('select', toggleStill);

      requested.addEventListener('visibilitychange', () => {
        if (requested.visibilityState !== 'visible') {
          cancelStill('XR 不在前景，已取消倒數。');
        }
      });

      $('ui').classList.add('xr');

      await renderer.xr.setSession(requested);

      if (session !== requested) return;

      renderer.xr.getReferenceSpace()?.addEventListener(
        'reset',
        () => {
          cancelStill();
          actor.visible = false;
          xrAligned = false;

          message('XR 座標已重設，請重新召喚貓。');
        }
      );

      $('xr-status').textContent = mode === 'immersive-ar'
        ? 'AR 局部空間：不使用 GPS 對齊，不做地面辨識。'
        : 'VR 地圖空間：方向由進入時的視線對齊，不代表已完成真北定位。';

      message('按「我已靜止」倒數；無介面時點 XR 畫面或按控制器扳機。');

    } catch (e) {
      if (requested) {
        try {
          await requested.end();
        } catch {}

        if (!renderer.xr.isPresenting) {
          restoreXR(requested);
        }
      }

      message(`無法進入 XR：${e.message}`);

    } finally {
      xrBusy = false;
      syncXRButtons();
    }
  }

  $('ar').addEventListener('click', () => {
    enterXR('immersive-ar');
  });

  $('vr').addEventListener('click', () => {
    enterXR('immersive-vr');
  });

  $('exit').addEventListener('click', async () => {
    try {
      await session?.end();
    } catch (e) {
      message(`退出 XR 失敗：${e.message}`);
    }
  });

  // 避免按 DOM 按鈕時，同時觸發 XR select，造成倒數切換兩次。
  $('ui').addEventListener('beforexrselect', e => {
    if (e.target.closest('.panel,a,button,select')) {
      e.preventDefault();
    }
  });

  // ============================================================
  // 離開頁面取消倒數，避免回來後立刻生成。
  // 不做背景靜止判斷。
  // ============================================================
  function clearInput() {
    held.clear();
    pointers.clear();
    lastTime = null;

    cancelStill('已取消倒數，請保持頁面在前景測試。');
  }

  window.addEventListener('blur', () => {
    if (!session) clearInput();
  });

  document.addEventListener('visibilitychange', () => {
    if (document.hidden) clearInput();
  });

  window.addEventListener('pagehide', () => {
    stopGPS();
    stopSensor();

    if (session) {
      session.end().catch(() => {});
    }
  });

  window.addEventListener('resize', () => {
    if (session) return;

    camera.aspect = innerWidth / innerHeight;
    camera.updateProjectionMatrix();

    renderer.setSize(innerWidth, innerHeight);
  });

  $('start').addEventListener('click', () => {
    started = true;
    $('welcome').hidden = true;

    syncXRButtons();

    message(
      modelReady
        ? '按「我已靜止」開始測試。'
        : '地圖已啟動，模型仍在載入。'
    );
  });

  $('view').addEventListener('webglcontextlost', e => {
    e.preventDefault();
    cancelStill();

    message('繪圖環境中斷，請重新整理頁面。');
  });

  // ============================================================
  // 一般模式與 XR 共用動畫迴圈。
  // ============================================================
  const posePosition = new THREE.Vector3();
  const poseQuaternion = new THREE.Quaternion();
  const tempDirection = new THREE.Vector3();

  let hudTime = 0;

  function frame(now, xrFrame) {
    const dt = lastTime === null
      ? 0
      : Math.min((now - lastTime) / 1000, .1);

    lastTime = now;

    if (session) {
      if (!xrFrame) return;

      const reference = renderer.xr.getReferenceSpace();

      const pose = reference
        ? xrFrame.getViewerPose(reference)
        : null;

      xrTracked = !!pose;

      if (pose) {
        const p = pose.transform.position;
        const q = pose.transform.orientation;

        posePosition.set(p.x, p.y, p.z);
        poseQuaternion.set(q.x, q.y, q.z, q.w);

        if (!xrAligned) {
          if (xrMode === 'immersive-vr') {
            const b = bearing(
              tempDirection
                .set(0, 0, -1)
                .applyQuaternion(poseQuaternion)
            );

            rig.quaternion.setFromAxisAngle(
              yAxis,
              (b - xrEntryHeading) * RAD
            );

            rig.position
              .copy(savedView.position)
              .sub(
                posePosition
                  .clone()
                  .applyQuaternion(rig.quaternion)
              );
          }

          xrAligned = true;
        }

        rig.updateMatrixWorld(true);

        viewerPosition
          .copy(posePosition)
          .applyMatrix4(rig.matrixWorld);

        viewerForward
          .set(0, 0, -1)
          .applyQuaternion(poseQuaternion)
          .applyQuaternion(rig.quaternion)
          .normalize();

        if (xrMode === 'immersive-vr') {
          updateTiles(
            viewerPosition.x,
            viewerPosition.z
          );
        }
      } else {
        cancelStill('XR 暫時失去追蹤，已取消倒數。');
      }

    } else {
      smoothSensor(dt);
      applyCamera();
      movePlayer(dt);
      applyCamera();

      camera.getWorldPosition(viewerPosition);
      camera.getWorldDirection(viewerForward);

      updateTiles(player.x, player.z);
    }

    mixer?.update(dt);

    if (
      deadline !== null &&
      !document.hidden &&
      (
        !session ||
        (xrTracked && session.visibilityState === 'visible')
      )
    ) {
      const left = deadline - performance.now();

      $('count').textContent = String(
        Math.max(1, Math.ceil(left / 1000))
      );

      if (left <= 0) {
        placeCat();
      }
    }

    hudTime += dt;

    if (hudTime > .25) {
      hudTime = 0;

      const ll = toLngLat(player.x, player.z);
      const b = bearing(viewerForward);

      const e = Math.asin(
        clamp(viewerForward.y, -1, 1)
      ) / RAD;

      if (session) {
        setText('readout',
          `XR ${xrMode === 'immersive-ar' ? 'AR' : 'VR'}` +
          ` · ${xrTracked ? '追蹤中' : '等待追蹤'}`);
        setText('sensor-readout', '');
        setText('position-readout', '');
      } else {
        displayedHeading = wrap(stableTenth(b, displayedHeading, true));
        displayedElevation = stableTenth(e, displayedElevation);

        const accuracyText = finite(accuracy)
          ? ` ±${Math.round(accuracy)}m`
          : '';

        const tileErrorText = failedTiles
          ? ` ｜ 圖磚失敗 ${failedTiles}，可切換底圖重試`
          : '';

        setText('readout',
          `方位 ${displayedHeading.toFixed(1)}° · 仰角 ${displayedElevation.toFixed(1)}°`);
        setText('sensor-readout', sensorText + tileErrorText);
        setText('position-readout',
          `${gpsText}${accuracyText}` +
          ` · ${ll.lat.toFixed(6)}, ${ll.lng.toFixed(6)}`);
      }
    }

    renderer.render(scene, camera);
  }

  applyCamera();
  updateTiles(0, 0);
  renderer.setAnimationLoop(frame);

  clearTimeout(bootTimer);
  $('boot-error').textContent = '';

  $('start').disabled = false;
  $('start').textContent = '開始第一人稱預覽';

  // 供 DevTools 查看測試狀態；不傳送位置資料。
  window.happycatXR = {
    version: '0.1',

    get state() {
      return {
        started,
        modelReady,

        countdown: deadline === null
          ? null
          : Math.max(
              0,
              (deadline - performance.now()) / 1000
            ),

        catVisible: actor.visible,
        catPosition: actor.position.toArray(),
        cameraPosition: viewerPosition.toArray(),

        mode: xrMode || 'map',
        gps: watchId !== null,
        sensor: sensorOn,
        failedTiles
      };
    }
  };

  // ============================================================
  // 相對路徑載入原本的貓；優先播放 Idle。
  // 模型載入失敗時，地圖仍可使用。
  // ============================================================
  try {
    const gltf = await new GLTFLoader().loadAsync(MODEL_URL);

    gltf.scene.updateMatrixWorld(true);

    const box = new THREE.Box3().setFromObject(gltf.scene);

    if (box.isEmpty()) {
      throw new Error('模型沒有可顯示的幾何物件');
    }

    catHalfHeight = box.getSize(new THREE.Vector3()).y / 2;

    // 將模型視覺中心放到召喚位置，不修改原 GLB。
    const offset = new THREE.Group();

    offset.position
      .copy(box.getCenter(new THREE.Vector3()))
      .negate();

    offset.add(gltf.scene);
    actor.add(offset);

    gltf.scene.traverse(o => {
      if (o.isMesh) o.frustumCulled = false;
    });
    addFur(gltf.scene, {
      layers: matchMedia('(hover:none) and (pointer:coarse)').matches ? 8 : 12
    });

    mixer = new THREE.AnimationMixer(gltf.scene);

    const idle =
      gltf.animations.find(c => c.name === 'Idle') ||
      gltf.animations[0];

    if (idle) {
      mixer.clipAction(idle).play();
    }

    modelReady = true;

    $('still').disabled = false;
    $('still').textContent = '我已靜止 · 3 秒後見貓';

    syncXRButtons();

    message('cat_v01.glb 已就緒，可以開始召喚測試。');

  } catch (e) {
    $('still').textContent = '模型載入失敗';

    message(
      `無法載入 ${MODEL_URL}：${e.message}。` +
      '請確認共用模型檔可讀取；地圖仍可操作。'
    );
  }
}

main().catch(error => {
  clearTimeout(bootTimer);
  console.error(error);

  $('boot-error').textContent = `啟動失敗：${error.message}`;
  $('start').textContent = '請修正錯誤後重新整理';

  message(`啟動失敗：${error.message}`);
});
