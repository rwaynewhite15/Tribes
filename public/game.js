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
  buildMode: false, // settler/builder action selecting tile (not used; actions are in place)
  hoverTile: null,
  // camera
  cam: { x: 0, y: 0, scale: 1 },
  drag: null,
};

const TILE = 64; // base tile size in world pixels

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------
window.addEventListener('DOMContentLoaded', async () => {
  G.defs = await api.get('/api/defs');
  bindMenu();
  bindGameControls();
  await refreshSavedGames();
});

function bindMenu() {
  $('ng-start').addEventListener('click', startNewGame);
  $('go-menu').addEventListener('click', () => { $('gameover').classList.add('hidden'); showMenu(); });
  $('btn-menu').addEventListener('click', showMenu);
}

async function refreshSavedGames() {
  const { games, storage } = await api.get('/api/games');
  $('storage-badge').textContent = storage === 'postgres' ? 'Neon DB' : 'local files';
  const ul = $('saved-list');
  ul.innerHTML = '';
  if (!games.length) { ul.innerHTML = '<li class="empty">No saved games yet.</li>'; return; }
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
      await api.del('/api/games/' + g.id); refreshSavedGames();
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
  maybeGameOver();
}

function centerOnHumanStart() {
  const human = G.state.players.find((p) => p.isHuman);
  let fx = G.state.width / 2, fy = G.state.height / 2;
  const u = G.state.units.find((x) => x.owner === human.id);
  const c = G.state.cities.find((x) => x.owner === human.id);
  const focus = c || u;
  if (focus) { fx = focus.x; fy = focus.y; }
  G.cam.scale = 1;
  G.cam.x = fx * TILE + TILE / 2 - canvas.width / (2 * G.cam.scale);
  G.cam.y = fy * TILE + TILE / 2 - canvas.height / (2 * G.cam.scale);
  clampCamera();
}

window.addEventListener('resize', () => { if (!$('game').classList.contains('hidden')) { resizeCanvas(); render(); } });
function resizeCanvas() {
  const wrap = $('board-wrap');
  canvas.width = wrap.clientWidth;
  canvas.height = wrap.clientHeight;
}

// ---------------------------------------------------------------------------
// Controls
// ---------------------------------------------------------------------------
function bindGameControls() {
  $('btn-end').addEventListener('click', endTurn);

  const cv = () => $('board');
  cv().addEventListener('mousedown', (e) => {
    G.drag = { x: e.clientX, y: e.clientY, camX: G.cam.x, camY: G.cam.y, moved: false };
  });
  window.addEventListener('mousemove', (e) => {
    const rect = canvas.getBoundingClientRect();
    if (G.drag) {
      const dx = e.clientX - G.drag.x, dy = e.clientY - G.drag.y;
      if (Math.abs(dx) + Math.abs(dy) > 4) G.drag.moved = true;
      G.cam.x = G.drag.camX - dx / G.cam.scale;
      G.cam.y = G.drag.camY - dy / G.cam.scale;
      clampCamera(); render();
    } else {
      onHover(e.clientX - rect.left, e.clientY - rect.top, e.clientX, e.clientY);
    }
  });
  window.addEventListener('mouseup', (e) => {
    if (G.drag && !G.drag.moved) {
      const rect = canvas.getBoundingClientRect();
      onClickBoard(e.clientX - rect.left, e.clientY - rect.top);
    }
    G.drag = null;
  });
  canvas.addEventListener('wheel', (e) => {
    e.preventDefault();
    const factor = e.deltaY < 0 ? 1.12 : 1 / 1.12;
    const rect = canvas.getBoundingClientRect();
    const mx = e.clientX - rect.left, my = e.clientY - rect.top;
    const wx = G.cam.x + mx / G.cam.scale, wy = G.cam.y + my / G.cam.scale;
    G.cam.scale = Math.max(0.45, Math.min(2.2, G.cam.scale * factor));
    G.cam.x = wx - mx / G.cam.scale;
    G.cam.y = wy - my / G.cam.scale;
    clampCamera(); render();
  }, { passive: false });

  // Keyboard: space ends turn, Esc clears selection.
  window.addEventListener('keydown', (e) => {
    if ($('game').classList.contains('hidden')) return;
    if (e.code === 'Space') { e.preventDefault(); endTurn(); }
    if (e.code === 'Escape') { G.selUnit = null; G.selCity = null; renderSelection(); render(); }
  });
}

function clampCamera() {
  const worldW = G.state.width * TILE, worldH = G.state.height * TILE;
  const viewW = canvas.width / G.cam.scale, viewH = canvas.height / G.cam.scale;
  if (worldW <= viewW) G.cam.x = (worldW - viewW) / 2;
  else G.cam.x = Math.max(-40, Math.min(worldW - viewW + 40, G.cam.x));
  if (worldH <= viewH) G.cam.y = (worldH - viewH) / 2;
  else G.cam.y = Math.max(-40, Math.min(worldH - viewH + 40, G.cam.y));
}

