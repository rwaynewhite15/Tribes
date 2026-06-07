// Tribes client. Renders the board on a canvas and talks to the server API.
'use strict';

const $ = (id) => document.getElementById(id);
const api = {
  async get(url) { const r = await fetch(url); return r.json(); },
  async post(url, body) {
    const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) });
    return { ok: r.ok, data: await r.json() };
  },
  async del(url) { const r = await fetch(url, { method: 'DELETE' }); return r.json(); },
};

const G = {
  defs: null,
  state: null,
  gameId: null,
  selUnit: null,   // selected unit id
  selCity: null,   // selected city id
  selTile: null,   // inspected bare-terrain tile {x,y}
  hoverTile: null,
  // camera + viewport (CSS pixels; dpr scales the backing buffer)
  cam: { x: 0, y: 0, scale: 1 },
  view: { cssW: 0, cssH: 0, dpr: 1 },
  drag: null,
  pointers: new Map(), // active touch/mouse pointers for pan + pinch
  pinch: null,
};

// --- Hex grid geometry (pointy-top, odd-r offset) ----------------------------
const HEX_S = 40;                      // hex "radius" (centre to corner) in world px
const HEX_W = Math.sqrt(3) * HEX_S;    // width across the flats
const HEX_H = 2 * HEX_S;               // full height (corner to corner)
const HEX_VSTEP = 1.5 * HEX_S;         // vertical distance between row centres
const ORIGIN_X = HEX_W / 2;            // margin so col 0 isn't clipped
const ORIGIN_Y = HEX_S;

// World-pixel centre of the hex at offset (col,row). Odd rows shift right.
function hexCenter(col, row) {
  return {
    x: ORIGIN_X + HEX_W * (col + (row & 1) * 0.5),
    y: ORIGIN_Y + HEX_VSTEP * row,
  };
}

// Trace a pointy-top hexagon path centred at (cx,cy) (caller fills/strokes).
function hexPath(cx, cy, r = HEX_S) {
  ctx.beginPath();
  for (let i = 0; i < 6; i++) {
    const a = Math.PI / 180 * (60 * i - 90); // vertex at the top
    const x = cx + r * Math.cos(a), y = cy + r * Math.sin(a);
    if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
  }
  ctx.closePath();
}

function hexRound(qf, rf) {
  let x = qf, z = rf, y = -qf - rf;
  let rx = Math.round(x), ry = Math.round(y), rz = Math.round(z);
  const dx = Math.abs(rx - x), dy = Math.abs(ry - y), dz = Math.abs(rz - z);
  if (dx > dy && dx > dz) rx = -ry - rz;
  else if (dy > dz) ry = -rx - rz;
  else rz = -rx - ry;
  return { q: rx, r: rz };
}

// World pixel -> tile {x:col, y:row}, or null if outside the map.
function worldToTile(wx, wy) {
  const px = wx - ORIGIN_X, py = wy - ORIGIN_Y;
  const qf = (Math.sqrt(3) / 3 * px - 1 / 3 * py) / HEX_S;
  const rf = (2 / 3 * py) / HEX_S;
  const { q, r } = hexRound(qf, rf);
  const col = q + ((r - (r & 1)) / 2);
  const row = r;
  if (col < 0 || row < 0 || col >= G.state.width || row >= G.state.height) return null;
  return { x: col, y: row };
}

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------
window.addEventListener('DOMContentLoaded', async () => {
  G.defs = await api.get('/api/defs');
  bindMenu();
  bindGameControls();
  await refreshSavedGames();
  await tryResume();
});

const LAST_GAME_KEY = 'tribes.lastGameId';

// If we were in a game before a reload/refresh, drop the player straight back in.
async function tryResume() {
  let id;
  try { id = localStorage.getItem(LAST_GAME_KEY); } catch { id = null; }
  if (!id) return;
  try {
    const res = await api.get('/api/games/' + id);
    if (res && res.state && res.state.id) { enterGame(res.state); return; }
  } catch { /* fall through to menu */ }
  try { localStorage.removeItem(LAST_GAME_KEY); } catch {}
}

function bindMenu() {
  $('ng-start').addEventListener('click', startNewGame);
  $('go-menu').addEventListener('click', () => { $('gameover').classList.add('hidden'); showMenu(); });
  $('btn-menu').addEventListener('click', showMenu);
  $('btn-refresh').addEventListener('click', refreshSavedGames);
}

