// Authoritative game engine. Pure-ish functions operating on a state object.
// The server is the single source of truth; clients send actions and render
// whatever state comes back.
import {
  TERRAIN, IMPROVEMENTS, RESOURCES, UNITS, CITY, STARTING_GOLD,
} from './defs.js';
import { generateMap, findStartTile, makeRng } from './map.js';

let _idCounter = 1;
function nextId(prefix) { return `${prefix}${_idCounter++}`; }

// After loading a saved game, bump the counter past every existing id so newly
// created units/cities never collide with persisted ones.
export function reseedIdCounter(state) {
  let max = 0;
  const scan = (id) => {
    if (typeof id !== 'string') return;
    const n = parseInt(id.replace(/^[a-z]+/i, ''), 10);
    if (Number.isFinite(n) && n > max) max = n;
  };
  for (const p of state.players) scan(p.id);
  for (const c of state.cities) scan(c.id);
  for (const u of state.units) scan(u.id);
  _idCounter = max + 1;
}

// --- Geometry helpers --------------------------------------------------------
export const idx = (state, x, y) => y * state.width + x;
export const inBounds = (state, x, y) => x >= 0 && y >= 0 && x < state.width && y < state.height;
export const tileAt = (state, x, y) => (inBounds(state, x, y) ? state.tiles[idx(state, x, y)] : null);

// --- Hex grid geometry -------------------------------------------------------
// Tiles are stored in a rectangular array but laid out as pointy-top hexagons
// using "odd-r" offset coordinates: odd rows are shifted half a hex to the
// right. Neighbour deltas therefore depend on the row's parity.
const HEX_DIRS = [
  // even rows (y & 1 === 0)
  [[+1, 0], [-1, 0], [0, -1], [-1, -1], [0, +1], [-1, +1]],
  // odd rows  (y & 1 === 1)
  [[+1, 0], [-1, 0], [0, -1], [+1, -1], [0, +1], [+1, +1]],
];

// The six neighbouring (x,y) coordinates of a hex (may be out of bounds).
export function hexNeighbors(x, y) {
  return HEX_DIRS[y & 1].map(([dx, dy]) => [x + dx, y + dy]);
}

// Offset -> axial conversion, then cube distance between two hexes.
function toAxial(x, y) { return { q: x - ((y - (y & 1)) / 2), r: y }; }
export function hexDistance(ax, ay, bx, by) {
  const a = toAxial(ax, ay), b = toAxial(bx, by);
  return (Math.abs(a.q - b.q) + Math.abs(a.r - b.r) + Math.abs((a.q + a.r) - (b.q + b.r))) / 2;
}

// All in-bounds tiles within hex distance R of (cx,cy), including the centre.
function tilesWithin(state, cx, cy, R) {
  const out = [];
  for (let dy = -R; dy <= R; dy++) {
    for (let dx = -R - 1; dx <= R + 1; dx++) {
      const x = cx + dx, y = cy + dy;
      if (!inBounds(state, x, y)) continue;
      if (hexDistance(cx, cy, x, y) > R) continue;
      out.push(tileAt(state, x, y));
    }
  }
  return out;
}

export function unitAt(state, x, y) {
  return state.units.find((u) => u.x === x && u.y === y) || null;
}
export function cityAt(state, x, y) {
  return state.cities.find((c) => c.x === x && c.y === y) || null;
}
export function playerById(state, id) {
  return state.players.find((p) => p.id === id) || null;
}

