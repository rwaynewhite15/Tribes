// Persistence layer. Uses Neon/Postgres when DATABASE_URL is set, otherwise
// falls back to local JSON files under ./saves so the game runs with zero setup.
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import crypto from 'crypto';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SAVES_DIR = path.join(__dirname, '..', 'saves');
const DATABASE_URL = process.env.DATABASE_URL || process.env.NEON_DATABASE_URL || '';

let pool = null;
let mode = 'file';

export async function initStorage() {
  if (DATABASE_URL) {
    try {
      const { default: pg } = await import('pg');
      pool = new pg.Pool({
        connectionString: DATABASE_URL,
        // Neon requires SSL.
        ssl: DATABASE_URL.includes('localhost') ? false : { rejectUnauthorized: false },
        max: 5,
      });
      await pool.query(`
        CREATE TABLE IF NOT EXISTS games (
          id          TEXT PRIMARY KEY,
          name        TEXT NOT NULL,
          turn        INTEGER NOT NULL DEFAULT 1,
          game_over   BOOLEAN NOT NULL DEFAULT false,
          state       JSONB NOT NULL,
          created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
          updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
        );
      `);
      mode = 'postgres';
      console.log('[db] Connected to Postgres (Neon). Saved games will persist there.');
      return;
    } catch (err) {
      console.error('[db] Postgres init failed, falling back to file storage:', err.message);
      pool = null;
    }
  }
  await fs.mkdir(SAVES_DIR, { recursive: true });
  mode = 'file';
  console.log(`[db] Using local file storage at ${SAVES_DIR}. Set DATABASE_URL to persist to Neon.`);
}

export function storageMode() { return mode; }

function newId() { return 'g' + crypto.randomBytes(8).toString('hex'); }

export async function saveGame(state) {
  if (!state.id) state.id = newId();
  state.updatedAt = new Date().toISOString();
  if (mode === 'postgres') {
    await pool.query(
      `INSERT INTO games (id, name, turn, game_over, state, updated_at)
       VALUES ($1, $2, $3, $4, $5, now())
       ON CONFLICT (id) DO UPDATE
         SET name = EXCLUDED.name,
             turn = EXCLUDED.turn,
             game_over = EXCLUDED.game_over,
             state = EXCLUDED.state,
             updated_at = now()`,
      [state.id, state.name, state.turn, !!state.gameOver, JSON.stringify(state)],
    );
  } else {
    await fs.writeFile(path.join(SAVES_DIR, `${state.id}.json`), JSON.stringify(state, null, 2));
  }
  return state.id;
}

export async function loadGame(id) {
  if (mode === 'postgres') {
    const { rows } = await pool.query('SELECT state FROM games WHERE id = $1', [id]);
    return rows.length ? rows[0].state : null;
  }
  try {
    const raw = await fs.readFile(path.join(SAVES_DIR, `${id}.json`), 'utf8');
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

export async function listGames() {
  if (mode === 'postgres') {
    const { rows } = await pool.query(
      `SELECT id, name, turn, game_over, updated_at
         FROM games ORDER BY updated_at DESC LIMIT 100`,
    );
    return rows.map((r) => ({
      id: r.id, name: r.name, turn: r.turn, gameOver: r.game_over, updatedAt: r.updated_at,
    }));
  }
  try {
    const files = await fs.readdir(SAVES_DIR);
    const games = [];
    for (const f of files) {
      if (!f.endsWith('.json')) continue;
      try {
        const s = JSON.parse(await fs.readFile(path.join(SAVES_DIR, f), 'utf8'));
        const humans = (s.players || []).filter((p) => p.type === 'human' || p.isHuman);
        games.push({
          id: s.id, name: s.name, turn: s.turn, gameOver: !!s.gameOver, updatedAt: s.updatedAt || null,
          phase: s.phase || 'active', spectate: !!s.spectate,
          openSlots: humans.filter((p) => !p.joined).length,
          humanSlots: humans.length,
        });
      } catch { /* skip corrupt save */ }
    }
    games.sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
    return games;
  } catch {
    return [];
  }
}

export async function deleteGame(id) {
  if (mode === 'postgres') {
    await pool.query('DELETE FROM games WHERE id = $1', [id]);
    return;
  }
  try { await fs.unlink(path.join(SAVES_DIR, `${id}.json`)); } catch { /* already gone */ }
}