async function refreshSavedGames() {
  const ul = $('saved-list');
  ul.innerHTML = '<li class="empty">Loading…</li>';
  let games, storage, error;
  try {
    const res = await api.get('/api/games');
    games = res.games; storage = res.storage; error = res.error;
  } catch (e) {
    error = e.message || 'Network error';
  }
  $('storage-badge').textContent = storage === 'postgres' ? 'Neon DB' : (storage ? 'local files' : '—');
  ul.innerHTML = '';
  if (error) {
    ul.innerHTML = `<li class="empty err">Couldn't load saved games: ${escapeHtml(error)}</li>`;
    return;
  }
  if (!games || !games.length) { ul.innerHTML = '<li class="empty">No saved games yet.</li>'; return; }
  for (const g of games) {
    const li = document.createElement('li');
    const when = g.updatedAt ? new Date(g.updatedAt).toLocaleString() : '';
    li.innerHTML = `
      <div class="sg-info">
        <span class="sg-name">${escapeHtml(g.name)} ${g.gameOver ? '🏁' : ''}</span>
        <span class="sg-meta">Turn ${g.turn} · ${when}</span>
      </div>
      <div class="sg-actions">
        <button class="primary load">Load</button>
        <button class="del">✕</button>
      </div>`;
    li.querySelector('.load').addEventListener('click', () => loadGame(g.id));
    li.querySelector('.del').addEventListener('click', async () => {
      await api.del('/api/games/' + g.id);
      try { if (localStorage.getItem(LAST_GAME_KEY) === g.id) localStorage.removeItem(LAST_GAME_KEY); } catch {}
      refreshSavedGames();
    });
    ul.appendChild(li);
  }
}

async function startNewGame() {
  const name = $('ng-name').value || 'My Empire';
  const [w, h] = $('ng-size').value.split('x').map(Number);
  const aiPlayers = Number($('ng-ai').value);
  const { ok, data } = await api.post('/api/games', { name, width: w, height: h, aiPlayers });
  if (!ok) { toast(data.error || 'Failed to create game'); return; }
  enterGame(data.state);
}

async function loadGame(id) {
  const { state } = await api.get('/api/games/' + id);
  if (!state) { toast('Could not load game'); return; }
  enterGame(state);
}

function showMenu() {
  $('game').classList.add('hidden');
  $('menu').classList.remove('hidden');
  refreshSavedGames();
}

// ---------------------------------------------------------------------------
// Entering the game
// ---------------------------------------------------------------------------
let canvas, ctx;
function enterGame(state) {
  G.state = state;
  G.gameId = state.id;
  try { localStorage.setItem(LAST_GAME_KEY, state.id); } catch {}
  G.selUnit = null; G.selCity = null;
  $('menu').classList.add('hidden');
  $('game').classList.remove('hidden');
  canvas = $('board');
  ctx = canvas.getContext('2d');
  resizeCanvas();
  centerOnHumanStart();
  render();
  updateHud();
  renderLog();
  renderSelection();
  setSheetTab('sel');
  if (isMobileLayout()) toggleSheet(true); // show the intro hint on phones
  maybeGameOver();
}

function centerOnHumanStart() {
  const human = G.state.players.find((p) => p.isHuman);
  let fx = G.state.width / 2, fy = G.state.height / 2;
  const u = G.state.units.find((x) => x.owner === human.id);
  const c = G.state.cities.find((x) => x.owner === human.id);
  const focus = c || u;
  if (focus) { fx = focus.x; fy = focus.y; }
  // Fit a few tiles on screen at a sensible default zoom for phones.
  G.cam.scale = G.view.cssW < 560 ? Math.max(0.6, Math.min(1, G.view.cssW / (6 * HEX_W))) : 1;
  const c0 = hexCenter(fx, fy);
  G.cam.x = c0.x - G.view.cssW / (2 * G.cam.scale);
  G.cam.y = c0.y - G.view.cssH / (2 * G.cam.scale);
  clampCamera();
}

window.addEventListener('resize', () => { if (!$('game').classList.contains('hidden')) { resizeCanvas(); render(); } });
// Size the backing buffer for the device pixel ratio so the map stays crisp on
// retina / high-density phone screens, while we draw in CSS-pixel coordinates.
function resizeCanvas() {
  const wrap = $('board-wrap');
  const dpr = Math.min(window.devicePixelRatio || 1, 3);
  G.view.cssW = wrap.clientWidth;
  G.view.cssH = wrap.clientHeight;
  G.view.dpr = dpr;
  canvas.width = Math.round(G.view.cssW * dpr);
  canvas.height = Math.round(G.view.cssH * dpr);
  canvas.style.width = G.view.cssW + 'px';
  canvas.style.height = G.view.cssH + 'px';
}

