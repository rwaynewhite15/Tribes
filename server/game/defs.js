// Static game definitions: terrain, unit types, improvements, resources.
// Everything in this file is data only — no game state, no mutation.

// --- Terrain -----------------------------------------------------------------
// gold: base gold a city earns from working this tile (before improvements)
// moveCost: movement points to enter the tile
// passable: whether land units may stand on it
// canImprove: which improvement type a builder may construct here
export const TERRAIN = {
  grassland: { name: 'Grassland', gold: 1, moveCost: 1, passable: true,  canImprove: 'farm',       color: '#7cb342' },
  plains:    { name: 'Plains',    gold: 1, moveCost: 1, passable: true,  canImprove: 'farm',       color: '#c0ca33' },
  forest:    { name: 'Forest',    gold: 0, moveCost: 2, passable: true,  canImprove: 'lumbermill', color: '#33691e' },
  hills:     { name: 'Hills',     gold: 1, moveCost: 2, passable: true,  canImprove: 'mine',       color: '#8d6e63' },
  desert:    { name: 'Desert',    gold: 0, moveCost: 1, passable: true,  canImprove: null,         color: '#e0c068' },
  mountains: { name: 'Mountains', gold: 0, moveCost: 0, passable: false, canImprove: null,         color: '#616161' },
  water:     { name: 'Water',     gold: 0, moveCost: 0, passable: false, canImprove: null,         color: '#1e88e5' },
};

// --- Improvements ------------------------------------------------------------
// bonusGold: extra gold per turn this improvement adds to the worked tile
export const IMPROVEMENTS = {
  farm:       { name: 'Farm',        bonusGold: 1, terrain: 'grassland,plains', icon: '≡' }, // ≡
  mine:       { name: 'Mine',        bonusGold: 2, terrain: 'hills',             icon: '⛏' }, // ⛏
  lumbermill: { name: 'Lumber Mill', bonusGold: 1, terrain: 'forest',           icon: '▒' }, // ▒
};

// --- Special resources -------------------------------------------------------
// Sit on top of terrain. A builder may "harvest" them for a one-time gold lump.
export const RESOURCES = {
  goldore: { name: 'Gold Ore', harvest: 30, icon: '♦', color: '#ffd54f' }, // ♦
  wheat:   { name: 'Wheat',    harvest: 18, icon: '⚘', color: '#fff176' }, // ⚘
  deer:    { name: 'Deer',     harvest: 15, icon: '❦', color: '#bcaaa4' }, // ❦
};

// --- Units -------------------------------------------------------------------
// cost:     gold to buy in a city
// strength: combat strength
// hp:       max hit points
// moves:    movement points per turn
// range:    attack range (1 = melee; >1 = ranged, takes no counter-damage)
// role:     'settle' | 'build' | 'military'
// charges:  (builders) number of improvements/harvests before the unit is used up
export const UNITS = {
  settler:   { name: 'Settler',   cost: 40, strength: 0,  hp: 20,  moves: 2, range: 0, role: 'settle',   icon: '⚑' }, // ⚑
  builder:   { name: 'Builder',   cost: 25, strength: 0,  hp: 20,  moves: 2, range: 0, role: 'build',    icon: '⚒', charges: 3 }, // ⚒
  warrior:   { name: 'Warrior',   cost: 30, strength: 20, hp: 100, moves: 2, range: 1, role: 'military', icon: '⚔' }, // ⚔
  archer:    { name: 'Archer',    cost: 40, strength: 15, hp: 100, moves: 2, range: 2, role: 'military', icon: '➳' }, // ➳
  spearman:  { name: 'Spearman',  cost: 45, strength: 25, hp: 100, moves: 2, range: 1, role: 'military', icon: '↑' }, // ↑
  horseman:  { name: 'Horseman',  cost: 55, strength: 28, hp: 100, moves: 4, range: 1, role: 'military', icon: '♞' }, // ♞
  swordsman: { name: 'Swordsman', cost: 65, strength: 35, hp: 100, moves: 2, range: 1, role: 'military', icon: '☨' }, // ☨
  catapult:  { name: 'Catapult',  cost: 75, strength: 30, hp: 100, moves: 2, range: 2, role: 'military', icon: '⧉' }, // ⧉
};

// Units a city is allowed to purchase.
export const BUILDABLE_UNITS = Object.keys(UNITS);

// City defence baseline.
export const CITY = {
  baseHp: 100,
  baseStrength: 18,
  // Extra defensive strength per population point. Population now equals a
  // city's tile count (so a fresh city is ~7, not 1); this is tuned lower than
  // before so larger cities are tougher without becoming uncapturable.
  strengthPerPop: 1,
  // a garrisoned military unit lends part of its strength to the city
  garrisonStrengthFactor: 0.5,
  // gold a city centre produces on its own, before worked tiles
  baseGold: 2,
  // turns of accumulated food (gold-funded) needed to grow by 1 pop
  growthEvery: 6,
  minDistanceBetweenCities: 3,
  // hex radius of tiles claimed/worked by a city when it is founded
  workRadius: 1,
  // a city's territory may expand (via growth or purchase) out to this hex radius
  maxRadius: 3,
  // buying a border tile: cost = base + step * (tiles already purchased by the city)
  tileBuyBase: 20,
  tileBuyStep: 12,
};

export const STARTING_GOLD = 60;

// AI difficulty. Harder levels give the AI economic and expansion bonuses and
// push it to field bigger armies — it earns its edge through "handicap" bonuses
// plus smarter play, not by cheating at the combat dice.
//   incomeMult  : multiplier on the AI's gold/turn
//   startBonus  : extra starting gold per AI
//   maxCities   : how many cities the AI keeps expanding toward
//   armyPerCity : target military units per city it owns
export const DIFFICULTY = {
  easy:   { label: 'Easy',   incomeMult: 0.8, startBonus: 0,   maxCities: 3, armyPerCity: 1.5 },
  normal: { label: 'Normal', incomeMult: 1.1, startBonus: 20,  maxCities: 4, armyPerCity: 2 },
  hard:   { label: 'Hard',   incomeMult: 1.5, startBonus: 60,  maxCities: 6, armyPerCity: 3 },
  deity:  { label: 'Deity',  incomeMult: 2.0, startBonus: 120, maxCities: 8, armyPerCity: 4 },
};
export const DEFAULT_DIFFICULTY = 'hard';
