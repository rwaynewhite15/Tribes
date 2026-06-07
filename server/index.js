// Tribes — Express server. Serves the client and exposes the game API.
import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import {
  createGame, applyAction, reachableTiles, attackTargets, reseedIdCounter,
  cityDefenseStrength,
} from './game/engine.js';
import { UNITS, IMPROVEMENTS, TERRAIN, RESOURCES } from './game/defs.js';
import {
  initStorage, saveGame, loadGame, listGames, deleteGame, storageMode,
} from './db.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
app.use(express.json({ limit: '4mb' }));
app.use(express.static(path.join(__dirname, '..', 'public')));

const HUMAN = (state) => state.players.find((p) => p.isHuman);

// Attach per-unit derived hints (reachable tiles, attack targets) so the client
// can highlight options without re-implementing the rules.
function withHints(state) {
  const view = JSON.parse(JSON.stringify(state));
  const hints = {};
  const human = HUMAN(state);
  if (human && state.players[state.currentPlayer].id === human.id && !state.gameOver) {
    for (const u of state.units) {
      if (u.owner !== human.id) continue;
      const reach = reachableTiles(state, u);
      hints[u.id] = {
        moves: [...reach.keys()].map((k) => { const [x, y] = k.split(',').map(Number); return { x, y }; }),
        attacks: attackTargets(state, u),
      };
    }
  }
  view._hints = hints;
  // City defence strength for display.
  view._cityDef = {};
  for (const c of state.cities) view._cityDef[c.id] = cityDefenseStrength(state, c);
  return view;
}

// Static reference data the client needs to render menus and costs.
app.get('/api/defs', (req, res) => {
  res.json({ UNITS, IMPROVEMENTS, TERRAIN, RESOURCES });
});

app.get('/api/games', async (req, res) => {
  try { res.json({ games: await listGames(), storage: storageMode() }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/games', async (req, res) => {
  try {
    const { name, width, height, aiPlayers } = req.body || {};
    const state = createGame({
      name: (name || 'New Game').slice(0, 60),
      width: clamp(width, 12, 30, 18),
      height: clamp(height, 8, 20, 12),
      aiPlayers: clamp(aiPlayers, 1, 5, 1),
    });
    await saveGame(state);
    res.json({ state: withHints(state) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/games/:id', async (req, res) => {
  try {
    const state = await loadGame(req.params.id);
    if (!state) return res.status(404).json({ error: 'Game not found.' });
    reseedIdCounter(state);
    res.json({ state: withHints(state) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/games/:id', async (req, res) => {
  try { await deleteGame(req.params.id); res.json({ ok: true }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

// Apply a single human action, persist, and return the updated state.
app.post('/api/games/:id/action', async (req, res) => {
  try {
    const state = await loadGame(req.params.id);
    if (!state) return res.status(404).json({ error: 'Game not found.' });
    reseedIdCounter(state);
    const human = HUMAN(state);
    const result = applyAction(state, human.id, req.body || {});
    if (!result.ok) {
      // Still return current state so the client can resync, with the error.
      return res.status(400).json({ error: result.error, state: withHints(state) });
    }
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