// ---------------------------------------------------------------------------
// Controls
// ---------------------------------------------------------------------------
function bindGameControls() {
  // The canvas element is static in the HTML, so grab it now. (enterGame also
  // sets these, but we must bind listeners to the real element here, not to the
  // still-undefined module variable, or every game control fails to attach.)
  canvas = $('board');
  ctx = canvas.getContext('2d');

  $('btn-end').addEventListener('click', endTurn);

  // Unified pointer handling works for touch, pen and mouse:
  //   1 pointer  -> tap to select/act, drag to pan
  //   2 pointers -> pinch to zoom
  canvas.addEventListener('pointerdown', onPointerDown);
  canvas.addEventListener('pointermove', onPointerMove, { passive: false });
  canvas.addEventListener('pointerup', onPointerUp);
  canvas.addEventListener('pointercancel', onPointerUp);
  canvas.addEventListener('pointerleave', (e) => { if (e.pointerType === 'mouse') hideTooltip(); });

  // Desktop wheel zoom.
  canvas.addEventListener('wheel', (e) => {
    e.preventDefault();
    const factor = e.deltaY < 0 ? 1.12 : 1 / 1.12;
    const rect = canvas.getBoundingClientRect();
    zoomAt(e.clientX - rect.left, e.clientY - rect.top, factor);
    clampCamera(); render();
  }, { passive: false });

  // Zoom buttons (handy on phones without a mouse wheel).
  $('btn-zoom-in').addEventListener('click', () => { zoomAt(G.view.cssW / 2, G.view.cssH / 2, 1.25); clampCamera(); render(); });
  $('btn-zoom-out').addEventListener('click', () => { zoomAt(G.view.cssW / 2, G.view.cssH / 2, 1 / 1.25); clampCamera(); render(); });

  // Mobile bottom-sheet: handle toggles open/closed; tapping the hint also
  // toggles; tapping a tab switches panel and expands the sheet on demand.
  $('sheet-toggle').addEventListener('click', () => toggleSheet());
  $('sheet-hint').addEventListener('click', () => toggleSheet());
  document.querySelectorAll('.sheet-tabs button').forEach((b) => {
    b.addEventListener('click', () => { setSheetTab(b.dataset.tab); if (isMobileLayout()) toggleSheet(true); });
  });

  // Keyboard: space ends turn, Esc clears selection.
  window.addEventListener('keydown', (e) => {
    if ($('game').classList.contains('hidden')) return;
    if (e.code === 'Space') { e.preventDefault(); endTurn(); }
    if (e.code === 'Escape') { G.selUnit = null; G.selCity = null; renderSelection(); render(); }
  });
}

function localXY(e) {
  const rect = canvas.getBoundingClientRect();
  return { x: e.clientX - rect.left, y: e.clientY - rect.top };
}

function onPointerDown(e) {
  canvas.setPointerCapture?.(e.pointerId);
  const p = localXY(e);
  G.pointers.set(e.pointerId, p);
  if (G.pointers.size === 1) {
    G.drag = { x: p.x, y: p.y, camX: G.cam.x, camY: G.cam.y, moved: false, t: Date.now() };
  } else if (G.pointers.size === 2) {
    G.drag = null; // switch from pan to pinch
    const pts = [...G.pointers.values()];
    G.pinch = { dist: dist(pts[0], pts[1]), scale: G.cam.scale };
  }
}

function onPointerMove(e) {
  if (!G.pointers.has(e.pointerId)) {
    if (e.pointerType === 'mouse') { const p = localXY(e); onHover(p.x, p.y, e.clientX, e.clientY); }
    return;
  }
  e.preventDefault();
  const p = localXY(e);
  G.pointers.set(e.pointerId, p);

  if (G.pinch && G.pointers.size >= 2) {
    const pts = [...G.pointers.values()];
    const d = dist(pts[0], pts[1]);
    const mid = { x: (pts[0].x + pts[1].x) / 2, y: (pts[0].y + pts[1].y) / 2 };
    const target = Math.max(0.45, Math.min(2.4, G.pinch.scale * (d / G.pinch.dist)));
    setScaleAt(mid.x, mid.y, target);
    clampCamera(); render();
    return;
  }

  if (G.drag) {
    const dx = p.x - G.drag.x, dy = p.y - G.drag.y;
    if (Math.abs(dx) + Math.abs(dy) > 6) G.drag.moved = true;
    G.cam.x = G.drag.camX - dx / G.cam.scale;
    G.cam.y = G.drag.camY - dy / G.cam.scale;
    clampCamera(); render();
  }
}

function onPointerUp(e) {
  const wasTap = G.drag && !G.drag.moved && (Date.now() - G.drag.t) < 500;
  const p = G.pointers.get(e.pointerId);
  G.pointers.delete(e.pointerId);
  canvas.releasePointerCapture?.(e.pointerId);

  if (G.pointers.size < 2) G.pinch = null;
  if (G.pointers.size === 1) {
    // Dropped one finger of a pinch — resume panning from the remaining finger.
    const rem = [...G.pointers.values()][0];
    G.drag = { x: rem.x, y: rem.y, camX: G.cam.x, camY: G.cam.y, moved: true, t: Date.now() };
    return;
  }
  if (G.pointers.size === 0) {
    if (wasTap && p) onClickBoard(p.x, p.y);
    G.drag = null;
  }
}

function dist(a, b) { return Math.hypot(a.x - b.x, a.y - b.y); }

