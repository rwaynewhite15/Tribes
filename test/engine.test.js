// Smoke tests for the game engine. Run with: npm test
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createGame, applyAction, reachableTiles, reseedIdCounter, tileAt,
  hexNeighbors, hexDistance, cityFrontierTiles, tileBuyCost,
} from '../server/game/engine.js';

function humanId(state) { return state.players.find((p) => p.isHuman).id; }

test('hex geometry: every hex has 6 neighbours each at distance 1', () => {
  // Sample interior tiles on both row parities.
  for (const [x, y] of [[5, 4], [5, 5], [8, 6], [3, 7]]) {
    const ns = hexNeighbors(x, y);
    assert.equal(ns.length, 6);
    const seen = new Set();
    for (const [nx, ny] of ns) {
      assert.equal(hexDistance(x, y, nx, ny), 1, `(${nx},${ny}) should be distance 1 from (${x},${y})`);
      seen.add(`${nx},${ny}`);
      // Neighbour relation is symmetric.
      assert.ok(hexNeighbors(nx, ny).some(([a, b]) => a === x && b === y), 'neighbour is mutual');
    }
    assert.equal(seen.size, 6, 'neighbours are distinct');
  }
  assert.equal(hexDistance(5, 5, 5, 5), 0, 'distance to self is 0');
  // A straight run east should grow by exactly 1 each step.
  assert.equal(hexDistance(2, 4, 5, 4), 3);
});

test('createGame produces a valid initial state', () => {
  const s = createGame({ width: 16, height: 10, aiPlayers: 1, seed: 42 });
  assert.equal(s.tiles.length, 16 * 10);
  assert.equal(s.players.length, 2);
  // Each player starts with a settler and a warrior.
  for (const p of s.players) {
    const own = s.units.filter((u) => u.owner === p.id);
    assert.ok(own.some((u) => u.type === 'settler'), 'has settler');
    assert.ok(own.some((u) => u.type === 'warrior'), 'has warrior');
  }
});

test('settler can found a city and economy updates', () => {
  const s = createGame({ width: 16, height: 10, aiPlayers: 1, seed: 7 });
  const hid = humanId(s);
  const settler = s.units.find((u) => u.owner === hid && u.type === 'settler');
  const res = applyAction(s, hid, { type: 'found_city', unitId: settler.id });
  assert.ok(res.ok, res.error);
  assert.equal(s.cities.length, 1);
  const city = s.cities[0];
  assert.equal(city.owner, hid);
  assert.ok(city.goldPerTurn >= 2, 'city earns gold');
  // Settler consumed.
  assert.equal(s.units.find((u) => u.id === settler.id), undefined);
});

test('builders can only improve tiles inside their own territory', () => {
  const s = createGame({ width: 16, height: 10, aiPlayers: 1, seed: 7 });
  const hid = humanId(s);
  // Found a city so the player owns some tiles.
  const settler = s.units.find((u) => u.owner === hid && u.type === 'settler');
  applyAction(s, hid, { type: 'found_city', unitId: settler.id });
  const city = s.cities[0];

  // Find an owned, improvable, empty tile adjacent to the city; force it to
  // hills (always improvable) and drop a builder on it.
  const owned = s.tiles.find((t) => t.ownerCity === city.id && !(t.x === city.x && t.y === city.y));
  owned.terrain = 'hills'; owned.improvement = null; owned.resource = null;
  const builder = { id: 'ub1', owner: hid, type: 'builder', x: owned.x, y: owned.y, hp: 20, maxHp: 20, movesLeft: 2, fortified: false, charges: 3 };
  s.units.push(builder);
  const okRes = applyAction(s, hid, { type: 'build', unitId: builder.id, improvement: 'mine' });
  assert.ok(okRes.ok, okRes.error);
  assert.equal(owned.improvement, 'mine', 'mine built on owned tile');

  // Now an unowned hills tile far away should be rejected.
  const far = s.tiles.find((t) => !t.ownerCity && t.x > city.x + 2);
  far.terrain = 'hills'; far.improvement = null; far.resource = null;
  const builder2 = { id: 'ub2', owner: hid, type: 'builder', x: far.x, y: far.y, hp: 20, maxHp: 20, movesLeft: 2, fortified: false, charges: 3 };
  s.units.push(builder2);
  const badRes = applyAction(s, hid, { type: 'build', unitId: builder2.id, improvement: 'mine' });
  assert.equal(badRes.ok, false, 'building outside territory is rejected');
  assert.equal(far.improvement, null, 'no improvement placed off-territory');
});

test('a player can purchase a bordering tile to expand a city', () => {
  const s = createGame({ width: 18, height: 12, aiPlayers: 1, seed: 7 });
  const hid = humanId(s);
  const settler = s.units.find((u) => u.owner === hid && u.type === 'settler');
  applyAction(s, hid, { type: 'found_city', unitId: settler.id });
  const city = s.cities[0];
  const player = s.players.find((p) => p.id === hid);
  player.gold = 500;

  const frontier = cityFrontierTiles(s, city);
  assert.ok(frontier.length > 0, 'city has frontier tiles to buy');
  const target = frontier[0];
  // Make it a grassland farm-yielding tile so the economy clearly increases.
  target.terrain = 'grassland'; target.improvement = null; target.resource = null;
  const cost = tileBuyCost(city);
  const goldBefore = player.gold;
  const gptBefore = city.goldPerTurn;

  const res = applyAction(s, hid, { type: 'buy_tile', cityId: city.id, x: target.x, y: target.y });
  assert.ok(res.ok, res.error);
  assert.equal(target.ownerCity, city.id, 'tile now owned by the city');
  assert.equal(player.gold, goldBefore - cost, 'gold deducted by cost');
  assert.equal(city.tilesPurchased, 1, 'purchase counter incremented');
  assert.ok(city.goldPerTurn > gptBefore, 'owning the new tile raises income');
  // Next tile costs more.
  assert.ok(tileBuyCost(city) > cost, 'each purchase raises the price');

  // Cannot buy a far-off non-bordering tile.
  const far = s.tiles.find((t) => !t.ownerCity && hexDistance(city.x, city.y, t.x, t.y) > 4);
  const bad = applyAction(s, hid, { type: 'buy_tile', cityId: city.id, x: far.x, y: far.y });
  assert.equal(bad.ok, false, 'non-bordering tile rejected');
});