// --- Game creation -----------------------------------------------------------
export function createGame({ name = 'New Game', width = 18, height = 12, aiPlayers = 1, seed } = {}) {
  _idCounter = 1;
  const actualSeed = seed ?? Math.floor(Math.random() * 1e9);
  const tiles = generateMap(width, height, actualSeed);

  const colors = ['#1565c0', '#c62828', '#2e7d32', '#6a1b9a', '#ef6c00', '#00838f'];
  const playerCount = 1 + aiPlayers;
  const players = [];
  for (let p = 0; p < playerCount; p++) {
    players.push({
      id: nextId('p'),
      name: p === 0 ? 'You' : `Rival ${p}`,
      isHuman: p === 0,
      gold: STARTING_GOLD,
      goldPerTurn: 0,
      color: colors[p % colors.length],
      alive: true,
    });
  }

  const state = {
    id: null,
    name,
    seed: actualSeed,
    width,
    height,
    turn: 1,
    currentPlayer: 0,
    tiles,
    players,
    cities: [],
    units: [],
    log: [],
    gameOver: false,
    winner: null,
  };

  // Spread starting positions across the map width.
  const taken = [];
  for (let p = 0; p < playerCount; p++) {
    const x0 = Math.floor((p / playerCount) * width);
    const x1 = Math.floor(((p + 1) / playerCount) * width);
    const region = { x0, y0: 1, x1, y1: height - 1 };
    const start = findStartTile(tiles, width, height, region, taken) || { x: x0 + 1, y: Math.floor(height / 2) };
    taken.push(start);
    // Each player begins with a settler plus a warrior escort.
    spawnUnit(state, players[p].id, 'settler', start.x, start.y);
    const escort = freeAdjacent(state, start.x, start.y) || start;
    spawnUnit(state, players[p].id, 'warrior', escort.x, escort.y);
  }

  recomputeEconomy(state);
  pushLog(state, `Turn 1 — ${players[0].name} begins. Settle a city to start your empire.`);
  return state;
}

function spawnUnit(state, owner, type, x, y) {
  const def = UNITS[type];
  const u = {
    id: nextId('u'),
    owner,
    type,
    x,
    y,
    hp: def.hp,
    maxHp: def.hp,
    movesLeft: def.moves,
    fortified: false,
  };
  if (def.charges) u.charges = def.charges;
  state.units.push(u);
  return u;
}

function freeAdjacent(state, x, y) {
  for (const [nx, ny] of hexNeighbors(x, y)) {
    if (!inBounds(state, nx, ny)) continue;
    const t = tileAt(state, nx, ny);
    if (!TERRAIN[t.terrain].passable) continue;
    if (unitAt(state, nx, ny)) continue;
    if (cityAt(state, nx, ny)) continue;
    return { x: nx, y: ny };
  }
  return null;
}

// --- Economy -----------------------------------------------------------------
export function tileGold(tile) {
  let g = TERRAIN[tile.terrain].gold;
  if (tile.improvement && IMPROVEMENTS[tile.improvement]) g += IMPROVEMENTS[tile.improvement].bonusGold;
  return g;
}

export function recomputeEconomy(state) {
  for (const p of state.players) p.goldPerTurn = 0;
  for (const c of state.cities) {
    let gold = CITY.baseGold;
    for (const t of tilesWithin(state, c.x, c.y, CITY.workRadius)) {
      if (t.x === c.x && t.y === c.y) continue; // centre handled by baseGold
      if (t.ownerCity && t.ownerCity !== c.id) continue;
      gold += tileGold(t);
    }
    c.goldPerTurn = gold;
    const owner = playerById(state, c.owner);
    if (owner) owner.goldPerTurn += gold;
  }
}

export function cityDefenseStrength(state, city) {
  let s = CITY.baseStrength + city.population * CITY.strengthPerPop;
  const garrison = unitAt(state, city.x, city.y);
  if (garrison && garrison.owner === city.owner && UNITS[garrison.type].role === 'military') {
    s += UNITS[garrison.type].strength * CITY.garrisonStrengthFactor;
  }
  return Math.round(s);
}

// --- Pathfinding -------------------------------------------------------------
// Tiles a unit can reach this turn, keyed "x,y" -> remaining-move cost spent.
export function reachableTiles(state, unit) {
  const result = new Map();
  if (unit.movesLeft <= 0) return result;
  const startKey = `${unit.x},${unit.y}`;
  result.set(startKey, 0);
  // Dijkstra bounded by movesLeft.
  const frontier = [{ x: unit.x, y: unit.y, cost: 0 }];
  while (frontier.length) {
    frontier.sort((a, b) => a.cost - b.cost);
    const cur = frontier.shift();
    for (const [nx, ny] of hexNeighbors(cur.x, cur.y)) {
      if (!inBounds(state, nx, ny)) continue;
      const t = tileAt(state, nx, ny);
      if (!TERRAIN[t.terrain].passable) continue;
      const occupant = unitAt(state, nx, ny);
      if (occupant) continue; // can't path through any unit
      const city = cityAt(state, nx, ny);
      if (city && city.owner !== unit.owner) continue; // enemy city blocks
      const stepCost = Math.max(1, TERRAIN[t.terrain].moveCost);
      const newCost = cur.cost + stepCost;
      if (newCost > unit.movesLeft) continue;
      const key = `${nx},${ny}`;
      if (result.has(key) && result.get(key) <= newCost) continue;
      result.set(key, newCost);
      frontier.push({ x: nx, y: ny, cost: newCost });
    }
  }
  result.delete(startKey);
  return result;
}