// Zoom keeping the world point under (sx,sy) fixed on screen.
function zoomAt(sx, sy, factor) {
  setScaleAt(sx, sy, Math.max(0.45, Math.min(2.4, G.cam.scale * factor)));
}
function setScaleAt(sx, sy, newScale) {
  const wx = G.cam.x + sx / G.cam.scale, wy = G.cam.y + sy / G.cam.scale;
  G.cam.scale = newScale;
  G.cam.x = wx - sx / G.cam.scale;
  G.cam.y = wy - sy / G.cam.scale;
}

function clampCamera() {
  const worldW = HEX_W * (G.state.width + 0.5) + ORIGIN_X;
  const worldH = HEX_VSTEP * (G.state.height - 1) + HEX_H + ORIGIN_Y;
  const viewW = G.view.cssW / G.cam.scale, viewH = G.view.cssH / G.cam.scale;
  if (worldW <= viewW) G.cam.x = (worldW - viewW) / 2;
  else G.cam.x = Math.max(-40, Math.min(worldW - viewW + 40, G.cam.x));
  if (worldH <= viewH) G.cam.y = (worldH - viewH) / 2;
  else G.cam.y = Math.max(-40, Math.min(worldH - viewH + 40, G.cam.y));
}

function screenToTile(sx, sy) {
  const wx = G.cam.x + sx / G.cam.scale;
  const wy = G.cam.y + sy / G.cam.scale;
  return worldToTile(wx, wy);
}

// ---------------------------------------------------------------------------
// Click / hover handling
// ---------------------------------------------------------------------------
function isHumanTurn() {
  const human = G.state.players.find((p) => p.isHuman);
  return !G.state.gameOver && G.state.players[G.state.currentPlayer].id === human.id;
}

async function onClickBoard(sx, sy) {
  const t = screenToTile(sx, sy);
  if (!t) return;
  const human = G.state.players.find((p) => p.isHuman);

  const unitHere = G.state.units.find((u) => u.x === t.x && u.y === t.y);
  const cityHere = G.state.cities.find((c) => c.x === t.x && c.y === t.y);

  // If we have a selected unit and click is a valid move/attack, act.
  if (G.selUnit && isHumanTurn()) {
    const sel = G.state.units.find((u) => u.id === G.selUnit);
    const hints = G.state._hints[G.selUnit];
    if (sel && hints) {
      const atk = hints.attacks.find((a) => a.x === t.x && a.y === t.y);
      if (atk) { await doAction({ type: 'attack', unitId: sel.id, x: t.x, y: t.y }); return; }
      const mv = hints.moves.find((m) => m.x === t.x && m.y === t.y);
      if (mv && !(unitHere) && !(cityHere && cityHere.owner !== human.id)) {
        await doAction({ type: 'move', unitId: sel.id, x: t.x, y: t.y }); return;
      }
    }
  }

  // Otherwise: select what's under the cursor (prefer own unit, then city).
  G.selTile = null;
  if (unitHere && unitHere.owner === human.id) { G.selUnit = unitHere.id; G.selCity = null; }
  else if (cityHere && cityHere.owner === human.id) { G.selCity = cityHere.id; G.selUnit = null; }
  else if (unitHere) { G.selUnit = unitHere.id; G.selCity = null; } // inspect enemy unit
  else if (cityHere) { G.selCity = cityHere.id; G.selUnit = null; }
  else { G.selUnit = null; G.selCity = null; G.selTile = t; } // inspect bare terrain
  // Note: we intentionally do NOT force the bottom sheet open here, so a player
  // who minimized it can keep tapping the map without it popping back up. The
  // collapsed bar shows what's selected; tap the handle or a tab to expand.
  setSheetTab('sel');
  renderSelection(); render();
}

function hideTooltip() { $('tooltip').classList.add('hidden'); }

function onHover(sx, sy, clientX, clientY) {
  const t = screenToTile(sx, sy);
  G.hoverTile = t;
  const tip = $('tooltip');
  if (!t) { tip.classList.add('hidden'); render(); return; }
  const tile = G.state.tiles[t.y * G.state.width + t.x];
  const def = G.defs.TERRAIN[tile.terrain];
  let html = `<b>${def.name}</b> (${t.x},${t.y})<br>Gold ${terrainTileGold(tile)}`;
  if (tile.improvement) html += `<br>${G.defs.IMPROVEMENTS[tile.improvement].name}`;
  if (tile.resource) html += `<br>✦ ${G.defs.RESOURCES[tile.resource].name}`;
  const u = G.state.units.find((x) => x.x === t.x && x.y === t.y);
  const c = G.state.cities.find((x) => x.x === t.x && x.y === t.y);
  if (c) { const owner = G.state.players.find((p) => p.id === c.owner); html += `<br><b style="color:${owner.color}">${c.name}</b> · HP ${c.hp}/${c.maxHp} · Def ${G.state._cityDef[c.id]}`; }
  if (u) { const owner = G.state.players.find((p) => p.id === u.owner); const ud = G.defs.UNITS[u.type]; html += `<br><b style="color:${owner.color}">${ud.name}</b> · HP ${u.hp}/${u.maxHp}` + (ud.strength ? ` · Str ${ud.strength}` : ''); }
  tip.innerHTML = html;
  tip.style.left = Math.min(clientX + 14, window.innerWidth - 230) + 'px';
  tip.style.top = (clientY + 14) + 'px';
  tip.classList.remove('hidden');
  render();
}

