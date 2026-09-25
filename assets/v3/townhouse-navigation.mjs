import * as THREE from 'three';

export const HOUSE = Object.freeze({x: 0, z: -28, entrance: {x: 0, z: -18}, radius: .22, height: .48, step: .21});
const EPS = .008;
const SUPPORT = /^(Floor_slab|Ground_oak_floor|Upper_oak_floor|Stair_ascending_flight|Stair_return_flight|Half_landing|Stair_arrival_bridge|Stair_departure_bridge|Entrance_ramp)/;

// Colliders come from the delivered GLB, so the visible doors and stair holes
// are also the physical openings. A small spatial grid keeps queries local.
export class TownhouseWorld {
  constructor(model) {
    model.updateMatrixWorld(true);
    this.grid = new Map();
    this.ray = new THREE.Raycaster();
    this.down = new THREE.Vector3(0, -1, 0);
    this.origin = new THREE.Vector3();
    this.hits = [];
    this.boxes = [];
    model.traverse(mesh => {
      if (!mesh.isMesh) return;
      const box = new THREE.Box3().setFromObject(mesh);
      const entry = {mesh, box, support: SUPPORT.test(mesh.name), ramp: mesh.name.startsWith('Entrance_ramp')};
      this.boxes.push(entry);
      for (let x = Math.floor(box.min.x / 2); x <= Math.floor(box.max.x / 2); x++) {
        for (let z = Math.floor(box.min.z / 2); z <= Math.floor(box.max.z / 2); z++) {
          const key = `${x},${z}`;
          if (!this.grid.has(key)) this.grid.set(key, []);
          this.grid.get(key).push(entry);
        }
      }
    });
  }
  contains(x, z, margin = 0) {
    return Math.abs(x - HOUSE.x) <= 20 + margin && Math.abs(z - HOUSE.z) <= 14 + margin;
  }
  inside(x, z) { return Math.abs(x - HOUSE.x) < 14.8 && Math.abs(z - HOUSE.z) < 7.3; }
  nearby(x, z, radius = 0) {
    const result = new Set();
    for (let i = Math.floor((x-radius)/2); i <= Math.floor((x+radius)/2); i++) {
      for (let j = Math.floor((z-radius)/2); j <= Math.floor((z+radius)/2); j++) {
        for (const entry of this.grid.get(`${i},${j}`) || []) result.add(entry);
      }
    }
    return result;
  }
  floor(x, z, ceiling) {
    if (!this.contains(x,z)) return 0;
    this.ray.far = Math.max(0, ceiling + EPS + .01);
    this.hits.length = 0;
    const candidates=this.nearby(x,z,.003);
    // Millimetre-sized seam tolerance handles independently exported treads.
    for(const [dx,dz] of [[0,0],[-.003,0],[.003,0],[0,-.003],[0,.003]]) {
      this.origin.set(x+dx, ceiling + EPS, z+dz);
      this.ray.set(this.origin, this.down);
      for (const entry of candidates) {
        if (entry.support) entry.mesh.raycast(this.ray, this.hits);
      }
    }
    let highest = 0;
    for (const hit of this.hits) {
      // All support surfaces are horizontal or the shallow entrance ramp.
      if (hit.point.y <= ceiling + EPS && hit.point.y > highest) highest = hit.point.y;
    }
    return highest;
  }
  blocked(x, z, feet, height = HOUSE.height, radius = HOUSE.radius) {
    for (const {box, ramp, support} of this.nearby(x,z,radius)) {
      if (ramp || box.max.y <= feet + (support ? HOUSE.step : 0) + EPS || box.min.y >= feet + height - EPS) continue;
      const dx = x - Math.max(box.min.x, Math.min(x,box.max.x));
      const dz = z - Math.max(box.min.z, Math.min(z,box.max.z));
      if (dx*dx + dz*dz < radius*radius) return true;
    }
    return false;
  }
  ceiling(x,z,feet,nextFeet,height=HOUSE.height) {
    let stop = nextFeet;
    for (const {box,ramp} of this.nearby(x,z,HOUSE.radius)) {
      if (ramp || box.min.y < feet+height-EPS || box.min.y > nextFeet+height) continue;
      const dx=x-Math.max(box.min.x,Math.min(x,box.max.x));
      const dz=z-Math.max(box.min.z,Math.min(z,box.max.z));
      if (dx*dx+dz*dz < HOUSE.radius**2) stop=Math.min(stop,box.min.y-height-EPS);
    }
    return stop;
  }
  cameraDistance(from,to) {
    const delta = new THREE.Vector3().subVectors(to,from);
    const length = delta.length();
    if (!length) return 0;
    const ray = new THREE.Ray(from,delta.divideScalar(length));
    const hit = new THREE.Vector3();
    let distance=length;
    for (const {box} of this.boxes) {
      const expanded=box.clone().expandByScalar(.1);
      if (expanded.containsPoint(from)) continue;
      if (ray.intersectBox(expanded,hit)) distance=Math.min(distance,Math.max(.08,hit.distanceTo(from)-.08));
    }
    return distance;
  }
}

// Mutates a character with absolute world elevation. Called at <= 1/120 s by
// the existing animation controller; sweep subdivision also handles fast runs.
export function moveCharacter(body,dx,dz,dt,world,outsideBlocked=()=>false) {
  const floor=(x,z,top)=>world ? world.floor(x,z,top) : 0;
  const count=Math.max(1,Math.ceil(Math.hypot(dx,dz)/.07));
  const tryMove=(x,z)=>{
    if (outsideBlocked(x,z)) return false;
    const support=floor(x,z,body.y+(body.grounded?HOUSE.step:0));
    const candidate=body.grounded && Math.abs(support-body.y)<=HOUSE.step+EPS ? support : body.y;
    if (world?.blocked(x,z,candidate)) return false;
    body.x=x; body.z=z; body.y=candidate;
    return true;
  };
  for(let i=0;i<count;i++) {
    const x=body.x+dx/count,z=body.z+dz/count;
    if(!tryMove(x,z)) { tryMove(x,body.z); tryMove(body.x,z); }
  }
  const support=floor(body.x,body.z,body.y+EPS);
  if(body.vy<=0 && body.y-support<=.025) {
    body.y=support; body.vy=0; body.grounded=true;
    return;
  }
  body.grounded=false;
  body.vy-=9.8*dt;
  let next=body.y+body.vy*dt;
  if(next>body.y && world) {
    const stopped=world.ceiling(body.x,body.z,body.y,next);
    if(stopped<next) body.vy=0;
    next=stopped;
  }
  if(next<=support && body.vy<=0) {
    body.y=support; body.vy=0; body.grounded=true;
  } else body.y=next;
}