// Enemy units / cities this unit may attack this turn (within range of its tile).
export function attackTargets(state, unit) {
  const def = UNITS[unit.type];
  if (def.role !== 'military' || unit.movesLeft <= 0) return [];
  const range = def.range;
  const targets = [];
  for (let dy = -range; dy <= range; dy++) {
    for (let dx = -range - 1; dx <= range + 1; dx++) {
      if (dx === 0 && dy === 0) continue;
      const tx = unit.x + dx, ty = unit.y + dy;
      if (!inBounds(state, tx, ty)) continue;
      if (hexDistance(unit.x, unit.y, tx, ty) > range) continue;
      const eu = unitAt(state, tx, ty);
      const ec = cityAt(state, tx, ty);
      if (eu && eu.owner !== unit.owner) targets.push({ x: tx, y: ty, kind: 'unit', id: eu.id });
      else if (ec && ec.owner !== unit.owner) targets.push({ x: tx, y: ty, kind: 'city', id: ec.id });
    }
  }
  return targets;
}

// --- Logging -----------------------------------------------------------------
function pushLog(state, msg) {
  state.log.push({ turn: state.turn, msg });
  if (state.log.length > 200) state.log.shift();
}

// --- Combat ------------------------------------------------------------------
function combatDamage(attStr, defStr, rng) {
  const ratio = attStr - defStr;
  const base = 30 * Math.pow(2, ratio / 25);
  const jitter = 0.8 + rng() * 0.4; // ±20%
  return Math.max(1, Math.min(90, Math.round(base * jitter)));
}

function rngFor(state) {
  // Deterministic-ish per action without storing rng state: mix turn + counter.
  state._rngSeed = (state._rngSeed || (state.seed ^ 0x9e3779b9)) + 0x6d2b79f5;
  return makeRng(state._rngSeed >>> 0);
}

function resolveAttack(state, attacker, target) {
  const aDef = UNITS[attacker.type];
  const rng = rngFor(state);
  const tile = target.kind === 'city'
    ? state.cities.find((c) => c.id === target.id)
    : state.units.find((u) => u.id === target.id);
  if (!tile) return { ok: false, error: 'Target no longer exists.' };

  if (target.kind === 'unit') {
    const defender = tile;
    const dDef = UNITS[defender.type];
    const dmgToDef = combatDamage(aDef.strength, dDef.strength || 0, rng);
    defender.hp -= dmgToDef;
    let msg = `${aDef.name} hits ${dDef.name} for ${dmgToDef}.`;
    // Melee attackers take counter-damage; ranged do not.
    if (aDef.range === 1 && defender.hp > 0) {
      const dmgToAtt = combatDamage(dDef.strength || 0, aDef.strength, rng);
      attacker.hp -= dmgToAtt;
      msg += ` Takes ${dmgToAtt} back.`;
    }
    pushLog(state, msg);
    if (defender.hp <= 0) {
      removeUnit(state, defender.id);
      pushLog(state, `${dDef.name} destroyed.`);
      // Melee unit may advance into the now-empty tile if it survived.
      if (aDef.range === 1 && attacker.hp > 0 && !unitAt(state, defender.x, defender.y) && !cityAt(state, defender.x, defender.y)) {
        attacker.x = defender.x; attacker.y = defender.y;
      }
    }
  } else {
    const city = tile;
    const defStr = cityDefenseStrength(state, city);
    const dmgToCity = combatDamage(aDef.strength, defStr, rng);
    city.hp -= dmgToCity;
    let msg = `${aDef.name} bombards ${city.name} for ${dmgToCity}.`;
    if (aDef.range === 1 && city.hp > 0) {
      const dmgToAtt = combatDamage(defStr, aDef.strength, rng);
      attacker.hp -= dmgToAtt;
      msg += ` Takes ${dmgToAtt} back.`;
    }
    pushLog(state, msg);
    if (city.hp <= 0) {
      if (aDef.range === 1) {
        captureCity(state, city, attacker);
      } else {
        city.hp = 1; // ranged can't capture; leaves city on the brink
        pushLog(state, `${city.name} is reeling but needs a melee unit to be taken.`);
      }
    }
  }

  attacker.movesLeft = 0;
  attacker.fortified = false;
  if (attacker.hp <= 0) {
    removeUnit(state, attacker.id);
    pushLog(state, `${aDef.name} was lost in the assault.`);
  }
  recomputeEconomy(state);
  checkVictory(state);
  return { ok: true };
}