function terrainTileGold(tile) {
  let g = G.defs.TERRAIN[tile.terrain].gold;
  if (tile.improvement) g += G.defs.IMPROVEMENTS[tile.improvement].bonusGold;
  return g;
}

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------
async function doAction(action) {
  if (!isHumanTurn() && action.type !== 'end_turn') { toast('Not your turn'); return; }
  setStatus('Working…');
  const { ok, data } = await api.post(`/api/games/${G.gameId}/action`, action);
  if (!ok) {
    toast(data.error || 'Action failed');
    if (data.state) G.state = data.state;
  } else {
    G.state = data.state;
  }
  setStatus('');
  // Keep selection valid.
  if (G.selUnit && !G.state.units.find((u) => u.id === G.selUnit)) G.selUnit = null;
  if (G.selCity && !G.state.cities.find((c) => c.id === G.selCity)) G.selCity = null;
  updateHud(); renderLog(); renderSelection(); render(); maybeGameOver();
}

async function endTurn() {
  if (!isHumanTurn()) return;
  G.selUnit = null;
  setStatus('Rivals are scheming…');
  await doAction({ type: 'end_turn' });
}

// ---------------------------------------------------------------------------
// Rendering — canvas board
// ---------------------------------------------------------------------------
function render() {
  if (!G.state) return;
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.fillStyle = '#0b0f14';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.scale(G.view.dpr, G.view.dpr); // map device pixels -> CSS pixels
  ctx.scale(G.cam.scale, G.cam.scale);
  ctx.translate(-G.cam.x, -G.cam.y);

  const s = G.state;
  const sel = G.selUnit ? s.units.find((u) => u.id === G.selUnit) : null;
  const hints = sel ? s._hints[sel.id] : null;
  const moveSet = new Set(hints ? hints.moves.map((m) => m.x + ',' + m.y) : []);
  const atkSet = new Set(hints ? hints.attacks.map((m) => m.x + ',' + m.y) : []);

  // Visible world rect (+margin) so we only draw hexes that are on screen.
  const vx0 = G.cam.x - HEX_W, vy0 = G.cam.y - HEX_H;
  const vx1 = G.cam.x + G.view.cssW / G.cam.scale + HEX_W;
  const vy1 = G.cam.y + G.view.cssH / G.cam.scale + HEX_H;

  // Tiles
  for (let y = 0; y < s.height; y++) {
    for (let x = 0; x < s.width; x++) {
      const c = hexCenter(x, y);
      if (c.x < vx0 || c.x > vx1 || c.y < vy0 || c.y > vy1) continue; // cull
      const tile = s.tiles[y * s.width + x];
      hexPath(c.x, c.y);
      ctx.fillStyle = G.defs.TERRAIN[tile.terrain].color;
      ctx.fill();
      // subtle checker texture
      if ((x + y) % 2 === 0) { ctx.fillStyle = 'rgba(0,0,0,0.06)'; ctx.fill(); }

      // territory tint
      if (tile.ownerCity) {
        const city = s.cities.find((cc) => cc.id === tile.ownerCity);
        if (city) {
          const owner = s.players.find((p) => p.id === city.owner);
          ctx.fillStyle = hexA(owner.color, 0.20); ctx.fill();
        }
      }

      // move / attack highlights
      const key = x + ',' + y;
      if (atkSet.has(key)) { ctx.fillStyle = 'rgba(224,82,82,0.42)'; ctx.fill(); }
      else if (moveSet.has(key)) { ctx.fillStyle = 'rgba(79,157,222,0.30)'; ctx.fill(); }

      // resource / improvement glyphs
      if (tile.resource) {
        drawGlyph(G.defs.RESOURCES[tile.resource].icon, c.x, c.y - HEX_S * 0.34, 17, G.defs.RESOURCES[tile.resource].color);
      }
      if (tile.improvement) {
        drawGlyph(G.defs.IMPROVEMENTS[tile.improvement].icon, c.x + HEX_W * 0.26, c.y + HEX_S * 0.5, 15, 'rgba(255,255,255,.85)');
      }

      // grid outline
      hexPath(c.x, c.y);
      ctx.strokeStyle = 'rgba(0,0,0,0.22)'; ctx.lineWidth = 1; ctx.stroke();

      if (G.hoverTile && G.hoverTile.x === x && G.hoverTile.y === y) {
        hexPath(c.x, c.y, HEX_S - 1);
        ctx.strokeStyle = 'rgba(255,255,255,0.7)'; ctx.lineWidth = 2; ctx.stroke();
      }
    }
  }

  // Cities
  for (const c of s.cities) {
    const owner = s.players.find((p) => p.id === c.owner);
    const ct = hexCenter(c.x, c.y);
    hexPath(ct.x, ct.y, HEX_S * 0.74);
    ctx.fillStyle = owner.color; ctx.fill();
    ctx.strokeStyle = 'rgba(0,0,0,.5)'; ctx.lineWidth = 2; ctx.stroke();
    drawGlyph('★', ct.x, ct.y + HEX_S * 0.28, 22, '#fff', 'center');
    label(c.name, ct.x, ct.y - HEX_S * 0.66, owner.color);
    hpBar(ct.x - HEX_W * 0.32, ct.y + HEX_S * 0.62, HEX_W * 0.64, c.hp / c.maxHp, '#e0c050');
    // population badge
    ctx.fillStyle = '#000a'; roundRect(ct.x + HEX_W * 0.16, ct.y - HEX_S * 0.5, 18, 16, 4); ctx.fill();
    drawGlyph(String(c.population), ct.x + HEX_W * 0.16 + 9, ct.y - HEX_S * 0.5 + 12, 12, '#fff', 'center');
    if (G.selCity === c.id) { hexPath(ct.x, ct.y, HEX_S - 2); ctx.strokeStyle = '#fff'; ctx.lineWidth = 3; ctx.stroke(); }
  }

  // Units
  for (const u of s.units) {
    const owner = s.players.find((p) => p.id === u.owner);
    const ud = G.defs.UNITS[u.type];
    const ct = hexCenter(u.x, u.y);
    const r = HEX_S * 0.44;
    ctx.beginPath();
    ctx.arc(ct.x, ct.y, r, 0, Math.PI * 2);
    ctx.fillStyle = owner.color; ctx.fill();
    ctx.lineWidth = 2; ctx.strokeStyle = (u.movesLeft > 0 && owner.isHuman) ? '#fff' : 'rgba(0,0,0,.55)'; ctx.stroke();
    drawGlyph(ud.icon, ct.x, ct.y + 7, 21, '#fff', 'center');
    if (ud.role === 'military') hpBar(ct.x - HEX_W * 0.28, ct.y + HEX_S * 0.5, HEX_W * 0.56, u.hp / u.maxHp, '#4caf50');
    if (u.fortified) drawGlyph('⛨', ct.x + HEX_W * 0.26, ct.y - HEX_S * 0.3, 13, '#cfd8e0', 'center');
    if (G.selUnit === u.id) {
      ctx.beginPath(); ctx.arc(ct.x, ct.y, r + HEX_S * 0.12, 0, Math.PI * 2);
      ctx.strokeStyle = '#fff'; ctx.lineWidth = 3; ctx.stroke();
    }
  }
}