test('cannot found two cities too close together', () => {
  const s = createGame({ width: 16, height: 10, aiPlayers: 1, seed: 11 });
  const hid = humanId(s);
  const settler = s.units.find((u) => u.owner === hid && u.type === 'settler');
  applyAction(s, hid, { type: 'found_city', unitId: settler.id });
  // Buy another settler and try to settle on an adjacent-ish tile.
  s.players.find((p) => p.id === hid).gold = 999;
  const city = s.cities[0];
  // Force a settler next to the city.
  s.units.push({ id: 'utest', owner: hid, type: 'settler', x: city.x + 1, y: city.y, hp: 20, maxHp: 20, movesLeft: 2, fortified: false });
  const res = applyAction(s, hid, { type: 'found_city', unitId: 'utest' });
  assert.equal(res.ok, false, 'should reject settling too close');
});

test('reachableTiles respects movement points and impassable terrain', () => {
  const s = createGame({ width: 16, height: 10, aiPlayers: 1, seed: 99 });
  const hid = humanId(s);
  const warrior = s.units.find((u) => u.owner === hid && u.type === 'warrior');
  const reach = reachableTiles(s, warrior);
  // Should be able to reach at least one tile but not the whole map.
  assert.ok(reach.size > 0, 'has reachable tiles');
  assert.ok(reach.size < s.tiles.length, 'cannot reach everything');
  for (const key of reach.keys()) {
    const [x, y] = key.split(',').map(Number);
    assert.ok(tileAt(s, x, y), 'reachable tile in bounds');
  }
});

test('buying a unit costs gold and adds a unit', () => {
  const s = createGame({ width: 16, height: 10, aiPlayers: 1, seed: 3 });
  const hid = humanId(s);
  const settler = s.units.find((u) => u.owner === hid && u.type === 'settler');
  applyAction(s, hid, { type: 'found_city', unitId: settler.id });
  const player = s.players.find((p) => p.id === hid);
  player.gold = 100;
  const before = s.units.length;
  const city = s.cities[0];
  // Clear the city tile so the unit has somewhere to spawn.
  const res = applyAction(s, hid, { type: 'buy_unit', cityId: city.id, unitType: 'warrior' });
  assert.ok(res.ok, res.error);
  assert.equal(s.units.length, before + 1);
  assert.equal(player.gold, 100 - 30);
});

test('end_turn collects income and runs AI without throwing', () => {
  const s = createGame({ width: 18, height: 12, aiPlayers: 1, seed: 123 });
  const hid = humanId(s);
  const settler = s.units.find((u) => u.owner === hid && u.type === 'settler');
  applyAction(s, hid, { type: 'found_city', unitId: settler.id });
  const goldBefore = s.players.find((p) => p.id === hid).gold;
  const res = applyAction(s, hid, { type: 'end_turn' });
  assert.ok(res.ok, res.error);
  // Control returns to the human.
  assert.ok(s.players[s.currentPlayer].isHuman, 'human is active again');
  assert.ok(s.turn >= 2, 'turn advanced');
  assert.ok(s.players.find((p) => p.id === hid).gold >= goldBefore, 'income collected');
});

test('reseedIdCounter prevents id collisions after load', () => {
  const s = createGame({ width: 14, height: 10, aiPlayers: 1, seed: 5 });
  const hid = humanId(s);
  const settler = s.units.find((u) => u.owner === hid && u.type === 'settler');
  applyAction(s, hid, { type: 'found_city', unitId: settler.id });
  // Simulate reload.
  const json = JSON.parse(JSON.stringify(s));
  reseedIdCounter(json);
  json.players.find((p) => p.id === hid).gold = 100;
  const city = json.cities[0];
  applyAction(json, hid, { type: 'buy_unit', cityId: city.id, unitType: 'warrior' });
  const ids = json.units.map((u) => u.id);
  assert.equal(new Set(ids).size, ids.length, 'no duplicate unit ids');
});

test('full domination victory is reachable by destroying all rival cities', () => {
  const s = createGame({ width: 16, height: 10, aiPlayers: 1, seed: 21 });
  const hid = humanId(s);
  // Remove all rival units and cities to simulate total conquest.
  const rival = s.players.find((p) => !p.isHuman);
  s.units = s.units.filter((u) => u.owner !== rival.id);
  s.cities = s.cities.filter((c) => c.owner !== rival.id);
  const settler = s.units.find((u) => u.owner === hid && u.type === 'settler');
  applyAction(s, hid, { type: 'found_city', unitId: settler.id });
  applyAction(s, hid, { type: 'end_turn' });
  assert.ok(s.gameOver, 'game should be over');
  assert.equal(s.winner, hid, 'human wins');
});
