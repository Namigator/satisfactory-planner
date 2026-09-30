// Rail logic: the track graph built from drawn railways, rail networks (connected track + stations),
// shortest paths between stations, and a simulation of trains running their timetables.
(function () {
  'use strict';

  const D = window.SF_DATA;
  const ATTACH_DIST = 40; // a station connects to track within this many meters
  const SPLIT_DIST = 0.6; // a rail point this close to another rail's segment joins it (T-junction)

  // Train figures (see also js/transport.js). Speeds are trip averages including acceleration.
  const TRAIN = {
    speed: 28, // m/s
    dockTime: 27.08, // s a freight platform needs to load or unload
    stopTime: 8, // s for a stop with no cargo work
    carSlots: 32,
    carFluid: 1600, // m³
    locoPower: 110, // MW at full throttle
    trackSection: 12, // m of track per build-cost unit (estimate)
  };

  const key = (x, y) => `${Math.round(x * 10)},${Math.round(y * 10)}`;

  function segProject(p, a, b) {
    const dx = b[0] - a[0];
    const dy = b[1] - a[1];
    const len2 = dx * dx + dy * dy;
    const t = len2 ? Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / len2)) : 0;
    const q = [a[0] + t * dx, a[1] + t * dy];
    return { t, q, d: Math.hypot(p[0] - q[0], p[1] - q[1]) };
  }

  /**
   * Graph of all railways. Nodes are rail points (merged when they coincide) plus one node per
   * train station, attached to the nearest track. Returns { nodes: Map(id -> {x,y,adj: Map}), lineOf, stationNode }.
   */
  function buildGraph(lines, stations) {
    const nodes = new Map();
    const node = (x, y) => {
      const id = key(x, y);
      if (!nodes.has(id)) nodes.set(id, { id, x, y, adj: new Map() });
      return nodes.get(id);
    };
    const link = (a, b) => {
      if (a === b) return;
      const d = Math.hypot(a.x - b.x, a.y - b.y);
      if (!a.adj.has(b.id) || a.adj.get(b.id) > d) {
        a.adj.set(b.id, d);
        b.adj.set(a.id, d);
      }
    };
    const rails = lines.filter((l) => l.kind === 'rail' && l.points.length >= 2);
    const segs = [];
    const lineNode = {};
    rails.forEach((l) => {
      lineNode[l.id] = key(...l.points[0]);
      for (let i = 1; i < l.points.length; i++) {
        const a = node(...l.points[i - 1]);
        const b = node(...l.points[i]);
        link(a, b);
        segs.push({ a, b, line: l.id });
      }
    });
    // T-junctions: a rail point lying on another segment splits that segment.
    [...nodes.values()].forEach((n) => {
      segs.forEach((s) => {
        if (s.a === n || s.b === n) return;
        const pr = segProject([n.x, n.y], [s.a.x, s.a.y], [s.b.x, s.b.y]);
        if (pr.d < SPLIT_DIST && pr.t > 0 && pr.t < 1) {
          link(n, s.a);
          link(n, s.b);
        }
      });
    });
    // Stations attach to the closest point on any segment.
    const stationNode = {};
    stations.filter((s) => s.kind === 'trainStation').forEach((s) => {
      let best = null;
      segs.forEach((sg) => {
        const pr = segProject([s.x, s.y], [sg.a.x, sg.a.y], [sg.b.x, sg.b.y]);
        if (pr.d <= ATTACH_DIST && (!best || pr.d < best.pr.d)) best = { sg, pr };
      });
      if (!best) return;
      const sn = { id: 'st:' + s.id, x: s.x, y: s.y, adj: new Map(), station: s.id };
      nodes.set(sn.id, sn);
      const { sg, pr } = best;
      const along = (n) => Math.hypot(n.x - pr.q[0], n.y - pr.q[1]) + pr.d;
      sn.adj.set(sg.a.id, along(sg.a));
      sn.adj.set(sg.b.id, along(sg.b));
      sg.a.adj.set(sn.id, along(sg.a));
      sg.b.adj.set(sn.id, along(sg.b));
      stationNode[s.id] = sn.id;
    });
    // Connected components = rail networks.
    const comp = new Map();
    let c = 0;
    nodes.forEach((n) => {
      if (comp.has(n.id)) return;
      const stack = [n.id];
      comp.set(n.id, c);
      while (stack.length) {
        const id = stack.pop();
        nodes.get(id).adj.forEach((_, nb) => {
          if (!comp.has(nb)) {
            comp.set(nb, c);
            stack.push(nb);
          }
        });
      }
      c++;
    });
    return { nodes, comp, lineNode, stationNode };
  }

  /** The network (component id) a rail line or station belongs to, or null. */
  function networkOf(graph, ref) {
    const id = ref.type === 'line' ? graph.lineNode[ref.id] : graph.stationNode[ref.id];
    return id != null && graph.comp.has(id) ? graph.comp.get(id) : null;
  }

  /** Shortest track path between two stations: { dist, points } or null if not connected. */
  function shortestPath(graph, fromStation, toStation) {
    const src = graph.stationNode[fromStation];
    const dst = graph.stationNode[toStation];
    if (!src || !dst) return null;
    if (src === dst) return { dist: 0, points: [[graph.nodes.get(src).x, graph.nodes.get(src).y]] };
    const dist = new Map([[src, 0]]);
    const prev = new Map();
    const done = new Set();
    const open = [src];
    while (open.length) {
      let bi = 0;
      for (let i = 1; i < open.length; i++) if (dist.get(open[i]) < dist.get(open[bi])) bi = i;
      const u = open.splice(bi, 1)[0];
      if (done.has(u)) continue;
      done.add(u);
      if (u === dst) break;
      graph.nodes.get(u).adj.forEach((w, v) => {
        // Trains only pass through a station node when it is their start or destination.
        if (v !== dst && v.startsWith('st:')) return;
        const nd = dist.get(u) + w;
        if (!dist.has(v) || nd < dist.get(v)) {
          dist.set(v, nd);
          prev.set(v, u);
          open.push(v);
        }
      });
    }
    if (!dist.has(dst)) return null;
    const points = [];
    for (let v = dst; v; v = prev.get(v)) points.unshift([graph.nodes.get(v).x, graph.nodes.get(v).y]);
    return { dist: dist.get(dst), points };
  }

  // ---------- Trains ----------
  const isLoco = (v) => v.type === 'loco';

  // A station is one row of parts on a single track: Train Station buildings and platforms, left to
  // right. Each building faces left or right; a docked train points that way and its cars extend
  // over the parts on the other side. Buildings at both ends let trains use the same platforms
  // from either direction.
  const isBuilding = (p) => !!p && p.kind === 'station';
  const buildingsOf = (station) => ((station && station.layout) || []).filter(isBuilding);
  const buildingDir = (b) => (b.facing === 'right' ? -1 : 1);

  /** Where each vehicle stands for a stop: [{ vehicle, pos (layout index), platform | 'station' | null, blocked }]. */
  function alignment(train, stop, station) {
    const layout = station.layout || [];
    const j = layout.findIndex((p) => p.id === stop.subId && isBuilding(p));
    if (j < 0) return [];
    const dir = buildingDir(layout[j]);
    const cars = train.consist;
    const order = stop.rear ? cars.map((_, i) => cars.length - 1 - i) : cars.map((_, i) => i);
    return order.map((vi, k) => {
      const pos = j + k * dir;
      const part = layout[pos];
      return { vehicle: vi, pos, dir, platform: k === 0 ? 'station' : part && !isBuilding(part) ? part : null, blocked: k > 0 && isBuilding(part) };
    });
  }
  /** Whether a locomotive at a stop points left in drawings (the layout runs left to right). */
  function facesLeft(v, stop, station) {
    const b = buildingsOf(station).find((x) => x.id === stop.subId);
    const dir = b ? buildingDir(b) : 1;
    return ((!v.reversed) !== !!stop.rear) === (dir === 1);
  }

  /**
   * Run a train's timetable. stations: list of map stations (with subs). Returns
   * { ok, legs, roundTrip, distance, flows: [{item, perMin, perTrip, from, to}], stops: [...], warnings, path }.
   */
  function simulate(train, stations, graph) {
    const warnings = [];
    const byId = {};
    stations.forEach((s) => (byId[s.id] = s));
    const stops = train.stops
      .map((st) => {
        const station = byId[st.stationId];
        const sub = buildingsOf(station).find((x) => x.id === st.subId);
        return { st, station, sub };
      });
    const cars = train.consist;
    if (!cars.length || !isLoco(cars[0])) warnings.push('The first vehicle must be a locomotive.');
    stops.forEach(({ station, sub }, i) => {
      if (!station) warnings.push(`Stop ${i + 1}: the station was removed.`);
      else if (!sub) warnings.push(`Stop ${i + 1}: choose a Train Station building of ${station.name || 'the station'}.`);
    });
    if (stops.length < 2) warnings.push('Add at least two stops.');

    // Legs along the track (the last stop returns to the first).
    const legs = [];
    let distance = 0;
    let path = [];
    let reachable = stops.length >= 2;
    for (let i = 0; i < stops.length && stops.length >= 2; i++) {
      const a = stops[i].station;
      const b = stops[(i + 1) % stops.length].station;
      const sp = a && b ? shortestPath(graph, a.id, b.id) : null;
      if (!sp) {
        reachable = false;
        warnings.push(`No track from stop ${i + 1} to stop ${((i + 1) % stops.length) + 1}${a && !graph.stationNode[a.id] ? ` (${a.name || 'station'} is not on a railway)` : ''}.`);
      }
      legs.push({ from: i, to: (i + 1) % stops.length, dist: sp ? sp.dist : null });
      if (sp) {
        distance += sp.dist;
        path = path.concat(sp.points);
      }
    }

    // Cargo: go around the timetable twice so every car has settled into its load/unload cycle.
    const content = cars.map(() => null); // item id carried by each car
    const loadedAt = cars.map(() => null);
    const flows = [];
    const stopInfo = stops.map(() => ({ slots: [], work: false }));
    for (let pass = 0; pass < 2; pass++) {
      stops.forEach(({ st, sub, station }, si) => {
        if (!sub) return;
        const slots = alignment(train, st, station);
        const info = [];
        slots.forEach(({ vehicle, platform }, k) => {
          const v = cars[vehicle];
          const row = { vehicle, vehicleType: v.type, platform, pos: slots[k].pos, action: null, item: null, before: content[vehicle] };
          if (k === 0) {
            if (!isLoco(v)) row.action = 'error';
            row.after = content[vehicle];
            info.push(row);
            return;
          }
          if (!platform || isLoco(v) || platform.kind === 'empty') {
            row.after = content[vehicle];
            info.push(row);
            return;
          }
          const fluidPlatform = platform.kind === 'fluid';
          if (platform.mode === 'load' && platform.item) {
            const itemFluid = !!(D.items[platform.item] && D.items[platform.item].liquid);
            if (itemFluid !== fluidPlatform) row.action = 'mismatch';
            else if (content[vehicle] == null || content[vehicle] === platform.item) {
              if (content[vehicle] == null) loadedAt[vehicle] = si;
              content[vehicle] = platform.item;
              row.action = 'load';
              row.item = platform.item;
            }
          } else if (platform.mode === 'unload' && content[vehicle] != null) {
            const carFluid = !!D.items[content[vehicle]].liquid;
            if ((!platform.item || platform.item === content[vehicle]) && carFluid === fluidPlatform) {
              row.action = 'unload';
              row.item = content[vehicle];
              if (pass === 1) flows.push({ item: content[vehicle], vehicle, from: loadedAt[vehicle], to: si });
              content[vehicle] = null;
              loadedAt[vehicle] = null;
            }
          }
          row.after = content[vehicle];
          info.push(row);
        });
        if (pass === 1) {
          stopInfo[si].slots = info;
          stopInfo[si].work = info.some((r) => r.action === 'load' || r.action === 'unload');
          // Cars (not locomotives) that stand at no platform cannot be loaded or unloaded.
          const past = slots.filter((x, k) => k > 0 && !x.platform && !isLoco(cars[x.vehicle])).length;
          if (past) stopInfo[si].overhang = past;
          if (info[0] && info[0].action === 'error') warnings.push(`Stop ${si + 1}: ${st.rear ? 'the last' : 'the first'} vehicle is not a locomotive, so the train cannot dock.`);
          info.forEach((r) => {
            if (r.action === 'mismatch') warnings.push(`Stop ${si + 1}: car ${r.vehicle + 1} is at a ${r.platform.kind === 'fluid' ? 'fluid' : 'freight'} platform set to a ${r.platform.kind === 'fluid' ? 'solid' : 'fluid'} item.`);
          });
        }
      });
    }
    cars.forEach((v, i) => {
      if (!isLoco(v) && content[i] != null && !flows.some((f) => f.vehicle === i)) warnings.push(`Car ${i + 1} is loaded with ${D.items[content[i]].name} but never unloaded.`);
    });

    const dwell = stopInfo.reduce((a, s) => a + (s.work ? TRAIN.dockTime : TRAIN.stopTime), 0);
    const roundTrip = reachable ? distance / TRAIN.speed + dwell : null;
    const merged = {};
    flows.forEach((f) => {
      const k = `${f.item}|${f.from}|${f.to}`;
      const perTrip = D.items[f.item].liquid ? TRAIN.carFluid : TRAIN.carSlots * (D.items[f.item].stack || 100);
      merged[k] = merged[k] || { item: f.item, from: f.from, to: f.to, perTrip: 0, cars: 0 };
      merged[k].perTrip += perTrip;
      merged[k].cars++;
    });
    const flowList = Object.values(merged).map((f) => ({ ...f, perMin: roundTrip ? (f.perTrip * 60) / roundTrip : 0 }));
    return {
      ok: reachable && !warnings.length,
      legs, distance, roundTrip, flows: flowList, stops: stopInfo, warnings, path,
      locos: cars.filter(isLoco).length, cars: cars.filter((v) => !isLoco(v)).length,
    };
  }

  // ---------- Bill of materials ----------
  const COSTS = {
    loco: 'Desc_Locomotive_C',
    car: 'Desc_FreightWagon_C',
    station: 'Desc_TrainStation_C',
    freight: 'Desc_TrainDockingStation_C',
    fluid: 'Desc_TrainDockingStationLiquid_C',
    empty: 'Desc_TrainPlatformEmpty_C',
    track: 'Desc_RailroadTrack_C',
  };
  /** counts: { loco, car, station, freight, fluid, empty, trackMeters } -> { parts: [...], materials: {item: n}, power } */
  function billOfMaterials(counts) {
    const materials = {};
    const parts = [];
    const add = (what, n) => {
      const b = D.buildCosts[COSTS[what]];
      if (!b || !n) return;
      parts.push({ what, name: b.name, icon: b.icon, count: n });
      b.cost.forEach(([item, amt]) => (materials[item] = (materials[item] || 0) + amt * n));
    };
    ['loco', 'car', 'station', 'freight', 'fluid', 'empty'].forEach((w) => add(w, counts[w]));
    if (counts.trackMeters) {
      const sections = Math.ceil(counts.trackMeters / TRAIN.trackSection);
      const b = D.buildCosts[COSTS.track];
      parts.push({ what: 'track', name: `${b.name} (≈ ${Math.round(counts.trackMeters)} m)`, icon: b.icon, count: sections, unit: 'sections' });
      b.cost.forEach(([item, amt]) => (materials[item] = (materials[item] || 0) + amt * sections));
    }
    const power =
      (counts.station || 0) * D.buildCosts[COSTS.station].power +
      (counts.freight || 0) * D.buildCosts[COSTS.freight].power +
      (counts.fluid || 0) * D.buildCosts[COSTS.fluid].power +
      (counts.loco || 0) * TRAIN.locoPower;
    return { parts, materials, power };
  }

  window.Rail = { TRAIN, buildGraph, networkOf, shortestPath, simulate, alignment, facesLeft, isBuilding, buildingsOf, billOfMaterials, segProject };
})();