function drawGlyph(text, x, y, size, color, align = 'center') {
  ctx.font = `${size}px 'Segoe UI Symbol', system-ui, sans-serif`;
  ctx.textAlign = align; ctx.fillStyle = color;
  ctx.fillText(text, x, y);
  ctx.textAlign = 'left';
}
function label(text, x, y, color) {
  ctx.font = "bold 12px system-ui"; ctx.textAlign = 'center';
  ctx.lineWidth = 3; ctx.strokeStyle = 'rgba(0,0,0,.7)'; ctx.strokeText(text, x, y);
  ctx.fillStyle = '#fff'; ctx.fillText(text, x, y); ctx.textAlign = 'left';
}
function hpBar(x, y, w, frac, color) {
  ctx.fillStyle = 'rgba(0,0,0,.55)'; ctx.fillRect(x - 1, y - 1, w + 2, 6);
  ctx.fillStyle = color; ctx.fillRect(x, y, Math.max(0, w * frac), 4);
}
function roundRect(x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}
function hexA(hex, a) {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
}

// ---------------------------------------------------------------------------
// HUD / sidebar / log
// ---------------------------------------------------------------------------
function updateHud() {
  const s = G.state;
  const human = s.players.find((p) => p.isHuman);
  $('hud-turn').textContent = s.turn;
  $('hud-gold').textContent = Math.floor(human.gold);
  $('hud-gpt').textContent = `(+${human.goldPerTurn}/turn)`;
  $('hud-cities').textContent = s.cities.filter((c) => c.owner === human.id).length;
  $('btn-end').disabled = !isHumanTurn();
}

function setStatus(msg) { $('hud-status').textContent = msg; }