function captureCity(state, city, attacker) {
  const oldOwner = playerById(state, city.owner);
  const newOwner = playerById(state, attacker.owner);
  pushLog(state, `${newOwner.name} captured ${city.name} from ${oldOwner.name}!`);
  // Tile ownership is keyed by city id, which is unchanged on capture, so the
  // worked tiles transfer with the city automatically.
  city.owner = attacker.owner;
  city.hp = Math.round(city.maxHp / 2);
  city.population = Math.max(1, city.population - 1);
  city.captured = true;
  // Move the attacker into the city.
  const occupant = unitAt(state, city.x, city.y);
  if (occupant && occupant.id !== attacker.id) removeUnit(state, occupant.id);
  attacker.x = city.x; attacker.y = city.y;
}

function removeUnit(state, unitId) {
  const i = state.units.findIndex((u) => u.id === unitId);
  if (i >= 0) state.units.splice(i, 1);
}

// --- Victory / elimination ---------------------------------------------------
export function checkVictory(state) {
  for (const p of state.players) {
    const hasCity = state.cities.some((c) => c.owner === p.id);
    const hasSettler = state.units.some((u) => u.owner === p.id && u.type === 'settler');
    if (p.alive && !hasCity && !hasSettler) {
      p.alive = false;
      pushLog(state, `${p.name} has been eliminated.`);
    }
  }
  const survivors = state.players.filter((p) => p.alive);
  if (survivors.length <= 1 && !state.gameOver) {
    state.gameOver = true;
    state.winner = survivors[0] ? survivors[0].id : null;
    const w = survivors[0];
    pushLog(state, w ? `${w.name} achieves a Domination Victory!` : 'The world lies in ruins. No victor.');
  }
}

// --- Action handling ---------------------------------------------------------
// Every mutating action funnels through here. playerId is the actor.
export function applyAction(state, playerId, action) {
  if (state.gameOver) return { ok: false, error: 'The game is over.' };
  const player = playerById(state, playerId);
  if (!player) return { ok: false, error: 'Unknown player.' };
  if (state.players[state.currentPlayer].id !== playerId) {
    return { ok: false, error: 'Not your turn.' };
  }

  switch (action.type) {
    case 'move':        return doMove(state, player, action);
    case 'attack':      return doAttack(state, player, action);
    case 'found_city':  return doFoundCity(state, player, action);
    case 'build':       return doBuild(state, player, action);
    case 'harvest':     return doHarvest(state, player, action);
    case 'buy_unit':    return doBuyUnit(state, player, action);
    case 'fortify':     return doFortify(state, player, action);
    case 'skip':        return doSkip(state, player, action);
    case 'end_turn':    return doEndTurn(state, player);
    default:            return { ok: false, error: `Unknown action: ${action.type}` };
  }
}

function ownUnit(state, player, unitId) {
  const u = state.units.find((x) => x.id === unitId);
  if (!u) return { error: 'Unit not found.' };
  if (u.owner !== player.id) return { error: 'Not your unit.' };
  return { unit: u };
}

