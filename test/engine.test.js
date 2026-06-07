// Smoke tests for the game engine. Run with: npm test
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createGame, applyAction, reachableTiles, reseedIdCounter, tileAt,
} from '../server/game/engine.js';

function humanId(state) { return state.players.find((p) => p.isHuman).id; }

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