function renderSelection() {
  const panel = $('selection-panel');
  const s = G.state;
  const human = s.players.find((p) => p.isHuman);
  updateSheetHint();

  if (G.selUnit) {
    const u = s.units.find((x) => x.id === G.selUnit);
    if (!u) { panel.innerHTML = defaultHint(); return; }
    const ud = G.defs.UNITS[u.type];
    const owner = s.players.find((p) => p.id === u.owner);
    const mine = u.owner === human.id;
    let html = `<div class="sel-title"><span class="ico">${ud.icon}</span> <span style="color:${owner.color}">${ud.name}</span></div>`;
    html += `<div class="sel-sub">${owner.name}${mine ? '' : ' (enemy)'} · at (${u.x},${u.y})</div>`;
    html += `<div class="statline">`;
    if (ud.strength) html += `<span class="stat">Str <b>${ud.strength}</b></span>`;
    html += `<span class="stat">Moves <b>${u.movesLeft}/${ud.moves}</b></span>`;
    if (u.charges != null) html += `<span class="stat">Charges <b>${u.charges}</b></span>`;
    if (ud.range > 1) html += `<span class="stat">Range <b>${ud.range}</b></span>`;
    html += `</div>`;
    if (ud.role === 'military') html += hpBarHtml(u.hp, u.maxHp);

    if (mine && isHumanTurn()) {
      html += `<div class="actions" id="unit-actions"></div>`;
    } else if (!mine) {
      html += `<p class="hint">An enemy unit. Move an adjacent military unit and attack to destroy it.</p>`;
    }
    panel.innerHTML = html;
    if (mine && isHumanTurn()) buildUnitActions(u);
    return;
  }

  if (G.selCity) {
    const c = s.cities.find((x) => x.id === G.selCity);
    if (!c) { panel.innerHTML = defaultHint(); return; }
    const owner = s.players.find((p) => p.id === c.owner);
    const mine = c.owner === human.id;
    let html = `<div class="sel-title"><span class="ico">★</span> <span style="color:${owner.color}">${c.name}</span></div>`;
    html += `<div class="sel-sub">${owner.name} · pop ${c.population} · +${c.goldPerTurn} gold/turn</div>`;
    html += `<div class="statline"><span class="stat">Defence <b>${s._cityDef[c.id]}</b></span><span class="stat">Growth <b>${c.growth}/6</b></span></div>`;
    html += hpBarHtml(c.hp, c.maxHp, '#e0c050');
    if (mine && isHumanTurn()) {
      html += `<div class="section-h">Train units (gold ⛁ ${Math.floor(human.gold)})</div><div class="buy-grid" id="buy-grid"></div>`;
    } else if (!mine) {
      html += `<p class="hint">An enemy city. Bombard it to zero HP, then capture with an adjacent melee unit.</p>`;
    }
    panel.innerHTML = html;
    if (mine && isHumanTurn()) buildBuyGrid(c);
    return;
  }

  if (G.selTile) {
    const tile = s.tiles[G.selTile.y * s.width + G.selTile.x];
    if (tile) {
      const def = G.defs.TERRAIN[tile.terrain];
      let html = `<div class="sel-title"><span class="ico">▦</span> ${def.name}</div>`;
      html += `<div class="sel-sub">Tile (${G.selTile.x},${G.selTile.y})</div>`;
      html += `<div class="statline"><span class="stat">Gold <b>${terrainTileGold(tile)}</b></span>`;
      if (def.canImprove) html += `<span class="stat">Improve: <b>${G.defs.IMPROVEMENTS[def.canImprove].name}</b></span>`;
      if (!def.passable) html += `<span class="stat">Impassable</span>`;
      html += `</div>`;
      if (tile.improvement) html += `<div class="sel-sub">${G.defs.IMPROVEMENTS[tile.improvement].icon} ${G.defs.IMPROVEMENTS[tile.improvement].name} built here.</div>`;
      if (tile.resource) html += `<div class="sel-sub">✦ ${G.defs.RESOURCES[tile.resource].name} — a Builder can harvest it for ${G.defs.RESOURCES[tile.resource].harvest} gold.</div>`;
      panel.innerHTML = html;
      return;
    }
  }

  panel.innerHTML = defaultHint();
}

function defaultHint() {
  const tips = [
    'Click your <b>Settler</b> and press <b>Found City</b> to begin.',
    'Use <b>Builders</b> to add farms, mines and lumber mills for more gold.',
    'Train military in your cities, then march on enemy cities to capture them.',
    'Capture every rival city for a <b>Domination Victory</b>.',
  ];
  return `<p class="hint">${tips.join('<br><br>')}</p>`;
}

function hpBarHtml(hp, max, color = '#4caf50') {
  const f = Math.max(0, Math.min(1, hp / max));
  return `<div class="bar"><span style="width:${f * 100}%;background:${color}"></span></div><div class="sel-sub">HP ${Math.max(0, Math.round(hp))}/${max}</div>`;
}