function doMove(state, player, { unitId, x, y }) {
  const { unit, error } = ownUnit(state, player, unitId);
  if (error) return { ok: false, error };
  const reach = reachableTiles(state, unit);
  const key = `${x},${y}`;
  if (!reach.has(key)) return { ok: false, error: 'Tile not reachable this turn.' };
  unit.x = x; unit.y = y;
  unit.movesLeft = Math.max(0, unit.movesLeft - reach.get(key));
  unit.fortified = false;
  return { ok: true };
}

function doAttack(state, player, { unitId, x, y }) {
  const { unit, error } = ownUnit(state, player, unitId);
  if (error) return { ok: false, error };
  const targets = attackTargets(state, unit);
  const target = targets.find((t) => t.x === x && t.y === y);
  if (!target) return { ok: false, error: 'No valid target there.' };
  return resolveAttack(state, unit, target);
}

function doFoundCity(state, player, { unitId }) {
  const { unit, error } = ownUnit(state, player, unitId);
  if (error) return { ok: false, error };
  if (unit.type !== 'settler') return { ok: false, error: 'Only settlers can found cities.' };
  const tile = tileAt(state, unit.x, unit.y);
  if (!TERRAIN[tile.terrain].passable) return { ok: false, error: 'Cannot settle here.' };
  if (cityAt(state, unit.x, unit.y)) return { ok: false, error: 'A city already stands here.' };
  for (const c of state.cities) {
    if (hexDistance(c.x, c.y, unit.x, unit.y) < CITY.minDistanceBetweenCities) {
      return { ok: false, error: 'Too close to another city.' };
    }
  }
  const city = {
    id: nextId('c'),
    owner: player.id,
    name: cityName(state, player),
    x: unit.x,
    y: unit.y,
    hp: CITY.baseHp,
    maxHp: CITY.baseHp,
    population: 1,
    growth: 0,
    goldPerTurn: 0,
    captured: false,
  };
  state.cities.push(city);
  claimTiles(state, city);
  removeUnit(state, unit.id);
  recomputeEconomy(state);
  pushLog(state, `${player.name} founded ${city.name}.`);
  return { ok: true };
}

function claimTiles(state, city) {
  for (const t of tilesWithin(state, city.x, city.y, CITY.workRadius)) {
    if (!t.ownerCity) t.ownerCity = city.id;
  }
  const c = tileAt(state, city.x, city.y);
  if (c) c.ownerCity = city.id;
}

function cityName(state, player) {
  const pool = [
    'Avalon', 'Brightford', 'Caldera', 'Dawnhold', 'Emberton', 'Frosthaven',
    'Goldmere', 'Highrock', 'Ironvale', 'Jadeport', 'Kingsreach', 'Lakewatch',
    'Mossgarde', 'Northwind', 'Oakhollow', 'Pinecrest', 'Quarrytown', 'Riverbend',
    'Stonewall', 'Thornkeep', 'Umberfell', 'Vexford', 'Westmarch', 'Yellowstone',
  ];
  const used = new Set(state.cities.map((c) => c.name));
  for (const n of pool) if (!used.has(n)) return n;
  return `City ${state.cities.length + 1}`;
}

function doBuild(state, player, { unitId, improvement }) {
  const { unit, error } = ownUnit(state, player, unitId);
  if (error) return { ok: false, error };
  if (unit.type !== 'builder') return { ok: false, error: 'Only builders can construct improvements.' };
  if (unit.movesLeft <= 0) return { ok: false, error: 'Builder has no moves left.' };
  const tile = tileAt(state, unit.x, unit.y);
  const def = IMPROVEMENTS[improvement];
  if (!def) return { ok: false, error: 'Unknown improvement.' };
  if (TERRAIN[tile.terrain].canImprove !== improvement) {
    return { ok: false, error: `Cannot build a ${def.name} on ${TERRAIN[tile.terrain].name}.` };
  }
  if (tile.improvement) return { ok: false, error: 'Tile already improved.' };
  tile.improvement = improvement;
  unit.movesLeft = 0;
  unit.charges -= 1;
  pushLog(state, `${player.name} built a ${def.name}.`);
  if (unit.charges <= 0) {
    removeUnit(state, unit.id);
    pushLog(state, 'Builder exhausted and disbanded.');
  }
  recomputeEconomy(state);
  return { ok: true };
}

