// Layered flow diagram of a solved plan, rendered as SVG with pan/zoom.
(function () {
  'use strict';

  const NS = 'http://www.w3.org/2000/svg';
  const NODE_W = 210;
  const COL_GAP = 120;
  const ROW_GAP = 26;

  const TYPE_COLOR = {
    imp: 'var(--import)',
    sup: 'var(--supply)',
    rec: 'var(--accent)',
    out: 'var(--good)',
    sur: 'var(--muted)',
  };

  function el(tag, attrs, parent) {
    const e = document.createElementNS(NS, tag);
    for (const k in attrs) e.setAttribute(k, attrs[k]);
    if (parent) parent.appendChild(e);
    return e;
  }

  function truncate(s, n) {
    return s.length > n ? s.slice(0, n - 1) + '…' : s;
  }

  function buildNodes(result, fmt, names) {
    const nodes = new Map();
    const add = (id, type, lines, item) => nodes.set(id, { id, type, lines, icon: names.itemIcon(item), ins: [], outs: [] });
    result.imports.forEach((im) =>
      add('imp:' + im.item, 'imp', [names.item(im.item), `${fmt(im.rate)}/min ${im.missing ? '(external)' : 'extracted'}`], im.item));
    result.supplies.forEach((s) => add('sup:' + s.item, 'sup', [names.item(s.item), `${fmt(s.rate)}/min supplied`], s.item));
    result.steps.forEach((s) =>
      add('rec:' + s.recipe.id, 'rec', [
        s.recipe.name.replace(/^Alternate: /, '') + (s.recipe.alt ? ' (alt)' : ''),
        `${fmt(s.count)} × ${names.building(s.recipe.building)}`,
        `${fmt(s.power, 1)} MW`,
      ], s.recipe.out[0][0]));
    result.targets.forEach((t) => add('out:' + t.item, 'out', [names.item(t.item), `${fmt(t.rate)}/min output`], t.item));
    result.surplus.forEach((s) => add('sur:' + s.item, 'sur', [names.item(s.item), `${fmt(s.rate)}/min surplus`], s.item));
    return nodes;
  }

  function layout(nodes, edges) {
    const list = [...nodes.values()];
    // Break cycles with a DFS; back edges are drawn dashed and ignored for layering.
    const state = new Map();
    const visit = (n) => {
      state.set(n, 1);
      for (const e of n.outs) {
        const s = state.get(e.target);
        if (s === 1) e.back = true;
        else if (!s) visit(e.target);
      }
      state.set(n, 2);
    };
    list.filter((n) => !n.ins.length).forEach((n) => !state.get(n) && visit(n));
    list.forEach((n) => !state.get(n) && visit(n));

    // Longest-path layering over forward edges.
    const indeg = new Map(list.map((n) => [n, n.ins.filter((e) => !e.back).length]));
    const queue = list.filter((n) => !indeg.get(n));
    queue.forEach((n) => (n.layer = 0));
    const order = [];
    while (queue.length) {
      const n = queue.shift();
      order.push(n);
      for (const e of n.outs) {
        if (e.back) continue;
        e.target.layer = Math.max(e.target.layer || 0, n.layer + 1);
        indeg.set(e.target, indeg.get(e.target) - 1);
        if (!indeg.get(e.target)) queue.push(e.target);
      }
    }
    // Final outputs in the last column; sources pulled right next to their first consumer.
    const maxRec = Math.max(0, ...list.filter((n) => n.type === 'rec').map((n) => n.layer));
    list.forEach((n) => {
      if (n.type === 'out' || n.type === 'sur') n.layer = maxRec + 1;
    });
    list.forEach((n) => {
      if ((n.type === 'imp' || n.type === 'sup') && n.outs.length) {
        n.layer = Math.max(0, Math.min(...n.outs.map((e) => e.target.layer)) - 1);
      }
    });

    const layers = [];
    list.forEach((n) => (layers[n.layer] = layers[n.layer] || []).push(n));
    for (let i = 0; i < layers.length; i++) layers[i] = layers[i] || [];
    list.forEach((n) => (n.h = Math.max(44, n.lines.length * 17 + 14, Math.max(n.ins.length, n.outs.length) * 14 + 12)));

    // Crossing reduction: barycenter sweeps.
    const setIdx = () => layers.forEach((L) => L.forEach((n, i) => (n.idx = i)));
    setIdx();
    const bary = (n, dir) => {
      const nb = dir > 0 ? n.ins.map((e) => e.source) : n.outs.map((e) => e.target);
      const ok = nb.filter((m) => (dir > 0 ? m.layer < n.layer : m.layer > n.layer));
      return ok.length ? ok.reduce((a, m) => a + m.idx, 0) / ok.length : n.idx;
    };
    for (let it = 0; it < 8; it++) {
      const dir = it % 2 ? -1 : 1;
      const seq = dir > 0 ? layers.map((_, i) => i) : layers.map((_, i) => layers.length - 1 - i);
      for (const li of seq) {
        const L = layers[li];
        L.forEach((n) => (n.b = bary(n, dir)));
        L.sort((a, b) => a.b - b.b);
        L.forEach((n, i) => (n.idx = i));
      }
    }

    // Vertical placement: pull nodes toward neighbours, then remove overlaps.
    layers.forEach((L) => {
      let y = 0;
      L.forEach((n) => {
        n.y = y;
        y += n.h + ROW_GAP;
      });
    });
    const center = (n) => n.y + n.h / 2;
    for (let it = 0; it < 12; it++) {
      const dir = it % 2 ? -1 : 1;
      const seq = dir > 0 ? layers.map((_, i) => i) : layers.map((_, i) => layers.length - 1 - i);
      for (const li of seq) {
        const L = layers[li];
        L.forEach((n) => {
          const nb = [...n.ins.map((e) => e.source), ...n.outs.map((e) => e.target)].filter((m) => m.layer !== n.layer);
          if (nb.length) n.y = nb.reduce((a, m) => a + center(m), 0) / nb.length - n.h / 2;
        });
        // Resolve overlaps keeping order: push down, then pull back up to balance.
        for (let i = 1; i < L.length; i++) L[i].y = Math.max(L[i].y, L[i - 1].y + L[i - 1].h + ROW_GAP);
        for (let i = L.length - 2; i >= 0; i--) {
          const want = L[i].y;
          L[i].y = Math.min(want, L[i + 1].y - L[i].h - ROW_GAP);
        }
      }
    }
    const minY = Math.min(...list.map((n) => n.y));
    list.forEach((n) => {
      n.y -= minY;
      n.x = n.layer * (NODE_W + COL_GAP);
    });

    // Port positions: spread edges along node sides, ordered by the other end's height.
    list.forEach((n) => {
      n.outs.sort((a, b) => center(a.target) - center(b.target));
      n.outs.forEach((e, i) => (e.sy = n.y + ((i + 1) * n.h) / (n.outs.length + 1)));
      n.ins.sort((a, b) => center(a.source) - center(b.source));
      n.ins.forEach((e, i) => (e.ty = n.y + ((i + 1) * n.h) / (n.ins.length + 1)));
    });
    return list;
  }

  function itemColor(name) {
    let h = 0;
    for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) >>> 0;
    return `hsl(${h % 360} 65% 62%)`;
  }

  class FlowGraph {
    constructor(container) {
      this.container = container;
      this.view = { k: 1, x: 0, y: 0 };
      this.svg = el('svg', {});
      this.root = el('g', {}, this.svg);
      container.appendChild(this.svg);
      this.bindPanZoom();
    }

    bindPanZoom() {
      const c = this.container;
      c.addEventListener('wheel', (ev) => {
        ev.preventDefault();
        const r = c.getBoundingClientRect();
        const mx = ev.clientX - r.left;
        const my = ev.clientY - r.top;
        const f = Math.exp(-ev.deltaY * 0.0015);
        const k = Math.min(3, Math.max(0.1, this.view.k * f));
        this.view.x = mx - ((mx - this.view.x) * k) / this.view.k;
        this.view.y = my - ((my - this.view.y) * k) / this.view.k;
        this.view.k = k;
        this.apply();
      }, { passive: false });
      let drag = null;
      c.addEventListener('pointerdown', (ev) => {
        if (ev.button !== 0) return;
        drag = { x: ev.clientX, y: ev.clientY, vx: this.view.x, vy: this.view.y };
        c.setPointerCapture(ev.pointerId);
        c.classList.add('dragging');
      });
      c.addEventListener('pointermove', (ev) => {
        if (!drag) return;
        this.view.x = drag.vx + ev.clientX - drag.x;
        this.view.y = drag.vy + ev.clientY - drag.y;
        this.apply();
      });
      const end = () => {
        drag = null;
        c.classList.remove('dragging');
      };
      c.addEventListener('pointerup', end);
      c.addEventListener('pointercancel', end);
    }

    apply() {
      this.root.setAttribute('transform', `translate(${this.view.x},${this.view.y}) scale(${this.view.k})`);
    }

    fit() {
      if (!this.bounds) return;
      const r = this.container.getBoundingClientRect();
      if (!r.width || !r.height) return;
      const pad = 40;
      const { w, h } = this.bounds;
      // Fit the whole graph, but never shrink text below readability; large graphs start at the left.
      const k = Math.max(0.6, Math.min(1.1, (r.width - pad * 2) / w, (r.height - pad * 2) / h));
      this.view.k = k;
      this.view.x = w * k > r.width - pad * 2 ? pad : (r.width - w * k) / 2;
      this.view.y = h * k > r.height - pad * 2 ? pad : (r.height - h * k) / 2;
      this.apply();
    }

    render(result, fmt, names) {
      this.root.textContent = '';
      this.bounds = null;
      if (!result || result.status !== 'optimal') return;

      const nodes = buildNodes(result, fmt, names);
      const edges = result.flows
        .filter((f) => nodes.has(f.from) && nodes.has(f.to))
        .map((f) => ({ ...f, source: nodes.get(f.from), target: nodes.get(f.to) }));
      edges.forEach((e) => {
        e.source.outs.push(e);
        e.target.ins.push(e);
      });
      const list = layout(nodes, edges);

      const gEdges = el('g', {}, this.root);
      const gLabels = el('g', {}, this.root);
      const gNodes = el('g', {}, this.root);
      let maxY = 0;
      list.forEach((n) => (maxY = Math.max(maxY, n.y + n.h)));

      for (const e of edges) {
        const sx = e.source.x + NODE_W;
        const tx = e.target.x;
        const back = tx <= sx;
        const g = el('g', { class: 'g-edge' + (back ? ' back' : '') }, gEdges);
        const color = itemColor(e.item);
        let d;
        let mid;
        if (back) {
          const low = Math.max(e.source.y + e.source.h, e.target.y + e.target.h) + 50;
          d = `M${sx},${e.sy} C${sx + 90},${e.sy} ${sx + 90},${low} ${sx},${low} L${tx},${low} C${tx - 90},${low} ${tx - 90},${e.ty} ${tx},${e.ty}`;
          mid = [(sx + tx) / 2, low];
          maxY = Math.max(maxY, low);
        } else {
          const dx = Math.max(40, (tx - sx) * 0.5);
          d = `M${sx},${e.sy} C${sx + dx},${e.sy} ${tx - dx},${e.ty} ${tx},${e.ty}`;
          mid = [(sx + tx) / 2, (e.sy + e.ty) / 2];
        }
        el('path', { d, stroke: color }, g);
        el('title', {}, g).textContent = `${names.item(e.item)}: ${fmt(e.rate)}/min`;
        const label = el('g', { class: 'g-label' }, gLabels);
        const text = `${truncate(names.item(e.item), 22)} ${fmt(e.rate)}`;
        const w = text.length * 6.1 + 10;
        el('rect', { x: mid[0] - w / 2, y: mid[1] - 9, width: w, height: 17, rx: 4 }, label);
        const t = el('text', { x: mid[0], y: mid[1] + 3.5, 'text-anchor': 'middle' }, label);
        t.textContent = text;
        e.els = [g, label];
      }

      for (const n of list) {
        const g = el('g', { class: 'g-node', transform: `translate(${n.x},${n.y})` }, gNodes);
        el('rect', { class: 'box', width: NODE_W, height: n.h, rx: 7 }, g);
        el('rect', { class: 'strip', width: 5, height: n.h, rx: 2, fill: TYPE_COLOR[n.type] }, g);
        const top = n.h / 2 - ((n.lines.length - 1) * 17) / 2 + 4;
        const tx = n.icon ? 52 : 14;
        if (n.icon) el('image', { href: n.icon, x: 13, y: n.h / 2 - 16, width: 32, height: 32 }, g);
        n.lines.forEach((line, i) => {
          const t = el('text', { x: tx, y: top + i * 17, class: i ? 's' : 't' }, g);
          t.textContent = truncate(line, i ? 27 : 23);
        });
        el('title', {}, g).textContent = n.lines.join('\n');
        n.el = g;
        g.addEventListener('pointerenter', () => this.highlight(n, true));
        g.addEventListener('pointerleave', () => this.highlight(n, false));
      }

      const w = Math.max(...list.map((n) => n.x + NODE_W), NODE_W);
      this.bounds = { w, h: maxY + 20 };
      this.fit();
    }

    highlight(n, on) {
      this.container.classList.toggle('hovering', on);
      const mark = (x) => x.classList.toggle('hl', on);
      mark(n.el);
      [...n.ins, ...n.outs].forEach((e) => {
        e.els.forEach(mark);
        mark(e.source.el);
        mark(e.target.el);
      });
    }

    setLabels(on) {
      this.container.classList.toggle('no-labels', !on);
    }
  }

  window.FlowGraph = FlowGraph;
})();
