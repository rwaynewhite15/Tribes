// Boots the browser client (public/game.js) inside a minimal DOM stub to verify
// that game-screen event handlers actually attach. This guards against bugs
// where binding throws partway through and silently disables the map / buttons.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.join(__dirname, '..', 'public', 'game.js');

function makeEl(id) {
  const listeners = {};
  return {
    id,
    _listeners: listeners,
    style: {},
    dataset: {},
    classList: {
      _s: new Set(),
      add(c) { this._s.add(c); },
      remove(c) { this._s.delete(c); },
      toggle(c, f) { const on = f === undefined ? !this._s.has(c) : f; on ? this._s.add(c) : this._s.delete(c); return on; },
      contains(c) { return this._s.has(c); },
    },
    addEventListener(type, fn) { (listeners[type] = listeners[type] || []).push(fn); },
    removeEventListener() {},
    setAttribute() {}, getAttribute() { return null; },
    appendChild() {}, querySelector() { return makeEl('q'); },
    getBoundingClientRect() { return { left: 0, top: 0, width: 360, height: 640 }; },
    getContext() { return new Proxy({}, { get: () => () => {} }); },
    clientWidth: 360, clientHeight: 520,
    textContent: '', innerHTML: '',
    setPointerCapture() {}, releasePointerCapture() {},
  };
}

async function bootClient() {
  const elements = {};
  const getEl = (id) => (elements[id] = elements[id] || makeEl(id));
  const tabButtons = [makeEl('tabSel'), makeEl('tabLog')];
  tabButtons[0].dataset.tab = 'sel';
  tabButtons[1].dataset.tab = 'log';

  const winListeners = {};
  const addWin = (type, fn) => (winListeners[type] = winListeners[type] || []).push(fn);
  const localStorage = { _d: {}, getItem(k) { return this._d[k] || null; }, setItem(k, v) { this._d[k] = v; }, removeItem(k) { delete this._d[k]; } };

  const sandbox = {
    console,
    document: {
      getElementById: getEl,
      querySelectorAll: (sel) => (sel === '.sheet-tabs button' ? tabButtons : []),
      querySelector: () => makeEl('q'),
      addEventListener: addWin,
      createElement: () => makeEl('new'),
    },
    window: { addEventListener: addWin, matchMedia: () => ({ matches: true }), devicePixelRatio: 2, innerWidth: 360, innerHeight: 640, localStorage },
    navigator: {},
    localStorage,
    requestAnimationFrame: (fn) => fn(),
    setTimeout, clearTimeout, Math, JSON, Date, Set, Map, Object, Array, String, Number, Boolean, Promise, parseInt, parseFloat, isNaN,
    fetch: async (url) => ({
      ok: true,
      json: async () => {
        if (url.includes('/api/defs')) return { UNITS: {}, IMPROVEMENTS: {}, TERRAIN: {}, RESOURCES: {} };
        if (url.includes('/api/games')) return { games: [], storage: 'file' };
        return {};
      },
    }),
  };
  sandbox.globalThis = sandbox;

  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(SRC, 'utf8'), sandbox, { filename: 'game.js' });

  for (const fn of winListeners.DOMContentLoaded || []) await fn();
  await new Promise((r) => setTimeout(r, 20));
  return { elements, tabButtons };
}

test('client boot attaches all game-screen control handlers', async () => {
  const { elements, tabButtons } = await bootClient();
  const board = elements.board;
  assert.ok(board && board._listeners.pointerdown, 'map: pointerdown bound');
  assert.ok(board._listeners.pointerup, 'map: pointerup bound');
  assert.ok(elements['btn-end']._listeners.click, 'End Turn bound');
  assert.ok(elements['sheet-toggle']._listeners.click, 'Hide/Show toggle bound');
  assert.ok(elements['sheet-hint']._listeners.click, 'sheet hint bound');
  assert.ok(elements['btn-zoom-in']._listeners.click, 'zoom-in bound');
  assert.ok(tabButtons.every((b) => b._listeners.click), 'Selection/Chronicle tabs bound');
});
