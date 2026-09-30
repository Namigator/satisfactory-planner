// World map view: places factory buildings on the game map (a factory can be placed several
// times), plans the logistics links between them and resource nodes, and lets the user draw
// infrastructure (conveyors, pipes, hypertubes, railways, truck roads, drone routes, stations,
// power lines and geothermal generators), and checks each power grid's balance.
window.MapView = function (App) {
  'use strict';

  // Append children to a DOM node, flattening arrays and skipping empty values.
  const put = (parent, ...kids) => parent.append(...kids.flat(Infinity).filter((k) => k != null && k !== false));

  const { D, h, $, fmt, itemIcon, named, iconSelect } = App;
  const T = window.Transport;
  const L = window.Layout;
  const P = window.Power;
  const WATER_EXTRACTOR_MW = 20; // power of one Water Extractor at 100% (game knowledge)
  const { nodes, nodeById, LINE_KINDS, STATION_KINDS, polylineLength, fmtLen } = window.MapNodes;
  const side = $('#map-side');
  let map = null;
  let selection = null; // { type: 'factory' (id = placement id) | 'node' | 'link' | 'line' | 'station', id }
  let placing = null; // { fid, pid } — pid null for a new placement
  let tool = 'select';
  let picker = null; // item whose "connect" list is open in the factory panel
  let model = null;
  let power = null; // power grids of the current model (see buildPower)

  const st = () => App.state();
  const factoryById = (id) => st().factories.find((f) => f.id === id);
  const isLiquid = (item) => D.items[item].liquid;
  const uid = () => Math.random().toString(36).slice(2, 9);
  const SIDE_NAMES = { N: 'North', E: 'East', S: 'South', W: 'West' };
  const TRANSPORT_ICON = { belt: 'conveyor', pipe: 'pipe', train: 'locomotive', truck: 'truckStation', drone: 'drone' };
  const trains = window.TrainView(App, { commit: () => commit(), refresh: () => refresh(), select: (s) => select(s), map: () => map });

  // ---------- Placements ----------
  /** Every placed copy of every factory: { f, p, index, label }. */
  function instances() {
    const out = [];
    st().factories.forEach((f) => (f.placements || []).forEach((p, i) => out.push({ f, p, index: i, label: instanceLabel(f, i) })));
    return out;
  }
  const instanceLabel = (f, i) => ((f.placements || []).length > 1 ? `${f.name} #${i + 1}` : f.name);
  function instanceById(pid) {
    for (const f of st().factories) {
      const i = (f.placements || []).findIndex((p) => p.id === pid);
      if (i >= 0) return { f, p: f.placements[i], index: i, label: instanceLabel(f, i) };
    }
    return null;
  }

  // ---------- Derived data ----------
  let geoCache = new Map();

  /** Building geometry: size, shape cells (all floors) and ports in floor-plan coordinates. */
  function building(f) {
    if (geoCache.has(f.id)) return geoCache.get(f.id);
    const r = App.resultFor(f);
    let b = { w: 16, h: 16, floors: 1, cells: [[0, 0], [1, 0], [0, 1], [1, 1]], ports: [] };
    if (r && r.status === 'optimal') {
      f.layout = L.reconcile(f.layout, r);
      const g = L.compute(f.layout, r);
      b = {
        w: g.w, h: g.h, floors: g.floors,
        cells: g.union.map((k) => k.split(',').map(Number)),
        ports: L.ioPorts(g, r, portSides(f)).map((p) => ({ item: p.item, dir: p.dir, side: p.side, x: p.x, y: p.y })),
      };
    }
    geoCache.set(f.id, b);
    return b;
  }
  // Floor plan coordinates -> world coordinates for one placement (position + rotation).
  function toWorld(p, b, lx, ly) {
    const a = ((p.rot || 0) * Math.PI) / 180;
    const x = lx - b.w / 2;
    const y = ly - b.h / 2;
    return [p.x + x * Math.cos(a) - y * Math.sin(a), p.y + x * Math.sin(a) + y * Math.cos(a)];
  }
  function portWorld(inst, dir, item) {
    const b = building(inst.f);
    const port = b.ports.find((x) => x.dir === dir && x.item === item);
    return port ? toWorld(inst.p, b, port.x, port.y) : [inst.p.x, inst.p.y];
  }

  /**
   * Which wall each item enters/leaves by: the user's choice, otherwise the wall facing the
   * first link's other end (or its nearest bend) as seen from that placement, otherwise W/E.
   */
  function portSides(f) {
    const res = { in: {}, out: {}, auto: { in: {}, out: {} } };
    const over = f.portSides || { in: {}, out: {} };
    st().links.forEach((l) => {
      const dir = l.to.type === 'factory' && l.to.id === f.id ? 'in' : l.from.type === 'factory' && l.from.id === f.id ? 'out' : null;
      if (!dir || res.auto[dir][l.item]) return;
      const inst = instanceById(dir === 'in' ? l.to.inst : l.from.inst);
      if (!inst) return;
      const via = l.via || [];
      const target = via.length ? (dir === 'in' ? via[via.length - 1] : via[0]) : centerPos(dir === 'in' ? l.from : l.to);
      if (!target) return;
      const a = ((inst.p.rot || 0) * Math.PI) / 180;
      const dx = target[0] - inst.p.x;
      const dy = target[1] - inst.p.y;
      const lx = dx * Math.cos(a) + dy * Math.sin(a);
      const ly = -dx * Math.sin(a) + dy * Math.cos(a);
      res.auto[dir][l.item] = Math.abs(lx) >= Math.abs(ly) ? (lx > 0 ? 'E' : 'W') : ly > 0 ? 'S' : 'N';
    });
    ['in', 'out'].forEach((dir) => Object.assign(res[dir], res.auto[dir], over[dir] || {}));
    return res;
  }

  /** Wall picker for one port; onChange is called after the choice is saved. */
  function sideSelect(f, dir, item, onChange) {
    const sides = portSides(f);
    const pinned = f.layout && f.layout.portPos && f.layout.portPos[dir + ':' + item];
    const current = pinned ? pinned.side : (f.portSides && f.portSides[dir] && f.portSides[dir][item]) || 'auto';
    const auto = sides.auto[dir][item] || (dir === 'in' ? 'W' : 'E');
    return h('select', {
      class: 'side-select',
      title: 'Wall this item enters or leaves by (North = top of the floor plan)',
      onchange: (ev) => {
        f.portSides = f.portSides || { in: {}, out: {} };
        f.portSides[dir] = f.portSides[dir] || {};
        if (ev.target.value === 'auto') delete f.portSides[dir][item];
        else f.portSides[dir][item] = ev.target.value;
        if (f.layout && f.layout.portPos) delete f.layout.portPos[dir + ':' + item];
        App.layoutChanged();
        if (onChange) onChange();
      },
    }, h('option', { value: 'auto', selected: current === 'auto' }, `Auto (${auto})`),
    ['N', 'E', 'S', 'W'].map((sd) => h('option', { value: sd, selected: current === sd }, `${SIDE_NAMES[sd]} wall`)));
  }

  /** Items a factory needs delivered (raw resources and available inputs it uses), per copy. */
  function needs(f) {
    const r = App.resultFor(f);
    const out = {};
    if (!r || r.status !== 'optimal') return out;
    r.imports.forEach((x) => (out[x.item] = (out[x.item] || 0) + x.rate));
    r.supplies.forEach((x) => (out[x.item] = (out[x.item] || 0) + x.rate));
    return belted(out);
  }
  /** Items a factory ships out (products and surplus), per copy. */
  function provides(f) {
    const r = App.resultFor(f);
    const out = {};
    if (!r || r.status !== 'optimal') return out;
    r.targets.forEach((x) => (out[x.item] = (out[x.item] || 0) + x.rate));
    r.surplus.forEach((x) => (out[x.item] = (out[x.item] || 0) + x.rate));
    return belted(out);
  }
  // Power reaches a building over power lines, never over links.
  function belted(rates) {
    for (const item in rates) if (D.items[item].virtual) delete rates[item];
    return rates;
  }
  const isInst = (ep, pid) => ep.type === 'factory' && ep.inst === pid;
  const nodeLinks = (nodeId) => st().links.filter((l) => l.from.type === 'node' && l.from.id === nodeId);
  /** One extractor serves every link from a node, so plan it for their total draw. */
  function nodePlan(n) {
    const links = nodeLinks(n.id);
    const total = links.reduce((a, l) => a + l.rate, 0);
    return { ...T.extractionPlan(n, total, isLiquid(n.item), st().nodeMiners[n.id]), links };
  }
  function planText(n, plan) {
    const c = plan.chosen;
    if (!c.ok) return `${c.name} would need ${fmt(c.clock * 100, 0)}% (over 250%)`;
    if (n.kind === 'well') return `Resource Well Pressurizer at ${fmt(c.clock * 100, 2)}% (satellites at ${fmt(c.base)}/min base → ${fmt(plan.rate)}/min here)`;
    return `${c.name} at ${fmt(c.clock * 100, 2)}%`;
  }
  const incoming = (pid, item) => st().links.filter((l) => isInst(l.to, pid) && l.item === item).reduce((a, l) => a + l.rate, 0);
  const outgoing = (pid, item) => st().links.filter((l) => isInst(l.from, pid) && l.item === item).reduce((a, l) => a + l.rate, 0);

  function centerPos(ep) {
    if (ep.type === 'node') {
      const n = nodeById[ep.id];
      return n ? [n.x, n.y] : null;
    }
    if (ep.type === 'factory') {
      const inst = instanceById(ep.inst);
      return inst ? [inst.p.x, inst.p.y] : null;
    }
    return null;
  }
  // Where a link attaches: a building's wall port for the item, a node, or nothing (on-site).
  function endpointPos(ep, dir, item) {
    if (ep.type === 'factory') {
      const inst = instanceById(ep.inst);
      return inst ? portWorld(inst, dir, item) : null;
    }
    return centerPos(ep);
  }
  function endpointName(ep) {
    if (ep.type === 'node') {
      const n = nodeById[ep.id];
      return n ? `${T.PURITY_NAME[n.purity]} ${D.items[n.item].name} ${n.kind === 'well' ? 'well' : 'node'}` : 'Missing node';
    }
    if (ep.type === 'factory') {
      const inst = instanceById(ep.inst);
      return inst ? inst.label : 'Removed building';
    }
    return 'On-site water extractors';
  }

  function linkInfo(l) {
    const a = endpointPos(l.from, 'out', l.item);
    const b = endpointPos(l.to, 'in', l.item);
    const pts = a && b ? [a, ...(l.via || []), b] : [];
    const distance = pts.length ? polylineLength(pts) : 0;
    const item = D.items[l.item];
    const info = l.from.type === 'local' ? { lines: [], warn: [], summary: 'on site' } : T.describe(l.transport, l.rate, distance, item);
    const extraction = [];
    if (l.from.type === 'node') {
      const n = nodeById[l.from.id];
      if (n) {
        const plan = nodePlan(n);
        const c = plan.chosen;
        const shared = plan.links.length > 1 ? ` (node total ${fmt(plan.rate)}/min for ${plan.links.length} links)` : '';
        extraction.push(`${planText(n, plan)} on a ${T.PURITY_NAME[n.purity].toLowerCase()} ${n.kind === 'well' ? 'satellite node' : 'node'}${shared}`);
        if (c.ok && c.shards) extraction.push(`Needs ${c.shards} Power Shard${c.shards > 1 ? 's' : ''} · ≈ ${fmt(c.power, 1)} MW`);
        else if (c.ok) extraction.push(`≈ ${fmt(c.power, 1)} MW`);
        if (!c.ok) {
          info.warn.push(plan.recommended
            ? `${c.name} can give at most ${fmt(c.max)}/min here; ${plan.recommended.name} would work.`
            : `This node gives at most ${fmt(plan.max)}/min${plan.max < c.base * T.MAX_CLOCK ? ' (one belt/pipe)' : ' (250% clock)'}. Split across more nodes.`);
        }
      }
    }
    if (l.from.type === 'local') {
      const n = Math.ceil(l.rate / T.WATER_EXTRACTOR - 1e-9);
      extraction.push(`${n} Water Extractor${n > 1 ? 's' : ''} at 100% (${T.WATER_EXTRACTOR} m³/min each)`);
    }
    if (l.from.type === 'factory') {
      const inst = instanceById(l.from.inst);
      if (inst) {
        const avail = provides(inst.f)[l.item] || 0;
        const out = outgoing(inst.p.id, l.item);
        if (out > avail + 1e-6) info.warn.push(`${inst.label} only produces ${fmt(avail)}/min of this (${fmt(out)} allocated).`);
      }
    }
    return { a, b, distance, info, extraction };
  }

  function buildModel() {
    geoCache = new Map();
    const insts = instances().map(({ f, p, label }) => {
      const b = building(f);
      const need = needs(f);
      const t = f.targets.find((x) => x.item);
      return {
        key: p.id, fid: f.id, name: label, x: p.x, y: p.y, rot: p.rot || 0, w: b.w, h: b.h,
        cells: b.cells, cellSet: new Set(b.cells.map((c) => c.join(','))),
        icon: f.kind === 'power' ? App.S.POWER_ITEM : t ? t.item : null,
        warn: Object.keys(need).some((i) => incoming(p.id, i) < need[i] - 1e-6),
        ports: b.ports.map((q) => {
          const [x, y] = toWorld(p, b, q.x, q.y);
          return { item: q.item, dir: q.dir, x, y };
        }),
      };
    });
    const links = st().links.map((l) => {
      const li = linkInfo(l);
      return { id: l.id, item: l.item, rate: l.rate, transport: l.transport, a: li.a, b: li.b, via: l.via || [],
        rateText: `${fmt(l.rate)}/min`, summary: li.info.summary, warn: li.info.warn.length > 0 };
    });
    const usedNodes = new Set(st().links.filter((l) => l.from.type === 'node').map((l) => l.from.id));
    st().infra.stations.forEach((s) => {
      const g = s.kind === 'geothermal' && geyserAt(s.x, s.y);
      if (g) usedNodes.add(g.id);
    });
    const filters = st().mapFilters;
    power = buildPower(insts);
    model = {
      instances: insts, links, lines: st().infra.lines, stations: st().infra.stations, highlight: trains.highlight(),
      selection, placing, tool, usedNodes, hiddenItems: new Set(filters.hidden), minPurity: filters.minPurity,
      power: { maxSpan: maxSpan(), lines: power.lineTowers },
    };
  }

  // ---------- Power grids ----------
  const maxSpan = () => st().powerSettings.maxSpan;
  const GEYSER_SNAP = 30; // m: a geothermal generator this close to a geyser sits on it
  function geyserAt(x, y) {
    let best = null;
    nodes.forEach((n) => {
      const d = Math.hypot(n.x - x, n.y - y);
      if (n.kind === 'geyser' && d <= GEYSER_SNAP && (!best || d < best.d)) best = { n, d };
    });
    return best && best.n;
  }
  /** MW generated and used by each building that power lines can reach, keyed like the grid members. */
  function powerMembers(insts) {
    const members = [];
    const value = {};
    insts.forEach((m) => {
      const inst = instanceById(m.key);
      const r = App.resultFor(inst.f);
      const ok = r && r.status === 'optimal';
      // On-site water extractors feeding this building run on its grid.
      const water = st().links.filter((l) => l.from.type === 'local' && isInst(l.to, m.key)).reduce((a, l) => a + Math.ceil(l.rate / T.WATER_EXTRACTOR - 1e-9), 0);
      const key = 'f:' + m.key;
      value[key] = { gen: ok ? r.generated : 0, use: (ok ? r.power : 0) + water * WATER_EXTRACTOR_MW, name: m.name, sel: { type: 'factory', id: m.key } };
      const a = (-(m.rot || 0) * Math.PI) / 180;
      members.push({ key, x: m.x, y: m.y, contains: (x, y) => {
        if (m.ports.some((q) => Math.hypot(q.x - x, q.y - y) <= 1)) return true;
        const dx = x - m.x;
        const dy = y - m.y;
        const lx = dx * Math.cos(a) - dy * Math.sin(a) + m.w / 2;
        const ly = dx * Math.sin(a) + dy * Math.cos(a) + m.h / 2;
        return m.cellSet.has(Math.floor(lx / 8) + ',' + Math.floor(ly / 8));
      } });
    });
    st().infra.stations.filter((s) => s.kind === 'geothermal').forEach((s) => {
      const g = geyserAt(s.x, s.y);
      const key = 's:' + s.id;
      value[key] = { gen: g ? P.POWER.geothermal[g.purity] : 0, use: 0, name: s.name || 'Geothermal generator', sel: { type: 'station', id: s.id } };
      members.push({ key, x: s.x, y: s.y });
    });
    // Extractors: one per node (one pressurizer per resource well), powered where a line reaches the node.
    const seenWells = new Set();
    new Set(st().links.filter((l) => l.from.type === 'node').map((l) => l.from.id)).forEach((id) => {
      const n = nodeById[id];
      if (!n) return;
      const plan = nodePlan(n);
      const well = n.kind === 'well' && n.core;
      const key = 'n:' + n.id;
      value[key] = { gen: 0, use: plan.chosen.ok && !(well && seenWells.has(well)) ? plan.chosen.power : 0, name: `${plan.chosen.name} (${D.items[n.item].name})`, sel: { type: 'node', id: n.id } };
      if (well) seenWells.add(well);
      members.push({ key, x: n.x, y: n.y });
    });
    return { members, value };
  }
  function buildPower(insts) {
    const { members, value } = powerMembers(insts);
    const g = P.buildGrids(st().infra.lines, members, maxSpan());
    g.grids.forEach((grid) => (grid.balance = P.balance(grid, (k) => value[k])));
    return { ...g, value };
  }
  const gridById = (id) => power.grids.find((g) => g.id === id);
  function gridBadge(grid) {
    const b = grid.balance;
    const cls = !grid.members.length ? 'missing' : b.net >= -1e-6 ? 'ok' : 'missing';
    return h('span', { class: 'status-pill ' + cls, title: `${fmt(b.gen, 1)} MW generated, ${fmt(b.use, 1)} MW used` }, `${b.net >= 0 ? '+' : ''}${fmt(b.net, 1)} MW`);
  }
  function gridCard(grid, title) {
    const b = grid.balance;
    const rows = grid.members.map((k) => {
      const v = power.value[k];
      return h('button', { class: 'link-item', onclick: () => select(v.sel) },
        h('span', { class: 'grid-kind' }, k[0] === 'f' ? '▣' : k[0] === 's' ? '⚡' : '⛏'), h('span', {}, v.name),
        h('span', { class: 'num' + (v.gen ? ' gen' : '') }, v.gen ? `+${fmt(v.gen, 1)}` : v.use ? `−${fmt(v.use, 1)}` : '0'), h('span', {}));
    });
    const mats = P.billOfMaterials(grid.towers, grid.meters);
    return h('section', { class: 'fp-card' },
      h('div', { class: 'panel-head' }, h('h3', {}, title || `Power grid ${grid.id}`), gridBadge(grid)),
      h('div', { class: 'kv' },
        h('span', {}, 'Generated'), h('span', { class: 'num' }, `${fmt(b.gen, 1)} MW`),
        h('span', {}, 'Used'), h('span', { class: 'num' }, `${fmt(b.use, 1)} MW`),
        h('span', {}, 'Power lines'), h('span', { class: 'num' }, `${grid.lines.length} · ${fmtLen(grid.meters)} · ${grid.towers} tower${grid.towers === 1 ? '' : 's'}`),
        mats.length ? [h('span', {}, 'Materials'), h('span', { class: 'chips' }, mats.map(([i, q]) => h('span', { class: 'chip' }, itemIcon(i, 16), D.items[i] ? D.items[i].name : i, h('span', { class: 'num' }, fmt(Math.ceil(q), 0)))))] : null),
      b.net < -1e-6 ? h('p', { class: 'fp-warn' }, `Short by ${fmt(-b.net, 1)} MW: machines on this grid will stop. Add generators or connect a power plant.`) : null,
      grid.long ? h('p', { class: 'fp-warn' }, `${grid.long} span${grid.long > 1 ? 's are' : ' is'} longer than ${fmtLen(maxSpan())}. Add points there or turn on auto-placed towers.`) : null,
      rows.length ? [h('h4', {}, 'Connected'), rows] : h('p', { class: 'sub' }, 'Nothing connected yet. End a power line on a building, a geothermal generator or a resource node you extract from.'));
  }

  // ---------- Mutations ----------
  function commit() {
    App.save();
    refresh();
  }
  function select(sel) {
    selection = sel;
    picker = null;
    refresh();
  }
  function addLink(from, to, item, rate) {
    const l = { id: uid(), from, to, item, rate: Math.max(0, Math.round(rate * 1000) / 1000), transport: isLiquid(item) ? 'pipe' : 'belt', miner: 3, via: [] };
    st().links.push(l);
    selection = { type: 'link', id: l.id };
    picker = null;
    commit();
  }
  function removeLink(id) {
    st().links = st().links.filter((l) => l.id !== id);
    selection = null;
    commit();
  }
  function removePlacement(inst) {
    inst.f.placements = inst.f.placements.filter((p) => p !== inst.p);
    st().links = st().links.filter((l) => !isInst(l.to, inst.p.id) && !isInst(l.from, inst.p.id));
    selection = null;
    commit();
  }
  function startPlacing(fid, pid) {
    placing = { fid, pid: pid || null };
    setTool('select');
    refresh();
  }
  function setTool(t) {
    tool = t;
    if (map) map.cancelDraft();
    document.querySelectorAll('#map-tools button').forEach((b) => b.classList.toggle('active', b.dataset.tool === tool));
    refresh();
  }
  function removeInfra(type, id) {
    const infra = st().infra;
    if (type === 'station') trains.stationRemoved(id);
    if (type === 'line') infra.lines = infra.lines.filter((l) => l.id !== id);
    else infra.stations = infra.stations.filter((s) => s.id !== id);
    selection = null;
    commit();
  }

  // ---------- Side panel ----------
  function back() {
    return h('button', { class: 'btn ghost small', onclick: () => select(null) }, '← Overview');
  }

  function renderSide() {
    side.textContent = '';
    const trainStationSelected = selection && selection.type === 'station' &&
      (st().infra.stations.find((s) => s.id === selection.id) || {}).kind === 'trainStation';
    side.classList.toggle('wide', trains.active() || trainStationSelected);
    if (trains.active()) {
      trains.renderPlanner(side);
      return;
    }
    const sel = selection;
    const inst = sel && sel.type === 'factory' ? instanceById(sel.id) : null;
    if (inst) renderFactory(inst);
    else if (sel && sel.type === 'node' && nodeById[sel.id]) renderNode(nodeById[sel.id]);
    else if (sel && sel.type === 'link' && st().links.find((l) => l.id === sel.id)) renderLink(st().links.find((l) => l.id === sel.id));
    else if (sel && sel.type === 'line' && st().infra.lines.find((l) => l.id === sel.id)) renderLine(st().infra.lines.find((l) => l.id === sel.id));
    else if (sel && sel.type === 'station' && st().infra.stations.find((s) => s.id === sel.id)) renderStation(st().infra.stations.find((s) => s.id === sel.id));
    else renderOverview();
  }

  function statusBadge(got, need) {
    const cls = got >= need - 1e-6 ? 'ok' : got > 0 ? 'partial' : 'missing';
    return h('span', { class: 'status-pill ' + cls }, `${fmt(got)} / ${fmt(need)}`);
  }

  function renderOverview() {
    const s = st();
    const factories = s.factories.map((f) => {
      const t = f.targets.find((x) => x.item);
      const list = (f.placements || []).map((p, i) => {
        const need = needs(f);
        const items = Object.keys(need);
        const done = items.filter((it) => incoming(p.id, it) >= need[it] - 1e-6).length;
        return h('button', { class: 'inst-row', onclick: () => {
          map.centerOn(p.x, p.y, Math.max(map.view.k, 0.6));
          select({ type: 'factory', id: p.id });
        } }, h('span', {}, f.placements.length > 1 ? `#${i + 1}` : 'Placed'), h('span', { class: 'sub' }, `${done}/${items.length} inputs linked`));
      });
      return h('div', { class: 'map-factory' },
        h('div', { class: 'map-row' },
          h('span', { class: 'named strong' }, f.kind === 'power' ? itemIcon(App.S.POWER_ITEM, 20) : t ? itemIcon(t.item, 20) : null, f.name),
          h('span', { class: 'sub' }, (f.placements || []).length ? `${f.placements.length}× placed` : 'not placed'),
          h('button', { class: 'btn small', title: 'Place a copy of this factory on the map', onclick: () => startPlacing(f.id) }, (f.placements || []).length ? '+ Copy' : 'Place')),
        list);
    });

    const counts = {};
    nodes.forEach((n) => (counts[n.item] = (counts[n.item] || 0) + 1));
    const hidden = new Set(s.mapFilters.hidden);
    const layers = Object.keys(counts)
      .sort((a, b) => D.items[a].name.localeCompare(D.items[b].name))
      .map((item) => h('label', { class: 'layer' },
        h('input', { type: 'checkbox', checked: !hidden.has(item), onchange: (ev) => {
          const set = new Set(s.mapFilters.hidden);
          if (ev.target.checked) set.delete(item);
          else set.add(item);
          s.mapFilters.hidden = [...set];
          commit();
        } }),
        itemIcon(item, 18), h('span', {}, D.items[item].name), h('span', { class: 'sub num' }, counts[item])));
    const purity = h('select', { onchange: (ev) => {
      s.mapFilters.minPurity = Number(ev.target.value);
      commit();
    } }, ['All purities', 'Normal and pure', 'Pure only'].map((t, i) => h('option', { value: i, selected: s.mapFilters.minPurity === i }, t)));

    // Infrastructure totals.
    const totals = {};
    s.infra.lines.forEach((l) => (totals[l.kind] = (totals[l.kind] || 0) + polylineLength(l.points)));
    const stationCounts = {};
    s.infra.stations.forEach((x) => (stationCounts[x.kind] = (stationCounts[x.kind] || 0) + 1));
    const infraRows = [
      ...Object.keys(LINE_KINDS).filter((k) => totals[k]).map((k) =>
        h('div', { class: 'fp-lane-row' }, named(infraIconEl(LINE_KINDS[k].icon), LINE_KINDS[k].label),
          h('span', { class: 'num' }, fmtLen(totals[k])), h('span', { class: 'badge' }, `${s.infra.lines.filter((l) => l.kind === k).length}`))),
      ...Object.keys(STATION_KINDS).filter((k) => stationCounts[k]).map((k) =>
        h('div', { class: 'fp-lane-row' }, named(infraIconEl(STATION_KINDS[k].icon), STATION_KINDS[k].label),
          h('span', { class: 'num' }, `${stationCounts[k]}×`), h('span', {}))),
    ];
    const infraList = [...s.infra.stations.filter((x) => x.name), ...s.infra.lines.filter((l) => l.name)].map((x) =>
      h('button', { class: 'link-item', onclick: () => {
        const p = x.points ? x.points[0] : [x.x, x.y];
        map.centerOn(p[0], p[1], Math.max(map.view.k, 0.4));
        select({ type: x.points ? 'line' : 'station', id: x.id });
      } }, infraIconEl(x.points ? LINE_KINDS[x.kind].icon : STATION_KINDS[x.kind].icon), h('span', {}, x.name), h('span', { class: 'sub' }, x.points ? fmtLen(polylineLength(x.points)) : ''), h('span', {})));

    const span = h('input', { type: 'number', class: 'num', min: 10, step: 10, value: maxSpan(), title: 'Longest span between two Power Towers', onchange: (ev) => {
      s.powerSettings.maxSpan = Math.max(10, Number(ev.target.value) || P.POWER.maxSpan);
      commit();
    } });
    const offGrid = instances().filter((i) => {
      const v = power.value['f:' + i.p.id];
      return v && (v.use > 0 || v.gen > 0) && !power.gridOfMember['f:' + i.p.id];
    });
    const gridRows = power.grids.map((g) => h('button', { class: 'link-item', onclick: () => {
      const l = s.infra.lines.find((x) => x.id === g.lines[0]);
      if (l) map.centerOn(l.points[0][0], l.points[0][1], Math.max(map.view.k, 0.3));
      select({ type: 'line', id: g.lines[0] });
    } }, h('span', { class: 'grid-kind' }, '⚡'), h('span', {}, `Grid ${g.id}`), h('span', { class: 'sub' }, `${g.members.length} connected · ${fmt(g.balance.gen, 0)}/${fmt(g.balance.use, 0)} MW`), gridBadge(g)));
    const powerCard = h('section', { class: 'fp-card' }, h('h3', {}, 'Power grids'),
      gridRows.length ? gridRows : h('p', { class: 'sub' }, 'No power lines yet. Draw them with the Power tool, from a power plant to the buildings it feeds.'),
      offGrid.length ? h('p', { class: 'fp-warn' }, `Not on any grid: ${offGrid.map((i) => i.label).join(', ')}`) : null,
      h('div', { class: 'kv' }, h('span', {}, 'Max span (m)'), span),
      h('p', { class: 'hint' }, 'Power Towers can only be this far apart. Longer spans get extra towers automatically, unless you turn that off on the line.'));

    put(side,
      h('section', { class: 'fp-card' }, h('h3', {}, 'Factories'), factories,
        h('p', { class: 'hint' }, 'Each placement is a separate building with its own links. Select one, then drag it to move it.')),
      powerCard,
      h('section', { class: 'fp-card' }, h('h3', {}, 'Infrastructure'),
        infraRows.length ? infraRows : h('p', { class: 'sub' }, 'Nothing drawn yet. Use the tools at the top of the map.'),
        infraList.length ? [h('h4', {}, 'Named'), infraList] : null),
      h('section', { class: 'fp-card' }, h('div', { class: 'panel-head' }, h('h3', {}, 'Resource nodes'), purity),
        h('div', { class: 'layer-actions' },
          h('button', { class: 'link', onclick: () => { s.mapFilters.hidden = []; commit(); } }, 'Show all'), ' · ',
          h('button', { class: 'link', onclick: () => { s.mapFilters.hidden = Object.keys(counts); commit(); } }, 'Hide all')),
        h('div', { class: 'layers' }, layers),
        h('div', { class: 'legend-row' }, 'Ring color: ', h('span', { style: 'color:var(--bad)' }, 'impure'), ' · ', h('span', { style: 'color:var(--warn)' }, 'normal'), ' · ', h('span', { style: 'color:var(--good)' }, 'pure'))),
      h('section', { class: 'fp-card' }, h('h3', {}, 'Planned links'),
        Object.entries(T.TRANSPORTS).map(([k, name]) => h('div', { class: 'legend-row' }, h('span', { class: 'legend-line ' + k }), name)),
        h('p', { class: 'sub' }, `${s.links.length} link${s.links.length === 1 ? '' : 's'} planned.`)));
  }

  function infraIconEl(key, size) {
    return h('img', { class: 'icon', src: `img/icons/${D.infraIcons[key]}.png`, width: size || 18, height: size || 18, alt: '' });
  }

  function linkRow(l, dir) {
    const other = dir === 'in' ? endpointName(l.from) : endpointName(l.to);
    const li = linkInfo(l);
    return h('button', { class: 'link-item', onclick: () => select({ type: 'link', id: l.id }) },
      h('span', { class: 'legend-line ' + (l.from.type === 'local' ? 'local' : l.transport) }),
      h('span', {}, `${dir === 'in' ? 'from' : 'to'} ${other}`),
      h('span', { class: 'num' }, fmt(l.rate)),
      li.info.warn.length ? h('span', { class: 'warn-dot', title: li.info.warn.join('\n') }, '!') : null);
  }

  function candidates(inst, item, remaining) {
    const out = [];
    const here = inst.p;
    instances().forEach((o) => {
      if (o.f.id === inst.f.id) return;
      const total = provides(o.f)[item] || 0;
      if (total <= 0) return;
      const avail = total - outgoing(o.p.id, item);
      const dist = Math.hypot(here.x - o.p.x, here.y - o.p.y);
      out.push(h('button', { class: 'cand', onclick: () => addLink({ type: 'factory', id: o.f.id, inst: o.p.id }, { type: 'factory', id: inst.f.id, inst: here.id }, item, Math.min(remaining, Math.max(0, avail)) || remaining) },
        h('span', {}, o.label), h('span', { class: 'sub' }, `${fmt(Math.max(0, avail))}/min free · ${fmtLen(dist)}`)));
    });
    if (item === 'Desc_Water_C') {
      out.push(h('button', { class: 'cand', onclick: () => addLink({ type: 'local' }, { type: 'factory', id: inst.f.id, inst: here.id }, item, remaining) },
        h('span', {}, 'On-site water extractors'), h('span', { class: 'sub' }, `${Math.ceil(remaining / T.WATER_EXTRACTOR - 1e-9)} × 120 m³/min`)));
    }
    const used = new Set(st().links.filter((l) => l.from.type === 'node').map((l) => l.from.id));
    nodes
      .filter((n) => n.item === item)
      .map((n) => ({ n, d: Math.hypot(n.x - here.x, n.y - here.y) }))
      .sort((a, b) => a.d - b.d)
      .slice(0, 8)
      .forEach(({ n, d }) => {
        const max = T.nodeMaxRate(n, 3, isLiquid(item));
        out.push(h('button', { class: 'cand' + (used.has(n.id) ? ' used' : ''),
          onmouseenter: () => { model.selection = { type: 'node', id: n.id }; map.requestDraw(); },
          onmouseleave: () => { model.selection = selection; map.requestDraw(); },
          onclick: () => addLink({ type: 'node', id: n.id }, { type: 'factory', id: inst.f.id, inst: here.id }, item, Math.min(remaining, max)) },
          h('span', { class: 'named' }, h('span', { class: 'purity p' + n.purity }), `${T.PURITY_NAME[n.purity]} ${n.kind === 'well' ? 'well node' : 'node'}`),
          h('span', { class: 'sub' }, `${fmtLen(d)} · up to ${fmt(max)}/min${used.has(n.id) ? ' · in use' : ''}`)));
      });
    if (!out.length) out.push(h('p', { class: 'sub' }, 'Nothing produces this. Add it as a product of another factory and place that factory.'));
    return out;
  }

  function numInput(value, onchange, step) {
    return h('input', { type: 'number', class: 'num', value: Math.round(value), step: step || 1, onchange: (ev) => onchange(Number(ev.target.value) || 0) });
  }

  function renderFactory(inst) {
    const { f, p } = inst;
    const b = building(f);
    const need = needs(f);
    const prov = provides(f);
    const s = st();
    const title = h('h3', { class: 'editable', title: 'Click to rename the factory (all copies)' }, f.name);
    title.addEventListener('click', () => App.renameInline(title, f));

    const inputs = Object.keys(need).map((item) => {
      const got = incoming(p.id, item);
      const remaining = Math.max(0, need[item] - got);
      const open = picker === item;
      return h('div', { class: 'io-block' },
        h('div', { class: 'io-head' },
          named(itemIcon(item, 20), D.items[item].name), statusBadge(got, need[item]),
          h('button', { class: 'btn small' + (open ? ' primary' : ''), onclick: () => { picker = open ? null : item; renderSide(); } }, open ? 'Close' : '+ Link')),
        h('div', { class: 'io-side' }, 'Enters by', sideSelect(f, 'in', item, refresh)),
        s.links.filter((l) => isInst(l.to, p.id) && l.item === item).map((l) => linkRow(l, 'in')),
        open ? h('div', { class: 'cands' }, candidates(inst, item, remaining || need[item])) : null);
    });
    const outputs = Object.keys(prov).map((item) =>
      h('div', { class: 'io-block' },
        h('div', { class: 'io-head' }, named(itemIcon(item, 20), D.items[item].name),
          h('span', { class: 'sub num' }, `${fmt(outgoing(p.id, item))} / ${fmt(prov[item])} shipped`)),
        h('div', { class: 'io-side' }, 'Leaves by', sideSelect(f, 'out', item, refresh)),
        s.links.filter((l) => isInst(l.from, p.id) && l.item === item).map((l) => linkRow(l, 'out'))));

    put(side,
      back(),
      h('section', { class: 'fp-card' },
        title,
        f.placements.length > 1 ? h('p', { class: 'sub' }, `Copy ${inst.index + 1} of ${f.placements.length}. Every copy is an identical building.`) : null,
        h('div', { class: 'kv' },
          h('span', {}, 'Position (m)'),
          h('span', { class: 'xy' }, numInput(p.x, (v) => { p.x = v; commit(); }), numInput(p.y, (v) => { p.y = v; commit(); })),
          h('span', {}, 'Rotation'),
          h('span', { class: 'xy' },
            numInput(p.rot || 0, (v) => { p.rot = ((v % 360) + 360) % 360; commit(); }, 15),
            h('button', { class: 'btn small', title: 'Rotate 90°', onclick: () => { p.rot = ((p.rot || 0) + 90) % 360; commit(); } }, '⟳ 90°')),
          h('span', {}, 'Footprint'), h('span', { class: 'num' }, `${b.w} × ${b.h} m · ${b.floors} floor${b.floors > 1 ? 's' : ''}`)),
        h('div', { class: 'btn-row' },
          h('button', { class: 'btn small', onclick: () => startPlacing(f.id, p.id) }, 'Move (click on map)'),
          h('button', { class: 'btn small', onclick: () => startPlacing(f.id) }, '+ Place a copy'),
          h('button', { class: 'btn small ghost', onclick: () => map.centerOn(p.x, p.y, Math.max(map.view.k, 1.5)) }, 'Zoom to'),
          h('button', { class: 'btn small ghost', onclick: () => App.openFactory(f.id, 'floor') }, 'Floor plan'),
          h('button', { class: 'btn small ghost', onclick: () => {
            if (confirm(`Remove ${inst.label} from the map? Its links are removed too.`)) removePlacement(inst);
          } }, 'Remove')),
        h('p', { class: 'hint' }, 'The white arrow on the footprint marks the top (north) edge of the floor plan.')),
      powerStatus('f:' + p.id),
      h('section', { class: 'fp-card' }, h('h3', {}, 'Inputs'),
        inputs.length ? inputs : h('p', { class: 'sub' }, 'This factory needs no inputs.'),
        h('p', { class: 'hint' }, 'To feed this factory from another one, add the item under Available inputs in the planner.')),
      h('section', { class: 'fp-card' }, h('h3', {}, 'Outputs'), outputs));
  }

  // One line about a building's power: its own draw/output and the grid it is on.
  function powerStatus(key) {
    const v = power.value[key];
    if (!v || (!v.gen && !v.use)) return null;
    const grid = gridById(power.gridOfMember[key]);
    const own = [v.gen ? `generates ${fmt(v.gen, 1)} MW` : null, v.use ? `uses ${fmt(v.use, 1)} MW` : null].filter(Boolean).join(', ');
    return h('section', { class: 'fp-card' },
      h('div', { class: 'panel-head' }, h('h3', {}, 'Power'), grid ? gridBadge(grid) : h('span', { class: 'status-pill missing' }, 'no grid')),
      h('p', { class: 'sub' }, own[0].toUpperCase() + own.slice(1) + '.'),
      grid
        ? h('button', { class: 'link', onclick: () => select({ type: 'line', id: grid.lines[0] }) }, `On power grid ${grid.id}: ${fmt(grid.balance.gen, 1)} MW generated, ${fmt(grid.balance.use, 1)} MW used`)
        : h('p', { class: 'fp-warn' }, 'Not connected. Draw a power line that ends on this building (or one of its ports).'));
  }

  function renderGeyser(n) {
    const station = st().infra.stations.find((s) => s.kind === 'geothermal' && geyserAt(s.x, s.y) === n);
    put(side,
      back(),
      h('section', { class: 'fp-card' },
        h('h3', { class: 'named' }, infraIconEl('geothermal', 24), `${T.PURITY_NAME[n.purity]} geyser`),
        h('p', { class: 'sub num' }, `x ${Math.round(n.x)} m · y ${Math.round(n.y)} m`),
        h('table', { class: 'plan-table' }, h('thead', {}, h('tr', {}, h('th', {}, 'Purity'), h('th', { class: 'r' }, 'Geothermal (average)'))),
          h('tbody', {}, T.PURITY_NAME.map((name, i) => h('tr', { class: i === n.purity ? 'chosen' : '' }, h('td', {}, name), h('td', { class: 'r num' }, `${P.POWER.geothermal[i]} MW`))))),
        h('p', { class: 'hint' }, 'Output swings between half and 1.5× the average; plan grids with some margin.'),
        station
          ? h('button', { class: 'btn small', onclick: () => select({ type: 'station', id: station.id }) }, 'Show its geothermal generator')
          : h('button', { class: 'btn small primary', onclick: () => {
            const s = { id: uid(), kind: 'geothermal', x: n.x, y: n.y, rot: 0, name: '' };
            st().infra.stations.push(s);
            selection = { type: 'station', id: s.id };
            commit();
          } }, '+ Place a geothermal generator')));
  }

  function renderNode(n) {
    if (n.kind === 'geyser') return renderGeyser(n);
    const liquid = isLiquid(n.item);
    const rows = n.kind === 'well' || n.item === 'Desc_LiquidOil_C'
      ? [[T.extractorName(n), T.nodeBaseRate(n), T.nodeMaxRate(n, 3, liquid)]]
      : [1, 2, 3].map((t) => [`Miner Mk.${t}`, T.nodeBaseRate(n, t), T.nodeMaxRate(n, t, liquid)]);
    const s = st();
    const users = s.links.filter((l) => l.from.type === 'node' && l.from.id === n.id);
    const wanting = instances().filter((i) => needs(i.f)[n.item] > incoming(i.p.id, n.item) + 1e-6);
    const plan = users.length ? nodePlan(n) : null;
    put(side,
      back(),
      h('section', { class: 'fp-card' },
        h('h3', { class: 'named' }, itemIcon(n.item, 24), D.items[n.item].name),
        h('p', {}, h('span', { class: 'purity p' + n.purity }), ` ${T.PURITY_NAME[n.purity]} ${n.kind === 'well' ? 'resource well satellite (needs a Resource Well Pressurizer)' : 'resource node'}`),
        h('p', { class: 'sub num' }, `x ${Math.round(n.x)} m · y ${Math.round(n.y)} m`),
        h('table', {}, h('thead', {}, h('tr', {}, h('th', {}, 'Extractor'), h('th', { class: 'r' }, '100%'), h('th', { class: 'r' }, 'Max (250%)'))),
          h('tbody', {}, rows.map(([name, base, max]) => h('tr', {}, h('td', {}, name), h('td', { class: 'r num' }, fmt(base)), h('td', { class: 'r num' }, fmt(max))))))),
      plan ? extractionCard(n, plan) : null,
      powerStatus('n:' + n.id),
      h('section', { class: 'fp-card' }, h('h3', {}, 'Used by'),
        users.length ? users.map((l) => linkRow(l, 'out')) : h('p', { class: 'sub' }, 'Not used yet.'),
        wanting.length ? [h('h4', {}, 'Supply a factory'), wanting.map((i) => h('button', { class: 'cand', onclick: () => {
          const remaining = needs(i.f)[n.item] - incoming(i.p.id, n.item);
          addLink({ type: 'node', id: n.id }, { type: 'factory', id: i.f.id, inst: i.p.id }, n.item, Math.min(remaining, T.nodeMaxRate(n, 3, liquid)));
        } }, h('span', {}, i.label), h('span', { class: 'sub' }, `needs ${fmt(needs(i.f)[n.item] - incoming(i.p.id, n.item))}/min more · ${fmtLen(Math.hypot(n.x - i.p.x, n.y - i.p.y))}`)))] : null));
  }

  // Required extractor for a node's total draw, with every option compared.
  function extractionCard(n, plan) {
    const c = plan.chosen;
    const rec = plan.recommended;
    const tierSelect = n.kind === 'well' || n.item === 'Desc_LiquidOil_C'
      ? null
      : h('select', { onchange: (ev) => {
        if (ev.target.value === 'auto') delete st().nodeMiners[n.id];
        else st().nodeMiners[n.id] = Number(ev.target.value);
        commit();
      } }, h('option', { value: 'auto', selected: !plan.pinned }, `Auto (${rec ? rec.name : 'none fits'})`),
      [1, 2, 3].map((t) => h('option', { value: t, selected: plan.pinned && c.tier === t }, `Miner Mk.${t}`)));
    const unit = isLiquid(n.item) ? 'm³/min' : '/min';
    return h('section', { class: 'fp-card' },
      h('h3', {}, 'Extraction'),
      h('div', { class: 'kv' },
        h('span', {}, 'Total draw'), h('span', { class: 'num' }, `${fmt(plan.rate)} ${unit} · ${plan.links.length} link${plan.links.length > 1 ? 's' : ''}`),
        h('span', {}, 'Build'), h('span', { class: 'strong' }, planText(n, plan)),
        h('span', {}, 'Power Shards'), h('span', { class: 'num' }, !c.ok ? '—' : c.shards ? `${c.shards} (allows up to ${fmt(Math.min(2.5, 1 + c.shards * 0.5) * 100)}%)` : 'none'),
        h('span', {}, 'Power'), h('span', { class: 'num' }, !c.ok ? '—' : `≈ ${fmt(c.power, 1)} MW${n.kind === 'well' ? ' (whole well)' : ''}`),
        tierSelect ? [h('span', {}, 'Extractor'), tierSelect] : null),
      !c.ok ? h('p', { class: 'fp-warn' }, rec
        ? `${c.name} tops out at ${fmt(c.max)} ${unit} on this node. ${rec.name} would work.`
        : `Too much for one node: it gives at most ${fmt(plan.max)} ${unit}. Move some of the draw to another node.`) : null,
      n.kind === 'well' ? h('p', { class: 'hint' }, 'The pressurizer clock applies to every satellite of this well.') : null,
      h('table', { class: 'plan-table' },
        h('thead', {}, h('tr', {}, h('th', {}, 'Extractor'), h('th', { class: 'r' }, 'Clock'), h('th', { class: 'r' }, 'Shards'), h('th', { class: 'r' }, 'Power'), h('th', {}, ''))),
        h('tbody', {}, plan.options.map((o) => h('tr', { class: o === c ? 'chosen' : '' },
          h('td', {}, o.name),
          h('td', { class: 'r num' + (o.ok ? '' : ' sub'), title: o.ok ? '' : 'Most this extractor can give on this node' }, o.ok ? `${fmt(o.clock * 100, 2)}%` : `max ${fmt(o.max)}`),
          h('td', { class: 'r num' }, o.ok ? o.shards : '—'),
          h('td', { class: 'r num' }, o.ok ? `${fmt(o.power, 1)} MW` : '—'),
          h('td', { class: 'sub', title: o === rec ? 'Recommended' : '' }, o === rec ? '★' : ''))))));
  }

  function renderLink(l) {
    const li = linkInfo(l);
    const liquid = isLiquid(l.item);
    const rate = h('input', { type: 'number', class: 'num', min: 0, step: 'any', value: l.rate, onchange: (ev) => { l.rate = Math.max(0, Number(ev.target.value) || 0); commit(); } });
    const transport = iconSelect(Object.entries(T.TRANSPORTS).map(([k, name]) => ({ value: k, label: name, icon: () => infraIconEl(TRANSPORT_ICON[k], 20) })), l.transport,
      (v) => { l.transport = v; commit(); });
    const node = l.from.type === 'node' ? nodeById[l.from.id] : null;
    const plan = node ? nodePlan(node) : null;
    const minerSel = node && !liquid && node.kind !== 'well'
      ? h('select', { title: 'Shared by every link from this node', onchange: (ev) => {
        if (ev.target.value === 'auto') delete st().nodeMiners[node.id];
        else st().nodeMiners[node.id] = Number(ev.target.value);
        commit();
      } }, h('option', { value: 'auto', selected: !plan.pinned }, `Auto (${plan.recommended ? plan.recommended.name : 'none fits'})`),
      [1, 2, 3].map((t) => h('option', { value: t, selected: plan.pinned && plan.chosen.tier === t }, `Miner Mk.${t}`)))
      : null;
    const endpoint = (ep) => ep.type === 'local'
      ? h('span', {}, endpointName(ep))
      : h('button', { class: 'link', onclick: () => {
        const p = centerPos(ep);
        if (p) map.centerOn(p[0], p[1], Math.max(map.view.k, 0.6));
        select(ep.type === 'factory' ? { type: 'factory', id: ep.inst } : { type: ep.type, id: ep.id });
      } }, endpointName(ep));

    put(side,
      back(),
      h('section', { class: 'fp-card' },
        h('h3', { class: 'named' }, itemIcon(l.item, 24), D.items[l.item].name),
        h('p', {}, 'From ', endpoint(l.from), h('br'), 'to ', endpoint(l.to)),
        h('div', { class: 'kv' },
          h('span', {}, `Rate (${liquid ? 'm³' : 'items'}/min)`), rate,
          l.from.type === 'local' ? null : [h('span', {}, 'Transport'), transport],
          minerSel ? [h('span', {}, 'Extractor'), minerSel] : null,
          li.a && li.b ? [h('span', {}, 'Route length'), h('span', { class: 'num' }, fmtLen(li.distance))] : null)),
      h('section', { class: 'fp-card' }, h('h3', {}, 'What to build'),
        h('ul', { class: 'build-list' }, [...li.extraction, ...li.info.lines].map((t) => h('li', {}, t))),
        li.info.warn.map((w) => h('p', { class: 'fp-warn' }, w))),
      li.a && li.b ? h('section', { class: 'fp-card' }, h('h3', {}, 'Route'),
        h('p', { class: 'hint' }, 'Drag the small dots on the selected link to add bends. Double-click a bend to remove it. Bends snap to drawn infrastructure.'),
        (l.via || []).length ? h('button', { class: 'btn small', onclick: () => { l.via = []; commit(); } }, `Clear ${l.via.length} bend${l.via.length > 1 ? 's' : ''}`) : null) : null,
      h('button', { class: 'btn small danger', onclick: () => removeLink(l.id) }, 'Delete link'));
  }

  function renderLine(line) {
    const kind = iconSelect(Object.entries(LINE_KINDS).map(([k, v]) => ({ value: k, label: v.label, icon: () => infraIconEl(v.icon, 20) })), line.kind,
      (v) => { line.kind = v; commit(); });
    const name = h('input', { type: 'text', value: line.name || '', placeholder: 'Optional name', onchange: (ev) => { line.name = ev.target.value.trim(); commit(); } });
    const len = polylineLength(line.points);
    const extras = [];
    if (line.kind === 'conveyor') extras.push(`Belt length ≈ ${fmtLen(len)}`);
    if (line.kind === 'pipe') extras.push(`Pipe length ≈ ${fmtLen(len)} (add pumps for height)`);
    if (line.kind === 'hypertube') extras.push(`Hypertube length ≈ ${fmtLen(len)} plus an entrance at each end`);
    if (line.kind === 'rail') extras.push(`Track length ≈ ${fmtLen(len)}; one-way trains need a loop or stations at both ends`);
    if (line.kind === 'road') extras.push(`Route ≈ ${fmtLen(len)}; record the truck's path along it`);
    if (line.kind === 'drone') extras.push(`Flight distance ≈ ${fmtLen(len)}; place a drone port at each end`);
    const pw = line.kind === 'power' ? power.lineTowers[line.id] : null;
    if (pw) {
      const auto = pw.towers.filter((t) => t.auto).length;
      extras.push(`${pw.towers.length} Power Tower${pw.towers.length === 1 ? '' : 's'}${auto ? ` (${auto} placed automatically)` : ''}; points on a building or resource node connect to it instead`);
      extras.push(`Longest span ${fmtLen(Math.max(...pw.spans.map((x) => x.len)))} (max ${fmtLen(maxSpan())})`);
    }
    put(side,
      back(),
      h('section', { class: 'fp-card' },
        h('h3', { class: 'named' }, infraIconEl(LINE_KINDS[line.kind].icon, 24), LINE_KINDS[line.kind].label),
        h('div', { class: 'kv' },
          h('span', {}, 'Type'), kind,
          h('span', {}, 'Name'), name,
          h('span', {}, 'Length'), h('span', { class: 'num' }, fmtLen(len)),
          h('span', {}, 'Points'), h('span', { class: 'num' }, line.points.length)),
        h('ul', { class: 'build-list' }, extras.map((t) => h('li', {}, t))),
        h('p', { class: 'hint' }, 'Drag the white points to move them, drag the small dots to add points, double-click a point to remove it. Points snap to stations, ports and other lines.'),
        line.kind === 'rail' ? h('button', { class: 'btn small primary', onclick: () => trains.open({ type: 'line', id: line.id }) }, 'Plan routes') : null,
        pw ? [
          h('label', { class: 'check' }, h('input', { type: 'checkbox', checked: line.auto !== false, onchange: (ev) => { line.auto = ev.target.checked; commit(); } }),
            'Auto-place towers on long spans'),
          pw.long ? h('p', { class: 'fp-warn' }, `${pw.long} span${pw.long > 1 ? 's are' : ' is'} longer than ${fmtLen(maxSpan())} (drawn red). Add points, or turn auto-placement on.`) : null,
          pw.towers.some((t) => t.auto) ? h('button', { class: 'btn small', title: 'Turn the automatic towers into points you can move', onclick: () => {
            line.points = P.withAutoTowers(line, maxSpan());
            commit();
          } }, 'Convert auto towers to points') : null,
        ] : null),
      pw ? gridCard(gridById(power.gridOfLine[line.id])) : null,
      h('button', { class: 'btn small danger', onclick: () => removeInfra('line', line.id) }, 'Delete'));
  }

  function renderStation(stn) {
    const kind = iconSelect(Object.entries(STATION_KINDS).map(([k, v]) => ({ value: k, label: v.label, icon: () => infraIconEl(v.icon, 20) })), stn.kind,
      (v) => { stn.kind = v; commit(); });
    const name = h('input', { type: 'text', value: stn.name || '', placeholder: 'e.g. Iron Hub', onchange: (ev) => { stn.name = ev.target.value.trim(); commit(); } });
    // Lines that start or end at this station.
    const attached = st().infra.lines.filter((l) => [l.points[0], l.points[l.points.length - 1]].some((p) => Math.hypot(p[0] - stn.x, p[1] - stn.y) < 1));
    put(side,
      back(),
      h('section', { class: 'fp-card' },
        h('h3', { class: 'named' }, infraIconEl(STATION_KINDS[stn.kind].icon, 24), stn.name || STATION_KINDS[stn.kind].label),
        h('div', { class: 'kv' },
          h('span', {}, 'Type'), kind,
          h('span', {}, 'Name'), name,
          h('span', {}, 'Position (m)'), h('span', { class: 'xy' }, numInput(stn.x, (v) => { stn.x = v; commit(); }), numInput(stn.y, (v) => { stn.y = v; commit(); })),
          h('span', {}, 'Facing'), h('span', { class: 'xy' },
            numInput(stn.rot || 0, (v) => { stn.rot = ((v % 360) + 360) % 360; commit(); }, 15),
            h('button', { class: 'btn small', onclick: () => { stn.rot = ((stn.rot || 0) + 90) % 360; commit(); } }, '⟳ 90°'))),
        h('p', { class: 'hint' }, 'Select it, then drag to move. Lines drawn to it snap to its center.')),
      ...(stn.kind === 'trainStation' ? trains.stationSections(stn) : []),
      stn.kind === 'geothermal' ? geothermalCard(stn) : null,
      h('section', { class: 'fp-card' }, h('h3', {}, 'Connected lines'),
        attached.length ? attached.map((l) => h('button', { class: 'link-item', onclick: () => select({ type: 'line', id: l.id }) },
          infraIconEl(LINE_KINDS[l.kind].icon), h('span', {}, l.name || LINE_KINDS[l.kind].label), h('span', { class: 'num' }, fmtLen(polylineLength(l.points))), h('span', {})))
          : h('p', { class: 'sub' }, 'None yet.')),
      h('button', { class: 'btn small danger', onclick: () => removeInfra('station', stn.id) }, 'Delete'));
  }

  function geothermalCard(stn) {
    const g = geyserAt(stn.x, stn.y);
    return [
      h('section', { class: 'fp-card' }, h('h3', {}, 'Geothermal'),
        g ? h('p', {}, `On a ${T.PURITY_NAME[g.purity].toLowerCase()} geyser: ≈ ${P.POWER.geothermal[g.purity]} MW on average (between ${P.POWER.geothermal[g.purity] / 2} and ${P.POWER.geothermal[g.purity] * 1.5} MW).`)
          : h('p', { class: 'fp-warn' }, 'Not on a geyser. Drag it onto one (it snaps within 30 m).')),
      powerStatus('s:' + stn.id),
    ];
  }

  // ---------- Map wiring ----------
  function ensureMap() {
    if (map) return;
    map = new window.WorldMap($('#worldmap'), {
      model: () => model,
      onSelect: (sel) => select(sel),
      onCancelTool: () => {
        placing = null;
        setTool('select');
      },
      onPlace: (x, y) => {
        const f = factoryById(placing.fid);
        const pid = placing.pid;
        placing = null;
        if (f) {
          f.placements = f.placements || [];
          let p = pid && f.placements.find((q) => q.id === pid);
          if (p) {
            p.x = Math.round(x);
            p.y = Math.round(y);
          } else {
            const prev = f.placements[f.placements.length - 1];
            p = { id: uid(), x: Math.round(x), y: Math.round(y), rot: prev ? prev.rot || 0 : 0 };
            f.placements.push(p);
          }
          selection = { type: 'factory', id: p.id };
        }
        commit();
      },
      onMoveFactory: (pid, x, y, done) => {
        const inst = instanceById(pid);
        inst.p.x = x;
        inst.p.y = y;
        if (done) commit();
        else {
          buildModel();
          map.requestDraw();
        }
      },
      onMoveStation: (id, x, y, done) => {
        const s = st().infra.stations.find((q) => q.id === id);
        const g = done && s.kind === 'geothermal' && geyserAt(x, y);
        if (g) [x, y] = [g.x, g.y];
        // Lines ending at the station follow it.
        st().infra.lines.forEach((l) => [0, l.points.length - 1].forEach((i) => {
          if (Math.hypot(l.points[i][0] - s.x, l.points[i][1] - s.y) < 1) l.points[i] = [x, y];
        }));
        s.x = x;
        s.y = y;
        if (done) commit();
        else {
          buildModel();
          map.requestDraw();
        }
      },
      onRouteChange: (kind, id, pts, done) => {
        if (kind === 'link') st().links.find((x) => x.id === id).via = pts;
        else st().infra.lines.find((x) => x.id === id).points = pts;
        if (done) commit();
        else {
          buildModel();
          map.requestDraw();
        }
      },
      onDraw: (kind, points) => {
        const line = { id: uid(), kind, points, name: '' };
        if (kind === 'power') line.auto = true;
        st().infra.lines.push(line);
        selection = { type: 'line', id: line.id };
        commit();
      },
      onStation: (kind, x, y) => {
        const g = kind === 'geothermal' && geyserAt(x, y);
        if (g) [x, y] = [g.x, g.y];
        const s = { id: uid(), kind, x, y, rot: 0, name: '' };
        if (kind === 'trainStation') {
          s.name = `Station ${st().infra.stations.filter((q) => q.kind === 'trainStation').length + 1}`;
          trains.ensureSubs(s);
        }
        st().infra.stations.push(s);
        selection = { type: 'station', id: s.id };
        commit();
      },
    });
  }

  function refresh() {
    if (!App.isMapVisible()) return;
    ensureMap();
    buildModel();
    map.draw();
    renderSide();
    trains.renderEditor();
  }

  // Toolbar: select + line kinds + station kinds.
  const SHORT = { conveyor: 'Belt', pipe: 'Pipe', hypertube: 'Hypertube', rail: 'Rail', road: 'Road', drone: 'Drone route',
    power: 'Power', trainStation: 'Train station', truckStation: 'Truck station', dronePort: 'Drone port', geothermal: 'Geothermal' };
  function buildToolbar() {
    const bar = $('#map-tools');
    const btn = (key, label, iconKey, title) => h('button', { 'data-tool': key, title, class: key === tool ? 'active' : '', onclick: () => setTool(key) },
      iconKey ? infraIconEl(iconKey, 20) : null, h('span', {}, label));
    bar.append(
      btn('select', '↖ Select', null, 'Select, move and edit (Esc)'),
      h('span', { class: 'sep' }),
      ...Object.entries(LINE_KINDS).map(([k, v]) => btn(k, SHORT[k], v.icon, `Draw ${v.label.toLowerCase()}: click points, double-click to finish`)),
      h('span', { class: 'sep' }),
      ...Object.entries(STATION_KINDS).map(([k, v]) => btn(k, SHORT[k], v.icon, `Place a ${v.label.toLowerCase()}`)));
  }
  buildToolbar();

  document.addEventListener('keydown', (ev) => {
    if (!App.isMapVisible() || (ev.target.closest && ev.target.closest('input, select, textarea'))) return;
    if (ev.key === 'Escape') {
      if (map && map.cancelDraft()) return;
      if (trains.editorOpen()) return trains.closeEditor();
      if (trains.active()) return trains.close();
      if (placing) placing = null;
      else if (tool !== 'select') return setTool('select');
      else selection = null;
      refresh();
    } else if (ev.key === 'Backspace' && map && map.draft) {
      map.undoDraftPoint();
      ev.preventDefault();
    } else if (ev.key === 'Enter' && map && map.draft) {
      map.finishDraft();
    } else if ((ev.key === 'Delete' || ev.key === 'Backspace') && selection) {
      if (selection.type === 'link') removeLink(selection.id);
      else if (selection.type === 'line' || selection.type === 'station') removeInfra(selection.type, selection.id);
      else return;
      ev.preventDefault();
    }
  });
  $('#map-fit').addEventListener('click', () => map && map.fit());

  return {
    refresh,
    portSides,
    sideSelect,
    show() {
      ensureMap();
      refresh();
      map.resize();
    },
    selectFactory(fid) {
      const f = factoryById(fid);
      selection = f && f.placements && f.placements.length ? { type: 'factory', id: f.placements[0].id } : null;
    },
  };
};
