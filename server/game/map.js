// Procedural map generation.
import { TERRAIN, RESOURCES } from './defs.js';

// A tiny seeded RNG so a given seed always reproduces the same map.
export function makeRng(seed) {
  let s = (seed >>> 0) || 1;
  return function rng() {
    // xorshift32
    s ^= s << 13; s >>>= 0;
    s ^= s >> 17;
    s ^= s << 5;  s >>>= 0;
    return s / 4294967296;
  };
}

const TERRAIN_KEYS = Object.keys(TERRAIN);

// Simple value-noise: average a few random fields at different scales.
function noiseField(rng, width, height) {
  const field = new Float64Array(width * height);
  for (const scale of [4, 8]) {
    const gw = Math.ceil(width / scale) + 1;
    const gh = Math.ceil(height / scale) + 1;
    const grid = [];
    for (let i = 0; i < gw * gh; i++) grid.push(rng());
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const gx = x / scale, gy = y / scale;
        const x0 = Math.floor(gx), y0 = Math.floor(gy);
        const fx = gx - x0, fy = gy - y0;
        const a = grid[y0 * gw + x0];
        const b = grid[y0 * gw + x0 + 1];
        const c = grid[(y0 + 1) * gw + x0];
        const d = grid[(y0 + 1) * gw + x0 + 1];
        const top = a + (b - a) * fx;
        const bot = c + (d - c) * fx;
        field[y * width + x] += (top + (bot - top) * fy) / 2;
      }
    }
  }
  return field;
}

export function generateMap(width, height, seed) {
  const rng = makeRng(seed);
  const elevation = noiseField(rng, width, height);
  const moisture = noiseField(rng, width, height);
  const tiles = [];

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = y * width + x;
      const e = elevation[i];
      const m = moisture[i];
      let terrain;
      if (e < 0.32) terrain = 'water';
      else if (e > 0.82) terrain = 'mountains';
      else if (e > 0.68) terrain = 'hills';
      else if (m < 0.30) terrain = 'desert';
      else if (m > 0.66) terrain = 'forest';
      else if (m > 0.50) terrain = 'grassland';
      else terrain = 'plains';

      const tile = { x, y, terrain, improvement: null, resource: null, ownerCity: null };

      // Sprinkle special resources on suitable land.
      if (TERRAIN[terrain].passable) {
        const r = rng();
        if (terrain === 'hills' && r < 0.10) tile.resource = 'goldore';
        else if ((terrain === 'grassland' || terrain === 'plains') && r < 0.08) tile.resource = 'wheat';
        else if (terrain === 'forest' && r < 0.10) tile.resource = 'deer';
      }
      tiles.push(tile);
    }
  }
  return tiles;
}

// Find a reasonable, passable, non-resource starting tile near a corner region.
export function findStartTile(tiles, width, height, region, taken) {
  // region: {x0,y0,x1,y1} preferred area; we search outward from its centre.
  const cx = Math.floor((region.x0 + region.x1) / 2);
  const cy = Math.floor((region.y0 + region.y1) / 2);
  let best = null, bestScore = -Infinity;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const t = tiles[y * width + x];
      if (!TERRAIN[t.terrain].passable) continue;
      if (t.terrain === 'forest' || t.terrain === 'hills') continue; // want open ground for a settler
      // Distance from desired region centre (closer is better).
      const regionDist = Math.hypot(x - cx, y - cy);
      // Distance from already-taken starts (farther is better).
      let minTaken = Infinity;
      for (const p of taken) minTaken = Math.min(minTaken, Math.hypot(x - p.x, y - p.y));
      if (taken.length && minTaken < 6) continue;
      const score = -regionDist + Math.min(minTaken, 20) * 0.5 + (TERRAIN[t.terrain].gold);
      if (score > bestScore) { bestScore = score; best = { x, y }; }
    }
  }
  return best;
}
