// Factory floor plan: turns a solved plan into rows of machines on the 8 m foundation grid,
// and provides an SVG editor to move, rotate and split rows across floors.
(function () {
  'use strict';

  const D = window.SF_DATA;
  const NS = 'http://www.w3.org/2000/svg';
  const FOUNDATION = 8;
  const MARGIN = 8; // free strip inside the walls for incoming/outgoing belts
  const ROW_GAP = 7;
  const COL_GAP = 12;
  const MAX_ROW_LEN = 80;
  const LANE = 2; // meters per belt/pipe lane

  // Approximate machine footprints in meters: w = side-by-side width, l = input-to-output length.
  const FOOTPRINT = {
    Desc_SmelterMk1_C: [6, 9],
    Desc_ConstructorMk1_C: [8, 10],
    Desc_AssemblerMk1_C: [10, 15],
    Desc_FoundryMk1_C: [10, 9],
    Desc_ManufacturerMk1_C: [18, 20],
    Desc_OilRefinery_C: [10, 20],
    Desc_Blender_C: [18, 16],
    Desc_Packager_C: [8, 8],
    Desc_HadronCollider_C: [24, 38],
    Desc_Converter_C: [16, 16],
    Desc_QuantumEncoder_C: [22, 48],
    Desc_GeneratorCoal_C: [10, 26],
    Desc_GeneratorFuel_C: [20, 20],
    Desc_GeneratorNuclear_C: [36, 43],
    Desc_GeneratorBiomass_Automated_C: [8, 8],
  };
  // Virtual items (power) travel on power lines, not belts: no lanes between rows, no wall ports.
  const onBelt = (item) => !(D.items[item] && D.items[item].virtual);

  // ---------- Geometry ----------
  /** Geometry of one production step's block in local (unrotated) coordinates. */
  function blockGeometry(step, perRow) {
    const r = step.recipe;
    const [w, l] = FOOTPRINT[r.building] || [10, 10];
    const pitch = Math.ceil(w / 2) * 2;
    const n = step.machines;
    const per = Math.max(1, Math.min(n, perRow || defaultPerRow(step)));
    const rows = Math.ceil(n / per);
    const inLanes = Math.max(1, r.in.length) * LANE + 1;
    const outLanes = Math.max(1, r.out.length) * LANE + 1;
    const rowDepth = inLanes + l + outLanes;
    const W = LANE + per * pitch + LANE; // feeder column + machines + collector column
    const H = rows * rowDepth;
    const machines = [];
    for (let i = 0; i < n; i++) {
      const row = Math.floor(i / per);
      const col = i % per;
      machines.push({ x: LANE + col * pitch + (pitch - w) / 2, y: row * rowDepth + inLanes, w, l });
    }
    const inputs = step.inputs.map(([item, rate], k) => ({ item, rate, y: 1 + k * LANE, side: 'in' }));
    const outputs = step.outputs.map(([item, rate], k) => ({ item, rate, y: inLanes + l + 1 + k * LANE, side: 'out' }));
    return { W, H, per, rows, rowDepth, inLanes, outLanes, pitch, machines, inputs, outputs };
  }

  function defaultPerRow(step) {
    const [w] = FOOTPRINT[step.recipe.building] || [10, 10];
    return Math.max(1, Math.floor(MAX_ROW_LEN / (Math.ceil(w / 2) * 2)));
  }

  // Map local block coordinates to floor coordinates for a rotation (0/90/180/270).
  function transformPoint(b, g, lx, ly) {
    switch (b.rot || 0) {
      case 90: return [b.x + g.H - ly, b.y + lx];
      case 180: return [b.x + g.W - lx, b.y + g.H - ly];
      case 270: return [b.x + ly, b.y + g.W - lx];
      default: return [b.x + lx, b.y + ly];
    }
  }
  function rotateDir(rot, dx, dy) {
    switch (rot || 0) {
      case 90: return [-dy, dx];
      case 180: return [-dx, -dy];
      case 270: return [dy, -dx];
      default: return [dx, dy];
    }
  }
  function bbox(b, g) {
    const swap = b.rot === 90 || b.rot === 270;
    return { x: b.x, y: b.y, w: swap ? g.H : g.W, h: swap ? g.W : g.H };
  }
  function blockTransform(b, g) {
    switch (b.rot || 0) {
      case 90: return `translate(${b.x + g.H},${b.y}) rotate(90)`;
      case 180: return `translate(${b.x + g.W},${b.y + g.H}) rotate(180)`;
      case 270: return `translate(${b.x},${b.y + g.W}) rotate(270)`;
      default: return `translate(${b.x},${b.y})`;
    }
  }
  // Port position (floor coords), its outward direction and the point 2 m outside it.
  function port(b, g, p) {
    const lx = p.side === 'in' ? 0 : g.W;
    const [x, y] = transformPoint(b, g, lx, p.y);
    const [dx, dy] = rotateDir(b.rot, p.side === 'in' ? -1 : 1, 0);
    return { x, y, dx, dy, ax: x + dx * 3, ay: y + dy * 3 };
  }

  // ---------- Model ----------
  function stepKey(step) {
    return step.recipe.id;
  }

  // Production stage of each step (longest path over step-to-step flows, cycles ignored).
  function stages(result) {
    const ids = result.steps.map(stepKey);
    const preds = {};
    ids.forEach((id) => (preds[id] = new Set()));
    result.flows.forEach((f) => {
      if (f.from.startsWith('rec:') && f.to.startsWith('rec:')) preds[f.to.slice(4)].add(f.from.slice(4));
    });
    const stage = {};
    const visiting = new Set();
    const visit = (id) => {
      if (stage[id] != null) return stage[id];
      if (visiting.has(id)) return 0;
      visiting.add(id);
      let s = 0;
      preds[id].forEach((p) => (s = Math.max(s, visit(p) + 1)));
      visiting.delete(id);
      return (stage[id] = s);
    };
    ids.forEach(visit);
    return stage;
  }

  /** Lay out all steps from scratch: stages become columns, spread over `floors` floors. */
  function autoLayout(result, floors) {
    floors = Math.max(1, floors || 1);
    const stage = stages(result);
    const byStage = [];
    result.steps.forEach((s) => (byStage[stage[stepKey(s)]] = byStage[stage[stepKey(s)]] || []).push(s));
    const columns = byStage.filter(Boolean).map((steps) => steps.map((s) => ({ s, g: blockGeometry(s) })));
    const area = (col) => col.reduce((a, { g }) => a + g.W * (g.H + ROW_GAP), 0);
    const total = columns.reduce((a, c) => a + area(c), 0);

    const blocks = {};
    let floor = 1;
    let acc = 0;
    let x = MARGIN;
    columns.forEach((col) => {
      if (floor < floors && acc >= (total * floor) / floors) {
        floor++;
        x = MARGIN;
      }
      let y = MARGIN;
      let colW = 0;
      col.forEach(({ s, g }) => {
        blocks[stepKey(s)] = { x, y, rot: 0, floor, perRow: g.per };
        y += g.H + ROW_GAP;
        colW = Math.max(colW, g.W);
      });
      x += colW + COL_GAP;
      acc += area(col);
    });
    return { floors, blocks };
  }

  /** Keep existing placements, add blocks for new steps, drop blocks for removed steps. */
  function reconcile(layout, result) {
    if (!result || result.status !== 'optimal') return layout;
    if (!layout || !layout.blocks || !Object.keys(layout.blocks).length) {
      const fresh = autoLayout(result, (layout && layout.floors) || 1);
      fresh.shapes = (layout && layout.shapes) || {};
      fresh.portPos = (layout && layout.portPos) || {};
      fresh.lifts = (layout && layout.lifts) || {};
      return fresh;
    }
    const blocks = {};
    let bottom = MARGIN;
    const fresh = [];
    result.steps.forEach((s) => {
      const b = layout.blocks[stepKey(s)];
      if (b) {
        blocks[stepKey(s)] = b;
        const g = blockGeometry(s, b.perRow);
        if (b.floor === 1) bottom = Math.max(bottom, bbox(b, g).y + bbox(b, g).h + ROW_GAP);
      } else fresh.push(s);
    });
    let x = MARGIN;
    fresh.forEach((s) => {
      const g = blockGeometry(s);
      blocks[stepKey(s)] = { x, y: bottom, rot: 0, floor: 1, perRow: g.per };
      x += g.W + COL_GAP;
    });
    const floors = Math.max(layout.floors || 1, ...Object.values(blocks).map((b) => b.floor || 1));
    return { floors, blocks, shapes: layout.shapes || {}, portPos: layout.portPos || {}, lifts: layout.lifts || {} };
  }

  /** Full geometry for rendering and for the world map footprint. */
  function compute(layout, result) {
    const placed = result.steps.map((s) => {
      const b = layout.blocks[stepKey(s)];
      const g = blockGeometry(s, b.perRow);
      return { step: s, b, g, box: bbox(b, g) };
    });
    // Auto shape: the rectangle around all rows plus a margin. Custom shapes are per floor.
    let autoW = FOUNDATION;
    let autoH = FOUNDATION;
    placed.forEach(({ box }) => {
      autoW = Math.max(autoW, box.x + box.w + MARGIN);
      autoH = Math.max(autoH, box.y + box.h + MARGIN);
    });
    autoW = Math.ceil(autoW / FOUNDATION) * FOUNDATION;
    autoH = Math.ceil(autoH / FOUNDATION) * FOUNDATION;
    const floors = layout.floors || 1;
    const shapes = layout.shapes || {};
    const cells = {};
    let w = 0;
    let h = 0;
    for (let f = 1; f <= floors; f++) {
      if (shapes[f] && shapes[f].length) cells[f] = new Set(shapes[f]);
      else {
        cells[f] = new Set();
        for (let i = 0; i < autoW / FOUNDATION; i++) for (let j = 0; j < autoH / FOUNDATION; j++) cells[f].add(i + ',' + j);
      }
      cells[f].forEach((k) => {
        const [i, j] = k.split(',').map(Number);
        w = Math.max(w, (i + 1) * FOUNDATION);
        h = Math.max(h, (j + 1) * FOUNDATION);
      });
    }
    w = Math.max(w, FOUNDATION);
    h = Math.max(h, FOUNDATION);
    const union = new Set();
    Object.values(cells).forEach((set) => set.forEach((k) => union.add(k)));

    // Rows that stick out of their floor's shape.
    const outside = new Set();
    placed.forEach(({ step, b, box }) => {
      const set = cells[b.floor] || cells[1];
      for (let i = Math.floor(box.x / FOUNDATION); i < Math.ceil((box.x + box.w) / FOUNDATION); i++) {
        for (let j = Math.floor(box.y / FOUNDATION); j < Math.ceil((box.y + box.h) / FOUNDATION); j++) {
          if (!set.has(i + ',' + j)) outside.add(step.recipe.id);
        }
      }
    });

    // Overlaps on the same floor.
    const overlaps = new Set();
    for (let i = 0; i < placed.length; i++) {
      for (let j = i + 1; j < placed.length; j++) {
        const a = placed[i];
        const c = placed[j];
        if (a.b.floor !== c.b.floor) continue;
        if (a.box.x < c.box.x + c.box.w && c.box.x < a.box.x + a.box.w && a.box.y < c.box.y + c.box.h && c.box.y < a.box.y + a.box.h) {
          overlaps.add(a.step.recipe.id);
          overlaps.add(c.step.recipe.id);
        }
      }
    }
    return { placed, w, h, floors, overlaps, cells, union: [...union], outside, custom: (f) => !!(shapes[f] && shapes[f].length),
      portPos: layout.portPos || {}, lifts: layout.lifts || {} };
  }

  // Connections: step-to-step flows plus building entrances/exits.
  function connections(geo, result) {
    const byId = {};
    geo.placed.forEach((p) => (byId[p.step.recipe.id] = p));
    const portFor = (p, item, side) => {
      const list = side === 'in' ? p.g.inputs : p.g.outputs;
      const lane = list.find((l) => l.item === item) || list[0];
      return port(p.b, p.g, lane);
    };
    const out = [];
    result.flows.forEach((f) => {
      if (!onBelt(f.item)) return;
      const src = f.from.startsWith('rec:') ? byId[f.from.slice(4)] : null;
      const dst = f.to.startsWith('rec:') ? byId[f.to.slice(4)] : null;
      if (src && dst) {
        out.push({ kind: 'internal', key: `${src.step.recipe.id}>${dst.step.recipe.id}:${f.item}`, item: f.item, rate: f.rate,
          a: portFor(src, f.item, 'out'), b: portFor(dst, f.item, 'in'),
          fa: src.b.floor, fb: dst.b.floor });
      }
    });
    return out;
  }

  const WALL_NORMAL = { N: [0, 1], S: [0, -1], W: [1, 0], E: [-1, 0] }; // pointing into the building
  const PORT_SPACING = 3;

  /**
   * Building entrances (items coming in) and exits (items going out): one port per item on a wall.
   * sides: { in: {item: 'N'|'E'|'S'|'W'}, out: {...} }; defaults are W for inputs and E for outputs.
   * Each port: { item, dir, side, rate, x, y (on the wall), rows: [{ port, floor }] }.
   */
  function ioPorts(geo, result, sides) {
    const byId = {};
    geo.placed.forEach((p) => (byId[p.step.recipe.id] = p));
    const groups = {};
    const add = (dir, item, rate, p) => {
      const key = dir + ':' + item;
      const g = (groups[key] = groups[key] || { item, dir, rate: 0, rows: [] });
      g.rate += rate;
      const list = dir === 'in' ? p.g.inputs : p.g.outputs;
      const lane = list.find((l) => l.item === item) || list[0];
      if (!g.rows.some((r) => r.id === p.step.recipe.id)) g.rows.push({ id: p.step.recipe.id, port: port(p.b, p.g, lane), floor: p.b.floor });
    };
    result.flows.forEach((f) => {
      if (!onBelt(f.item)) return;
      const src = f.from.startsWith('rec:') ? byId[f.from.slice(4)] : null;
      const dst = f.to.startsWith('rec:') ? byId[f.to.slice(4)] : null;
      if (dst && !src) add('in', f.item, f.rate, dst);
      else if (src && !dst) add('out', f.item, f.rate, src);
    });
    const ports = Object.values(groups).map((g) => {
      const key = g.dir + ':' + g.item;
      const pinned = geo.portPos && geo.portPos[key];
      if (pinned && onWall(geo.cells[g.rows[0].floor], pinned)) {
        return { ...g, key, side: pinned.side, along: pinned.side === 'W' || pinned.side === 'E' ? pinned.y : pinned.x, pinned };
      }
      const side = ((sides && sides[g.dir]) || {})[g.item] || (g.dir === 'in' ? 'W' : 'E');
      const a = g.rows[0].port;
      const vertical = side === 'W' || side === 'E';
      const len = vertical ? geo.h : geo.w;
      const along = Math.max(2, Math.min(len - 2, Math.round(vertical ? a.ay : a.ax)));
      return { ...g, key, side, along };
    });
    // Keep ports on the same wall at least PORT_SPACING apart.
    ['N', 'E', 'S', 'W'].forEach((side) => {
      const list = ports.filter((p) => p.side === side && !p.pinned).sort((a, b) => a.along - b.along);
      for (let i = 1; i < list.length; i++) list[i].along = Math.max(list[i].along, list[i - 1].along + PORT_SPACING);
    });
    ports.forEach((p) => {
      if (p.pinned) {
        [p.x, p.y] = [p.pinned.x, p.pinned.y];
        [p.nx, p.ny] = WALL_NORMAL[p.side];
        return;
      }
      const set = (geo.cells && geo.cells[p.rows[0].floor]) || new Set();
      const line = Math.floor(p.along / FOUNDATION);
      const hits = [];
      set.forEach((k) => {
        const [i, j] = k.split(',').map(Number);
        if ((p.side === 'W' || p.side === 'E') && j === line) hits.push(i);
        if ((p.side === 'N' || p.side === 'S') && i === line) hits.push(j);
      });
      const lo = hits.length ? Math.min(...hits) * FOUNDATION : 0;
      const hi = hits.length ? (Math.max(...hits) + 1) * FOUNDATION : p.side === 'E' ? geo.w : geo.h;
      [p.x, p.y] = { W: [lo, p.along], E: [hi, p.along], N: [p.along, lo], S: [p.along, hi] }[p.side];
      [p.nx, p.ny] = WALL_NORMAL[p.side];
    });
    return ports;
  }

  // Is a pinned port position still on an outer wall of the floor's shape?
  function onWall(set, { side, x, y }) {
    if (!set) return false;
    const F = FOUNDATION;
    const has = (i, j) => set.has(i + ',' + j);
    if (side === 'N' || side === 'S') {
      if (y % F) return false;
      const i = Math.floor(x / F);
      const j = y / F;
      return side === 'N' ? has(i, j) && !has(i, j - 1) : has(i, j - 1) && !has(i, j);
    }
    if (x % F) return false;
    const i = x / F;
    const j = Math.floor(y / F);
    return side === 'W' ? has(i, j) && !has(i - 1, j) : has(i - 1, j) && !has(i, j);
  }

  // Nearest point on the outer wall of a floor shape, snapped to 1 m and kept off the corners.
  function nearestWall(set, fx, fy) {
    const F = FOUNDATION;
    let best = null;
    let bestD = Infinity;
    const consider = (side, x0, y0, x1, y1) => {
      const horizontal = y0 === y1;
      const t = horizontal ? Math.min(x1 - 1, Math.max(x0 + 1, Math.round(fx))) : Math.min(y1 - 1, Math.max(y0 + 1, Math.round(fy)));
      const x = horizontal ? t : x0;
      const y = horizontal ? y0 : t;
      const d = Math.hypot(fx - x, fy - y);
      if (d < bestD) {
        bestD = d;
        best = { side, x, y };
      }
    };
    set.forEach((k) => {
      const [i, j] = k.split(',').map(Number);
      const x = i * F;
      const y = j * F;
      if (!set.has(i + ',' + (j - 1))) consider('N', x, y, x + F, y);
      if (!set.has(i + ',' + (j + 1))) consider('S', x, y + F, x + F, y + F);
      if (!set.has(i - 1 + ',' + j)) consider('W', x, y, x, y + F);
      if (!set.has(i + 1 + ',' + j)) consider('E', x + F, y, x + F, y + F);
    });
    return best;
  }

  // Route from a wall port into a row's port (or reversed for exits): straight in, one bend, then along the row.
  function wallRoute(p, rowPort) {
    const q = [p.x + p.nx * 3, p.y + p.ny * 3];
    const corner = p.side === 'W' || p.side === 'E' ? [rowPort.ax, q[1]] : [q[0], rowPort.ay];
    return [[p.x, p.y], q, corner, [rowPort.ax, rowPort.ay], [rowPort.x, rowPort.y]];
  }

  // ---------- Editor ----------
  function el(tag, attrs, parent) {
    const e = document.createElementNS(NS, tag);
    for (const k in attrs) e.setAttribute(k, attrs[k]);
    if (parent) parent.appendChild(e);
    return e;
  }
  function itemColor(id) {
    const name = D.items[id] ? D.items[id].name : id;
    let h = 0;
    for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) >>> 0;
    return `hsl(${h % 360} 65% 62%)`;
  }
  const iconHref = (entry) => (entry ? `img/icons/${entry.icon}.png` : '');

  // SVG path of a set of foundation cells, and the path of its outer walls.
  function cellsPath(set) {
    let d = '';
    set.forEach((k) => {
      const [i, j] = k.split(',').map(Number);
      d += `M${i * FOUNDATION},${j * FOUNDATION}h${FOUNDATION}v${FOUNDATION}h${-FOUNDATION}z`;
    });
    return d;
  }
  function wallsPath(set) {
    let d = '';
    const F = FOUNDATION;
    set.forEach((k) => {
      const [i, j] = k.split(',').map(Number);
      const x = i * F;
      const y = j * F;
      if (!set.has(i + ',' + (j - 1))) d += `M${x},${y}h${F}`;
      if (!set.has(i + ',' + (j + 1))) d += `M${x},${y + F}h${F}`;
      if (!set.has(i - 1 + ',' + j)) d += `M${x},${y}v${F}`;
      if (!set.has(i + 1 + ',' + j)) d += `M${x + F},${y}v${F}`;
    });
    return d;
  }

  class FloorPlan {
    constructor(container, opts) {
      this.container = container;
      this.opts = opts; // { fmt, onChange(layout), onSelect(recipeId) }
      this.view = { k: 4, x: 20, y: 20 };
      this.floor = 1;
      this.selected = null;
      this.shapeMode = false; // editing the floor's foundation shape
      this.brush = true; // shift-rectangle adds (true) or removes (false) foundations
      this.anchor = null; // first corner of a shift-click rectangle
      this.overlay = 'none'; // 'none' | 'below' | 'above' | 'both'
      this.svg = el('svg', { class: 'fp-svg' });
      const defs = el('defs', {}, this.svg);
      const minor = el('pattern', { id: 'fp-minor', width: 1, height: 1, patternUnits: 'userSpaceOnUse' }, defs);
      el('path', { d: 'M1 0V1H0', class: 'fp-grid-minor' }, minor);
      const major = el('pattern', { id: 'fp-major', width: FOUNDATION, height: FOUNDATION, patternUnits: 'userSpaceOnUse' }, defs);
      el('path', { d: `M${FOUNDATION} 0V${FOUNDATION}H0`, class: 'fp-grid-major' }, major);
      const arrow = el('marker', { id: 'fp-arrow', viewBox: '0 0 6 6', refX: 5, refY: 3, markerWidth: 5, markerHeight: 5, orient: 'auto-start-reverse' }, defs);
      el('path', { d: 'M0 0L6 3L0 6z', fill: 'context-stroke' }, arrow);
      this.root = el('g', {}, this.svg);
      container.appendChild(this.svg);
      this.bindPanZoom();
    }

    apply() {
      this.root.setAttribute('transform', `translate(${this.view.x},${this.view.y}) scale(${this.view.k})`);
      this.container.classList.toggle('fp-zoomed', this.view.k > 7);
    }

    toFloor(ev) {
      const r = this.container.getBoundingClientRect();
      return [(ev.clientX - r.left - this.view.x) / this.view.k, (ev.clientY - r.top - this.view.y) / this.view.k];
    }

    bindPanZoom() {
      const c = this.container;
      c.addEventListener('wheel', (ev) => {
        ev.preventDefault();
        const r = c.getBoundingClientRect();
        const mx = ev.clientX - r.left;
        const my = ev.clientY - r.top;
        const k = Math.min(40, Math.max(0.5, this.view.k * Math.exp(-ev.deltaY * 0.0015)));
        this.view.x = mx - ((mx - this.view.x) * k) / this.view.k;
        this.view.y = my - ((my - this.view.y) * k) / this.view.k;
        this.view.k = k;
        this.apply();
      }, { passive: false });
      let drag = null;
      c.addEventListener('contextmenu', (ev) => ev.preventDefault());
      c.addEventListener('pointerdown', (ev) => {
        if (ev.button !== 0 && ev.button !== 1 && ev.button !== 2) return;
        const blockEl = ev.target.closest('[data-block]');
        c.setPointerCapture(ev.pointerId);
        const cell = this.shapeMode && ev.button === 0 ? this.cellAt(ev) : null;
        if (cell) {
          const [i, j] = cell;
          if (ev.shiftKey) {
            if (!this.anchor) this.anchor = [i, j];
            else {
              this.fillRect(this.anchor, [i, j], this.brush);
              this.anchor = null;
              this.opts.onChange(this.layout);
            }
            this.draw();
            drag = null;
            return;
          }
          this.anchor = null;
          const value = !this.shapeSet().has(i + ',' + j);
          this.setCell(i, j, value);
          drag = { kind: 'paint', value, moved: true };
          this.draw();
        } else if (!this.shapeMode && ev.button === 0 && ev.target.closest('[data-port]')) {
          const el2 = ev.target.closest('[data-port]');
          drag = { kind: 'port', key: el2.dataset.port, floor: Number(el2.dataset.floor), moved: false };
        } else if (!this.shapeMode && ev.button === 0 && ev.target.closest('[data-lift]')) {
          drag = { kind: 'lift', key: ev.target.closest('[data-lift]').dataset.lift, moved: false };
        } else if (blockEl && !this.shapeMode && ev.button === 0) {
          const id = blockEl.dataset.block;
          const b = this.layout.blocks[id];
          const [fx, fy] = this.toFloor(ev);
          drag = { kind: 'block', id, b, ox: fx - b.x, oy: fy - b.y, moved: false };
          this.select(id);
        } else {
          drag = { kind: 'pan', x: ev.clientX, y: ev.clientY, vx: this.view.x, vy: this.view.y };
          c.classList.add('dragging');
        }
      });
      c.addEventListener('pointermove', (ev) => {
        if (!drag) return;
        if (drag.kind === 'pan') {
          this.view.x = drag.vx + ev.clientX - drag.x;
          this.view.y = drag.vy + ev.clientY - drag.y;
          this.apply();
          return;
        }
        if (drag.kind === 'port') {
          const [fx, fy] = this.toFloor(ev);
          const w = nearestWall(this.geo.cells[drag.floor] || new Set(), fx, fy);
          const cur = (this.layout.portPos || {})[drag.key];
          if (w && (!cur || cur.x !== w.x || cur.y !== w.y || cur.side !== w.side)) {
            this.layout.portPos = { ...(this.layout.portPos || {}), [drag.key]: w };
            drag.moved = true;
            this.draw();
          }
          return;
        }
        if (drag.kind === 'lift') {
          const [fx, fy] = this.toFloor(ev);
          const p = [Math.round(fx), Math.round(fy)];
          const cur = (this.layout.lifts || {})[drag.key];
          if (!cur || cur[0] !== p[0] || cur[1] !== p[1]) {
            this.layout.lifts = { ...(this.layout.lifts || {}), [drag.key]: p };
            drag.moved = true;
            this.draw();
          }
          return;
        }
        if (drag.kind === 'paint') {
          const cell = this.cellAt(ev);
          if (cell && this.shapeSet().has(cell.join(',')) !== drag.value) {
            this.setCell(cell[0], cell[1], drag.value);
            this.draw();
          }
          return;
        }
        const [fx, fy] = this.toFloor(ev);
        const nx = Math.max(0, Math.round(fx - drag.ox));
        const ny = Math.max(0, Math.round(fy - drag.oy));
        if (nx !== drag.b.x || ny !== drag.b.y) {
          drag.b.x = nx;
          drag.b.y = ny;
          drag.moved = true;
          this.draw();
        }
      });
      const end = () => {
        if (drag && ['block', 'paint', 'port', 'lift'].includes(drag.kind) && drag.moved) this.opts.onChange(this.layout);
        drag = null;
        c.classList.remove('dragging');
      };
      c.addEventListener('pointerup', end);
      c.addEventListener('dblclick', (ev) => {
        // Pointer capture retargets the event to the container; find what is actually under the cursor.
        const under = document.elementFromPoint(ev.clientX, ev.clientY);
        const portEl = under && under.closest('[data-port]');
        const liftEl = under && under.closest('[data-lift]');
        if (portEl && this.layout.portPos) delete this.layout.portPos[portEl.dataset.port];
        else if (liftEl && this.layout.lifts) delete this.layout.lifts[liftEl.dataset.lift];
        else return;
        this.opts.onChange(this.layout);
      });
      c.addEventListener('pointercancel', end);
    }

    // Size of the editable grid in shape mode: the building plus room to grow.
    editExtent() {
      const g = this.geo || { w: 64, h: 64 };
      return [g.w / FOUNDATION + 6, g.h / FOUNDATION + 6];
    }
    cellAt(ev) {
      const [fx, fy] = this.toFloor(ev);
      const i = Math.floor(fx / FOUNDATION);
      const j = Math.floor(fy / FOUNDATION);
      const [mi, mj] = this.editExtent();
      return i >= 0 && j >= 0 && i < mi && j < mj ? [i, j] : null;
    }
    // The current floor's shape as an editable set (a custom shape is created on first edit).
    shapeSet() {
      const shapes = (this.layout.shapes = this.layout.shapes || {});
      if (!shapes[this.floor] || !shapes[this.floor].length) {
        shapes[this.floor] = [...compute(this.layout, this.result).cells[this.floor]];
      }
      if (!this._set || this._setFor !== shapes[this.floor]) {
        this._set = new Set(shapes[this.floor]);
        this._setFor = shapes[this.floor];
      }
      return this._set;
    }
    commitSet(set) {
      this.layout.shapes[this.floor] = [...set];
      this._set = set;
      this._setFor = this.layout.shapes[this.floor];
    }
    setCell(i, j, on) {
      const set = new Set(this.shapeSet());
      if (on) set.add(i + ',' + j);
      else set.delete(i + ',' + j);
      this.commitSet(set);
    }
    fillRect([i0, j0], [i1, j1], on) {
      const set = new Set(this.shapeSet());
      for (let i = Math.min(i0, i1); i <= Math.max(i0, i1); i++) {
        for (let j = Math.min(j0, j1); j <= Math.max(j0, j1); j++) {
          if (on) set.add(i + ',' + j);
          else set.delete(i + ',' + j);
        }
      }
      this.commitSet(set);
    }
    setShapeMode(on) {
      this.shapeMode = on;
      this.anchor = null;
      this.container.classList.toggle('shape-mode', on);
      this.draw();
    }

    select(id) {
      this.selected = id;
      this.draw();
      this.opts.onSelect(id);
    }

    rotateSelected(dir) {
      const b = this.selected && this.layout.blocks[this.selected];
      if (!b) return;
      b.rot = ((b.rot || 0) + (dir || 90) + 360) % 360;
      this.opts.onChange(this.layout);
    }
    nudgeSelected(dx, dy) {
      const b = this.selected && this.layout.blocks[this.selected];
      if (!b) return;
      b.x = Math.max(0, b.x + dx);
      b.y = Math.max(0, b.y + dy);
      this.opts.onChange(this.layout);
    }

    fit() {
      if (!this.geo) return;
      const r = this.container.getBoundingClientRect();
      if (!r.width) return;
      const k = Math.min((r.width - 60) / this.geo.w, (r.height - 60) / this.geo.h);
      this.view.k = Math.max(0.5, Math.min(12, k));
      this.view.x = (r.width - this.geo.w * this.view.k) / 2;
      this.view.y = (r.height - this.geo.h * this.view.k) / 2;
      this.apply();
    }

    setData(layout, result, geo, sides) {
      const first = !this.geo;
      this.sides = sides;
      this.layout = layout;
      this.result = result;
      this.geo = geo;
      if (this.floor > geo.floors) this.floor = geo.floors;
      if (this.selected && !layout.blocks[this.selected]) this.selected = null;
      this.draw();
      if (first) requestAnimationFrame(() => this.fit());
    }

    draw() {
      const { fmt } = this.opts;
      this.root.textContent = '';
      if (!this.result || this.result.status !== 'optimal') return;
      const geo = compute(this.layout, this.result);
      this.geo = geo;
      const floor = this.floor;

      const set = geo.cells[floor];
      const shapeD = cellsPath(set);
      el('path', { d: shapeD, class: 'fp-floor' }, this.root);
      el('path', { d: shapeD, fill: 'url(#fp-minor)', class: 'fp-minor-layer' }, this.root);
      el('path', { d: shapeD, fill: 'url(#fp-major)' }, this.root);

      // Ghosts of the floors below/above, to line up conveyor lifts.
      const ghostFloors = [];
      if ((this.overlay === 'below' || this.overlay === 'both') && floor > 1) ghostFloors.push([floor - 1, 'below']);
      if ((this.overlay === 'above' || this.overlay === 'both') && floor < geo.floors) ghostFloors.push([floor + 1, 'above']);
      const gGhost = el('g', { class: 'fp-ghosts' }, this.root);
      ghostFloors.forEach(([gf, cls]) => {
        el('path', { d: wallsPath(geo.cells[gf]), class: 'fp-ghost-wall ' + cls }, gGhost);
        geo.placed.filter((p) => p.b.floor === gf).forEach(({ step, box }) => {
          el('rect', { x: box.x, y: box.y, width: box.w, height: box.h, rx: 0.6, class: 'fp-ghost-block ' + cls }, gGhost);
          const t = el('text', { x: box.x + 1, y: box.y + box.h - 1, class: 'fp-ghost-label ' + cls }, gGhost);
          t.textContent = `F${gf}: ${step.recipe.name.replace(/^Alternate: /, '')}`;
        });
      });

      el('path', { d: wallsPath(set), class: 'fp-wall' }, this.root);

      const gConn = el('g', {}, this.root);
      const gBlocks = el('g', {}, this.root);
      const gLabels = el('g', {}, this.root);

      // Blocks on this floor.
      geo.placed.forEach(({ step, b, g, box }) => {
        const onFloor = b.floor === floor;
        const r = step.recipe;
        const grp = el('g', {
          class: 'fp-block' + (onFloor ? '' : ' ghost') + (this.selected === r.id ? ' selected' : '') + ((geo.overlaps.has(r.id) || geo.outside.has(r.id)) && onFloor ? ' overlap' : ''),
          transform: blockTransform(b, g),
        }, onFloor ? gBlocks : null);
        if (!onFloor) return;
        grp.dataset.block = r.id;
        el('rect', { class: 'fp-block-bg', width: g.W, height: g.H, rx: 0.6 }, grp);
        // Lanes: feeder/collector columns and one line per ingredient/product per row.
        for (let row = 0; row < g.rows; row++) {
          const y0 = row * g.rowDepth;
          const count = row === g.rows - 1 ? step.machines - row * g.per : g.per;
          const rowEnd = LANE + count * g.pitch;
          g.inputs.forEach((p) => el('line', { x1: 1, y1: y0 + p.y, x2: rowEnd, y2: y0 + p.y, stroke: itemColor(p.item), class: 'fp-lane' + (D.items[p.item].liquid ? ' pipe' : '') }, grp));
          g.outputs.forEach((p) => el('line', { x1: LANE, y1: y0 + p.y, x2: g.W - 1, y2: y0 + p.y, stroke: itemColor(p.item), class: 'fp-lane' + (D.items[p.item].liquid ? ' pipe' : '') }, grp));
        }
        if (g.rows > 1) {
          g.inputs.forEach((p) => el('line', { x1: 1, y1: p.y, x2: 1, y2: (g.rows - 1) * g.rowDepth + p.y, stroke: itemColor(p.item), class: 'fp-lane' }, grp));
          g.outputs.forEach((p) => el('line', { x1: g.W - 1, y1: p.y, x2: g.W - 1, y2: (g.rows - 1) * g.rowDepth + p.y, stroke: itemColor(p.item), class: 'fp-lane' }, grp));
        }
        g.machines.forEach((m, i) => {
          const mg = el('g', { transform: `translate(${m.x},${m.y})` }, grp);
          el('rect', { class: 'fp-machine', width: m.w, height: m.l, rx: 0.4 }, mg);
          const s = Math.min(m.w, m.l) * 0.55;
          el('image', { href: iconHref(D.buildings[r.building]), x: (m.w - s) / 2, y: (m.l - s) / 2, width: s, height: s, class: 'fp-machine-icon' }, mg);
          const t = el('text', { x: 0.6, y: 1.6, class: 'fp-machine-no' }, mg);
          t.textContent = i + 1;
        });

        // Two-line header above the row, kept upright and trimmed to the row's width.
        const label = el('g', { class: 'fp-label', transform: `translate(${box.x},${box.y - 0.5})` }, gLabels);
        el('image', { href: iconHref(D.items[r.out[0][0]]), x: 0, y: -4.4, width: 4, height: 4 }, label);
        const clock = step.machines === step.count ? '100%' : `${fmt(step.clock * 100, 2)}%`;
        const chars = Math.max(6, Math.floor((box.w - 4.6) / 1.15));
        const fit = (s) => (s.length > chars ? s.slice(0, chars - 1) + '…' : s);
        el('text', { x: 4.6, y: -2.6 }, label).textContent = fit(r.name.replace(/^Alternate: /, ''));
        el('text', { x: 4.6, y: -0.5, class: 'sub' }, label).textContent = fit(`${step.machines}× ${D.buildings[r.building].name} @ ${clock}`);
      });

      // Connections.
      const conns = connections(geo, this.result);
      const labelAt = (x, y, c) => {
        const g = el('g', { class: 'fp-conn-label', transform: `translate(${x},${y})` }, gLabels);
        const text = `${fmt(c.rate)} · ${window.Transport.conveyorLabel(c.rate, D.items[c.item].liquid)}`;
        el('rect', { x: -0.3, y: -1.2, width: text.length * 0.62 + 2.6, height: 2.4, rx: 0.5 }, g);
        el('image', { href: iconHref(D.items[c.item]), x: 0, y: -1, width: 2, height: 2 }, g);
        el('text', { x: 2.3, y: 0.55 }, g).textContent = text;
      };
      const path = (pts, c, extra) => {
        const d = 'M' + pts.map((p) => p.join(',')).join('L');
        el('path', { d, stroke: itemColor(c.item), class: 'fp-conn' + (D.items[c.item].liquid ? ' pipe' : '') + (extra || ''), 'marker-end': 'url(#fp-arrow)' }, gConn);
      };
      const liftPos = (c) => geo.lifts[c.key] || [c.b.ax, c.b.ay];
      const lift = (x, y, c, up) => {
        const g = el('g', { class: 'fp-lift' + (geo.lifts[c.key] ? ' moved' : ''), transform: `translate(${x},${y})`, 'data-lift': c.key }, gLabels);
        el('title', {}, g).textContent = `Conveyor lift: ${D.items[c.item].name} ${up ? 'up' : 'down'} between floor ${c.fa} and floor ${c.fb} — drag to move, double-click to reset`;
        el('rect', { x: -1, y: -1, width: 2, height: 2, stroke: itemColor(c.item) }, g);
        el('text', { x: 0, y: 0.6, 'text-anchor': 'middle' }, g).textContent = up ? '▲' : '▼';
      };
      const route = (a, b) => {
        const mx = (a.ax + b.ax) / 2;
        return [[a.x, a.y], [a.ax, a.ay], [mx, a.ay], [mx, b.ay], [b.ax, b.ay], [b.x, b.y]];
      };
      conns.forEach((c) => {
        if (c.kind === 'internal') {
          if (c.fa === floor && c.fb === floor) {
            const pts = route(c.a, c.b);
            path(pts, c);
            labelAt((pts[2][0] + pts[3][0]) / 2 + 0.4, (pts[2][1] + pts[3][1]) / 2, c);
          } else if (c.fa === floor) {
            // Belt runs from the output to the conveyor lift (by default under/over the destination port).
            const [lx, ly] = liftPos(c);
            path([[c.a.x, c.a.y], [c.a.ax, c.a.ay], [c.a.ax, ly], [lx, ly]], c, ' cross');
            lift(lx, ly, c, c.fb > floor);
            labelAt(lx + 1.5, ly - 2, c);
          } else if (c.fb === floor) {
            const [lx, ly] = liftPos(c);
            lift(lx, ly, c, c.fa < floor);
            path([[lx, ly], [lx, c.b.ay], [c.b.ax, c.b.ay], [c.b.x, c.b.y]], c);
          }
        }
      });

      // Building entrances and exits on the walls.
      ioPorts(geo, this.result, this.sides).forEach((p) => {
        const rows = p.rows.filter((r) => r.floor === floor);
        if (!rows.length) return;
        rows.forEach((r) => {
          const pts = wallRoute(p, r.port);
          path(p.dir === 'in' ? pts : pts.reverse(), p, ' external');
        });
        const g = el('g', { class: 'fp-port ' + p.dir + (p.pinned ? ' moved' : ''), transform: `translate(${p.x},${p.y})`, 'data-port': p.key, 'data-floor': p.rows[0].floor }, gLabels);
        el('title', {}, g).textContent = `${p.dir === 'in' ? 'Entrance' : 'Exit'} (${p.side} wall): ${D.items[p.item].name} ${fmt(p.rate)}/min — drag along the wall to move, double-click to reset`;
        el('rect', { x: -1.6, y: -1.6, width: 3.2, height: 3.2, rx: 0.5, stroke: itemColor(p.item) }, g);
        el('image', { href: iconHref(D.items[p.item]), x: -1.3, y: -1.3, width: 2.6, height: 2.6 }, g);
        const lx = p.side === 'E' ? -16 : p.side === 'W' ? 2.4 : 2.2;
        const ly = p.side === 'N' ? 4.5 : p.side === 'S' ? -3 : -2.2;
        labelAt(p.x + lx, p.y + ly, p);
      });

      // Lifts arriving from the ghost floors, so they can be lined up.
      if (ghostFloors.length) {
        conns.forEach((c) => {
          if (c.kind !== 'internal' || c.fa === c.fb) return;
          const other = c.fa === floor ? c.fb : c.fb === floor ? c.fa : null;
          if (other == null || !ghostFloors.some(([gf]) => gf === other)) return;
          const [lx, ly] = liftPos(c);
          el('circle', { cx: lx, cy: ly, r: 2.2, class: 'fp-lift-ring' }, gLabels);
        });
      }

      // Shape editing grid.
      if (this.shapeMode) {
        const gEdit = el('g', { class: 'fp-shape-edit' }, this.root);
        const [mi, mj] = this.editExtent();
        let off = '';
        for (let i = 0; i < mi; i++) for (let j = 0; j < mj; j++) if (!set.has(i + ',' + j)) off += `M${i * 8},${j * 8}h8v8h-8z`;
        el('path', { d: off, class: 'fp-cell-off' }, gEdit);
        el('path', { d: shapeD, class: 'fp-cell-on' }, gEdit);
        if (this.anchor) el('rect', { x: this.anchor[0] * 8, y: this.anchor[1] * 8, width: 8, height: 8, class: 'fp-anchor' }, gEdit);
      }
      this.apply();
    }
  }

  window.Layout = { FloorPlan, autoLayout, reconcile, compute, connections, ioPorts, blockGeometry, cellsPath, FOUNDATION, FOOTPRINT };
})();