function doHarvest(state, player, { unitId }) {
  const { unit, error } = ownUnit(state, player, unitId);
  if (error) return { ok: false, error };
  if (unit.type !== 'builder') return { ok: false, error: 'Only builders can harvest resources.' };
  if (unit.movesLeft <= 0) return { ok: false, error: 'Builder has no moves left.' };
  const tile = tileAt(state, unit.x, unit.y);
  if (!tile.resource) return { ok: false, error: 'No resource to harvest here.' };
  const res = RESOURCES[tile.resource];
  player.gold += res.harvest;
  pushLog(state, `${player.name} harvested ${res.name} for ${res.harvest} gold.`);
  tile.resource = null;
  unit.movesLeft = 0;
  unit.charges -= 1;
  if (unit.charges <= 0) {
    removeUnit(state, unit.id);
    pushLog(state, 'Builder exhausted and disbanded.');
  }
  return { ok: true };
}

function doBuyUnit(state, player, { cityId, unitType }) {
  const city = state.cities.find((c) => c.id === cityId);
  if (!city) return { ok: false, error: 'City not found.' };
  if (city.owner !== player.id) return { ok: false, error: 'Not your city.' };
  const def = UNITS[unitType];
  if (!def) return { ok: false, error: 'Unknown unit.' };
  if (player.gold < def.cost) return { ok: false, error: 'Not enough gold.' };
  // Find an open tile for the new unit: the city tile if empty, else adjacent.
  let spot = null;
  if (!unitAt(state, city.x, city.y)) spot = { x: city.x, y: city.y };
  else spot = freeAdjacent(state, city.x, city.y);
  if (!spot) return { ok: false, error: 'No open space around the city.' };
  player.gold -= def.cost;
  const u = spawnUnit(state, player.id, unitType, spot.x, spot.y);
  u.movesLeft = 0; // freshly trained, acts next turn
  pushLog(state, `${player.name} trained a ${def.name} in ${city.name}.`);
  return { ok: true };
}

function doFortify(state, player, { unitId }) {
  const { unit, error } = ownUnit(state, player, unitId);
  if (error) return { ok: false, error };
  if (UNITS[unit.type].role !== 'military') return { ok: false, error: 'Only military units can fortify.' };
  unit.fortified = true;
  unit.movesLeft = 0;
  return { ok: true };
}

function doSkip(state, player, { unitId }) {
  const { unit, error } = ownUnit(state, player, unitId);
  if (error) return { ok: false, error };
  unit.movesLeft = 0;
  return { ok: true };
}

// --- Turn cycle --------------------------------------------------------------
function startTurnFor(state, player) {
  // Refresh moves and apply healing for the player's units.
  for (const u of state.units) {
    if (u.owner !== player.id) continue;
    u.movesLeft = UNITS[u.type].moves;
    const onFriendlyCity = cityAt(state, u.x, u.y);
    if (u.hp < u.maxHp && UNITS[u.type].role === 'military') {
      const heal = (onFriendlyCity && onFriendlyCity.owner === player.id) ? 25 : (u.fortified ? 15 : 10);
      u.hp = Math.min(u.maxHp, u.hp + heal);
    }
  }
  // City growth and healing.
  for (const c of state.cities) {
    if (c.owner !== player.id) continue;
    if (c.hp < c.maxHp) c.hp = Math.min(c.maxHp, c.hp + 10);
    c.growth += 1;
    if (c.growth >= CITY.growthEvery) {
      c.growth = 0;
      c.population += 1;
      pushLog(state, `${c.name} grew to population ${c.population}.`);
    }
  }
}

function collectIncome(state, player) {
  recomputeEconomy(state);
  player.gold += player.goldPerTurn;
}

function doEndTurn(state, player) {
  // Income is collected at the end of the player's turn.
  collectIncome(state, player);
  advanceToNextPlayer(state);
  return { ok: true };
}

