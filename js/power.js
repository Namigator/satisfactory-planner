// Power logic: Power Tower placement along drawn power lines (spans are limited in length), power
// grids (lines connected at shared points or T-junctions, plus the buildings they touch) and their
// balance of generated versus used MW. Pure functions over plain data.
(function () {
  'use strict';

  const D = window.SF_DATA;

  const POWER = {
    item: 'Power_MW', // virtual item produced by generator recipes; rates are MW
    maxSpan: 300, // m between Power Towers (estimate; editable in the map's Power grids card)
    cablePerMeter: 1 / 25, // Cable per meter of power line (estimate)
    attachDist: 1, // m: a line point this close to a building point connects it
    splitDist: 0.6, // m: a line point this close to another line's segment joins it (T-junction)
    geothermal: [100, 200, 400], // average MW of a Geothermal Generator on an impure/normal/pure geyser
  };

  const key = (x, y) => `${Math.round(x * 10)},${Math.round(y * 10)}`;
  const segProject = (p, a, b) => window.Rail.segProject(p, a, b);

  /**
   * Towers along one line. Every point is a tower unless it attaches to a building (isAttached).
   * With line.auto, spans longer than maxSpan get evenly spaced extra towers; otherwise they are
   * reported as too long. Returns { towers: [{x, y, auto}], spans: [{i, len, long}], long }.
   */
  function towers(line, maxSpan, isAttached) {
    const pts = line.points;
    const out = [];
    const spans = [];
    pts.forEach(([x, y]) => {
      if (!(isAttached && isAttached(x, y))) out.push({ x, y, auto: false });
    });
    for (let i = 1; i < pts.length; i++) {
      const [ax, ay] = pts[i - 1];
      const [bx, by] = pts[i];
      const len = Math.hypot(bx - ax, by - ay);
      const extra = Math.max(0, Math.ceil(len / maxSpan - 1e-9) - 1);
      if (line.auto !== false) {
        for (let k = 1; k <= extra; k++) out.push({ x: ax + ((bx - ax) * k) / (extra + 1), y: ay + ((by - ay) * k) / (extra + 1), auto: true });
      }
      spans.push({ i, len, long: line.auto === false && len > maxSpan + 1e-6 });
    }
    return { towers: out, spans, long: spans.filter((s) => s.long).length };
  }

  /** The points of a line with its auto towers inserted as real points. */
  function withAutoTowers(line, maxSpan) {
    const pts = [line.points[0]];
    for (let i = 1; i < line.points.length; i++) {
      const [ax, ay] = line.points[i - 1];
      const [bx, by] = line.points[i];
      const n = Math.max(1, Math.ceil(Math.hypot(bx - ax, by - ay) / maxSpan - 1e-9));
      for (let k = 1; k < n; k++) pts.push([Math.round((ax + ((bx - ax) * k) / n) * 10) / 10, Math.round((ay + ((by - ay) * k) / n) * 10) / 10]);
      pts.push(line.points[i]);
    }
    return pts;
  }

  /**
   * Power grids. lines: drawn infrastructure (only kind 'power' is used). members: buildings that can
   * connect, as { key, x, y, contains?(x, y) }: a member joins a line when a line point lies within
   * attachDist of (x, y) or inside it (contains). Returns
   * { grids: [{ id, lines, members, towers, long, meters }], gridOfLine, gridOfMember, lineTowers }.
   */
  function buildGrids(lines, members, maxSpan) {
    const parent = new Map();
    const find = (a) => {
      while (parent.get(a) !== a) {
        parent.set(a, parent.get(parent.get(a)));
        a = parent.get(a);
      }
      return a;
    };
    const add = (a) => {
      if (!parent.has(a)) parent.set(a, a);
    };
    const union = (a, b) => {
      add(a);
      add(b);
      const ra = find(a);
      const rb = find(b);
      if (ra !== rb) parent.set(ra, rb);
    };

    const power = lines.filter((l) => l.kind === 'power' && l.points.length >= 2);
    const memberAt = (x, y) => members.find((m) => Math.hypot(m.x - x, m.y - y) <= POWER.attachDist || (m.contains && m.contains(x, y)));
    const segs = [];
    power.forEach((l) => {
      const id = 'line:' + l.id;
      add(id);
      l.points.forEach(([x, y], i) => {
        union(id, 'pt:' + key(x, y));
        const m = memberAt(x, y);
        if (m) union(id, 'm:' + m.key);
        if (i) segs.push({ a: l.points[i - 1], b: l.points[i], id });
      });
    });
    // T-junctions: a line point lying on another line's segment.
    power.forEach((l) => l.points.forEach((p) => segs.forEach((s) => {
      if (s.id === 'line:' + l.id) return;
      const pr = segProject(p, s.a, s.b);
      if (pr.d < POWER.splitDist) union('line:' + l.id, s.id);
    })));

    const byRoot = new Map();
    const gridOf = (root) => {
      if (!byRoot.has(root)) byRoot.set(root, { id: byRoot.size + 1, lines: [], members: [], towerKeys: new Set(), long: 0, meters: 0 });
      return byRoot.get(root);
    };
    const gridOfLine = {};
    const gridOfMember = {};
    const lineTowers = {};
    power.forEach((l) => {
      const g = gridOf(find('line:' + l.id));
      g.lines.push(l.id);
      const t = towers(l, maxSpan, (x, y) => !!memberAt(x, y));
      lineTowers[l.id] = t;
      t.towers.forEach((tw) => g.towerKeys.add(key(tw.x, tw.y))); // shared points count once
      g.long += t.long;
      g.meters += t.spans.reduce((a, s) => a + s.len, 0);
      gridOfLine[l.id] = g.id;
    });
    members.forEach((m) => {
      const id = 'm:' + m.key;
      if (!parent.has(id)) return;
      const g = gridOf(find(id));
      g.members.push(m.key);
      gridOfMember[m.key] = g.id;
    });
    const grids = [...byRoot.values()].map((g) => ({ id: g.id, lines: g.lines, members: g.members, towers: g.towerKeys.size, long: g.long, meters: g.meters }));
    return { grids, gridOfLine, gridOfMember, lineTowers };
  }

  /** Sum of generated and used MW over a grid's members; valueOf(key) -> { gen, use }. */
  function balance(grid, valueOf) {
    let gen = 0;
    let use = 0;
    grid.members.forEach((k) => {
      const v = valueOf(k) || {};
      gen += v.gen || 0;
      use += v.use || 0;
    });
    return { gen, use, net: gen - use };
  }

  /** Materials for towers and cable: [[item, amount]]. */
  function billOfMaterials(towerCount, meters) {
    const total = {};
    const addCost = (id, n) => {
      const c = D.buildCosts[id];
      if (c && n > 0) c.cost.forEach(([item, amt]) => (total[item] = (total[item] || 0) + amt * n));
    };
    addCost('Desc_PowerTower_C', towerCount);
    addCost('Desc_PowerLine_C', Math.ceil(meters * POWER.cablePerMeter));
    return Object.entries(total);
  }

  window.Power = { POWER, towers, withAutoTowers, buildGrids, balance, billOfMaterials };
})();
