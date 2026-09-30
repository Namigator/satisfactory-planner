// World map: canvas renderer and input handling for the game map, resource nodes, placed factory
// buildings, planned links and drawn infrastructure. World coordinates are meters (game units / 100).
(function () {
  'use strict';

  const D = window.SF_DATA;
  const M = window.SF_MAP;

  const RESOURCE_COLORS = {
    Desc_OreIron_C: '#b9a7a0',
    Desc_OreCopper_C: '#e0875a',
    Desc_Stone_C: '#d9cfb8',
    Desc_Coal_C: '#4a4a4a',
    Desc_OreGold_C: '#e6c24c',
    Desc_RawQuartz_C: '#f0a6d8',
    Desc_Sulfur_C: '#e8e25a',
    Desc_OreBauxite_C: '#c96a48',
    Desc_OreUranium_C: '#7ee05a',
    Desc_SAM_C: '#a46be0',
    Desc_LiquidOil_C: '#2c2c3a',
    Desc_NitrogenGas_C: '#9bb7c9',
    Desc_Water_C: '#4fa3e0',
    Desc_Geyser_C: '#e8f4f8',
  };
  const PURITY_COLORS = ['#ef6b6b', '#f2c14e', '#5cc98a'];
  const LINK_STYLES = {
    belt: { color: '#f39a3c', width: 3, dash: [] },
    pipe: { color: '#4fa3e0', width: 4, dash: [] },
    train: { color: '#e7e9ee', width: 4, dash: [2, 5], rail: true },
    truck: { color: '#5cc98a', width: 3, dash: [8, 6] },
    drone: { color: '#b58cf0', width: 2.5, dash: [3, 6] },
  };

  // Drawn infrastructure: stroke layers from bottom to top (screen pixels).
  const LINE_KINDS = {
    conveyor: { label: 'Conveyor', icon: 'conveyor', layers: [{ w: 6, c: 'rgba(0,0,0,.5)' }, { w: 3.5, c: '#f39a3c' }] },
    pipe: { label: 'Pipeline', icon: 'pipe', layers: [{ w: 7, c: 'rgba(0,0,0,.5)' }, { w: 4.5, c: '#4fa3e0' }] },
    hypertube: { label: 'Hypertube', icon: 'hypertube', layers: [{ w: 10, c: 'rgba(0,0,0,.4)' }, { w: 7, c: 'rgba(159,227,255,.55)' }, { w: 2, c: '#effcff' }] },
    rail: { label: 'Railway', icon: 'rail', layers: [{ w: 10, c: 'rgba(0,0,0,.5)' }, { w: 9, c: '#9c8466', dash: [2, 4] }, { w: 3.5, c: '#2d3139' }, { w: 1.4, c: '#e7e9ee' }] },
    road: { label: 'Truck road', icon: 'road', layers: [{ w: 11, c: 'rgba(0,0,0,.5)' }, { w: 8.5, c: '#5d636d' }, { w: 1.3, c: '#f2f2f2', dash: [7, 7] }] },
    drone: { label: 'Drone route', icon: 'drone', layers: [{ w: 4.5, c: 'rgba(0,0,0,.45)' }, { w: 2.5, c: '#b58cf0', dash: [6, 5] }], maxPoints: 2 },
    power: { label: 'Power line', icon: 'power', layers: [{ w: 4.5, c: 'rgba(0,0,0,.55)' }, { w: 2, c: '#f5d547' }] },
  };
  const POWER_COLOR = '#f5d547';
  const STATION_KINDS = {
    trainStation: { label: 'Train station', icon: 'trainStation', color: '#e7e9ee' },
    truckStation: { label: 'Truck station', icon: 'truckStation', color: '#5cc98a' },
    dronePort: { label: 'Drone port', icon: 'dronePort', color: '#b58cf0' },
    geothermal: { label: 'Geothermal generator', icon: 'geothermal', color: POWER_COLOR },
  };

  const nodes = M.nodes.map(([id, item, purity, x, y, kind, core]) => ({ id, item, purity, x, y, kind, core }));
  const nodeById = {};
  nodes.forEach((n) => (nodeById[n.id] = n));

  const MAP_DIR = 'img/map';
  const TILE_GRID = 4;
  const SNAP_PX = 12;

  // Load and decode an image off the main thread; resolves to a drawable (ImageBitmap when available).
  async function loadImage(src) {
    const img = new Image();
    img.decoding = 'async';
    img.src = src;
    try {
      await img.decode();
    } catch (e) {
      return null;
    }
    try {
      return await createImageBitmap(img);
    } catch (e) {
      return img;
    }
  }

  const iconCache = {};
  function iconByName(name) {
    if (!iconCache[name]) {
      const img = new Image();
      img.src = `img/icons/${name}.png`;
      iconCache[name] = img;
    }
    return iconCache[name];
  }
  const itemIcon = (item) => iconByName(D.items[item].icon);
  const infraIcon = (key) => iconByName(D.infraIcons[key]);
  const drawable = (img) => img && img.complete && img.naturalWidth;

  function polylineLength(pts) {
    let d = 0;
    for (let i = 1; i < pts.length; i++) d += Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]);
    return d;
  }
  function fmtLen(m) {
    return m >= 1000 ? `${(m / 1000).toFixed(2)} km` : `${Math.round(m)} m`;
  }

  class WorldMap {
    /**
     * opts: {
     *   model() -> { instances, links, lines, stations, selection, hiddenItems, minPurity, usedNodes, placing, tool }
     *   onSelect(sel), onPlace(x, y), onMoveFactory(key, x, y, done), onMoveStation(id, x, y, done),
     *   onRouteChange(kind, id, points, done), onDraw(kind, points), onStation(kind, x, y)
     * }
     */
    constructor(container, opts) {
      this.container = container;
      this.opts = opts;
      this.canvas = document.createElement('canvas');
      this.ctx = this.canvas.getContext('2d');
      container.appendChild(this.canvas);
      this.tip = document.createElement('div');
      this.tip.className = 'map-tip';
      container.appendChild(this.tip);
      this.view = { k: 0.1, x: 0, y: 0 };
      this.draft = null; // polyline being drawn: { kind, points }
      this.cursor = null; // world position of the pointer (snapped) while a tool is active
      // The map is pre-cut into small WebP files (tools/build-maptiles.py): a 2048 px overview and
      // TILE_GRID² full-resolution tiles. Each is decoded asynchronously, never on the main thread.
      this.small = null;
      this.tiles = new Map();
      loadImage(`${MAP_DIR}/overview.webp`).then((img) => {
        this.small = img;
        this.requestDraw();
      });
      new ResizeObserver(() => this.resize()).observe(container);
      this.bind();
    }

    // ---------- View ----------
    requestDraw() {
      if (this.raf) return;
      this.raf = requestAnimationFrame(() => {
        this.raf = 0;
        this.draw();
      });
    }
    resize() {
      const r = this.container.getBoundingClientRect();
      if (!r.width || !r.height) return;
      const dpr = window.devicePixelRatio || 1;
      this.canvas.width = Math.round(r.width * dpr);
      this.canvas.height = Math.round(r.height * dpr);
      this.canvas.style.width = r.width + 'px';
      this.canvas.style.height = r.height + 'px';
      this.w = r.width;
      this.h = r.height;
      if (!this.fitted) {
        this.fitted = true;
        this.fit();
      } else this.draw();
    }
    fit() {
      const b = M.bounds;
      const k = Math.min(this.w / (b.x1 - b.x0), this.h / (b.y1 - b.y0));
      this.view.k = k;
      this.view.x = (this.w - (b.x1 - b.x0) * k) / 2 - b.x0 * k;
      this.view.y = (this.h - (b.y1 - b.y0) * k) / 2 - b.y0 * k;
      this.draw();
    }
    centerOn(x, y, k) {
      if (k) this.view.k = k;
      this.view.x = this.w / 2 - x * this.view.k;
      this.view.y = this.h / 2 - y * this.view.k;
      this.draw();
    }
    toScreen(x, y) {
      return [x * this.view.k + this.view.x, y * this.view.k + this.view.y];
    }
    toWorld(sx, sy) {
      return [(sx - this.view.x) / this.view.k, (sy - this.view.y) / this.view.k];
    }
    eventPos(ev) {
      const r = this.canvas.getBoundingClientRect();
      return [ev.clientX - r.left, ev.clientY - r.top];
    }

    tile(i, j) {
      const key = i + ',' + j;
      const t = this.tiles.get(key);
      if (t) return t.bmp;
      const entry = { bmp: null };
      this.tiles.set(key, entry);
      loadImage(`${MAP_DIR}/tile-${i}-${j}.webp`).then((img) => {
        entry.bmp = img;
        this.requestDraw();
      });
      return null;
    }

    // ---------- Model helpers ----------
    // The polyline the user can edit right now (selected link or drawn line), in world coordinates.
    editable() {
      const m = this.model;
      const sel = m && m.selection;
      if (!sel) return null;
      if (sel.type === 'link') {
        const l = m.links.find((x) => x.id === sel.id);
        if (l && l.a && l.b) return { kind: 'link', id: l.id, pts: [l.a, ...(l.via || []), l.b], fixedEnds: true };
      }
      if (sel.type === 'line') {
        const l = m.lines.find((x) => x.id === sel.id);
        if (l) return { kind: 'line', id: l.id, pts: l.points, fixedEnds: false };
      }
      return null;
    }
    // Emit an edited polyline back: links report only their bends.
    emitRoute(ed, pts, done) {
      this.opts.onRouteChange(ed.kind, ed.id, ed.fixedEnds ? pts.slice(1, -1) : pts, done);
    }

    // Points worth snapping to while drawing: stations, line vertices, factory ports and centers, nodes.
    snap(sx, sy) {
      const m = this.model;
      let best = null;
      let bestD = SNAP_PX;
      const test = (x, y) => {
        const [px, py] = this.toScreen(x, y);
        const d = Math.hypot(px - sx, py - sy);
        if (d < bestD) {
          bestD = d;
          best = [x, y];
        }
      };
      m.stations.forEach((s) => test(s.x, s.y));
      m.lines.forEach((l) => l.points.forEach((p) => test(p[0], p[1])));
      m.instances.forEach((f) => {
        if (f.x == null) return;
        test(f.x, f.y);
        (f.ports || []).forEach((p) => test(p.x, p.y));
      });
      this.visibleNodes().forEach((n) => test(n.x, n.y));
      if (this.draft) this.draft.points.forEach((p) => test(p[0], p[1]));
      const kind = m.tool && LINE_KINDS[m.tool] ? m.tool : this.dragKind;
      if (!best && kind) {
        const w = this.toWorld(sx, sy);
        m.lines.forEach((l) => {
          if (l.kind !== kind) return;
          for (let i = 1; i < l.points.length; i++) {
            const pr = window.Rail.segProject(w, l.points[i - 1], l.points[i]);
            const [px, py] = this.toScreen(...pr.q);
            const d = Math.hypot(px - sx, py - sy);
            if (d < bestD) {
              bestD = d;
              best = pr.q.map((v) => Math.round(v * 10) / 10);
            }
          }
        });
      }
      return best;
    }

    // ---------- Hit testing ----------
    hit(sx, sy) {
      const m = this.model;
      if (!m) return null;
      const ed = this.editable();
      if (ed) {
        const pts = ed.pts.map((p) => this.toScreen(...p));
        for (let i = 0; i < pts.length; i++) {
          if (ed.fixedEnds && (i === 0 || i === pts.length - 1)) continue;
          if (Math.hypot(pts[i][0] - sx, pts[i][1] - sy) < 8) return { type: 'vertex', ed, index: i };
        }
        for (let i = 1; i < pts.length; i++) {
          if (Math.hypot((pts[i - 1][0] + pts[i][0]) / 2 - sx, (pts[i - 1][1] + pts[i][1]) / 2 - sy) < 8) return { type: 'midpoint', ed, index: i };
        }
      }
      for (const s of [...m.stations].reverse()) {
        const [px, py] = this.toScreen(s.x, s.y);
        if (Math.abs(px - sx) <= 14 && Math.abs(py - sy) <= 14) return { type: 'station', id: s.id };
      }
      for (const f of [...m.instances].reverse()) {
        if (f.x == null) continue;
        const [px, py] = this.toScreen(f.x, f.y);
        if (sx >= px - 14 && sx <= px + 14 + (f.labelW || 0) && sy >= py - 34 && sy <= py - 8) return { type: 'factory', id: f.key };
        const a = (-(f.rot || 0) * Math.PI) / 180;
        const [wx, wy] = this.toWorld(sx, sy);
        const dx = wx - f.x;
        const dy = wy - f.y;
        const lx = dx * Math.cos(a) - dy * Math.sin(a) + f.w / 2;
        const ly = dx * Math.sin(a) + dy * Math.cos(a) + f.h / 2;
        if (f.cellSet && f.cellSet.has(Math.floor(lx / 8) + ',' + Math.floor(ly / 8))) return { type: 'factory', id: f.key };
      }
      let best = null;
      let bestD = 9;
      for (const n of this.visibleNodes()) {
        const [px, py] = this.toScreen(n.x, n.y);
        const d = Math.hypot(px - sx, py - sy);
        if (d < bestD) {
          bestD = d;
          best = n;
        }
      }
      if (best) return { type: 'node', id: best.id };
      const nearLine = (points) => {
        const pts = points.map((p) => this.toScreen(...p));
        for (let i = 1; i < pts.length; i++) if (segDist(sx, sy, pts[i - 1], pts[i]) < 6) return true;
        return false;
      };
      for (const l of m.lines) if (nearLine(l.points)) return { type: 'line', id: l.id };
      for (const l of m.links) if (l.a && l.b && nearLine([l.a, ...(l.via || []), l.b])) return { type: 'link', id: l.id };
      return null;
    }

    visibleNodes() {
      const m = this.model;
      return nodes.filter((n) => !m.hiddenItems.has(n.item) && n.purity >= m.minPurity);
    }

    // ---------- Events ----------
    bind() {
      const c = this.canvas;
      c.addEventListener('contextmenu', (ev) => ev.preventDefault());
      c.addEventListener('wheel', (ev) => {
        ev.preventDefault();
        const [mx, my] = this.eventPos(ev);
        const k = Math.min(20, Math.max(0.05, this.view.k * Math.exp(-ev.deltaY * 0.0015)));
        this.view.x = mx - ((mx - this.view.x) * k) / this.view.k;
        this.view.y = my - ((my - this.view.y) * k) / this.view.k;
        this.view.k = k;
        this.requestDraw();
      }, { passive: false });

      let drag = null;
      c.addEventListener('pointerdown', (ev) => {
        const [sx, sy] = this.eventPos(ev);
        c.setPointerCapture(ev.pointerId);
        const m = this.model;
        const tool = m.tool || 'select';
        // Right/middle button always pans; while drawing, a right-click finishes the line. With a tool active
        // (or while placing) and nothing drawn yet, a right-click without dragging cancels back to Select.
        if (ev.button !== 0) {
          if (ev.button === 2 && this.draft) {
            this.finishDraft();
            return;
          }
          const cancel = ev.button === 2 && (m.placing || tool !== 'select');
          drag = { kind: 'pan', sx, sy, vx: this.view.x, vy: this.view.y, moved: !cancel, click: cancel ? 'cancel' : null };
          return;
        }
        if (m.placing || tool !== 'select') {
          // Clicks place things; a drag still pans (decided on release).
          drag = { kind: 'pan', sx, sy, vx: this.view.x, vy: this.view.y, moved: false, click: 'tool' };
          return;
        }
        const h = this.hit(sx, sy);
        const sel = m.selection;
        if (h && h.type === 'vertex') {
          drag = { kind: 'vertex', ed: h.ed, index: h.index, pts: h.ed.pts.map((p) => p.slice()) };
          const line = h.ed.kind === 'line' && m.lines.find((l) => l.id === h.ed.id);
          this.dragKind = line ? line.kind : null;
        } else if (h && h.type === 'midpoint') {
          const pts = h.ed.pts.map((p) => p.slice());
          pts.splice(h.index, 0, this.toWorld(sx, sy));
          drag = { kind: 'vertex', ed: h.ed, index: h.index, pts };
          this.emitRoute(h.ed, pts, false);
        } else if (h && h.type === 'factory' && sel && sel.type === 'factory' && sel.id === h.id) {
          const f = m.instances.find((x) => x.key === h.id);
          const [wx, wy] = this.toWorld(sx, sy);
          drag = { kind: 'factory', id: h.id, ox: wx - f.x, oy: wy - f.y, moved: false };
        } else if (h && h.type === 'station' && sel && sel.type === 'station' && sel.id === h.id) {
          const s = m.stations.find((x) => x.id === h.id);
          const [wx, wy] = this.toWorld(sx, sy);
          drag = { kind: 'station', id: h.id, ox: wx - s.x, oy: wy - s.y, moved: false };
        } else {
          drag = { kind: 'pan', sx, sy, vx: this.view.x, vy: this.view.y, moved: false, hit: h };
        }
      });
      c.addEventListener('pointermove', (ev) => {
        const [sx, sy] = this.eventPos(ev);
        const m = this.model;
        if (m && ((m.tool && m.tool !== 'select') || m.placing)) {
          const snapped = this.snap(sx, sy);
          this.cursor = snapped || this.toWorld(sx, sy);
          this.snapped = !!snapped;
          this.requestDraw();
        }
        if (!drag) {
          this.hover(sx, sy);
          return;
        }
        if (drag.kind === 'pan') {
          if (Math.hypot(sx - drag.sx, sy - drag.sy) > 4) drag.moved = true;
          if (!drag.moved) return;
          this.view.x = drag.vx + sx - drag.sx;
          this.view.y = drag.vy + sy - drag.sy;
          this.requestDraw();
        } else if (drag.kind === 'factory' || drag.kind === 'station') {
          const [wx, wy] = this.toWorld(sx, sy);
          drag.moved = true;
          const fn = drag.kind === 'factory' ? this.opts.onMoveFactory : this.opts.onMoveStation;
          fn(drag.id, Math.round(wx - drag.ox), Math.round(wy - drag.oy), false);
        } else if (drag.kind === 'vertex') {
          drag.pts[drag.index] = (this.snap(sx, sy) || this.toWorld(sx, sy)).map((v) => Math.round(v * 10) / 10);
          this.emitRoute(drag.ed, drag.pts, false);
        }
      });
      c.addEventListener('pointerup', (ev) => {
        if (!drag) return;
        const d = drag;
        drag = null;
        this.dragKind = null;
        if (d.kind === 'pan' && !d.moved) {
          if (d.click === 'tool') this.toolClick(ev);
          else if (d.click === 'cancel') this.opts.onCancelTool();
          else this.opts.onSelect(d.hit ? { type: d.hit.type, id: d.hit.id } : null);
        }
        if (d.kind === 'factory' && d.moved) {
          const f = this.model.instances.find((x) => x.key === d.id);
          this.opts.onMoveFactory(d.id, f.x, f.y, true);
        }
        if (d.kind === 'station' && d.moved) {
          const s = this.model.stations.find((x) => x.id === d.id);
          this.opts.onMoveStation(d.id, s.x, s.y, true);
        }
        if (d.kind === 'vertex') this.emitRoute(d.ed, d.pts, true);
      });
      c.addEventListener('pointercancel', () => (drag = null));
      c.addEventListener('dblclick', (ev) => {
        const [sx, sy] = this.eventPos(ev);
        if (this.draft) {
          this.finishDraft();
          return;
        }
        const h = this.hit(sx, sy);
        if (h && h.type === 'vertex') {
          const pts = h.ed.pts.slice();
          if (!h.ed.fixedEnds && pts.length <= 2) return;
          pts.splice(h.index, 1);
          this.emitRoute(h.ed, pts, true);
        }
      });
      c.addEventListener('pointerleave', () => {
        this.tip.style.display = 'none';
        this.cursor = null;
        this.requestDraw();
      });
    }

    // A click with a drawing/placing tool active.
    toolClick(ev) {
      const m = this.model;
      const [sx, sy] = this.eventPos(ev);
      const p = (this.snap(sx, sy) || this.toWorld(sx, sy)).map((v) => Math.round(v * 10) / 10);
      if (m.placing) {
        this.opts.onPlace(p[0], p[1]);
        return;
      }
      if (STATION_KINDS[m.tool]) {
        this.opts.onStation(m.tool, p[0], p[1]);
        return;
      }
      const kind = LINE_KINDS[m.tool];
      if (!kind) return;
      if (!this.draft || this.draft.kind !== m.tool) this.draft = { kind: m.tool, points: [] };
      const last = this.draft.points[this.draft.points.length - 1];
      if (!last || Math.hypot(last[0] - p[0], last[1] - p[1]) * this.view.k > 2) this.draft.points.push(p);
      if (kind.maxPoints && this.draft.points.length >= kind.maxPoints) this.finishDraft();
      this.requestDraw();
    }
    finishDraft() {
      const d = this.draft;
      this.draft = null;
      if (d && d.points.length >= 2) this.opts.onDraw(d.kind, d.points);
      this.requestDraw();
    }
    cancelDraft() {
      const had = !!this.draft;
      this.draft = null;
      this.requestDraw();
      return had;
    }
    undoDraftPoint() {
      if (!this.draft) return false;
      this.draft.points.pop();
      if (!this.draft.points.length) this.draft = null;
      this.requestDraw();
      return true;
    }

    hover(sx, sy) {
      const m = this.model;
      if (!m) return;
      if ((m.tool && m.tool !== 'select') || m.placing) {
        this.tip.style.display = 'none';
        this.canvas.style.cursor = 'crosshair';
        return;
      }
      const h = this.hit(sx, sy);
      let text = '';
      if (h && h.type === 'node') {
        const n = nodeById[h.id];
        text = `${D.items[n.item].name} · ${window.Transport.PURITY_NAME[n.purity]}${n.kind === 'well' ? ' well' : ''}${m.usedNodes.has(n.id) ? ' · in use' : ''}`;
        if (n.kind === 'geyser') text = `${window.Transport.PURITY_NAME[n.purity]} geyser · ≈ ${window.Power.POWER.geothermal[n.purity]} MW geothermal${m.usedNodes.has(n.id) ? ' · in use' : ''}`;
      } else if (h && h.type === 'factory') text = m.instances.find((f) => f.key === h.id).name;
      else if (h && h.type === 'link') {
        const l = m.links.find((x) => x.id === h.id);
        text = `${D.items[l.item].name} · ${l.rateText} · ${l.summary}`;
      } else if (h && h.type === 'line') {
        const l = m.lines.find((x) => x.id === h.id);
        text = `${l.name || LINE_KINDS[l.kind].label} · ${fmtLen(polylineLength(l.points))}`;
        const pw = l.kind === 'power' && m.power && m.power.lines[l.id];
        if (pw) text += ` · ${pw.towers.length} tower${pw.towers.length === 1 ? '' : 's'}${pw.long ? ` · ${pw.long} span${pw.long > 1 ? 's' : ''} too long` : ''}`;
      } else if (h && h.type === 'station') {
        const s = m.stations.find((x) => x.id === h.id);
        text = `${STATION_KINDS[s.kind].label}${s.name ? ' · ' + s.name : ''}`;
      } else if (h && h.type === 'vertex') text = 'Drag to move · double-click to remove';
      else if (h && h.type === 'midpoint') text = 'Drag to add a bend';
      this.canvas.style.cursor = h ? 'pointer' : 'grab';
      if (!text) {
        this.tip.style.display = 'none';
        return;
      }
      this.tip.textContent = text;
      this.tip.style.display = 'block';
      this.tip.style.left = sx + 14 + 'px';
      this.tip.style.top = sy + 14 + 'px';
    }

    // ---------- Drawing ----------
    drawMap(ctx) {
      const b = M.bounds;
      const W = b.x1 - b.x0;
      const H = b.y1 - b.y0;
      const k = this.view.k;
      if (this.small) ctx.drawImage(this.small, b.x0, b.y0, W, H);
      if (W * k <= 2400) return;
      const n = TILE_GRID;
      const tw = W / n;
      const th = H / n;
      const [x0, y0] = this.toWorld(0, 0);
      const [x1, y1] = this.toWorld(this.w, this.h);
      for (let i = Math.max(0, Math.floor((x0 - b.x0) / tw)); i <= Math.min(n - 1, Math.floor((x1 - b.x0) / tw)); i++) {
        for (let j = Math.max(0, Math.floor((y0 - b.y0) / th)); j <= Math.min(n - 1, Math.floor((y1 - b.y0) / th)); j++) {
          const bmp = this.tile(i, j);
          if (bmp) ctx.drawImage(bmp, b.x0 + i * tw, b.y0 + j * th, tw + 0.5 / k, th + 0.5 / k);
        }
      }
    }

    strokeLayers(pts, layers) {
      const ctx = this.ctx;
      ctx.lineJoin = 'round';
      ctx.lineCap = 'round';
      for (const layer of layers) {
        ctx.beginPath();
        pts.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
        ctx.setLineDash(layer.dash || []);
        ctx.lineWidth = layer.w;
        ctx.strokeStyle = layer.c;
        ctx.stroke();
      }
      ctx.setLineDash([]);
    }

    draw() {
      if (!this.w) return;
      this.model = this.opts.model();
      const ctx = this.ctx;
      const dpr = window.devicePixelRatio || 1;
      const { k } = this.view;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.fillStyle = '#0e1013';
      ctx.fillRect(0, 0, this.w, this.h);

      ctx.save();
      ctx.translate(this.view.x, this.view.y);
      ctx.scale(k, k);
      this.drawMap(ctx);
      ctx.restore();
      ctx.fillStyle = 'rgba(10,12,16,0.25)';
      ctx.fillRect(0, 0, this.w, this.h);

      this.drawNodes();
      this.drawLines();
      this.drawHighlights();
      this.drawLinks();
      this.drawFactories();
      this.drawStations();
      this.drawEditHandles();
      this.drawDraft();
      this.drawBanner();
      this.drawScale();
    }

    drawNodes() {
      const ctx = this.ctx;
      const m = this.model;
      const k = this.view.k;
      const showIcons = k > 0.35;
      const r = showIcons ? 11 : k > 0.15 ? 5 : 3.5;
      for (const n of this.visibleNodes()) {
        const [x, y] = this.toScreen(n.x, n.y);
        if (x < -20 || y < -20 || x > this.w + 20 || y > this.h + 20) continue;
        const used = m.usedNodes.has(n.id);
        const selected = m.selection && m.selection.type === 'node' && m.selection.id === n.id;
        ctx.beginPath();
        ctx.arc(x, y, r, 0, Math.PI * 2);
        ctx.fillStyle = showIcons ? 'rgba(20,22,28,0.85)' : RESOURCE_COLORS[n.item] || '#fff';
        ctx.fill();
        ctx.lineWidth = showIcons ? 2.5 : 1.5;
        ctx.strokeStyle = PURITY_COLORS[n.purity];
        ctx.stroke();
        if (showIcons) {
          const ic = itemIcon(n.item);
          if (drawable(ic)) ctx.drawImage(ic, x - 8, y - 8, 16, 16);
        }
        if (used || selected) {
          ctx.beginPath();
          ctx.arc(x, y, r + 4, 0, Math.PI * 2);
          ctx.lineWidth = 2;
          ctx.strokeStyle = selected ? '#fff' : '#f39a3c';
          ctx.stroke();
        }
      }
    }

    drawLines() {
      const m = this.model;
      const sel = m.selection && m.selection.type === 'line' ? m.selection.id : null;
      for (const l of m.lines) {
        const pts = l.points.map((p) => this.toScreen(...p));
        if (l.id === sel) this.strokeLayers(pts, [{ w: LINE_KINDS[l.kind].layers[0].w + 5, c: 'rgba(255,255,255,.85)' }]);
        this.strokeLayers(pts, LINE_KINDS[l.kind].layers);
        if (l.kind === 'power') this.drawTowers(l, pts);
        if (l.id === sel || (l.name && this.view.k > 0.3)) {
          const mid = midpointOf(pts);
          this.label(mid[0], mid[1] - 14, null, `${l.name ? l.name + ' · ' : ''}${fmtLen(polylineLength(l.points))}`, D.infraIcons[LINE_KINDS[l.kind].icon]);
        }
      }
    }

    // Power towers along a power line: solid = placed points, hollow = placed automatically.
    // Spans longer than the maximum (auto-placement off) are drawn red.
    drawTowers(l, pts) {
      const pw = this.model.power && this.model.power.lines[l.id];
      if (!pw) return;
      const ctx = this.ctx;
      pw.spans.filter((sp) => sp.long).forEach((sp) => this.strokeLayers([pts[sp.i - 1], pts[sp.i]], [{ w: 3, c: '#ef6b6b', dash: [6, 4] }]));
      if (this.view.k < 0.06) return;
      const r = this.view.k > 0.5 ? 4 : 3;
      pw.towers.forEach((t) => {
        const [x, y] = this.toScreen(t.x, t.y);
        ctx.beginPath();
        ctx.arc(x, y, r, 0, Math.PI * 2);
        ctx.fillStyle = t.auto ? 'rgba(20,22,28,0.95)' : POWER_COLOR;
        ctx.fill();
        ctx.lineWidth = 1.5;
        ctx.strokeStyle = t.auto ? POWER_COLOR : 'rgba(0,0,0,.7)';
        ctx.stroke();
      });
    }

    // Train routes from the route planner, drawn over the track.
    drawHighlights() {
      (this.model.highlight || []).forEach((hl) => {
        this.strokeLayers(hl.points.map((p) => this.toScreen(...p)), [
          { w: hl.width + 4, c: 'rgba(0,0,0,.45)' },
          { w: hl.width, c: hl.color },
        ]);
      });
    }

    drawLinks() {
      const ctx = this.ctx;
      const m = this.model;
      const k = this.view.k;
      const selLink = m.selection && m.selection.type === 'link' ? m.selection.id : null;
      for (const l of m.links) {
        if (!l.a || !l.b) continue;
        const st = LINK_STYLES[l.transport] || LINK_STYLES.belt;
        const pts = [l.a, ...(l.via || []), l.b].map((p) => this.toScreen(...p));
        const selected = l.id === selLink;
        const layers = [{ w: st.width + (selected ? 6 : 3), c: selected ? 'rgba(255,255,255,0.9)' : 'rgba(0,0,0,0.55)' }];
        if (st.rail) layers.push({ w: st.width + 2, c: '#6b5a4a' });
        layers.push({ w: st.rail ? 2 : st.width, c: l.warn ? '#ef6b6b' : st.color, dash: st.dash });
        this.strokeLayers(pts, layers);
        let bi = 1;
        let bl = 0;
        for (let i = 1; i < pts.length; i++) {
          const d = Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]);
          if (d > bl) {
            bl = d;
            bi = i;
          }
        }
        if (bl > 30) {
          const [ax, ay] = pts[bi - 1];
          const [bx, by] = pts[bi];
          const mx = (ax + bx) / 2;
          const my = (ay + by) / 2;
          ctx.save();
          ctx.translate(mx, my);
          ctx.rotate(Math.atan2(by - ay, bx - ax));
          ctx.beginPath();
          ctx.moveTo(6, 0);
          ctx.lineTo(-5, -5);
          ctx.lineTo(-5, 5);
          ctx.closePath();
          ctx.fillStyle = st.color;
          ctx.fill();
          ctx.restore();
          if (k > 0.25 || selected) this.label(mx, my + 14, l.item, `${l.rateText} · ${l.summary}`);
        }
      }
    }

    drawFactories() {
      const ctx = this.ctx;
      const m = this.model;
      const k = this.view.k;
      for (const f of m.instances) {
        if (f.x == null) continue;
        const selected = m.selection && m.selection.type === 'factory' && m.selection.id === f.key;
        const [x, y] = this.toScreen(f.x, f.y);
        ctx.save();
        ctx.translate(x, y);
        ctx.rotate(((f.rot || 0) * Math.PI) / 180);
        ctx.scale(k, k);
        ctx.translate(-f.w / 2, -f.h / 2);
        // Foundation cells of all floors (the building's shape), with grid lines when zoomed in.
        ctx.fillStyle = selected ? 'rgba(243,154,60,0.45)' : 'rgba(243,154,60,0.28)';
        ctx.beginPath();
        f.cells.forEach(([i, j]) => ctx.rect(i * 8, j * 8, 8, 8));
        ctx.fill();
        if (8 * k > 5) {
          ctx.strokeStyle = 'rgba(255,255,255,0.12)';
          ctx.lineWidth = 1 / k;
          ctx.stroke();
        }
        ctx.strokeStyle = selected ? '#fff' : '#f39a3c';
        ctx.lineWidth = (selected ? 2 : 1.5) / k;
        ctx.beginPath();
        const s = f.cellSet;
        f.cells.forEach(([i, j]) => {
          if (!s.has(i + ',' + (j - 1))) { ctx.moveTo(i * 8, j * 8); ctx.lineTo(i * 8 + 8, j * 8); }
          if (!s.has(i + ',' + (j + 1))) { ctx.moveTo(i * 8, j * 8 + 8); ctx.lineTo(i * 8 + 8, j * 8 + 8); }
          if (!s.has(i - 1 + ',' + j)) { ctx.moveTo(i * 8, j * 8); ctx.lineTo(i * 8, j * 8 + 8); }
          if (!s.has(i + 1 + ',' + j)) { ctx.moveTo(i * 8 + 8, j * 8); ctx.lineTo(i * 8 + 8, j * 8 + 8); }
        });
        ctx.stroke();
        if (f.w * k > 40) {
          // Arrow on the north wall (top of the floor plan).
          ctx.fillStyle = '#fff';
          ctx.beginPath();
          ctx.moveTo(f.w / 2, -1 / k);
          ctx.lineTo(f.w / 2 - 5 / k, 7 / k);
          ctx.lineTo(f.w / 2 + 5 / k, 7 / k);
          ctx.fill();
        }
        ctx.restore();

        if (f.w * k > 40 && f.ports) {
          for (const p of f.ports) {
            const [px, py] = this.toScreen(p.x, p.y);
            const r = Math.min(9, Math.max(5, 2.5 * k));
            ctx.beginPath();
            ctx.arc(px, py, r, 0, Math.PI * 2);
            ctx.fillStyle = 'rgba(20,22,28,0.95)';
            ctx.fill();
            ctx.lineWidth = 2;
            ctx.strokeStyle = p.dir === 'in' ? '#5cc98a' : '#f39a3c';
            ctx.stroke();
            const ic = itemIcon(p.item);
            if (r >= 7 && drawable(ic)) ctx.drawImage(ic, px - r * 0.7, py - r * 0.7, r * 1.4, r * 1.4);
          }
        }

        ctx.font = '600 12px system-ui, sans-serif';
        f.labelW = ctx.measureText(f.name).width + 30;
        const lx = x - 14;
        const ly = y - 34;
        ctx.fillStyle = selected ? '#f39a3c' : 'rgba(27,30,37,0.95)';
        ctx.strokeStyle = selected ? '#fff' : f.warn ? '#f2c14e' : '#f39a3c';
        ctx.lineWidth = 1.5;
        roundRect(ctx, lx, ly, f.labelW, 24, 5);
        ctx.fill();
        ctx.stroke();
        ctx.beginPath();
        ctx.moveTo(x - 5, ly + 24);
        ctx.lineTo(x, y);
        ctx.lineTo(x + 5, ly + 24);
        ctx.fill();
        if (f.icon) {
          const ic = itemIcon(f.icon);
          if (drawable(ic)) ctx.drawImage(ic, lx + 4, ly + 3, 18, 18);
        }
        ctx.fillStyle = selected ? '#1a1d23' : '#e7e9ee';
        ctx.fillText(f.name, lx + 25, ly + 16);
      }
    }

    drawStations() {
      const ctx = this.ctx;
      const m = this.model;
      const sel = m.selection && m.selection.type === 'station' ? m.selection.id : null;
      for (const s of m.stations) {
        const kind = STATION_KINDS[s.kind];
        const [x, y] = this.toScreen(s.x, s.y);
        if (x < -30 || y < -30 || x > this.w + 30 || y > this.h + 30) continue;
        ctx.save();
        ctx.translate(x, y);
        ctx.rotate(((s.rot || 0) * Math.PI) / 180);
        ctx.fillStyle = 'rgba(20,22,28,0.95)';
        ctx.strokeStyle = s.id === sel ? '#fff' : kind.color;
        ctx.lineWidth = s.id === sel ? 2.5 : 2;
        roundRect(ctx, -13, -13, 26, 26, 5);
        ctx.fill();
        ctx.stroke();
        // A facing tick per substation (or one for the station itself).
        const buildings = (s.layout || []).filter((p) => p.kind === 'station');
        const dirs = buildings.length ? [...new Set(buildings.map((b) => (b.facing === 'right' ? 90 : -90)))] : [0];
        ctx.fillStyle = kind.color;
        dirs.forEach((d) => {
          ctx.save();
          ctx.rotate((d * Math.PI) / 180);
          ctx.beginPath();
          ctx.moveTo(0, -18);
          ctx.lineTo(-4.5, -12);
          ctx.lineTo(4.5, -12);
          ctx.fill();
          ctx.restore();
        });
        ctx.restore();
        if (buildings.length > 1) {
          ctx.beginPath();
          ctx.arc(x + 13, y - 13, 8, 0, Math.PI * 2);
          ctx.fillStyle = kind.color;
          ctx.fill();
          ctx.fillStyle = '#1a1d23';
          ctx.font = '700 10px system-ui, sans-serif';
          ctx.textAlign = 'center';
          ctx.fillText(String(buildings.length), x + 13, y - 9.5);
          ctx.textAlign = 'start';
        }
        const ic = infraIcon(kind.icon);
        if (drawable(ic)) ctx.drawImage(ic, x - 10, y - 10, 20, 20);
        if (s.name && (this.view.k > 0.2 || s.id === sel)) {
          ctx.font = '600 11px system-ui, sans-serif';
          const w = ctx.measureText(s.name).width + 10;
          ctx.fillStyle = 'rgba(20,22,28,0.9)';
          roundRect(ctx, x - w / 2, y + 16, w, 17, 4);
          ctx.fill();
          ctx.fillStyle = '#e7e9ee';
          ctx.fillText(s.name, x - w / 2 + 5, y + 28);
        }
      }
    }

    drawEditHandles() {
      const ed = this.editable();
      if (!ed) return;
      const ctx = this.ctx;
      const pts = ed.pts.map((p) => this.toScreen(...p));
      for (let i = 1; i < pts.length; i++) {
        ctx.beginPath();
        ctx.arc((pts[i - 1][0] + pts[i][0]) / 2, (pts[i - 1][1] + pts[i][1]) / 2, 4, 0, Math.PI * 2);
        ctx.fillStyle = 'rgba(255,255,255,0.6)';
        ctx.fill();
      }
      pts.forEach(([x, y], i) => {
        if (ed.fixedEnds && (i === 0 || i === pts.length - 1)) return;
        ctx.beginPath();
        ctx.arc(x, y, 6, 0, Math.PI * 2);
        ctx.fillStyle = '#fff';
        ctx.fill();
        ctx.strokeStyle = '#000';
        ctx.lineWidth = 1.5;
        ctx.stroke();
      });
    }

    drawDraft() {
      const m = this.model;
      const ctx = this.ctx;
      if (this.draft && this.draft.points.length) {
        const pts = [...this.draft.points, ...(this.cursor ? [this.cursor] : [])];
        this.strokeLayers(pts.map((p) => this.toScreen(...p)), LINE_KINDS[this.draft.kind].layers);
        const [x, y] = this.toScreen(...pts[pts.length - 1]);
        let text = fmtLen(polylineLength(pts));
        const maxSpan = m.power && m.power.maxSpan;
        if (this.draft.kind === 'power' && maxSpan && pts.length >= 2) {
          // The span being drawn: towers the planner adds to keep every span within the maximum.
          const a = pts[pts.length - 2];
          const b = pts[pts.length - 1];
          const span = Math.hypot(b[0] - a[0], b[1] - a[1]);
          const extra = Math.max(0, Math.ceil(span / maxSpan - 1e-9) - 1);
          if (extra) this.strokeLayers([this.toScreen(...a), this.toScreen(...b)], [{ w: 2, c: '#ef6b6b', dash: [6, 4] }]);
          text += ` · span ${fmtLen(span)}${extra ? ` > ${fmtLen(maxSpan)}: +${extra} tower${extra > 1 ? 's' : ''}` : ''}`;
        }
        this.label(x + 50, y - 16, null, text, D.infraIcons[LINE_KINDS[this.draft.kind].icon]);
      }
      if (this.cursor && ((m.tool && m.tool !== 'select') || m.placing)) {
        const [x, y] = this.toScreen(...this.cursor);
        ctx.beginPath();
        ctx.arc(x, y, this.snapped ? 7 : 4, 0, Math.PI * 2);
        ctx.strokeStyle = this.snapped ? '#5cc98a' : '#fff';
        ctx.lineWidth = 2;
        ctx.stroke();
      }
    }

    drawBanner() {
      const m = this.model;
      const ctx = this.ctx;
      let text = '';
      if (m.placing) text = 'Click on the map to place the factory · Esc to cancel';
      else if (LINE_KINDS[m.tool]) {
        text = this.draft
          ? `${LINE_KINDS[m.tool].label}: click to add points · double-click or right-click to finish · Backspace undoes a point · Esc cancels`
          : `${LINE_KINDS[m.tool].label}: click to start · points snap to stations, ports and line ends`;
      } else if (STATION_KINDS[m.tool]) text = `${STATION_KINDS[m.tool].label}: click to place · Esc to stop`;
      if (!text) return;
      ctx.font = '600 13px system-ui, sans-serif';
      const tw = ctx.measureText(text).width + 24;
      ctx.fillStyle = 'rgba(243,154,60,0.95)';
      roundRect(ctx, this.w / 2 - tw / 2, this.h - 52, tw, 30, 6);
      ctx.fill();
      ctx.fillStyle = '#1a1d23';
      ctx.fillText(text, this.w / 2 - tw / 2 + 12, this.h - 32);
    }

    label(x, y, item, text, iconName) {
      const ctx = this.ctx;
      ctx.font = '11px system-ui, sans-serif';
      const w = ctx.measureText(text).width + 26;
      ctx.fillStyle = 'rgba(20,22,28,0.9)';
      roundRect(ctx, x - w / 2, y - 9, w, 18, 4);
      ctx.fill();
      const ic = item ? itemIcon(item) : iconName ? iconByName(iconName) : null;
      if (drawable(ic)) ctx.drawImage(ic, x - w / 2 + 3, y - 7, 14, 14);
      ctx.fillStyle = '#e7e9ee';
      ctx.fillText(text, x - w / 2 + 20, y + 4);
    }

    drawScale() {
      const ctx = this.ctx;
      const target = 120 / this.view.k;
      const pow = Math.pow(10, Math.floor(Math.log10(target)));
      const nice = [1, 2, 5, 10].map((v) => v * pow).find((v) => v >= target * 0.6) || pow * 10;
      const px = nice * this.view.k;
      const x = 16;
      const y = this.h - 20;
      ctx.strokeStyle = '#e7e9ee';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(x, y - 5);
      ctx.lineTo(x, y);
      ctx.lineTo(x + px, y);
      ctx.lineTo(x + px, y - 5);
      ctx.stroke();
      ctx.fillStyle = '#e7e9ee';
      ctx.font = '12px system-ui, sans-serif';
      ctx.fillText(nice >= 1000 ? `${nice / 1000} km` : `${nice} m`, x + 4, y - 8);
    }
  }

  function midpointOf(pts) {
    const total = polylineLength(pts);
    let acc = 0;
    for (let i = 1; i < pts.length; i++) {
      const d = Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]);
      if (acc + d >= total / 2) {
        const t = d ? (total / 2 - acc) / d : 0;
        return [pts[i - 1][0] + (pts[i][0] - pts[i - 1][0]) * t, pts[i - 1][1] + (pts[i][1] - pts[i - 1][1]) * t];
      }
      acc += d;
    }
    return pts[0];
  }
  function roundRect(ctx, x, y, w, h, r) {
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
  }
  function segDist(px, py, [ax, ay], [bx, by]) {
    const dx = bx - ax;
    const dy = by - ay;
    const len = dx * dx + dy * dy;
    const t = len ? Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / len)) : 0;
    return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
  }

  window.WorldMap = WorldMap;
  window.MapNodes = { nodes, nodeById, RESOURCE_COLORS, PURITY_COLORS, LINK_STYLES, LINE_KINDS, STATION_KINDS, polylineLength, fmtLen };
})();
