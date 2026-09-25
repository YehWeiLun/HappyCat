import * as THREE from 'three';

// Shell fur for the HappyCat GLB. The body mesh carries two custom attributes
// baked in Blender: _FURLEN (fur length in metres; 0 on the nose, eye rims and
// paw pads) and _FURDIR (comb direction along the skin). Every shell is the same
// skinned geometry pushed out along the skinned normal and combed toward
// _FURDIR; a noise texture cuts each shell into tapered strands, so the layers
// read as fur from close up and as a soft fuzzy silhouette from far away.

const NOISE_SIZE = 128;
let noiseTexture = null;

function strandNoise() {
  if (noiseTexture) return noiseTexture;
  const data = new Uint8Array(NOISE_SIZE * NOISE_SIZE * 4);
  let seed = 20260925;
  const random = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  for (let i = 0; i < NOISE_SIZE * NOISE_SIZE; i++) {
    // R: strand height (most reach near full length, a few are short undercoat)
    // G, B: where the strand sits inside its cell, so strands don't line up in a grid
    const v = Math.min(1, .25 + .85 * Math.sqrt(random())) * 255;
    data.set([v, random() * 255, random() * 255, 255], i * 4);
  }
  noiseTexture = new THREE.DataTexture(data, NOISE_SIZE, NOISE_SIZE);
  noiseTexture.wrapS = noiseTexture.wrapT = THREE.RepeatWrapping;
  noiseTexture.magFilter = noiseTexture.minFilter = THREE.NearestFilter;
  noiseTexture.needsUpdate = true;
  return noiseTexture;
}

const VERTEX_PARS = /* glsl */`
attribute float _furlen;
attribute vec3 _furdir;
uniform float furH;
uniform float furLength;
uniform float furComb;
uniform float furGravity;
varying float vFurLen;
varying vec2 vFurUv;
`;

const VERTEX_SHELL = /* glsl */`
#ifdef USE_SKINNING
  vec3 furDir = ( skinMatrix * vec4( _furdir, 0.0 ) ).xyz;
#else
  vec3 furDir = _furdir;
#endif
float furL = _furlen * furLength;
transformed += ( normalize( objectNormal ) * furH + furDir * furComb * furH * furH ) * furL;
transformed.y -= furGravity * furH * furH * furL;
vFurLen = furL;
vFurUv = uv;
`;

const FRAGMENT_PARS = /* glsl */`
uniform sampler2D furNoise;
uniform float furH;
uniform float furScale;
varying float vFurLen;
varying vec2 vFurUv;
`;

// Strands are round, tapered cells; when a cell is smaller than a pixel the
// strands thicken into a continuous (but still layered) coat to avoid shimmer.
const FRAGMENT_SHELL = /* glsl */`
if ( vFurLen < 0.0006 ) discard;
vec2 furP = vFurUv * furScale;
vec2 furCell = floor( furP );
vec3 furRnd = texture2D( furNoise, ( furCell + 0.5 ) / ${NOISE_SIZE.toFixed(1)} ).rgb;
float furPix = length( fwidth( furP ) );
float furThick = mix( 1.05, 1.6, smoothstep( 0.6, 2.5, furPix ) );
float furT = furH / max( furRnd.r, 0.05 );
vec2 furOff = ( furRnd.gb - 0.5 ) * 0.55 * ( 1.0 - smoothstep( 0.6, 2.0, furPix ) );
if ( furT > 1.0 || length( fract( furP ) - 0.5 - furOff ) * 2.0 > ( 1.0 - furT ) * furThick + 0.1 ) discard;
diffuseColor.rgb *= mix( 0.74, 1.06, furH );
`;

// The skin under the fur is the root layer: a little darker where fur grows.
const FRAGMENT_ROOT = /* glsl */`
diffuseColor.rgb *= mix( 1.0, 0.8, smoothstep( 0.001, 0.006, vFurLen ) );
`;

function patch(material, uniforms, shell) {
  material.onBeforeCompile = shader => {
    Object.assign(shader.uniforms, uniforms);
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>\n${VERTEX_PARS}`)
      .replace('#include <skinning_vertex>', `#include <skinning_vertex>\n${shell ? VERTEX_SHELL : 'vFurLen = _furlen * furLength; vFurUv = uv;'}`);
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>\n${FRAGMENT_PARS}`)
      .replace('#include <map_fragment>', `#include <map_fragment>\n${shell ? FRAGMENT_SHELL : FRAGMENT_ROOT}`);
  };
  material.customProgramCacheKey = () => (shell ? 'catfur-shell' : 'catfur-root');
}

/**
 * Grow fur on every skinned mesh under `root` that has fur attributes.
 * Returns {setEnabled(bool), dispose()}.
 */
export function addFur(root, {layers = 12, length = 1, comb = .55, gravity = .3, scale = 520} = {}) {
  const shells = [];
  const bases = [];
  root.traverse(o => { if (o.isSkinnedMesh && o.geometry.getAttribute('_furlen')) bases.push(o); });
  for (const base of bases) {
    const skin = base.material;
    patch(skin, {furH: {value: 0}, furLength: {value: length}, furComb: {value: comb}, furGravity: {value: gravity},
      furNoise: {value: strandNoise()}, furScale: {value: scale}}, false);
    skin.needsUpdate = true;
    for (let i = 1; i <= layers; i++) {
      const h = i / layers;
      const material = new THREE.MeshStandardMaterial({
        map: skin.map, color: skin.color.clone(), roughness: 1, metalness: 0,
      });
      patch(material, {furH: {value: h}, furLength: {value: length}, furComb: {value: comb}, furGravity: {value: gravity},
        furNoise: {value: strandNoise()}, furScale: {value: scale}}, true);
      const shell = new THREE.SkinnedMesh(base.geometry, material);
      shell.name = `${base.name}_fur${i}`;
      shell.bind(base.skeleton, base.bindMatrix);
      shell.frustumCulled = false;
      shell.renderOrder = base.renderOrder + i;
      base.add(shell);
      shells.push(shell);
    }
  }
  return {
    shells,
    setEnabled(on) { for (const s of shells) s.visible = on; },
    dispose() { for (const s of shells) { s.removeFromParent(); s.material.dispose(); } },
  };
}
