(function () {
  'use strict';

  const D = window.SF_DATA;
  const S = window.Solver;
  const STORAGE_KEY = 'sf-planner:v1';

  // ---------- Helpers ----------
  const $ = (sel) => document.querySelector(sel);
  function h(tag, props, ...kids) {
    const e = document.createElement(tag);
    for (const k in props || {}) {
      const v = props[k];
      if (v == null || v === false) continue;
      if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
      else if (k === 'class') e.className = v;
      else if (k in e && k !== 'list') e[k] = v;
      else e.setAttribute(k, v === true ? '' : v);
    }
    for (const kid of kids.flat(Infinity)) {
      if (kid == null || kid === false) continue;
      e.appendChild(kid instanceof Node ? kid : document.createTextNode(kid));
    }
    return e;
  }
  const nf = [0, 1, 2, 3].map((d) => new Intl.NumberFormat('en-US', { maximumFractionDigits: d }));
  function fmt(n, d = 3) {
    if (Math.abs(n) >= 1000) d = Math.min(d, 1);
    return nf[d].format(n);
  }
  const itemName = (id) => (D.items[id] ? D.items[id].name : id);
  const buildingName = (id) => D.buildings[id].name;
  const names = {
    item: itemName,
    building: buildingName,
    itemIcon: (id) => (D.items[id] ? `img/icons/${D.items[id].icon}.png` : ''),
  };
  const uid = () => Math.random().toString(36).slice(2, 9);
  const nameToId = {};
  for (const id in D.items) nameToId[D.items[id].name.toLowerCase()] = id;
  const resources = Object.keys(D.items).filter((id) => D.items[id].limit);
  // Game icons live in img/icons/<icon>.png (see tools/build-data.js --icons).
  function icon(entry, size) {
    const img = h('img', { class: 'icon', alt: '', width: size || 20, height: size || 20, loading: 'lazy', decoding: 'async' });
    img.onerror = () => (img.style.visibility = 'hidden');
    if (entry) img.src = `img/icons/${entry.icon}.png`;
    else img.style.visibility = 'hidden';
    return img;
  }
  const itemIcon = (id, size) => icon(D.items[id], size);
  const buildingIcon = (id, size) => icon(D.buildings[id], size);
  const named = (iconEl, text) => h('span', { class: 'named' }, iconEl, text);
  const displayName = (r) => r.name.replace(/^Alternate: /, '');
  const fluidUnit = (id) => (!D.items[id] ? '' : D.items[id].unit ? ' ' + D.items[id].unit : D.items[id].liquid ? ' m³' : '');
  // Unit of a rate of this item: MW for power, m³/min for fluids, /min for solid items.
  const rateUnit = (id) => (D.items[id] && D.items[id].unit) || (D.items[id] && D.items[id].liquid ? 'm³/min' : '/min');
  const POWER = S.POWER_ITEM;
  const genRecipes = D.recipes.filter((r) => r.gen);
  const DEFAULT_GENS = ['Gen_GeneratorCoal_Coal'];

  let toastTimer;
  function toast(msg) {
    const t = $('#toast');
    t.textContent = msg;
    t.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => t.classList.remove('show'), 2200);
  }

  // ---------- Dropdowns with icons ----------
  // Native <select> and <datalist> popups can't show images, so lists of items and parts use this popup.
  // rows: [{ value, label, icon: () => Element }]. One popup is open at a time.
  let popup = null;
  function closePopup() {
    if (!popup) return;
    popup.el.remove();
    popup = null;
  }
  function openPopup(anchor, rows, active, onPick) {
    closePopup();
    const el = h('div', { class: 'pick-list', role: 'listbox' });
    el.addEventListener('pointerdown', (ev) => ev.preventDefault()); // keep focus on the anchor
    const p = { el, anchor, rows: [], active: -1, onPick };
    p.setRows = (list, act) => {
      p.rows = list;
      p.active = Math.min(act == null ? 0 : act, list.length - 1);
      el.replaceChildren(...(list.length
        ? list.map((r, i) => h('div', {
          class: 'pick-row' + (i === p.active ? ' active' : ''), role: 'option',
          onpointerenter: () => p.move(i - p.active),
          onclick: () => p.pick(i),
        }, r.icon ? r.icon() : null, h('span', {}, r.label)))
        : [h('div', { class: 'pick-empty' }, 'No match')]));
      p.scroll();
    };
    p.scroll = () => {
      const row = el.children[p.active];
      if (row) row.scrollIntoView({ block: 'nearest' });
    };
    p.move = (d) => {
      if (!p.rows.length) return;
      const next = (p.active + d + p.rows.length) % p.rows.length;
      if (el.children[p.active]) el.children[p.active].classList.remove('active');
      p.active = next;
      el.children[next].classList.add('active');
      p.scroll();
    };
    p.pick = (i = p.active) => {
      const row = p.rows[i];
      closePopup();
      if (row) onPick(row.value);
    };
    p.place = () => {
      if (!anchor.isConnected) return closePopup();
      const r = anchor.getBoundingClientRect();
      const below = window.innerHeight - r.bottom - 8;
      const up = below < 180 && r.top > below;
      el.style.left = Math.max(4, Math.min(r.left, window.innerWidth - Math.max(r.width, 220) - 4)) + 'px';
      el.style.minWidth = r.width + 'px';
      el.style.maxHeight = Math.min(320, (up ? r.top : window.innerHeight - r.bottom) - 8) + 'px';
      el.style.top = up ? '' : r.bottom + 2 + 'px';
      el.style.bottom = up ? window.innerHeight - r.top + 2 + 'px' : '';
    };
    document.body.appendChild(el);
    popup = p;
    p.setRows(rows, active);
    p.place();
    return p;
  }
  // Close when anything outside the popup scrolls, the window resizes or the user clicks elsewhere.
  window.addEventListener('scroll', (ev) => { if (popup && !popup.el.contains(ev.target)) closePopup(); }, true);
  window.addEventListener('resize', closePopup);
  document.addEventListener('pointerdown', (ev) => {
    if (popup && !popup.el.contains(ev.target) && !popup.anchor.contains(ev.target)) closePopup();
  });

  // Searchable item list on a text input, in place of a <datalist>. Picking fills the input and fires
  // its 'input' and 'change' events, so the input's own handlers resolve the name as if typed.
  // ids: item ids, or a function returning them.
  function itemCombo(input, ids) {
    input.setAttribute('autocomplete', 'off');
    input.setAttribute('role', 'combobox');
    const rows = () => {
      const list = typeof ids === 'function' ? ids() : ids;
      const q = input.value.trim().toLowerCase();
      const exact = list.some((id) => itemName(id).toLowerCase() === q);
      const hits = exact || !q ? list : list.filter((id) => itemName(id).toLowerCase().includes(q));
      if (q && !exact) hits.sort((a, b) => itemName(b).toLowerCase().startsWith(q) - itemName(a).toLowerCase().startsWith(q));
      const out = hits.map((id) => ({ value: id, label: itemName(id), icon: () => itemIcon(id, 20) }));
      return { out, active: exact ? Math.max(0, out.findIndex((r) => r.label.toLowerCase() === q)) : 0 };
    };
    const pick = (id) => {
      input.value = itemName(id);
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.dispatchEvent(new Event('change', { bubbles: true }));
    };
    const open = () => {
      const { out, active } = rows();
      openPopup(input, out, active, pick);
    };
    const mine = () => popup && popup.anchor === input;
    input.addEventListener('focus', open);
    input.addEventListener('click', () => { if (!mine()) open(); });
    input.addEventListener('input', (ev) => {
      if (!ev.isTrusted) return;
      if (!mine()) return open();
      const { out } = rows();
      popup.setRows(out, 0);
    });
    input.addEventListener('blur', () => { if (mine()) closePopup(); });
    input.addEventListener('keydown', (ev) => {
      if (ev.key === 'ArrowDown' || ev.key === 'ArrowUp') {
        if (!mine()) open();
        else popup.move(ev.key === 'ArrowDown' ? 1 : -1);
        ev.preventDefault();
      } else if (ev.key === 'Enter' && mine() && popup.rows.length) {
        popup.pick();
        ev.preventDefault();
      } else if (ev.key === 'Escape' && mine()) {
        closePopup();
        ev.preventDefault();
        ev.stopPropagation();
      }
    });
    return input;
  }

  // A <select> replacement whose options show icons. options: [{ value, label, icon: () => Element }].
  function iconSelect(options, value, onChange, props) {
    const cur = options.find((o) => String(o.value) === String(value)) || options[0];
    const btn = h('button', { type: 'button', class: 'pick-select', 'aria-haspopup': 'listbox', ...props },
      cur && cur.icon ? cur.icon() : null, h('span', { class: 'pick-label' }, cur ? cur.label : ''), h('span', { class: 'pick-caret' }, '▾'));
    const mine = () => popup && popup.anchor === btn;
    const pick = (v) => { if (String(v) !== String(value)) onChange(v); };
    const open = () => openPopup(btn, options, Math.max(0, options.indexOf(cur)), pick);
    btn.addEventListener('click', () => (mine() ? closePopup() : open()));
    btn.addEventListener('blur', () => { if (mine()) closePopup(); });
    btn.addEventListener('keydown', (ev) => {
      if (ev.key === 'ArrowDown' || ev.key === 'ArrowUp') {
        if (!mine()) open();
        else popup.move(ev.key === 'ArrowDown' ? 1 : -1);
      } else if ((ev.key === 'Enter' || ev.key === ' ') && mine()) popup.pick();
      else if (ev.key === 'Escape' && mine()) closePopup();
      else return;
      ev.preventDefault();
      ev.stopPropagation();
    });
    return btn;
  }

  // ---------- State ----------
  const defaultEnabledIds = () => D.recipes.filter(S.defaultEnabled).map((r) => r.id);
  function newFactory(name, targets) {
    return { id: uid(), name, kind: 'production', targets: targets || [], inputs: [], limits: {}, mode: 'resources', layout: null, placements: [] };
  }
  // A power plant: generators (and optionally their fuel chain) for a MW target or the most MW its inputs give.
  function newPowerPlant(name) {
    return { ...newFactory(name), kind: 'power', powerGoal: { mode: 'target', mw: 750 }, generators: DEFAULT_GENS.slice() };
  }
  function defaultState() {
    const f = newFactory('Factory 1', [{ item: 'Desc_ModularFrame_C', rate: 5 }]);
    return { factories: [f], activeId: f.id, enabled: defaultEnabledIds(), tab: 'overview', view: 'planner', links: [], infra: { lines: [], stations: [] }, trains: [], nodeMiners: {}, mapFilters: defaultMapFilters(), powerSettings: defaultPowerSettings() };
  }
  function defaultPowerSettings() {
    return { maxSpan: window.Power.POWER.maxSpan };
  }
  function defaultMapFilters() {
    return { hidden: ['Desc_Water_C', 'Desc_NitrogenGas_C'], minPurity: 0 };
  }
  function loadState() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw) return sanitize(JSON.parse(raw));
    } catch (e) {
      console.warn('Could not load saved state', e);
    }
    return defaultState();
  }
  function sanitizeFactory(f) {
    const entries = (list) =>
      (Array.isArray(list) ? list : [])
        .filter((t) => t && (t.item == null || D.items[t.item]))
        .map((t) => ({ item: t.item || null, rate: Number(t.rate) || 0 }));
    const power = f.kind === 'power';
    const goal = f.powerGoal || {};
    return {
      id: f.id || uid(),
      name: String(f.name || 'Factory'),
      kind: power ? 'power' : 'production',
      ...(power ? {
        powerGoal: { mode: goal.mode === 'max' ? 'max' : 'target', mw: Math.max(0, Number(goal.mw) || 0) },
        generators: Array.isArray(f.generators) ? f.generators.filter((id) => S.recipeById[id] && S.recipeById[id].gen) : DEFAULT_GENS.slice(),
      } : {}),
      targets: entries(f.targets),
      inputs: entries(f.inputs),
      limits: f.limits && typeof f.limits === 'object' ? f.limits : {},
      mode: ['resources', 'power', 'buildings'].includes(f.mode) ? f.mode : 'resources',
      layout: sanitizeLayout(f.layout),
      portSides: sanitizePortSides(f.portSides),
      placements: sanitizePlacements(f),
    };
  }
  // A factory can be placed several times on the map; older saves had a single `map` position.
  function sanitizePlacements(f) {
    const list = Array.isArray(f.placements) ? f.placements : f.map ? [f.map] : [];
    return list
      .filter((p) => p && isFinite(p.x) && isFinite(p.y))
      .map((p) => ({ id: p.id || uid(), x: Number(p.x), y: Number(p.y), rot: Number(p.rot) || 0 }));
  }
  function sanitizeInfra(infra) {
    const K = window.MapNodes;
    const pt = (p) => Array.isArray(p) && isFinite(p[0]) && isFinite(p[1]);
    const lines = (infra && Array.isArray(infra.lines) ? infra.lines : [])
      .filter((l) => l && K.LINE_KINDS[l.kind] && Array.isArray(l.points) && l.points.filter(pt).length >= 2)
      .map((l) => ({ id: l.id || uid(), kind: l.kind, name: String(l.name || ''), points: l.points.filter(pt).map((p) => [Number(p[0]), Number(p[1])]),
        ...(l.kind === 'power' ? { auto: l.auto !== false } : {}) }));
    const platform = (p) => {
      const kind = (p && (p.kind || p.type)) || 'freight';
      return {
        id: (p && p.id) || uid(),
        kind: ['freight', 'fluid', 'empty'].includes(kind) ? kind : 'freight',
        mode: p && p.mode === 'load' ? 'load' : 'unload',
        item: p && D.items[p.item] ? p.item : null,
      };
    };
    const building = (b, i) => ({ id: (b && b.id) || uid(), kind: 'station', name: String((b && b.name) || String.fromCharCode(65 + i)), facing: b && b.facing === 'right' ? 'right' : 'left' });
    // One row of parts per station. Older saves had a platform list per substation: the first one's
    // platforms become the shared row and further substations become buildings at the far end.
    const layoutOf = (s) => {
      if (Array.isArray(s.layout) && s.layout.length) {
        let n = 0;
        return s.layout.filter(Boolean).map((p) => (p.kind === 'station' ? building(p, n++) : platform(p)));
      }
      const subs = Array.isArray(s.subs) && s.subs.length ? s.subs : [{ name: 'A', platforms: [{ kind: 'freight' }] }];
      const row = [building({ id: subs[0].id, name: subs[0].name, facing: 'left' }, 0), ...(subs[0].platforms || []).map(platform)];
      subs.slice(1).forEach((sub, i) => row.push(building({ id: sub.id, name: sub.name, facing: 'right' }, i + 1)));
      return row;
    };
    const stations = (infra && Array.isArray(infra.stations) ? infra.stations : [])
      // Older saves had separate freight platform markers; they become a one-platform train station.
      .map((s) => (s && s.kind === 'freightPlatform' ? { ...s, kind: 'trainStation', subs: [{ name: 'A', platforms: [{ kind: 'freight' }] }] } : s))
      .filter((s) => s && K.STATION_KINDS[s.kind] && isFinite(s.x) && isFinite(s.y))
      .map((s) => {
        const out = { id: s.id || uid(), kind: s.kind, name: String(s.name || ''), x: Number(s.x), y: Number(s.y), rot: Number(s.rot) || 0 };
        if (s.kind === 'trainStation') out.layout = layoutOf(s);
        return out;
      });
    return { lines, stations };
  }
  function sanitizeTrains(trains, infra) {
    const subsOf = {};
    infra.stations.forEach((s) => (subsOf[s.id] = new Set((s.layout || []).filter((p) => p.kind === 'station').map((x) => x.id))));
    return (Array.isArray(trains) ? trains : []).filter((t) => t && Array.isArray(t.consist)).map((t, i) => ({
      id: t.id || uid(),
      name: String(t.name || `Train ${i + 1}`),
      color: /^#[0-9a-f]{6}$/i.test(t.color) ? t.color : '#f39a3c',
      network: t.network,
      consist: t.consist.filter((v) => v && (v.type === 'loco' || v.type === 'car')).map((v) => (v.type === 'loco' ? { type: 'loco', reversed: !!v.reversed } : { type: 'car' })),
      stops: (Array.isArray(t.stops) ? t.stops : [])
        .filter((s) => s && subsOf[s.stationId])
        .map((s) => ({ id: s.id || uid(), stationId: s.stationId, subId: subsOf[s.stationId].has(s.subId) ? s.subId : [...subsOf[s.stationId]][0] || null, rear: !!s.rear })),
    }));
  }
  // Miner tier chosen per resource node (absent = automatic).
  function sanitizeNodeMiners(m) {
    const out = {};
    for (const id in m || {}) if (window.MapNodes.nodeById[id] && [1, 2, 3].includes(m[id])) out[id] = m[id];
    return out;
  }
  function sanitizePortSides(p) {
    const out = { in: {}, out: {} };
    ['in', 'out'].forEach((dir) => {
      const src = (p && p[dir]) || {};
      for (const item in src) if (D.items[item] && ['N', 'E', 'S', 'W'].includes(src[item])) out[dir][item] = src[item];
    });
    return out;
  }
  function sanitizeLayout(l) {
    if (!l || typeof l !== 'object' || !l.blocks || typeof l.blocks !== 'object') return null;
    const blocks = {};
    for (const id in l.blocks) {
      const b = l.blocks[id];
      if (!S.recipeById[id] || !b || !isFinite(b.x) || !isFinite(b.y)) continue;
      blocks[id] = { x: Number(b.x), y: Number(b.y), rot: [0, 90, 180, 270].includes(b.rot) ? b.rot : 0, floor: Math.max(1, Number(b.floor) || 1), perRow: Math.max(1, Number(b.perRow) || 1) };
    }
    const shapes = {};
    if (l.shapes && typeof l.shapes === 'object') {
      for (const fl in l.shapes) {
        const cells = Array.isArray(l.shapes[fl]) ? l.shapes[fl].filter((k) => /^\d+,\d+$/.test(k)) : [];
        if (cells.length) shapes[fl] = cells;
      }
    }
    const portPos = {};
    for (const key in l.portPos || {}) {
      const p = l.portPos[key];
      if (p && ['N', 'E', 'S', 'W'].includes(p.side) && isFinite(p.x) && isFinite(p.y)) portPos[key] = { side: p.side, x: Number(p.x), y: Number(p.y) };
    }
    const lifts = {};
    for (const key in l.lifts || {}) {
      const p = l.lifts[key];
      if (Array.isArray(p) && isFinite(p[0]) && isFinite(p[1])) lifts[key] = [Number(p[0]), Number(p[1])];
    }
    return { floors: Math.max(1, Number(l.floors) || 1), blocks, shapes, portPos, lifts };
  }
  function sanitizeLinks(links, factories) {
    const byId = {};
    factories.forEach((f) => (byId[f.id] = f));
    const fixInst = (e) => {
      if (!e || e.type !== 'factory') return e;
      const f = byId[e.id];
      if (!f) return null;
      const inst = f.placements.some((p) => p.id === e.inst) ? e.inst : f.placements[0] && f.placements[0].id;
      return inst ? { type: 'factory', id: e.id, inst } : null;
    };
    const ep = (e) => e && (e.type === 'local' || (e.type === 'node' && window.MapNodes.nodeById[e.id]) || e.type === 'factory');
    return (Array.isArray(links) ? links : [])
      .map((l) => l && { ...l, from: fixInst(l.from), to: fixInst(l.to) })
      .filter((l) => l && D.items[l.item] && ep(l.from) && ep(l.to) && l.to.type === 'factory')
      .map((l) => ({
        id: l.id || uid(),
        from: l.from,
        to: l.to,
        item: l.item,
        rate: Math.max(0, Number(l.rate) || 0),
        transport: window.Transport.TRANSPORTS[l.transport] ? l.transport : 'belt',
        miner: [1, 2, 3].includes(l.miner) ? l.miner : 3,
        via: Array.isArray(l.via) ? l.via.filter((p) => Array.isArray(p) && isFinite(p[0]) && isFinite(p[1])) : [],
      }));
  }
  function sanitize(s) {
    if (!s || !Array.isArray(s.factories) || !s.factories.length) return defaultState();
    const factories = s.factories.map(sanitizeFactory);
    const enabled = Array.isArray(s.enabled) ? s.enabled.filter((id) => S.recipeById[id]) : defaultEnabledIds();
    const activeId = factories.some((f) => f.id === s.activeId) ? s.activeId : factories[0].id;
    const infra = sanitizeInfra(s.infra);
    const mapFilters = s.mapFilters && Array.isArray(s.mapFilters.hidden)
      ? { hidden: s.mapFilters.hidden, minPurity: Number(s.mapFilters.minPurity) || 0 }
      : defaultMapFilters();
    return { factories, activeId, enabled, tab: s.tab || 'overview', view: s.view === 'map' ? 'map' : 'planner',
      links: sanitizeLinks(s.links, factories), infra, trains: sanitizeTrains(s.trains, infra), nodeMiners: sanitizeNodeMiners(s.nodeMiners), mapFilters,
      powerSettings: s.powerSettings && Number(s.powerSettings.maxSpan) >= 10 ? { maxSpan: Number(s.powerSettings.maxSpan) } : defaultPowerSettings() };
  }

  let state = loadState();
  let enabled = new Set(state.enabled);
  let result = null;
  let graph = null;
  let graphDirty = true;
  let floorView = null;
  let mapView = null;

  function save() {
    state.enabled = [...enabled];
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
    } catch (e) {
      /* storage unavailable: keep working in memory */
    }
  }
  const factory = () => state.factories.find((f) => f.id === state.activeId);

  // Solved plans per factory, recomputed only when the factory or the recipe set changes.
  const resultCache = new Map();
  function resultFor(f) {
    const key = JSON.stringify([f.targets, f.inputs, f.limits, f.mode, f.kind, f.powerGoal, f.generators]) + '|' + [...enabled].sort().join();
    const c = resultCache.get(f.id);
    if (c && c.key === key) return c.result;
    const r = S.solve(f, enabled);
    resultCache.set(f.id, { key, result: r });
    return r;
  }

  let solveTimer;
  function commit(immediate) {
    save();
    clearTimeout(solveTimer);
    if (immediate) solveAndRender();
    else solveTimer = setTimeout(solveAndRender, 120);
  }

  // ---------- Factory tabs ----------
  function renderFactoryTabs() {
    const nav = $('#factory-tabs');
    nav.textContent = '';
    state.factories.forEach((f) => {
      nav.appendChild(
        h('div', {
          class: 'factory-tab' + (f.id === state.activeId ? ' active' : ''),
          onclick: () => {
            if (state.activeId === f.id) return;
            state.activeId = f.id;
            if (floorView) floorView.reset();
            if (mapView && state.view === 'map') mapView.selectFactory(f.id);
            renderAll();
            commit(true);
          },
        },
        f.id === state.activeId
          ? h('span', {
            class: 'tab-name editable',
            title: 'Click to rename',
            onclick: (ev) => {
              ev.stopPropagation();
              renameInline(ev.currentTarget, f);
            },
          }, f.name)
          : h('span', { class: 'tab-name' }, f.name),
        f.kind === 'power' ? h('span', { class: 'tab-kind', title: 'Power plant' }, '⚡') : null,
        state.factories.length > 1 &&
          h('button', {
            class: 'icon-btn',
            title: 'Delete factory',
            onclick: (ev) => {
              ev.stopPropagation();
              if (!confirm(`Delete "${f.name}"?`)) return;
              state.factories = state.factories.filter((x) => x !== f);
              state.links = state.links.filter((l) => l.to.id !== f.id && !(l.from.type === 'factory' && l.from.id === f.id));
              if (state.activeId === f.id) state.activeId = state.factories[0].id;
              renderAll();
              commit(true);
            },
          }, '×'))
      );
    });
    nav.append(
      h('div', {
        class: 'factory-tab add',
        title: 'New factory',
        onclick: () => {
          const f = newFactory(`Factory ${state.factories.length + 1}`);
          state.factories.push(f);
          state.activeId = f.id;
          renderAll();
          commit(true);
          const first = document.querySelector('#targets input');
          if (first) first.focus();
        },
      }, '+ New'),
      h('div', {
        class: 'factory-tab add',
        title: 'New power plant: generators for a MW target, or the most MW from given inputs',
        onclick: () => {
          const f = newPowerPlant(`Power plant ${state.factories.filter((x) => x.kind === 'power').length + 1}`);
          state.factories.push(f);
          state.activeId = f.id;
          renderAll();
          commit(true);
        },
      }, '+ Power plant')
    );
  }

  /** Swap a name element for a text box; Enter or leaving the box saves, Escape cancels. */
  function renameInline(elm, f) {
    const input = h('input', { type: 'text', class: 'rename-input', value: f.name, spellcheck: false });
    input.style.width = Math.max(8, f.name.length + 2) + 'ch';
    elm.replaceWith(input);
    input.focus();
    input.select();
    let done = false;
    const finish = (keep) => {
      if (done) return;
      done = true;
      const name = input.value.trim();
      if (keep && name) f.name = name;
      save();
      renderFactoryTabs();
      if (mapView) mapView.refresh();
    };
    input.addEventListener('input', () => (input.style.width = Math.max(8, input.value.length + 2) + 'ch'));
    input.addEventListener('keydown', (ev) => {
      if (ev.key === 'Enter') finish(true);
      else if (ev.key === 'Escape') finish(false);
      ev.stopPropagation();
    });
    input.addEventListener('blur', () => finish(true));
    input.addEventListener('click', (ev) => ev.stopPropagation());
    input.addEventListener('pointerdown', (ev) => ev.stopPropagation());
  }

  // ---------- Sidebar ----------
  // Item ids for the item pickers: products (anything a recipe makes, plus raw resources) and inputs.
  const byName = (ids) => [...ids].sort((a, b) => itemName(a).localeCompare(itemName(b)));
  const itemLists = (() => {
    const produced = new Set(resources);
    D.recipes.forEach((r) => r.out.forEach(([i]) => produced.add(i)));
    produced.delete('Desc_Geyser_C');
    return {
      products: byName(produced),
      items: byName(Object.keys(D.items).filter((id) => !D.items[id].virtual)),
    };
  })();

  function itemRow(entry, list, itemList, container) {
    const nameInput = h('input', {
      type: 'text',
      value: entry.item ? itemName(entry.item) : '',
      placeholder: 'Search item…',
      spellcheck: false,
    });
    itemCombo(nameInput, itemLists[itemList]);
    let rowIcon = itemIcon(entry.item, 22);
    const resolve = (final) => {
      const id = nameToId[nameInput.value.trim().toLowerCase()];
      if (id) {
        nameInput.classList.remove('invalid');
        if (entry.item !== id) {
          entry.item = id;
          const next = itemIcon(id, 22);
          rowIcon.replaceWith(next);
          rowIcon = next;
          commit();
        }
      } else if (final) {
        nameInput.classList.toggle('invalid', nameInput.value.trim() !== '');
      }
    };
    nameInput.addEventListener('input', () => resolve(false));
    nameInput.addEventListener('change', () => resolve(true));
    nameInput.addEventListener('focus', () => nameInput.select());

    const rate = h('input', {
      type: 'number',
      class: 'rate num',
      min: 0,
      step: 'any',
      value: entry.rate,
      title: entry.item === POWER ? 'MW' : 'Items (or m³) per minute',
      oninput: () => {
        entry.rate = Math.max(0, Number(rate.value) || 0);
        commit();
      },
    });
    const remove = h('button', {
      class: 'icon-btn',
      title: 'Remove',
      onclick: () => {
        list.splice(list.indexOf(entry), 1);
        renderSidebar();
        commit();
      },
    }, '×');
    container.appendChild(h('div', { class: 'item-row' }, rowIcon, nameInput, rate, remove));
    return nameInput;
  }

  function renderSidebar() {
    const f = factory();
    renderPowerPanel(f);
    const targets = $('#targets');
    targets.textContent = '';
    f.targets.forEach((t) => itemRow(t, f.targets, 'products', targets));
    if (!f.targets.length) targets.appendChild(h('div', { class: 'empty-row' }, 'No products yet.'));

    const inputs = $('#inputs');
    inputs.textContent = '';
    f.inputs.forEach((t) => itemRow(t, f.inputs, 'items', inputs));
    if (!f.inputs.length) inputs.appendChild(h('div', { class: 'empty-row' }, 'None.'));

    document.querySelectorAll('#mode button').forEach((b) => b.classList.toggle('active', b.dataset.mode === f.mode));
    $('#mode-hint').textContent = {
      resources: 'Use as few raw resources as possible, weighting scarce ones (e.g. uranium, SAM) more heavily.',
      power: 'Use as little power as possible; resources break ties.',
      buildings: 'Use as few machines as possible.',
    }[f.mode];

    const limits = $('#limits');
    limits.textContent = '';
    resources.forEach((id) => {
      limits.appendChild(h('label', { for: 'lim-' + id, class: 'named' }, itemIcon(id, 18), itemName(id)));
      limits.appendChild(
        h('input', {
          id: 'lim-' + id,
          type: 'number',
          class: 'num',
          min: 0,
          step: 'any',
          placeholder: '∞',
          value: f.limits[id] != null ? f.limits[id] : '',
          oninput: (ev) => {
            const v = ev.target.value;
            if (v === '') delete f.limits[id];
            else f.limits[id] = Math.max(0, Number(v));
            updateLimitsCount();
            commit();
          },
        })
      );
    });
    updateLimitsCount();
  }
  // Power plant settings: goal (target MW or max from inputs) and the allowed generator/fuel recipes.
  function renderPowerPanel(f) {
    const power = f.kind === 'power';
    $('#power-panel').hidden = !power;
    $('#targets-title').textContent = power ? 'Extra products' : 'Products';
    $('#targets-hint').textContent = power ? 'Optional: other items this plant should also output, per minute.' : 'What this factory should output, per minute.';
    $('#inputs-hint').textContent = power && f.powerGoal.mode === 'max'
      ? 'The fuel (or raw resources) you have, per minute. The plan makes as much power from them as it can.'
      : 'Items you already have (e.g. from another factory). Used before producing more.';
    if (!power) return;
    const goal = f.powerGoal;
    document.querySelectorAll('#power-goal button').forEach((b) => b.classList.toggle('active', b.dataset.goal === goal.mode));
    $('#power-mw-row').hidden = goal.mode !== 'target';
    const mw = $('#power-mw');
    if (document.activeElement !== mw) mw.value = goal.mw;
    $('#power-goal-hint').textContent = goal.mode === 'target'
      ? 'Picks generators and makes their fuel from raw resources, using the generators ticked below.'
      : 'Add fuel or raw resources under Available inputs (or cap resources under Resource limits). Water comes from on-site extractors.';
    const list = $('#power-gens');
    list.textContent = '';
    const chosen = new Set(f.generators);
    const byBuilding = {};
    genRecipes.forEach((r) => (byBuilding[r.building] = byBuilding[r.building] || []).push(r));
    Object.keys(byBuilding).forEach((b) => {
      list.appendChild(h('div', { class: 'power-gen-head named' }, buildingIcon(b, 18), `${buildingName(b)} · ${fmt(D.buildings[b].gen)} MW`));
      byBuilding[b].sort((x, y) => itemName(x.in[0][0]).localeCompare(itemName(y.in[0][0]))).forEach((r) => {
        const [fuel, rate] = r.in[0];
        list.appendChild(h('label', { class: 'check power-gen' },
          h('input', { type: 'checkbox', checked: chosen.has(r.id), onchange: (ev) => {
            f.generators = ev.target.checked ? [...f.generators, r.id] : f.generators.filter((id) => id !== r.id);
            renderPowerPanel(f);
            commit(true);
          } }),
          itemIcon(fuel, 16), h('span', {}, itemName(fuel)), h('span', { class: 'sub num' }, `${fmt(rate)}${fluidUnit(fuel)}/min`)));
      });
    });
    if (!f.generators.length) list.appendChild(h('p', { class: 'hint' }, 'None ticked: every generator and fuel may be used.'));
  }

  function updateLimitsCount() {
    const n = Object.keys(factory().limits).length;
    $('#limits-count').textContent = n ? `${n} set` : '';
  }

  function addEntry(listName) {
    const f = factory();
    f[listName].push({ item: null, rate: listName === 'targets' ? 10 : 60 });
    renderSidebar();
    const rows = document.querySelectorAll(`#${listName} .item-row input[type=text]`);
    rows[rows.length - 1].focus();
  }

  // ---------- Solve ----------
  function solveAndRender() {
    const f = factory();
    result = resultFor(f);
    if (result.status === 'optimal') f.layout = window.Layout.reconcile(f.layout, result);
    graphDirty = true;
    renderResults();
    if (mapView) mapView.refresh();
  }

  function chip(id, rate) {
    return h('span', { class: 'chip' + (D.items[id].liquid ? ' fluid' : '') },
      itemIcon(id, 18), itemName(id), h('span', { class: 'num' }, fmt(rate) + fluidUnit(id)));
  }

  function renderStatus() {
    const st = $('#status');
    st.hidden = true;
    st.className = 'status';
    if (!result || result.status === 'optimal') return;
    st.hidden = false;
    if (result.status === 'empty') {
      st.classList.add('info');
      const f = factory();
      st.textContent = f.kind !== 'power' ? 'Add a product in the sidebar to start planning.'
        : f.powerGoal.mode === 'max' ? 'Add the fuel you have under Available inputs (or set resource limits) to see how much power it gives.'
          : 'Set how many MW this power plant should generate.';
    } else if (result.status === 'infeasible') {
      st.classList.add('error');
      st.textContent = 'No plan can meet these targets. Check your resource limits, or enable more recipes.';
    } else {
      st.classList.add('error');
      st.textContent = `The solver could not finish (${result.status}).`;
    }
  }

  function renderResults() {
    renderStatus();
    renderOverview();
    renderProduction();
    renderRecipes();
    if (state.tab === 'graph') renderGraph();
    if (state.tab === 'floor' && floorView) floorView.render();
    $('#recipe-count').textContent = `${enabled.size}`;
  }

  // ---------- Overview ----------
  function renderOverview() {
    const root = $('#overview');
    root.textContent = '';
    if (!result || result.status !== 'optimal') return;
    const r = result;
    const totalBuildings = Object.values(r.buildings).reduce((a, b) => a + b, 0);
    const rawTotal = r.imports.filter((i) => !i.missing && !D.items[i.item].liquid).reduce((a, i) => a + i.rate, 0);
    const fluidTotal = r.imports.filter((i) => !i.missing && D.items[i.item].liquid).reduce((a, i) => a + i.rate, 0);
    const sinkPts = r.surplus.reduce((a, s) => a + s.rate * (D.items[s.item].sink || 0), 0);

    const stat = (label, value, unit, sub) =>
      h('div', { class: 'stat' }, h('div', { class: 'label' }, label),
        h('div', { class: 'value num' }, value, unit && h('small', {}, unit)), sub && h('div', { class: 'sub' }, sub));
    const gens = r.steps.filter((s) => s.recipe.gen).reduce((a, s) => a + s.machines, 0);
    const net = r.generated - r.power;
    root.appendChild(
      h('div', { class: 'stats' },
        r.generated > 0 ? stat('Power generated', fmt(r.generated, 1), 'MW', `${fmt(gens, 0)} generator${gens === 1 ? '' : 's'} · net ${net >= 0 ? '+' : ''}${fmt(net, 1)} MW`) : null,
        stat(r.generated > 0 ? 'Power used' : 'Power', fmt(r.power, 1), 'MW', 'with machines at suggested clock speeds'),
        stat('Machines', fmt(totalBuildings, 0), '', `${r.steps.length} production steps`),
        stat('Solid resources', fmt(rawTotal, 1), '/min', fluidTotal ? `+ ${fmt(fluidTotal, 1)} m³/min of fluids` : 'no fluids'),
        stat('Surplus sink value', fmt(sinkPts, 0), 'pts/min', r.surplus.length ? `${r.surplus.length} byproduct${r.surplus.length > 1 ? 's' : ''}` : 'no surplus'))
    );

    const waste = r.surplus.filter((x) => x.item === 'Desc_NuclearWaste_C' || x.item === 'Desc_PlutoniumWaste_C');
    if (waste.length) {
      root.appendChild(h('div', { class: 'warn-box' }, h('strong', {}, 'Nuclear waste: '),
        waste.map((x) => `${fmt(x.rate)}/min of ${itemName(x.item)}`).join(', '),
        ' cannot be sunk. Store it, or process it further (Plutonium, Ficsonium).'));
    }
    const missing = r.imports.filter((i) => i.missing);
    if (missing.length) {
      root.appendChild(
        h('div', { class: 'warn-box' },
          h('strong', {}, 'External inputs needed: '),
          'these items have no enabled recipe in this plan, so they are treated as imported. ',
          missing.map((m, i) => [
            i ? ', ' : '',
            h('button', { class: 'link named', onclick: () => openAlternatives(m.item) }, itemIcon(m.item, 18), `${itemName(m.item)} (${fmt(m.rate)} ${rateUnit(m.item)})`),
          ]))
      );
    }

    const grid = h('div', { class: 'grid-2' });
    root.appendChild(grid);

    const resRows = r.imports.filter((i) => !i.missing).map((im) => {
      const lim = D.items[im.item].limit;
      const pct = (im.rate / lim) * 100;
      return h('tr', {},
        h('td', {}, named(itemIcon(im.item), itemName(im.item))),
        h('td', { class: 'r num' }, fmt(im.rate) + fluidUnit(im.item)),
        h('td', { class: 'r num', title: `World total ≈ ${fmt(lim, 0)}/min` },
          im.item === 'Desc_Water_C' ? '—' : fmt(pct, 2) + '%',
          im.item !== 'Desc_Water_C' && h('div', { class: 'bar' + (pct > 50 ? ' high' : '') }, h('span', { style: `width:${Math.min(100, pct)}%` }))));
    });
    grid.appendChild(card('Raw resources', 'per minute', resRows.length &&
      table(['Resource', { t: 'Rate', r: 1 }, { t: 'Of world', r: 1 }], resRows), 'No raw resources needed.'));

    const outRows = [
      ...r.targets.map((t) => h('tr', {}, h('td', {}, named(itemIcon(t.item), itemName(t.item))), h('td', { class: 'r num' }, fmt(t.rate) + fluidUnit(t.item)),
        h('td', { class: 'sub' }, 'product'))),
      ...r.surplus.map((s) => h('tr', {}, h('td', {}, named(itemIcon(s.item), itemName(s.item))), h('td', { class: 'r num' }, fmt(s.rate) + fluidUnit(s.item)),
        h('td', { class: 'sub' }, D.items[s.item].sink ? `surplus · ${fmt(s.rate * D.items[s.item].sink, 0)} pts` : 'surplus'))),
    ];
    grid.appendChild(card('Outputs', 'per minute', table(['Item', { t: 'Rate', r: 1 }, ''], outRows)));

    const bRows = Object.keys(r.buildings)
      .sort((a, b) => r.buildings[b] - r.buildings[a])
      .map((b) => {
        const steps = r.steps.filter((s) => s.recipe.building === b);
        const p = steps.reduce((a, s) => a + s.power, 0);
        const g = steps.reduce((a, s) => a + stepGenerated(s), 0);
        return h('tr', {}, h('td', {}, named(buildingIcon(b), buildingName(b))), h('td', { class: 'r num' }, fmt(r.buildings[b], 0)),
          h('td', { class: 'r num' + (g ? ' gen' : '') }, g ? `+${fmt(g, 1)} MW` : fmt(p, 1) + ' MW'));
      });
    grid.appendChild(card('Machines', '', table(['Building', { t: 'Count', r: 1 }, { t: 'Power', r: 1 }], bRows)));

    if (r.supplies.length || factory().inputs.some((i) => i.item)) {
      const used = {};
      r.supplies.forEach((s) => (used[s.item] = s.rate));
      const sRows = factory().inputs.filter((i) => i.item).map((i) =>
        h('tr', {}, h('td', {}, named(itemIcon(i.item), itemName(i.item))), h('td', { class: 'r num' }, fmt(used[i.item] || 0)),
          h('td', { class: 'r num' }, fmt(i.rate))));
      grid.appendChild(card('Available inputs', 'per minute', table(['Item', { t: 'Used', r: 1 }, { t: 'Available', r: 1 }], sRows)));
    }
    root.appendChild(materialsCard(factory(), r));
  }

  // Building materials for one copy of the factory: structural parts (a 1 m foundation per floor-plan cell,
  // all floors) and machines (production buildings and generators, plus Water Extractors for imported water).
  const FOUNDATION = 'Desc_Foundation_8x1_01_C';
  const WATER_EXTRACTOR = 'Desc_WaterPump_C';
  function materialsCard(f, r) {
    const T = window.Transport;
    const costOf = (parts) => {
      const total = {};
      parts.forEach(([id, n]) => D.buildCosts[id] && D.buildCosts[id].cost.forEach(([i, a]) => (total[i] = (total[i] || 0) + a * n)));
      return total;
    };
    const mats = (total) => {
      const list = Object.entries(total).sort((a, b) => b[1] - a[1]);
      return list.length
        ? h('div', { class: 'mat-grid' }, list.map(([i, n]) => h('span', { class: 'chip' }, itemIcon(i, 18), itemName(i), h('span', { class: 'num' }, fmt(n, 0)))))
        : h('p', { class: 'sub' }, '—');
    };
    const partRow = (id, n, sub) => h('tr', {},
      h('td', {}, h('span', { class: 'named' }, icon(D.buildCosts[id], 20), h('span', {}, D.buildCosts[id].name, sub && h('div', { class: 'sub' }, sub)))),
      h('td', { class: 'r num' }, fmt(n, 0)));

    const geo = window.Layout.compute(f.layout, r);
    const perFloor = Array.from({ length: geo.floors }, (_, i) => geo.cells[i + 1].size);
    const foundations = perFloor.reduce((a, b) => a + b, 0);
    const structural = [[FOUNDATION, foundations]];

    const water = r.imports.find((i) => i.item === 'Desc_Water_C' && !i.missing);
    const machines = Object.keys(r.buildings).sort((a, b) => r.buildings[b] - r.buildings[a]).map((b) => [b, r.buildings[b]]);
    if (water) machines.push([WATER_EXTRACTOR, Math.ceil(water.rate / T.WATER_EXTRACTOR - 1e-9)]);

    const structMats = costOf(structural);
    const machineMats = costOf(machines);
    const total = costOf([...structural, ...machines]);
    return h('div', { class: 'card bom-card' },
      h('h3', {}, 'Building materials', h('span', { class: 'hint' }, 'one copy of this building')),
      h('div', { class: 'bom-cols' },
        h('section', {},
          h('h4', {}, 'Structural'),
          table(['Part', { t: 'Count', r: 1 }], [partRow(FOUNDATION, foundations,
            `8 × 8 m, ${geo.floors > 1 ? perFloor.map((c, i) => `F${i + 1}: ${c}`).join(' · ') : '1 floor'}${geo.custom(1) ? '' : ' (auto shape)'}`)]),
          mats(structMats)),
        h('section', {},
          h('h4', {}, 'Machines'),
          table(['Building', { t: 'Count', r: 1 }], machines.map(([id, n]) =>
            partRow(id, n, id === WATER_EXTRACTOR ? `${fmt(water.rate)} m³/min of water, if extracted on site` : null))),
          mats(machineMats))),
      h('div', { class: 'bom-total' }, h('h4', {}, 'Total'), mats(total)),
      h('p', { class: 'hint bom-note' }, 'Foundations follow the floor plan. Not included: walls, belts, pipes, lifts, power poles, and miners on resource nodes.'));
  }

  const stepGenerated = (s) => s.outputs.reduce((a, [i, q]) => a + (i === POWER ? q : 0), 0);

  function card(title, hint, body, emptyText) {
    return h('div', { class: 'card' }, h('h3', {}, title, hint && h('span', { class: 'hint' }, hint)),
      body || h('div', { class: 'empty' }, emptyText || 'Nothing here.'));
  }
  function table(cols, rows, cls) {
    return h('table', { class: cls || '' },
      h('thead', {}, h('tr', {}, cols.map((c) => h('th', { class: c.r ? 'r' : '' }, c.t != null ? c.t : c)))),
      h('tbody', {}, rows));
  }

  // ---------- Production ----------
  function renderProduction() {
    const root = $('#production');
    root.textContent = '';
    if (!result || result.status !== 'optimal') return;
    const rows = result.steps.map((s) => {
      const build = s.machines === s.count
        ? `${s.machines} × 100%`
        : `${s.machines} × ${fmt(s.clock * 100, 2)}%`;
      return h('tr', {},
        h('td', {}, h('div', { class: 'recipe-cell' }, s.recipe.gen ? buildingIcon(s.recipe.building, 36) : itemIcon(s.recipe.out[0][0], 36),
          h('div', {}, h('div', { class: 'recipe-name' }, displayName(s.recipe), s.recipe.alt && h('span', { class: 'tag' }, 'ALT')),
            h('div', { class: 'sub named' }, buildingIcon(s.recipe.building, 16), buildingName(s.recipe.building))))),
        h('td', { class: 'r' }, h('div', { class: 'machines num' }, fmt(s.count)), h('div', { class: 'sub num', title: 'Suggested build: machines × clock speed' }, build)),
        h('td', { class: 'r num' + (s.recipe.gen ? ' gen' : ''), style: 'white-space:nowrap' }, s.recipe.gen ? `+${fmt(stepGenerated(s), 1)} MW` : fmt(s.power, 1) + ' MW'),
        h('td', {}, h('div', { class: 'chips' }, s.inputs.map(([i, q]) => chip(i, q)))),
        h('td', {}, h('div', { class: 'chips' }, s.outputs.map(([i, q]) => chip(i, q)))),
        h('td', { class: 'r' }, s.recipe.gen ? null : h('button', { class: 'btn small', onclick: () => openAlternatives(s.recipe.out[0][0]) }, 'Recipes…')));
    });
    root.appendChild(card('Production steps', 'final products first · rates per minute',
      table(['Recipe', { t: 'Machines', r: 1 }, { t: 'Power', r: 1 }, 'Inputs', 'Outputs', ''], rows, 'prod-table')));

    const balRows = Object.keys(result.balance)
      .sort((a, b) => itemName(a).localeCompare(itemName(b)))
      .map((id) => {
        const b = result.balance[id];
        const inflow = b.produced + b.imported + b.supplied;
        const out = b.consumed + b.target;
        const src = [b.produced && `made ${fmt(b.produced)}`, b.imported && `extracted ${fmt(b.imported)}`, b.supplied && `supplied ${fmt(b.supplied)}`]
          .filter(Boolean).join(' · ');
        return h('tr', {},
          h('td', {}, named(itemIcon(id), itemName(id))),
          h('td', { class: 'r num' }, fmt(inflow) + fluidUnit(id), h('div', { class: 'sub' }, src)),
          h('td', { class: 'r num' }, fmt(out), b.target ? h('div', { class: 'sub' }, `incl. ${fmt(b.target)} output`) : null),
          h('td', { class: 'r num' }, fmt(Math.max(0, inflow - out))));
      });
    const wrap = h('div', { style: 'margin-top:16px' },
      card('Item balance', 'per minute', table(['Item', { t: 'In', r: 1 }, { t: 'Out', r: 1 }, { t: 'Surplus', r: 1 }], balRows)));
    root.appendChild(wrap);
  }

  // ---------- Graph ----------
  function renderGraph() {
    if (!graph) {
      graph = new window.FlowGraph($('#graph'));
      graph.setLabels($('#graph-labels').checked);
    }
    if (graphDirty) {
      graph.render(result, fmt, names);
      graphDirty = false;
    }
  }

  // ---------- Recipes ----------
  function recipeIO(r) {
    return h('div', { class: 'io' },
      h('div', { class: 'chips' }, r.in.map(([i, a]) => chip(i, S.perMinute(r, a)))),
      h('span', { class: 'arrow' }, '→'),
      h('div', { class: 'chips' }, r.out.map(([i, a]) => chip(i, S.perMinute(r, a)))));
  }

  function setEnabled(r, on) {
    if (on) enabled.add(r.id);
    else enabled.delete(r.id);
    commit(true);
  }

  function renderRecipes() {
    const list = $('#recipe-list');
    const q = $('#recipe-search').value.trim().toLowerCase();
    const filter = $('#recipe-filter').value;
    const used = new Set(result && result.steps ? result.steps.map((s) => s.recipe.id) : []);
    const terms = q.split(/\s+/).filter(Boolean);
    const recipes = D.recipes.filter((r) => {
      if (r.gen) return false; // generators are chosen per power plant
      if (filter === 'alt' && !r.alt) return false;
      if (filter === 'std' && r.alt) return false;
      if (filter === 'on' && !enabled.has(r.id)) return false;
      if (filter === 'off' && enabled.has(r.id)) return false;
      if (filter === 'used' && !used.has(r.id)) return false;
      if (!terms.length) return true;
      const hay = [r.name, buildingName(r.building), ...r.in.map(([i]) => itemName(i)), ...r.out.map(([i]) => itemName(i))]
        .join(' ').toLowerCase();
      return terms.every((t) => hay.includes(t));
    }).sort((a, b) => displayName(a).localeCompare(displayName(b)));
    const rows = recipes.map((r) =>
      h('tr', { class: enabled.has(r.id) ? '' : 'disabled' },
        h('td', {}, h('input', { type: 'checkbox', checked: enabled.has(r.id), 'aria-label': 'Enable ' + r.name, onchange: (ev) => setEnabled(r, ev.target.checked) })),
        h('td', {}, h('span', { class: 'recipe-name' }, displayName(r)), r.alt && h('span', { class: 'tag' }, 'ALT'),
          used.has(r.id) && h('span', { class: 'used-dot', title: 'Used in this plan' }),
          h('div', { class: 'sub named' }, buildingIcon(r.building, 16), `${buildingName(r.building)} · ${fmt(S.recipePower(r), 1)} MW`)),
        h('td', {}, recipeIO(r))));
    list.replaceChildren(
      h('div', { class: 'card', style: 'margin-top:4px' },
        rows.length
          ? table(['', 'Recipe', 'Per machine, per minute'], rows, 'recipe-table')
          : h('div', { class: 'empty' }, 'No recipes match.'))
    );
  }

  let altItem = null;
  function openAlternatives(item) {
    altItem = item;
    renderAlternatives();
    const dlg = $('#alt-dialog');
    if (!dlg.open) dlg.showModal();
  }
  function renderAlternatives() {
    if (!altItem) return;
    $('#alt-title').replaceChildren(named(itemIcon(altItem, 28), `Recipes producing ${itemName(altItem)}`));
    const used = new Set(result && result.steps ? result.steps.map((s) => s.recipe.id) : []);
    const recipes = (S.producersOf[altItem] || []).filter((r) => !r.gen).sort((a, b) => a.alt - b.alt || a.name.localeCompare(b.name));
    $('#alt-list').replaceChildren(
      ...(recipes.length
        ? recipes.map((r) =>
          h('label', { class: 'alt-row' + (used.has(r.id) ? ' used' : '') },
            h('input', {
              type: 'checkbox',
              checked: enabled.has(r.id),
              onchange: (ev) => {
                setEnabled(r, ev.target.checked);
                renderAlternatives();
              },
            }),
            h('div', {},
              h('div', {}, h('span', { class: 'recipe-name' }, displayName(r)), r.alt && h('span', { class: 'tag' }, 'ALT')),
              h('div', { class: 'sub named', style: 'margin-bottom:4px' }, buildingIcon(r.building, 16), `${buildingName(r.building)} · ${fmt(S.recipePower(r), 1)} MW`),
              recipeIO(r))))
        : [h('p', { class: 'hint' }, 'This item cannot be produced in a machine; it has to be supplied as an input.')])
    );
  }

  // ---------- Tabs ----------
  function setTab(tab) {
    state.tab = tab;
    document.querySelectorAll('#tabs button').forEach((b) => b.classList.toggle('active', b.dataset.tab === tab));
    document.querySelectorAll('.tab-panel').forEach((p) => p.classList.toggle('active', p.dataset.panel === tab));
    if (tab === 'graph') {
      const first = !graph;
      renderGraph();
      if (first) requestAnimationFrame(() => graph.fit());
    }
    if (tab === 'floor') floorView.render();
    save();
  }

  // ---------- Views ----------
  function setView(view) {
    state.view = view;
    document.querySelectorAll('#view-switch button').forEach((b) => b.classList.toggle('active', b.dataset.view === view));
    $('#planner-view').hidden = view !== 'planner';
    $('#map-view').hidden = view !== 'map';
    document.body.classList.toggle('map-mode', view === 'map');
    if (view === 'map') mapView.show();
    else setTab(state.tab);
    save();
  }
  function openFactory(id, tab) {
    state.activeId = id;
    if (floorView) floorView.reset();
    renderAll();
    solveAndRender();
    setView('planner');
    if (tab) setTab(tab);
  }

  // ---------- Share / import / export ----------
  function encode(obj) {
    return btoa(unescape(encodeURIComponent(JSON.stringify(obj)))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  }
  function decode(str) {
    const b64 = str.replace(/-/g, '+').replace(/_/g, '/');
    return JSON.parse(decodeURIComponent(escape(atob(b64))));
  }
  function recipeDiff() {
    const def = new Set(defaultEnabledIds());
    return {
      on: [...enabled].filter((id) => !def.has(id)),
      off: [...def].filter((id) => !enabled.has(id)),
    };
  }
  async function share() {
    const { id, ...f } = factory();
    const url = `${location.href.split('#')[0]}#plan=${encode({ f, r: recipeDiff() })}`;
    try {
      await navigator.clipboard.writeText(url);
      toast('Share link copied to clipboard');
    } catch (e) {
      prompt('Copy this link:', url);
    }
  }
  function importFromHash() {
    const m = location.hash.match(/^#plan=(.+)$/);
    if (!m) return;
    history.replaceState(null, '', location.pathname + location.search);
    try {
      const { f, r } = decode(m[1]);
      const imported = sanitizeFactory({ ...f, id: uid(), placements: [] });
      state.factories.push(imported);
      state.activeId = imported.id;
      if (r && (r.on.length || r.off.length)) {
        const diff = recipeDiff();
        const key = (a) => [...a].sort().join();
        const same = key(diff.on) === key(r.on) && key(diff.off) === key(r.off);
        if (!same && confirm('This shared plan uses a different set of enabled recipes. Apply its recipe selection? (This replaces yours.)')) {
          enabled = new Set(defaultEnabledIds().filter((id) => !r.off.includes(id)).concat(r.on.filter((id) => S.recipeById[id])));
        }
      }
      toast(`Imported "${imported.name}"`);
    } catch (e) {
      toast('That share link could not be read');
    }
  }
  function exportJSON() {
    save();
    const blob = new Blob([JSON.stringify(state, null, 2)], { type: 'application/json' });
    const a = h('a', { href: URL.createObjectURL(blob), download: 'satisfactory-plans.json' });
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  }
  function importJSON(file) {
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const next = sanitize(JSON.parse(reader.result));
        if (!confirm(`Replace your ${state.factories.length} factories with ${next.factories.length} from the file?`)) return;
        state = next;
        enabled = new Set(state.enabled);
        renderAll();
        setTab(state.tab);
        commit(true);
        toast('Imported');
      } catch (e) {
        toast('Could not read that file');
      }
    };
    reader.readAsText(file);
  }

  // ---------- Wiring ----------
  function renderAll() {
    renderFactoryTabs();
    renderSidebar();
  }

  function init() {
    const App = {
      D, S, h, $, fmt, itemIcon, buildingIcon, named, displayName, rateUnit, itemCombo, iconSelect, itemLists,
      state: () => state,
      factory,
      renameInline,
      resolveItem: (name) => nameToId[String(name).trim().toLowerCase()] || null,
      resultFor,
      save,
      openFactory,
      layoutChanged: () => {
        save();
        if (mapView) mapView.refresh();
      },
      isFloorVisible: () => state.view === 'planner' && state.tab === 'floor',
      isMapVisible: () => state.view === 'map',
    };
    floorView = window.FloorView(App);
    mapView = window.MapView(App);
    App.portSides = mapView.portSides;
    App.sideSelect = mapView.sideSelect;
    document.querySelectorAll('#view-switch button').forEach((b) => b.addEventListener('click', () => setView(b.dataset.view)));
    importFromHash();
    $('#add-target').addEventListener('click', () => addEntry('targets'));
    $('#add-input').addEventListener('click', () => addEntry('inputs'));
    document.querySelectorAll('#mode button').forEach((b) =>
      b.addEventListener('click', () => {
        factory().mode = b.dataset.mode;
        renderSidebar();
        commit(true);
      }));
    document.querySelectorAll('#power-goal button').forEach((b) =>
      b.addEventListener('click', () => {
        factory().powerGoal.mode = b.dataset.goal;
        renderSidebar();
        commit(true);
      }));
    $('#power-mw').addEventListener('input', (ev) => {
      factory().powerGoal.mw = Math.max(0, Number(ev.target.value) || 0);
      commit();
    });
    document.querySelectorAll('#tabs button').forEach((b) => b.addEventListener('click', () => setTab(b.dataset.tab)));
    $('#recipe-search').addEventListener('input', renderRecipes);
    $('#recipe-filter').addEventListener('change', renderRecipes);
    const bulkAlts = (on) => {
      D.recipes.filter((r) => r.alt).forEach((r) => (on ? enabled.add(r.id) : enabled.delete(r.id)));
      commit(true);
    };
    $('#alts-on').addEventListener('click', () => bulkAlts(true));
    $('#alts-off').addEventListener('click', () => bulkAlts(false));
    $('#recipes-reset').addEventListener('click', () => {
      if (!confirm('Reset enabled recipes to the defaults (standard recipes only)?')) return;
      enabled = new Set(defaultEnabledIds());
      commit(true);
    });
    $('#graph-fit').addEventListener('click', () => graph && graph.fit());
    $('#graph-labels').addEventListener('change', (ev) => graph && graph.setLabels(ev.target.checked));
    $('#btn-share').addEventListener('click', share);
    $('#btn-export').addEventListener('click', exportJSON);
    $('#file-import').addEventListener('change', (ev) => {
      if (ev.target.files[0]) importJSON(ev.target.files[0]);
      ev.target.value = '';
    });
    $('#alt-dialog').addEventListener('close', () => (altItem = null));
    window.addEventListener('hashchange', () => {
      if (!location.hash.startsWith('#plan=')) return;
      importFromHash();
      renderAll();
      commit(true);
    });

    renderAll();
    solveAndRender();
    setTab(state.tab);
    setView(state.view);
  }

  init();
})();
