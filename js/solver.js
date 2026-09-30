// Production planner: builds a linear program from targets + enabled recipes and solves it
// with a two-phase simplex. Variables are "machines running at 100%" per recipe, resource
// imports per minute, and use of user-supplied inputs.
(function () {
  'use strict';

  const EPS = 1e-9;
  const POWER_EXPONENT = 1.321929;

  // ---------- Simplex ----------
  // rows: [{ a: {varIndex: coef}, type: 'ge' | 'le' | 'eq', rhs }]
  // Minimises cost·x subject to rows and x >= 0.
  function solveLP(n, rows, cost) {
    const m = rows.length;
    const norm = rows.map((r) => {
      let { type, rhs } = r;
      let sign = 1;
      // Flip rows so rhs >= 0; a zero-rhs '>=' row becomes '<=' so its slack starts basic.
      if (rhs < 0 || (rhs === 0 && type === 'ge')) {
        sign = -1;
        rhs = -rhs;
        type = type === 'ge' ? 'le' : type === 'le' ? 'ge' : 'eq';
      }
      return { a: r.a, sign, type, rhs };
    });
    const nSlack = norm.filter((r) => r.type !== 'eq').length;
    const nArt = norm.filter((r) => r.type !== 'le').length;
    const N = n + nSlack + nArt;
    const T = [];
    const basis = new Array(m);
    let si = n;
    let ai = n + nSlack;
    for (let i = 0; i < m; i++) {
      const r = norm[i];
      const row = new Float64Array(N + 1);
      for (const k in r.a) row[k] = r.a[k] * r.sign;
      row[N] = r.rhs;
      if (r.type === 'le') {
        row[si] = 1;
        basis[i] = si++;
      } else if (r.type === 'ge') {
        row[si++] = -1;
        row[ai] = 1;
        basis[i] = ai++;
      } else {
        row[ai] = 1;
        basis[i] = ai++;
      }
      T.push(row);
    }
    const artStart = n + nSlack;

    function reducedCosts(c) {
      const z = new Float64Array(N + 1);
      for (let j = 0; j < N; j++) z[j] = c[j] || 0;
      for (let i = 0; i < m; i++) {
        const cb = c[basis[i]] || 0;
        if (!cb) continue;
        const row = T[i];
        for (let j = 0; j <= N; j++) z[j] -= cb * row[j];
      }
      return z;
    }

    function pivot(z, pr, pc) {
      const prow = T[pr];
      const pv = prow[pc];
      for (let j = 0; j <= N; j++) prow[j] /= pv;
      for (let i = 0; i < m; i++) {
        if (i === pr) continue;
        const row = T[i];
        const f = row[pc];
        if (Math.abs(f) < 1e-15) continue;
        for (let j = 0; j <= N; j++) row[j] -= f * prow[j];
      }
      const f = z[pc];
      if (f) for (let j = 0; j <= N; j++) z[j] -= f * prow[j];
      basis[pr] = pc;
    }

    // Dantzig's rule, falling back to Bland's rule during long degenerate streaks.
    // Columns whose negative reduced cost is only rounding noise (no usable pivot) are skipped.
    function run(z, colLimit) {
      let stall = 0;
      const skip = new Uint8Array(colLimit);
      for (let iter = 0; iter < 50000; iter++) {
        const bland = stall > 30;
        let pc = -1;
        let best = -EPS;
        for (let j = 0; j < colLimit; j++) {
          if (!skip[j] && z[j] < best) {
            pc = j;
            if (bland) break;
            best = z[j];
          }
        }
        if (pc < 0) return 'optimal';
        let pr = -1;
        let ratio = Infinity;
        for (let i = 0; i < m; i++) {
          const v = T[i][pc];
          if (v > EPS) {
            const r = T[i][N] / v;
            if (r < ratio - EPS || (Math.abs(r - ratio) <= EPS && basis[i] < basis[pr])) {
              ratio = r;
              pr = i;
            }
          }
        }
        if (pr < 0) {
          skip[pc] = 1;
          continue;
        }
        skip.fill(0);
        stall = ratio < EPS ? stall + 1 : 0;
        pivot(z, pr, pc);
      }
      return 'iterations';
    }

    // Phase 1
    if (nArt) {
      const c1 = {};
      for (let j = artStart; j < N; j++) c1[j] = 1;
      const z1 = reducedCosts(c1);
      run(z1, N);
      if (-z1[N] > 1e-6 * Math.max(1, ...norm.map((r) => r.rhs))) return { status: 'infeasible' };
      // Drive remaining (zero-valued) artificials out of the basis.
      for (let i = 0; i < m; i++) {
        if (basis[i] < artStart) continue;
        for (let j = 0; j < artStart; j++) {
          if (Math.abs(T[i][j]) > 1e-7) {
            pivot(z1, i, j);
            break;
          }
        }
      }
    }

    // Phase 2
    const z2 = reducedCosts(cost);
    const status = run(z2, artStart);
    if (status !== 'optimal') return { status };
    const x = new Float64Array(n);
    for (let i = 0; i < m; i++) if (basis[i] < n) x[basis[i]] = T[i][N];
    return { status: 'optimal', x };
  }

  // ---------- Model ----------
  const data = window.SF_DATA;
  const recipeById = {};
  const producersOf = {};
  for (const r of data.recipes) {
    recipeById[r.id] = r;
    for (const [item] of r.out) (producersOf[item] = producersOf[item] || []).push(r);
  }

  const POWER_ITEM = 'Power_MW';

  function recipePower(r) {
    if (r.power) return (r.power[0] + r.power[1]) / 2;
    return data.buildings[r.building].power;
  }

  function perMinute(r, amount) {
    return (amount * 60) / r.time;
  }

  function isResource(item) {
    return !!data.items[item].limit;
  }

  // Default enabled set: all standard recipes, except the Converter's ore-to-ore conversions.
  function defaultEnabled(r) {
    if (r.alt) return false;
    if (r.building === 'Desc_Converter_C' && r.out.some(([i]) => isResource(i))) return false;
    return true;
  }

  /**
   * plan: { targets: [{item, rate}], inputs: [{item, rate}], limits: {item: max}, mode }
   * enabled: Set of recipe ids
   */
  function solve(plan, enabled) {
    let targets = plan.targets.filter((t) => t.item && t.rate > 0);
    const inputs = plan.inputs.filter((t) => t.item && t.rate > 0);
    const limits = plan.limits || {};
    const hasLimit = (item) => limits[item] != null && limits[item] !== '';
    // Power plants: a MW target, or as many MW as the available inputs allow.
    const goal = plan.kind === 'power' && plan.powerGoal ? plan.powerGoal : null;
    const maxPower = !!goal && goal.mode === 'max';
    if (goal && !maxPower && goal.mw > 0) targets = [...targets, { item: POWER_ITEM, rate: Number(goal.mw) }];
    if (maxPower && !inputs.length && !Object.keys(limits).some(hasLimit)) return { status: 'empty' };
    if (!targets.length && !maxPower) return { status: 'empty' };
    // A power plant may restrict which generator/fuel recipes it uses.
    const gens = goal && Array.isArray(plan.generators) && plan.generators.length ? new Set(plan.generators) : null;
    // Generators are not in the global recipe selection: they are chosen per power plant.
    const allowed = (r) => (r.gen ? !gens || gens.has(r.id) : enabled.has(r.id));

    // Backward closure of items reachable from the targets through enabled recipes.
    const items = new Set();
    const recipes = new Set();
    const queue = targets.map((t) => t.item);
    if (maxPower) queue.push(POWER_ITEM);
    while (queue.length) {
      const item = queue.pop();
      if (items.has(item)) continue;
      items.add(item);
      for (const r of producersOf[item] || []) {
        if (!allowed(r) || recipes.has(r)) continue;
        recipes.add(r);
        r.in.forEach(([i]) => queue.push(i));
        r.out.forEach(([i]) => queue.push(i));
      }
    }
    inputs.forEach((s) => items.add(s.item));

    const itemList = [...items];
    const recipeList = [...recipes];
    const rowOf = {};
    itemList.forEach((it, i) => (rowOf[it] = i));

    // Variables: recipes, then imports, then supplied inputs.
    const vars = [];
    recipeList.forEach((r) => vars.push({ kind: 'recipe', recipe: r }));
    const hasProducer = new Set();
    recipeList.forEach((r) => r.out.forEach(([i]) => hasProducer.add(i)));
    // When maximizing power, only water (on-site extractors) and capped resources can be imported.
    const importable = (item) => !maxPower || item === 'Desc_Water_C' || (isResource(item) && hasLimit(item));
    itemList.forEach((item) => {
      if ((isResource(item) || !hasProducer.has(item)) && importable(item)) vars.push({ kind: 'import', item });
    });
    inputs.forEach((s) => vars.push({ kind: 'supply', item: s.item, max: s.rate }));

    const rows = itemList.map(() => ({ a: {}, type: 'ge', rhs: 0 }));
    targets.forEach((t) => (rows[rowOf[t.item]].rhs += t.rate));
    const cost = new Array(vars.length).fill(0);
    const mode = plan.mode || 'resources';

    vars.forEach((v, j) => {
      if (v.kind === 'recipe') {
        const r = v.recipe;
        const add = (item, amt) => {
          const row = rows[rowOf[item]].a;
          row[j] = (row[j] || 0) + amt;
        };
        r.in.forEach(([i, a]) => add(i, -perMinute(r, a)));
        r.out.forEach(([i, a]) => add(i, perMinute(r, a)));
        const p = recipePower(r);
        if (mode === 'power') cost[j] = p + 1e-3;
        else if (mode === 'buildings') cost[j] = 1 + p * 1e-4;
        else cost[j] = p * 1e-4 + 1e-5;
        // Maximizing: every MW generated is worth far more than any tie-breaking cost.
        if (maxPower) r.out.forEach(([i, a]) => i === POWER_ITEM && (cost[j] -= perMinute(r, a)));
      } else if (v.kind === 'import') {
        rows[rowOf[v.item]].a[j] = 1;
        const lim = data.items[v.item].limit;
        const weight = lim ? 1e5 / lim : 1e4;
        cost[j] = mode === 'resources' && !maxPower ? weight : weight * (lim ? 1e-3 : 10);
        if (hasLimit(v.item)) {
          rows.push({ a: { [j]: 1 }, type: 'le', rhs: Number(limits[v.item]) });
        }
      } else {
        rows[rowOf[v.item]].a[j] = 1;
        rows.push({ a: { [j]: 1 }, type: 'le', rhs: v.max });
      }
    });

    const t0 = performance.now();
    const lp = solveLP(vars.length, rows, cost);
    const ms = performance.now() - t0;
    if (lp.status !== 'optimal') return { status: lp.status, ms };

    const clean = (n) => (Math.abs(n) < 1e-7 ? 0 : n);
    const result = {
      status: 'optimal',
      ms,
      steps: [],
      imports: [],
      supplies: [],
      balance: {},
      power: 0,
      buildings: {},
    };
    const bal = (item) =>
      (result.balance[item] = result.balance[item] || { produced: 0, consumed: 0, target: 0, imported: 0, supplied: 0 });

    vars.forEach((v, j) => {
      const x = clean(lp.x[j]);
      if (x <= 0) return;
      if (v.kind === 'recipe') {
        const r = v.recipe;
        const machines = Math.ceil(x - 1e-6);
        const clock = x / machines;
        const basePower = recipePower(r);
        const step = {
          recipe: r,
          count: x,
          machines,
          clock,
          power: machines * basePower * Math.pow(clock, POWER_EXPONENT),
          inputs: r.in.map(([i, a]) => [i, perMinute(r, a) * x]),
          outputs: r.out.map(([i, a]) => [i, perMinute(r, a) * x]),
        };
        step.inputs.forEach(([i, q]) => (bal(i).consumed += q));
        step.outputs.forEach(([i, q]) => (bal(i).produced += q));
        result.steps.push(step);
        result.power += step.power;
        const b = r.building;
        result.buildings[b] = (result.buildings[b] || 0) + machines;
      } else if (v.kind === 'import') {
        result.imports.push({ item: v.item, rate: x, missing: !isResource(v.item) });
        bal(v.item).imported += x;
      } else {
        result.supplies.push({ item: v.item, rate: x, max: v.max });
        bal(v.item).supplied += x;
      }
    });
    // The MW a max-power plant reaches is its product.
    const generated = result.balance[POWER_ITEM] ? result.balance[POWER_ITEM].produced : 0;
    if (maxPower && generated > 1e-6) targets = [...targets, { item: POWER_ITEM, rate: generated }];
    result.generated = generated;
    targets.forEach((t) => (bal(t.item).target += t.rate));

    result.surplus = [];
    for (const item in result.balance) {
      const b = result.balance[item];
      const s = clean(b.produced + b.imported + b.supplied - b.consumed - b.target);
      if (s > 1e-5) result.surplus.push({ item, rate: s });
    }
    result.targets = targets;

    // Order steps from final products toward raw materials (by depth from targets).
    const depth = {};
    targets.forEach((t) => (depth[t.item] = 0));
    for (let pass = 0; pass < result.steps.length + 1; pass++) {
      let changed = false;
      for (const s of result.steps) {
        const d = Math.min(...s.outputs.map(([i]) => (depth[i] == null ? Infinity : depth[i])));
        if (d === Infinity) continue;
        for (const [i] of s.inputs) {
          if (depth[i] == null || depth[i] > d + 1) {
            depth[i] = d + 1;
            changed = true;
          }
        }
      }
      if (!changed) break;
    }
    const stepDepth = (s) => Math.min(...s.outputs.map(([i]) => (depth[i] == null ? 999 : depth[i])));
    result.steps.sort((a, b) => stepDepth(a) - stepDepth(b) || a.recipe.name.localeCompare(b.recipe.name));
    result.imports.sort((a, b) => b.rate - a.rate);

    result.flows = computeFlows(result);
    return result;
  }

  // Split each item's supply among its consumers proportionally, producing graph edges.
  function computeFlows(result) {
    const sources = {};
    const sinks = {};
    const push = (m, item, node, q) => (m[item] = m[item] || []).push({ node, q });
    result.imports.forEach((im) => push(sources, im.item, 'imp:' + im.item, im.rate));
    result.supplies.forEach((s) => push(sources, s.item, 'sup:' + s.item, s.rate));
    result.steps.forEach((s) => {
      s.outputs.forEach(([i, q]) => push(sources, i, 'rec:' + s.recipe.id, q));
      s.inputs.forEach(([i, q]) => push(sinks, i, 'rec:' + s.recipe.id, q));
    });
    result.targets.forEach((t) => push(sinks, t.item, 'out:' + t.item, t.rate));
    result.surplus.forEach((s) => push(sinks, s.item, 'sur:' + s.item, s.rate));

    const flows = [];
    for (const item in sources) {
      const src = sources[item];
      const total = src.reduce((a, s) => a + s.q, 0);
      if (total <= 0) continue;
      for (const sk of sinks[item] || []) {
        for (const s of src) {
          const q = (s.q / total) * sk.q;
          if (q > 1e-6 && s.node !== sk.node) flows.push({ from: s.node, to: sk.node, item, rate: q });
        }
      }
    }
    return flows;
  }

  window.Solver = { solve, solveLP, defaultEnabled, recipePower, perMinute, producersOf, recipeById, POWER_EXPONENT, POWER_ITEM };
})();