function advanceToNextPlayer(state) {
  let guard = 0;
  do {
    state.currentPlayer = (state.currentPlayer + 1) % state.players.length;
    if (state.currentPlayer === 0) state.turn += 1;
    guard += 1;
  } while (!state.players[state.currentPlayer].alive && guard < state.players.length * 2);

  const next = state.players[state.currentPlayer];
  startTurnFor(state, next);
  checkVictory(state);

  // Run AI turns immediately so control returns to the human player.
  let aiGuard = 0;
  while (!state.gameOver && !state.players[state.currentPlayer].isHuman && aiGuard < state.players.length + 2) {
    runAiTurn(state, state.players[state.currentPlayer]);
    collectIncome(state, state.players[state.currentPlayer]);
    state.currentPlayer = (state.currentPlayer + 1) % state.players.length;
    if (state.currentPlayer === 0) state.turn += 1;
    while (!state.players[state.currentPlayer].alive && state.players.some((p) => p.alive)) {
      state.currentPlayer = (state.currentPlayer + 1) % state.players.length;
      if (state.currentPlayer === 0) state.turn += 1;
    }
    startTurnFor(state, state.players[state.currentPlayer]);
    checkVictory(state);
    aiGuard += 1;
  }
}

// --- AI ----------------------------------------------------------------------
function runAiTurn(state, ai) {
  if (state.gameOver) return;
  // 1) Found a city with any settler on a legal spot.
  for (const u of state.units.filter((x) => x.owner === ai.id && x.type === 'settler')) {
    aiMoveToSettle(state, ai, u);
  }
  // 2) Builders improve nearby tiles.
  for (const u of state.units.filter((x) => x.owner === ai.id && x.type === 'builder')) {
    aiBuilder(state, ai, u);
  }
  // 3) Military units hunt enemies / defend.
  for (const u of state.units.filter((x) => x.owner === ai.id && UNITS[x.type].role === 'military')) {
    aiMilitary(state, ai, u);
  }
  // 4) Cities spend gold.
  for (const c of state.cities.filter((x) => x.owner === ai.id)) {
    aiCityProduce(state, ai, c);
  }
}

function aiMoveToSettle(state, ai, settler) {
  // If current tile is legal, settle.
  const legalHere = canSettleHere(state, settler.x, settler.y);
  if (legalHere) {
    applyDirect(state, ai, { type: 'found_city', unitId: settler.id });
    return;
  }
  // Otherwise wander toward open ground.
  const reach = reachableTiles(state, settler);
  let best = null, bestScore = -Infinity;
  for (const key of reach.keys()) {
    const [x, y] = key.split(',').map(Number);
    let score = TERRAIN[tileAt(state, x, y).terrain].gold;
    let minCity = Infinity;
    for (const c of state.cities) minCity = Math.min(minCity, hexDistance(c.x, c.y, x, y));
    if (minCity < CITY.minDistanceBetweenCities) score -= 5;
    else score += Math.min(minCity, 4);
    if (score > bestScore) { bestScore = score; best = { x, y }; }
  }
  if (best) applyDirect(state, ai, { type: 'move', unitId: settler.id, x: best.x, y: best.y });
  if (canSettleHere(state, settler.x, settler.y)) {
    applyDirect(state, ai, { type: 'found_city', unitId: settler.id });
  }
}

function canSettleHere(state, x, y) {
  const tile = tileAt(state, x, y);
  if (!tile || !TERRAIN[tile.terrain].passable) return false;
  if (cityAt(state, x, y)) return false;
  for (const c of state.cities) if (hexDistance(c.x, c.y, x, y) < CITY.minDistanceBetweenCities) return false;
  return true;
}

function aiBuilder(state, ai, builder) {
  const tile = tileAt(state, builder.x, builder.y);
  const canImp = TERRAIN[tile.terrain].canImprove;
  if (tile.resource) { applyDirect(state, ai, { type: 'harvest', unitId: builder.id }); return; }
  if (canImp && !tile.improvement && tile.ownerCity) {
    applyDirect(state, ai, { type: 'build', unitId: builder.id, improvement: canImp });
    return;
  }
  // Move toward an unimproved owned tile.
  const reach = reachableTiles(state, builder);
  let best = null, bestScore = -Infinity;
  for (const key of reach.keys()) {
    const [x, y] = key.split(',').map(Number);
    const t = tileAt(state, x, y);
    let score = 0;
    if (t.resource) score += 5;
    if (t.ownerCity && t.ownerCity && TERRAIN[t.terrain].canImprove && !t.improvement) {
      if (state.cities.find((c) => c.id === t.ownerCity && c.owner === ai.id)) score += 4;
    }
    if (score > bestScore) { bestScore = score; best = { x, y }; }
  }
  if (best && bestScore > 0) applyDirect(state, ai, { type: 'move', unitId: builder.id, x: best.x, y: best.y });
}