function buildUnitActions(u) {
  const box = $('unit-actions');
  const s = G.state;
  const tile = s.tiles[u.y * s.width + u.x];
  const btns = [];

  if (u.type === 'settler') {
    btns.push(actBtn('⚑ Found City', () => doAction({ type: 'found_city', unitId: u.id })));
  }
  if (u.type === 'builder') {
    const canImp = G.defs.TERRAIN[tile.terrain].canImprove;
    if (canImp && !tile.improvement && u.movesLeft > 0) {
      const imp = G.defs.IMPROVEMENTS[canImp];
      btns.push(actBtn(`${imp.icon} Build ${imp.name}`, () => doAction({ type: 'build', unitId: u.id, improvement: canImp })));
    }
    if (tile.resource && u.movesLeft > 0) {
      btns.push(actBtn(`✦ Harvest ${G.defs.RESOURCES[tile.resource].name}`, () => doAction({ type: 'harvest', unitId: u.id })));
    }
  }
  if (G.defs.UNITS[u.type].role === 'military' && u.movesLeft > 0 && !u.fortified) {
    btns.push(actBtn('⛨ Fortify', () => doAction({ type: 'fortify', unitId: u.id })));
  }
  if (u.movesLeft > 0) btns.push(actBtn('Skip', () => doAction({ type: 'skip', unitId: u.id })));

  if (!btns.length) {
    box.innerHTML = '<p class="hint">No actions available — unit is spent for this turn.</p>';
    return;
  }
  btns.forEach((b) => box.appendChild(b));
}

function actBtn(label, fn) {
  const b = document.createElement('button');
  b.innerHTML = label; b.addEventListener('click', fn); return b;
}

function buildBuyGrid(city) {
  const grid = $('buy-grid');
  const human = G.state.players.find((p) => p.isHuman);
  for (const [type, ud] of Object.entries(G.defs.UNITS)) {
    const afford = human.gold >= ud.cost;
    const b = document.createElement('button');
    b.className = 'buy-item';
    const stat = ud.role === 'military' ? `Str ${ud.strength}${ud.range > 1 ? ' · rng ' + ud.range : ''}`
      : (ud.role === 'settle' ? 'Founds a city' : `Builder · ${ud.charges} charges`);
    b.innerHTML = `<span class="bi-name">${ud.icon} ${ud.name}</span><span class="bi-stat">${stat}</span><span class="bi-cost">⛁ ${ud.cost}</span>`;
    b.disabled = !afford;
    b.addEventListener('click', () => doAction({ type: 'buy_unit', cityId: city.id, unitType: type }));
    grid.appendChild(b);
  }
}

function renderLog() {
  const ul = $('log-list');
  ul.innerHTML = '';
  const items = G.state.log.slice(-60).reverse();
  for (const e of items) {
    const li = document.createElement('li');
    li.innerHTML = `<span class="lt">T${e.turn}</span> ${escapeHtml(e.msg)}`;
    ul.appendChild(li);
  }
}

// ---------------------------------------------------------------------------
// Mobile bottom sheet
// ---------------------------------------------------------------------------
function isMobileLayout() { return window.matchMedia('(max-width: 760px)').matches; }

function setSheetTab(tab) {
  document.querySelectorAll('.sheet-tabs button').forEach((b) => b.classList.toggle('active', b.dataset.tab === tab));
  $('selection-panel').classList.toggle('tab-hidden', tab !== 'sel');
  $('log-panel').classList.toggle('tab-hidden', tab !== 'log');
}

function sheetIsOpen() { return $('sidebar').classList.contains('open'); }

function toggleSheet(open) {
  const isOpen = open != null ? open : !sheetIsOpen();
  $('sidebar').classList.toggle('open', isOpen);
  $('sheet-toggle').textContent = isOpen ? '▾ Hide' : '▴ Show';
  $('sheet-toggle').setAttribute('aria-label', isOpen ? 'Minimize panel' : 'Expand panel');
  // Resize the board to the space the sheet leaves behind.
  requestAnimationFrame(() => { resizeCanvas(); clampCamera(); render(); });
}

// Short summary of the current selection, shown in the collapsed sheet bar so a
// player who minimized the panel still knows what's selected.
function updateSheetHint() {
  const el = $('sheet-hint');
  if (!el) return;
  const s = G.state;
  let text = '';
  if (G.selUnit) {
    const u = s.units.find((x) => x.id === G.selUnit);
    if (u) text = `${G.defs.UNITS[u.type].icon} ${G.defs.UNITS[u.type].name}`;
  } else if (G.selCity) {
    const c = s.cities.find((x) => x.id === G.selCity);
    if (c) text = `★ ${c.name}`;
  }
  el.textContent = text;
}

function maybeGameOver() {
  if (!G.state.gameOver) return;
  const human = G.state.players.find((p) => p.isHuman);
  const won = G.state.winner === human.id;
  $('go-title').textContent = won ? '🏆 Domination Victory!' : '💀 Defeat';
  $('go-msg').textContent = won
    ? 'Every rival city flies your banner. The world is yours.'
    : 'Your last city has fallen. Your tribe is no more.';
  $('gameover').classList.remove('hidden');
}

// ---------------------------------------------------------------------------
// Misc
// ---------------------------------------------------------------------------
let toastTimer = null;
function toast(msg, ok = false) {
  const t = $('toast');
  t.textContent = msg; t.className = 'toast' + (ok ? ' ok' : '');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.add('hidden'), 2600);
  t.classList.remove('hidden');
}
function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
