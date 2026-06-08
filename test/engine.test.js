// Smoke tests for the game engine. Run with: npm test
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createGame, applyAction, reachableTiles, reseedIdCounter, tileAt,
  hexNeighbors, hexDistance, cityFrontierTiles, tileBuyCost, stepSpectator,
  cityPopulation, recomputeEconomy,
} from '../server/game/engine.js';
import { STARTING_GOLD, DIFFICULTY, DEFAULT_DIFFICULTY } from '../server/game/defs.js';

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

test('building an improvement adds a citizen and a new owned tile', () => {
  const s = createGame({ width: 18, height: 12, aiPlayers: 1, seed: 7 });
  const hid = humanId(s);
  const settler = s.units.find((u) => u.owner === hid && u.type === 'settler');
  applyAction(s, hid, { type: 'found_city', unitId: settler.id });
  const city = s.cities[0];

  const owned = s.tiles.find((t) => t.ownerCity === city.id && !(t.x === city.x && t.y === city.y));
  owned.terrain = 'hills'; owned.improvement = null; owned.resource = null;
  const builder = { id: 'ub1', owner: hid, type: 'builder', x: owned.x, y: owned.y, hp: 20, maxHp: 20, movesLeft: 2, fortified: false, charges: 3 };
  s.units.push(builder);

  const popBefore = city.population;
  const ownedBefore = s.tiles.filter((t) => t.ownerCity === city.id).length;
  const res = applyAction(s, hid, { type: 'build', unitId: builder.id, improvement: 'mine' });
  assert.ok(res.ok, res.error);
  assert.equal(city.population, popBefore + 1, 'improvement adds a citizen');
  assert.equal(s.tiles.filter((t) => t.ownerCity === city.id).length, ownedBefore + 1, 'improvement expands territory by one tile');
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

test('games support up to six players and never exceed the cap', () => {
  // AI-only: six civs means six players (the bug was a clamp to five).
  const watch = createGame({ aiPlayers: 6, seed: 5, spectate: true });
  assert.equal(watch.players.length, 6, 'six AI civs');
  assert.ok(watch.players.every((p) => p.type === 'ai'));

  // Single-player: one human host plus five AI rivals = six players.
  const solo = createGame({ aiPlayers: 5, openSlots: 0, seed: 5 });
  assert.equal(solo.players.length, 6);
  assert.equal(solo.players.filter((p) => p.type === 'human').length, 1);
  assert.equal(solo.players.filter((p) => p.type === 'ai').length, 5);

  // A request that would overflow the cap is trimmed down to six.
  const over = createGame({ aiPlayers: 5, openSlots: 5, seed: 5 });
  assert.equal(over.players.length, 6, 'capped at six players');
});

test('spectator (AI-only) game has no human and can be stepped to a result', () => {
  const s = createGame({ width: 16, height: 10, aiPlayers: 3, seed: 17, spectate: true });
  assert.equal(s.spectate, true);
  assert.equal(s.players.length, 3, 'three AI civs');
  assert.ok(s.players.every((p) => !p.isHuman), 'no human player');

  // Step many turns; the AIs should run without errors and the game progresses.
  const startTurn = s.turn;
  for (let i = 0; i < 400 && !s.gameOver; i++) stepSpectator(s);
  assert.ok(s.turn > startTurn, 'turns advanced');
  // Either someone won, or it is still a valid ongoing game with living civs.
  const alive = s.players.filter((p) => p.alive).length;
  assert.ok(s.gameOver ? alive <= 1 : alive >= 1, 'consistent end state');
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

// --- Multiplayer lobby --------------------------------------------------------
test('a multiplayer lobby waits to start and blocks actions until it does', async () => {
  const { createGame: cg, startGame, applyAction: act, normalizeState } = await import('../server/game/engine.js');
  const s = cg({ width: 16, height: 10, aiPlayers: 1, openSlots: 1, seed: 5 });
  // Two human seats (host + one open) plus one AI.
  assert.equal(s.phase, 'lobby');
  const humans = s.players.filter((p) => p.type === 'human');
  assert.equal(humans.length, 2);
  assert.ok(humans[0].host && humans[0].joined, 'host occupies the first seat');
  assert.ok(!humans[1].joined, 'second seat starts open');

  // Actions are refused while in the lobby.
  const blocked = act(s, humans[0].id, { type: 'end_turn' });
  assert.equal(blocked.ok, false);

  // An open seat nobody joined becomes an AI when the host starts.
  const r = startGame(s);
  assert.ok(r.ok, r.error);
  assert.equal(s.phase, 'active');
  assert.equal(s.players.find((p) => p.id === humans[1].id).type, 'ai', 'unjoined seat converts to AI');
  // Starting again is a no-op error.
  assert.equal(startGame(s).ok, false);
  // normalizeState is a no-op on an already-current state.
  assert.equal(normalizeState(s).phase, 'active');
});

test('with two humans, ending a turn passes play to the other human (AI runs between)', async () => {
  const { createGame: cg, startGame, applyAction: act } = await import('../server/game/engine.js');
  const s = cg({ width: 18, height: 12, aiPlayers: 1, openSlots: 1, seed: 9 });
  const humans = s.players.filter((p) => p.type === 'human');
  s.players.find((p) => p.id === humans[1].id).joined = true; // second human joins
  startGame(s);
  assert.equal(s.currentPlayer, 0, 'host goes first');
  const res = act(s, humans[0].id, { type: 'end_turn' });
  assert.ok(res.ok, res.error);
  // Control rests on the second human; the AI seat in between runs automatically.
  assert.equal(s.players[s.currentPlayer].id, humans[1].id);
});

test('normalizeState upgrades a pre-lobby save', async () => {
  const { normalizeState } = await import('../server/game/engine.js');
  const legacy = {
    phase: undefined,
    players: [
      { id: 'p1', name: 'You', isHuman: true },
      { id: 'p2', name: 'Rival', isHuman: false },
    ],
    cities: [], units: [],
  };
  normalizeState(legacy);
  assert.equal(legacy.phase, 'active');
  assert.equal(legacy.openSlots, 0);
  assert.equal(legacy.players[0].type, 'human');
  assert.equal(legacy.players[0].joined, true);
  assert.equal(legacy.players[1].type, 'ai');
  assert.equal(legacy.players[0].token, null);
});

// --- Population equals territory ---------------------------------------------
test('a city population always equals the number of tiles it owns', () => {
  const s = createGame({ width: 18, height: 12, aiPlayers: 1, seed: 7 });
  const hid = humanId(s);
  const settler = s.units.find((u) => u.owner === hid && u.type === 'settler');
  applyAction(s, hid, { type: 'found_city', unitId: settler.id });
  const city = s.cities[0];
  const tiles = () => s.tiles.filter((t) => t.ownerCity === city.id).length;

  // Founding claims a tile ring, and population reflects that count exactly.
  assert.equal(city.population, tiles(), 'population matches tiles at founding');
  assert.equal(city.population, cityPopulation(s, city));
  assert.ok(city.population > 1, 'a founded city has its worked ring as citizens');

  // Buying a tile adds exactly one citizen.
  s.players.find((p) => p.id === hid).gold = 500;
  const popBefore = city.population;
  const target = cityFrontierTiles(s, city)[0];
  applyAction(s, hid, { type: 'buy_tile', cityId: city.id, x: target.x, y: target.y });
  assert.equal(city.population, popBefore + 1, 'each new tile is one more citizen');
  assert.equal(city.population, tiles(), 'population still equals tile count');
});

// --- Human-only games --------------------------------------------------------
test('difficulty gives the AI a starting-gold handicap and scales its income', () => {
  // Harder games hand the AI extra starting gold; humans stay at the baseline.
  const easy = createGame({ aiPlayers: 1, seed: 7, difficulty: 'easy' });
  const deity = createGame({ aiPlayers: 1, seed: 7, difficulty: 'deity' });
  const easyAi = easy.players.find((p) => p.type === 'ai');
  const deityAi = deity.players.find((p) => p.type === 'ai');
  const human = deity.players.find((p) => p.type === 'human');
  assert.equal(human.gold, STARTING_GOLD, 'human is never handicapped');
  assert.equal(easyAi.gold, STARTING_GOLD + DIFFICULTY.easy.startBonus);
  assert.equal(deityAi.gold, STARTING_GOLD + DIFFICULTY.deity.startBonus);
  assert.ok(deityAi.gold > easyAi.gold, 'harder AI starts richer');

  // The AI's per-turn income is scaled by the difficulty multiplier.
  recomputeEconomy(deity);
  // Reproduce the raw (pre-handicap) AI income and compare.
  const raw = deity.cities
    .filter((c) => c.owner === deityAi.id)
    .reduce((sum, c) => sum + c.goldPerTurn, 0);
  assert.equal(deityAi.goldPerTurn, Math.round(raw * DIFFICULTY.deity.incomeMult));
});

test('an unknown difficulty falls back to the default level', () => {
  const s = createGame({ aiPlayers: 1, seed: 7, difficulty: 'impossible-mode' });
  assert.equal(s.difficulty, DEFAULT_DIFFICULTY);
});

test('a game can be created with no AI (human-only)', () => {
  const s = createGame({ width: 18, height: 12, aiPlayers: 0, openSlots: 1, seed: 3 });
  assert.equal(s.players.length, 2, 'host plus one open human seat');
  assert.ok(s.players.every((p) => p.type === 'human'), 'no AI civs');
  assert.equal(s.players.filter((p) => p.type === 'ai').length, 0);
  assert.equal(s.phase, 'lobby', 'open seats start in a lobby');
});
