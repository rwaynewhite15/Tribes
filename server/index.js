// Tribes — Express server. Serves the client and exposes the game API.
import express from 'express';
import path from 'path';
import crypto from 'crypto';
import { fileURLToPath } from 'url';
import {
  createGame, applyAction, reachableTiles, attackTargets, reseedIdCounter,
  cityDefenseStrength, cityFrontierTiles, tileBuyCost, stepSpectator, startGame,
  normalizeState,
} from './game/engine.js';
import { UNITS, IMPROVEMENTS, TERRAIN, RESOURCES } from './game/defs.js';
import {
  initStorage, saveGame, loadGame, listGames, deleteGame, storageMode,
} from './db.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
app.use(express.json({ limit: '4mb' }));
app.use(express.static(path.join(__dirname, '..', 'public')));

const genToken = () => crypto.randomBytes(16).toString('hex');
const tokenOf = (req) => req.get('x-player-token') || (req.body && req.body.token) || req.query.token || null;
// The player a request's token controls (or null for a non-player viewer).
const viewerOf = (state, token) => (token ? state.players.find((p) => p.token && p.token === token) : null);

// Who this request controls. A matching token always grants control. As a
// fallback, a single-human game (solo vs AI, or a legacy pre-multiplayer save)
// is driveable by any local client — it carries no real identity to protect.
// Multiplayer games (2+ human seats) are strictly token-gated.
function controllingPlayer(state, token) {
  const byToken = viewerOf(state, token);
  if (byToken) return byToken;
  const humans = state.players.filter((p) => p.type === 'human');
  if (humans.length === 1) return humans[0];
  return null;
}

// Build the client-facing view: strip secret tokens, attach the viewer's
// identity (_you) and, on their turn, their movement/attack/purchase hints.
function withHints(state, viewerId = null) {
  const view = JSON.parse(JSON.stringify(state));
  for (const p of view.players) delete p.token; // never leak tokens to clients
  const hints = {};
  const cityBuy = {};
  const viewer = viewerId ? state.players.find((p) => p.id === viewerId) : null;
  const yourTurn = viewer && !state.gameOver && state.phase !== 'lobby'
    && state.players[state.currentPlayer].id === viewer.id;
  if (yourTurn) {
    for (const u of state.units) {
      if (u.owner !== viewer.id) continue;
      const reach = reachableTiles(state, u);
      hints[u.id] = {
        moves: [...reach.keys()].map((k) => { const [x, y] = k.split(',').map(Number); return { x, y }; }),
        attacks: attackTargets(state, u),
      };
    }
    for (const c of state.cities) {
      if (c.owner !== viewer.id) continue;
      cityBuy[c.id] = {
        cost: tileBuyCost(c),
        tiles: cityFrontierTiles(state, c).map((t) => ({ x: t.x, y: t.y })),
      };
    }
  }
  view._hints = hints;
  view._cityBuy = cityBuy;
  view._you = viewer ? viewer.id : null;
  view._cityDef = {};
  for (const c of state.cities) view._cityDef[c.id] = cityDefenseStrength(state, c);
  return view;
}

// Static reference data the client needs to render menus and costs.
app.get('/api/defs', (req, res) => {
  res.json({ UNITS, IMPROVEMENTS, TERRAIN, RESOURCES });
});

app.get('/api/games', async (req, res) => {
  // Always 200 so the client can render the storage badge and a clear message;
  // a DB error becomes an inline note rather than a broken list.
  try {
    res.json({ games: await listGames(), storage: storageMode() });
  } catch (e) {
    console.error('[api] listGames failed:', e.message);
    res.json({ games: [], storage: storageMode(), error: e.message });
  }
});