function screenToTile(sx, sy) {
  const wx = G.cam.x + sx / G.cam.scale;
  const wy = G.cam.y + sy / G.cam.scale;
  const x = Math.floor(wx / TILE), y = Math.floor(wy / TILE);
  if (x < 0 || y < 0 || x >= G.state.width || y >= G.state.height) return null;
  return { x, y };
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
  if (unitHere && unitHere.owner === human.id) { G.selUnit = unitHere.id; G.selCity = null; }
  else if (cityHere && cityHere.owner === human.id) { G.selCity = cityHere.id; G.selUnit = null; }
  else if (unitHere) { G.selUnit = unitHere.id; G.selCity = null; } // inspect enemy unit
  else if (cityHere) { G.selCity = cityHere.id; G.selUnit = null; }
  else { G.selUnit = null; G.selCity = null; }
  renderSelection(); render();
}

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
  ctx.scale(G.cam.scale, G.cam.scale);
  ctx.translate(-G.cam.x, -G.cam.y);

  const s = G.state;
  const sel = G.selUnit ? s.units.find((u) => u.id === G.selUnit) : null;
  const hints = sel ? s._hints[sel.id] : null;
  const moveSet = new Set(hints ? hints.moves.map((m) => m.x + ',' + m.y) : []);
  const atkSet = new Set(hints ? hints.attacks.map((m) => m.x + ',' + m.y) : []);

  // Tiles
  for (let y = 0; y < s.height; y++) {
    for (let x = 0; x < s.width; x++) {
      const tile = s.tiles[y * s.width + x];
      const px = x * TILE, py = y * TILE;
      ctx.fillStyle = G.defs.TERRAIN[tile.terrain].color;
      ctx.fillRect(px, py, TILE, TILE);
      // subtle texture
      ctx.fillStyle = 'rgba(0,0,0,0.06)';
      if ((x + y) % 2 === 0) ctx.fillRect(px, py, TILE, TILE);

      // territory tint
      if (tile.ownerCity) {
        const city = s.cities.find((c) => c.id === tile.ownerCity);
        if (city) {
          const owner = s.players.find((p) => p.id === city.owner);
          ctx.fillStyle = hexA(owner.color, 0.18);
          ctx.fillRect(px, py, TILE, TILE);
        }
      }

      // improvement / resource glyphs
      if (tile.improvement) {
        drawGlyph(G.defs.IMPROVEMENTS[tile.improvement].icon, px + TILE - 16, py + TILE - 10, 16, 'rgba(255,255,255,.8)');
      }
      if (tile.resource) {
        drawGlyph(G.defs.RESOURCES[tile.resource].icon, px + 14, py + 18, 18, G.defs.RESOURCES[tile.resource].color);
      }

      // grid line
      ctx.strokeStyle = 'rgba(0,0,0,0.18)';
      ctx.lineWidth = 1;
      ctx.strokeRect(px + .5, py + .5, TILE, TILE);

      // highlights for selected unit
      const key = x + ',' + y;
      if (atkSet.has(key)) { ctx.fillStyle = 'rgba(224,82,82,0.42)'; ctx.fillRect(px, py, TILE, TILE); }
      else if (moveSet.has(key)) { ctx.fillStyle = 'rgba(79,157,222,0.28)'; ctx.fillRect(px, py, TILE, TILE); }

      if (G.hoverTile && G.hoverTile.x === x && G.hoverTile.y === y) {
        ctx.strokeStyle = 'rgba(255,255,255,0.65)'; ctx.lineWidth = 2;
        ctx.strokeRect(px + 1, py + 1, TILE - 2, TILE - 2);
      }
    }
  }

  // Cities
  for (const c of s.cities) {
    const owner = s.players.find((p) => p.id === c.owner);
    const px = c.x * TILE, py = c.y * TILE;
    ctx.fillStyle = owner.color;
    roundRect(px + 8, py + 8, TILE - 16, TILE - 16, 7); ctx.fill();
    ctx.strokeStyle = 'rgba(0,0,0,.5)'; ctx.lineWidth = 2; ctx.stroke();
    drawGlyph('★', px + TILE / 2, py + TILE / 2 + 6, 22, '#fff', 'center');
    // name + hp
    label(c.name, px + TILE / 2, py - 4, owner.color);
    hpBar(px + 10, py + TILE - 9, TILE - 20, c.hp / c.maxHp, '#e0c050');
    // pop badge
    ctx.fillStyle = '#000a'; roundRect(px + TILE - 22, py + 4, 18, 16, 4); ctx.fill();
    drawGlyph(String(c.population), px + TILE - 13, py + 16, 12, '#fff', 'center');
    if (G.selCity === c.id) { ctx.strokeStyle = '#fff'; ctx.lineWidth = 3; ctx.strokeRect(px + 5, py + 5, TILE - 10, TILE - 10); }
  }

  // Units
  for (const u of s.units) {
    const owner = s.players.find((p) => p.id === u.owner);
    const ud = G.defs.UNITS[u.type];
    const px = u.x * TILE, py = u.y * TILE;
    // body circle
    ctx.beginPath();
    ctx.arc(px + TILE / 2, py + TILE / 2, TILE * 0.27, 0, Math.PI * 2);
    ctx.fillStyle = owner.color; ctx.fill();
    ctx.lineWidth = 2; ctx.strokeStyle = u.movesLeft > 0 && owner.isHuman ? '#fff' : 'rgba(0,0,0,.55)'; ctx.stroke();
    drawGlyph(ud.icon, px + TILE / 2, py + TILE / 2 + 7, 22, '#fff', 'center');
    // hp bar for military
    if (ud.role === 'military') hpBar(px + 12, py + TILE - 12, TILE - 24, u.hp / u.maxHp, '#4caf50');
    if (u.fortified) drawGlyph('⛨', px + TILE - 14, py + 16, 13, '#cfd8e0', 'center');
    if (G.selUnit === u.id) {
      ctx.beginPath(); ctx.arc(px + TILE / 2, py + TILE / 2, TILE * 0.33, 0, Math.PI * 2);
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