function aiMilitary(state, ai, unit) {
  // Attack if a target is in range.
  let targets = attackTargets(state, unit);
  if (targets.length) {
    const target = pickAiTarget(state, targets);
    applyDirect(state, ai, { type: 'attack', unitId: unit.id, x: target.x, y: target.y });
    return;
  }
  // Move toward nearest enemy city, then enemy unit.
  const goal = nearestEnemyTarget(state, ai, unit);
  if (!goal) { applyDirect(state, ai, { type: 'fortify', unitId: unit.id }); return; }
  const reach = reachableTiles(state, unit);
  let best = null, bestDist = Infinity;
  for (const key of reach.keys()) {
    const [x, y] = key.split(',').map(Number);
    const d = hexDistance(x, y, goal.x, goal.y);
    if (d < bestDist) { bestDist = d; best = { x, y }; }
  }
  if (best && (best.x !== unit.x || best.y !== unit.y)) {
    applyDirect(state, ai, { type: 'move', unitId: unit.id, x: best.x, y: best.y });
  }
  // Try to attack again after moving.
  targets = attackTargets(state, unit);
  if (targets.length) {
    const target = pickAiTarget(state, targets);
    applyDirect(state, ai, { type: 'attack', unitId: unit.id, x: target.x, y: target.y });
  }
}

function pickAiTarget(state, targets) {
  // Prefer cities, then the weakest unit.
  const cities = targets.filter((t) => t.kind === 'city');
  if (cities.length) return cities[0];
  let best = targets[0], bestHp = Infinity;
  for (const t of targets) {
    const u = state.units.find((x) => x.id === t.id);
    if (u && u.hp < bestHp) { bestHp = u.hp; best = t; }
  }
  return best;
}

function nearestEnemyTarget(state, ai, unit) {
  let best = null, bestDist = Infinity;
  for (const c of state.cities) {
    if (c.owner === ai.id) continue;
    const d = hexDistance(c.x, c.y, unit.x, unit.y);
    if (d < bestDist) { bestDist = d; best = { x: c.x, y: c.y }; }
  }
  if (best) return best;
  for (const u of state.units) {
    if (u.owner === ai.id) continue;
    const d = hexDistance(u.x, u.y, unit.x, unit.y);
    if (d < bestDist) { bestDist = d; best = { x: u.x, y: u.y }; }
  }
  return best;
}

function aiCityProduce(state, ai, city) {
  // Count AI military and settlers to decide what to build.
  const myUnits = state.units.filter((u) => u.owner === ai.id);
  const military = myUnits.filter((u) => UNITS[u.type].role === 'military').length;
  const settlers = myUnits.filter((u) => u.type === 'settler').length;
  const builders = myUnits.filter((u) => u.type === 'builder').length;
  const cityCount = state.cities.filter((c) => c.owner === ai.id).length;

  let want;
  if (settlers === 0 && cityCount < 3 && ai.gold >= UNITS.settler.cost) want = 'settler';
  else if (builders < cityCount && ai.gold >= UNITS.builder.cost) want = 'builder';
  else if (military < cityCount * 2 + 1) {
    // Buy the best military unit we can afford.
    const affordable = ['swordsman', 'horseman', 'spearman', 'archer', 'warrior']
      .filter((t) => ai.gold >= UNITS[t].cost);
    want = affordable[0];
  }
  if (want) applyDirect(state, ai, { type: 'buy_unit', cityId: city.id, unitType: want });
}

// Internal action dispatch for the AI that bypasses the turn-owner check.
function applyDirect(state, player, action) {
  const saved = state.currentPlayer;
  state.currentPlayer = state.players.findIndex((p) => p.id === player.id);
  const res = applyAction(state, player.id, action);
  state.currentPlayer = saved;
  return res;
}

// --- Serialisation helpers ---------------------------------------------------
// A trimmed, client-facing view (the full state is already JSON-friendly).
export function publicState(state) {
  return state;
}
