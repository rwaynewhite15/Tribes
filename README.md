# ⚔ Tribes

A simple **Civilization-style domination game** that runs in your browser. Settle
cities with Settlers, develop the land with Builders, raise an army, and conquer
every rival city to win. No culture, science, or faith — the only currency is
**gold**. The world is a **hexagonal tile map**, so every tile has six
neighbours.

## Gameplay

- **Settle** — move a Settler onto good ground and *Found City*. Cities claim the
  surrounding tiles and earn gold every turn.
- **Develop** — use Builders (3 charges each) to build:
  - **Farms** on grassland/plains (+1 gold)
  - **Mines** on hills (+2 gold)
  - **Lumber Mills** on forest (+1 gold)
  - or **Harvest** special resources (Gold Ore, Wheat, Deer) for a one-time gold lump.
- **Train** — spend gold in your cities to recruit Warriors, Archers, Spearmen,
  Horsemen, Swordsmen, and Catapults, plus more Settlers and Builders.
- **Conquer** — units have combat strength and HP. Melee units trade blows and can
  advance into a kill; ranged units (Archer, Catapult) strike without taking a
  counterattack but cannot capture. Bombard a city to 0 HP, then walk a melee unit
  in to capture it.
- **Win** — eliminate every rival (capture all their cities) for a **Domination
  Victory**. Lose your last city and you're out.

The game is turn-based: take all your actions, then **End Turn** and the AI rivals
take theirs.

### Controls

The game is built to play well with touch (Chrome on a phone) or mouse.

| Action | Touch | Mouse / keyboard |
| --- | --- | --- |
| Select unit / city / tile | Tap | Click |
| Move / attack | Tap a highlighted tile (blue = move, red = attack) | Click it |
| Unit / city actions | Bottom sheet (Found City, Build, Harvest, Train, Fortify…) | Right-hand panel |
| Pan the map | One-finger drag | Click-drag |
| Zoom | Pinch, or the ＋ / － buttons | Mouse wheel or ＋ / － |
| Show / hide info panel | Tap the ▴ handle; switch Selection / Chronicle tabs | (always visible) |
| End turn | End Turn button | `Space` |
| Clear selection | — | `Esc` |

On phones the side panel becomes a collapsible **bottom sheet** so the map stays
front-and-centre; it pops open automatically when you select something.

## Running it

Requires Node.js 18+.

```bash
npm install
npm start
# open http://localhost:3000
```

For auto-reload during development: `npm run dev`. Run the engine tests with
`npm test`.

## Deploying to Render

This repo includes a [`render.yaml`](./render.yaml) blueprint.

1. Push the repo to GitHub.
2. In the Render dashboard: **New → Blueprint**, point it at the repo, and apply.
   (Or **New → Web Service** with Build Command `npm install` and Start Command
   `npm start` — Render injects `PORT` automatically.)
3. *(Optional but recommended)* add a `DATABASE_URL` environment variable in the
   Render dashboard with your Neon connection string so saved games survive
   restarts and deploys.

> ⚠️ Without `DATABASE_URL`, saves go to the container's local filesystem, which
> Render wipes on every deploy/restart. Set the Neon string to keep your games.

Once it's live, open the URL on your phone's Chrome browser and play — and add it
to your home screen for a full-screen, app-like experience.

## Saving games (Neon / Postgres)

Saved games persist automatically. By default they're written to local JSON files
under `./saves`, so the game works with **zero setup**.

To persist to a [Neon](https://neon.tech) (or any Postgres) database instead, set a
connection string:

```bash
cp .env.example .env
# edit .env and set DATABASE_URL=postgresql://...neon.tech/tribes?sslmode=require
```

or export it directly:

```bash
export DATABASE_URL='postgresql://user:pass@ep-xxx.aws.neon.tech/tribes?sslmode=require'
npm start
```

On startup the server creates a `games` table automatically if it doesn't exist.
The main menu shows whether you're using **Neon DB** or **local files**. Every
action auto-saves, and you can load or delete saved games from the menu.

> Note: this project reads `process.env.DATABASE_URL`. If you keep the value in a
> `.env` file and want Node to load it for you, run with
> `node --env-file=.env server/index.js`.

## Project layout

```
server/
  index.js        Express server + REST API
  db.js           Persistence: Postgres (Neon) with JSON-file fallback
  game/
    defs.js       Static data: terrain, units, improvements, resources
    map.js        Procedural map generation (seeded)
                  (hex grid uses pointy-top, odd-r offset coordinates)
    engine.js     Authoritative game logic, combat, and AI
public/
  index.html      App shell (menu + game + overlays)
  styles.css      Styling
  game.js         Canvas rendering and interaction
test/
  engine.test.js  Engine smoke tests (node:test)
```

The server is authoritative: the client sends actions (`move`, `attack`,
`found_city`, `build`, `harvest`, `buy_unit`, `fortify`, `end_turn`) and renders
whatever state the server returns, including per-unit movement/attack hints.

## Roadmap

- ✅ Single-player vs AI, mobile-friendly touch controls, Render-ready, optional
  Neon persistence.
- ⏳ **Two-player games.** The server is already authoritative (clients only send
  actions and render returned state), so multiplayer is mostly a matter of adding
  per-player identity/turn gating and a way to share a game id between two
  devices.
- ⏳ Polishing core gameplay balance based on playtesting.

## License

MIT