app.post('/api/games', async (req, res) => {
  try {
    const { name, width, height, aiPlayers, spectate, openSlots, playerName } = req.body || {};
    const ai = clamp(aiPlayers, 0, 5, 1);
    const open = clamp(openSlots, 0, 5, 0);
    // A non-spectator game needs at least two players. With no AI, that means
    // at least one open seat for another human (a human-only game).
    if (!spectate && (1 + open + ai) < 2) {
      return res.status(400).json({ error: 'A game needs at least one rival or one open seat for another player.' });
    }
    const state = createGame({
      name: (name || 'New Game').slice(0, 60),
      width: clamp(width, 12, 30, 18),
      height: clamp(height, 8, 20, 12),
      aiPlayers: ai,
      openSlots: open,
      spectate: !!spectate,
    });
    // The creator becomes the host, holding the first human slot and its token.
    let token = null;
    const host = state.players.find((p) => p.host);
    if (host) {
      token = genToken();
      host.token = token;
      if (playerName) host.name = String(playerName).slice(0, 24);
    }
    await saveGame(state);
    res.json({ state: withHints(state, host ? host.id : null), token });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/games/:id', async (req, res) => {
  try {
    const state = await loadGame(req.params.id);
    if (!state) return res.status(404).json({ error: 'Game not found.' });
    reseedIdCounter(state);
    normalizeState(state);
    const viewer = controllingPlayer(state, tokenOf(req));
    res.json({ state: withHints(state, viewer ? viewer.id : null) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/games/:id', async (req, res) => {
  try { await deleteGame(req.params.id); res.json({ ok: true }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

// Claim an open human slot in a lobby. Returns a token for that slot.
app.post('/api/games/:id/join', async (req, res) => {
  try {
    const state = await loadGame(req.params.id);
    if (!state) return res.status(404).json({ error: 'Game not found.' });
    reseedIdCounter(state);
    normalizeState(state);
    // Already holding a slot in this game? Just return the current view.
    const existing = viewerOf(state, tokenOf(req));
    if (existing) return res.json({ state: withHints(state, existing.id), token: tokenOf(req) });
    if (state.phase !== 'lobby') return res.status(400).json({ error: 'This game has already started.' });
    const slot = state.players.find((p) => p.type === 'human' && !p.joined);
    if (!slot) return res.status(400).json({ error: 'No open slots remaining.' });
    const token = genToken();
    slot.joined = true;
    slot.token = token;
    const { playerName } = req.body || {};
    if (playerName) slot.name = String(playerName).slice(0, 24);
    await saveGame(state);
    res.json({ state: withHints(state, slot.id), token });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Host-only: leave the lobby and begin the game.
app.post('/api/games/:id/start', async (req, res) => {
  try {
    const state = await loadGame(req.params.id);
    if (!state) return res.status(404).json({ error: 'Game not found.' });
    reseedIdCounter(state);
    normalizeState(state);
    const viewer = viewerOf(state, tokenOf(req));
    if (!viewer || !viewer.host) return res.status(403).json({ error: 'Only the host can start the game.' });
    const result = startGame(state);
    if (!result.ok) return res.status(400).json({ error: result.error, state: withHints(state, viewer.id) });
    await saveGame(state);
    res.json({ state: withHints(state, viewer.id) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Apply a single human action, persist, and return the updated state.
app.post('/api/games/:id/action', async (req, res) => {
  try {
    const state = await loadGame(req.params.id);
    if (!state) return res.status(404).json({ error: 'Game not found.' });
    reseedIdCounter(state);
    normalizeState(state);
    const viewer = controllingPlayer(state, tokenOf(req));
    if (!viewer) {
      if (!state.players.some((p) => p.type === 'human'))
        return res.status(400).json({ error: 'This is a spectator game — use Play/Step to advance.' });
      return res.status(403).json({ error: 'Join the game to take actions.' });
    }
    const result = applyAction(state, viewer.id, req.body || {});
    if (!result.ok) {
      // Still return current state so the client can resync, with the error.
      return res.status(400).json({ error: result.error, state: withHints(state, viewer.id) });
    }
    await saveGame(state);
    res.json({ state: withHints(state, viewer.id) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Advance an AI-only (spectator) game by one civilization's turn.
app.post('/api/games/:id/advance', async (req, res) => {
  try {
    const state = await loadGame(req.params.id);
    if (!state) return res.status(404).json({ error: 'Game not found.' });
    if (!state.spectate) return res.status(400).json({ error: 'Not a spectator game.' });
    reseedIdCounter(state);
    normalizeState(state);
    stepSpectator(state);
    await saveGame(state);
    res.json({ state: withHints(state) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

function clamp(v, lo, hi, dflt) {
  const n = Number(v);
  if (!Number.isFinite(n)) return dflt;
  return Math.max(lo, Math.min(hi, Math.round(n)));
}

const PORT = process.env.PORT || 3000;
initStorage().then(() => {
  app.listen(PORT, () => {
    console.log(`\n  ⚔  Tribes is running → http://localhost:${PORT}\n`);
  });
});
