// Logistics math: belt/pipe tiers, extraction rates, and vehicle throughput estimates.
// Vehicle figures are estimates (terrain, acceleration and routing vary); tune them here.
(function () {
  'use strict';

  const BELTS = [60, 120, 270, 480, 780, 1200];
  const PIPES = [300, 600];

  const VEHICLES = {
    // capacity in stacks (solids) or m³ (fluids); speed in m/s averaged over a trip; dwell = s per stop.
    train: { label: 'Train', slots: 32, fluid: 1600, speed: 28, dwell: 27.08, unit: 'freight car' },
    truck: { label: 'Truck', slots: 48, fluid: 0, speed: 18, dwell: 20, unit: 'truck' },
    drone: { label: 'Drone', slots: 9, fluid: 0, speed: 70, dwell: 51, unit: 'drone' },
  };

  const TRANSPORTS = {
    belt: 'Conveyor belt',
    pipe: 'Pipeline',
    train: 'Train',
    truck: 'Truck',
    drone: 'Drone',
  };

  // Base extraction per minute at 100% on a normal node; purity multiplies (impure ×0.5, pure ×2).
  const PURITY_MULT = [0.5, 1, 2];
  const PURITY_NAME = ['Impure', 'Normal', 'Pure'];
  const MINERS = { 1: 60, 2: 120, 3: 240 };
  const OIL_EXTRACTOR = 120;
  const WELL_SATELLITE = 60;
  const WATER_EXTRACTOR = 120;
  const MAX_CLOCK = 2.5;

  function tierFor(rate, caps) {
    if (rate <= 0) return { tier: 1, count: 0, cap: caps[0] };
    const i = caps.findIndex((c) => c >= rate - 1e-9);
    if (i >= 0) return { tier: i + 1, count: 1, cap: caps[i] };
    const top = caps[caps.length - 1];
    return { tier: caps.length, count: Math.ceil(rate / top - 1e-9), cap: top };
  }
  const beltFor = (rate) => tierFor(rate, BELTS);
  const pipeFor = (rate) => tierFor(rate, PIPES);
  function conveyorLabel(rate, liquid) {
    const t = liquid ? pipeFor(rate) : beltFor(rate);
    const name = liquid ? `Pipe Mk${t.tier}` : `Mk${t.tier}`;
    return t.count > 1 ? `${t.count}× ${name}` : name;
  }

  // Extraction capacity of a resource node at 100% clock.
  function nodeBaseRate(node, minerTier) {
    const purity = PURITY_MULT[node.purity];
    if (node.kind === 'well') return WELL_SATELLITE * purity;
    if (node.item === 'Desc_LiquidOil_C') return OIL_EXTRACTOR * purity;
    return MINERS[minerTier || 3] * purity;
  }
  function extractorName(node, minerTier) {
    if (node.kind === 'well') return 'Resource Well Extractor';
    if (node.item === 'Desc_LiquidOil_C') return 'Oil Extractor';
    return `Miner Mk.${minerTier || 3}`;
  }
  // Belts/pipes cap what one extractor can output.
  function nodeMaxRate(node, minerTier, liquid) {
    const cap = liquid ? PIPES[PIPES.length - 1] : BELTS[BELTS.length - 1];
    return Math.min(cap, nodeBaseRate(node, minerTier) * MAX_CLOCK);
  }

  // Extractor power at 100% clock (MW); like machines, power grows with clock^1.321929.
  const EXTRACTOR_POWER = { 1: 5, 2: 15, 3: 45, oil: 40, well: 150 };
  const POWER_EXPONENT = 1.321929;
  const shardsFor = (clock) => (clock > 1 + 1e-9 ? Math.ceil((clock - 1) / 0.5 - 1e-9) : 0);

  /**
   * How to draw `rate` per minute from one node: an option per extractor that fits it
   * (clock, power shards, power) and a recommendation — no shards if possible, then the least
   * power; otherwise the fewest shards. `pinned` forces a miner tier (1-3).
   */
  function extractionPlan(node, rate, liquid, pinned) {
    const cap = liquid ? PIPES[PIPES.length - 1] : BELTS[BELTS.length - 1];
    const oil = node.item === 'Desc_LiquidOil_C';
    const tiers = node.kind === 'well' ? ['well'] : oil ? ['oil'] : [1, 2, 3];
    const options = tiers.map((tier) => {
      const base = nodeBaseRate(node, typeof tier === 'number' ? tier : 3);
      const clock = rate / base;
      const max = Math.min(cap, base * MAX_CLOCK);
      const name = tier === 'well' ? 'Resource Well Pressurizer' : tier === 'oil' ? 'Oil Extractor' : `Miner Mk.${tier}`;
      return {
        tier, name, base, clock, max,
        shards: shardsFor(clock),
        power: EXTRACTOR_POWER[tier] * Math.pow(Math.max(clock, 0.01), POWER_EXPONENT),
        ok: rate <= max + 1e-9,
        beltLimited: base * MAX_CLOCK > cap && rate > cap,
      };
    });
    const fits = options.filter((o) => o.ok);
    const noShards = fits.filter((o) => o.shards === 0).sort((a, b) => a.power - b.power);
    const recommended = noShards[0] || fits.slice().sort((a, b) => a.shards - b.shards || a.power - b.power)[0] || null;
    const chosen = (pinned && options.find((o) => o.tier === pinned)) || recommended || options[options.length - 1];
    return { options, recommended, chosen, pinned: !!(pinned && options.some((o) => o.tier === pinned)), max: Math.max(...options.map((o) => o.max)), rate };
  }

  function polylineLength(points) {
    let d = 0;
    for (let i = 1; i < points.length; i++) d += Math.hypot(points[i][0] - points[i - 1][0], points[i][1] - points[i - 1][1]);
    return d;
  }

  /**
   * Describe what a link needs. rate per minute, distance in meters.
   * item: { stack, liquid }. Returns { lines: [..], warn: [..] }.
   */
  function describe(transport, rate, distance, item) {
    const lines = [];
    const warn = [];
    const liquid = item.liquid;
    if (transport === 'belt' || transport === 'pipe') {
      if (transport === 'belt' && liquid) warn.push('Fluids need a pipeline (or packaging).');
      if (transport === 'pipe' && !liquid) warn.push('Solid items cannot go through pipes.');
      const t = transport === 'pipe' ? pipeFor(rate) : beltFor(rate);
      const kind = transport === 'pipe' ? 'Pipeline' : 'Conveyor Belt';
      lines.push(`${t.count > 1 ? t.count + '× ' : ''}${kind} Mk.${t.tier} (${t.cap}/min each)`);
      lines.push(`≈ ${Math.round(distance * t.count)} m of ${transport === 'pipe' ? 'pipe' : 'belt'}`);
      if (transport === 'pipe' && distance > 0) lines.push('Add pumps for height gain (not modeled)');
      return { lines, warn, summary: `${t.count > 1 ? t.count + '× ' : ''}${transport === 'pipe' ? 'Pipe' : 'Belt'} Mk${t.tier}` };
    }
    const v = VEHICLES[transport];
    let perTrip;
    if (liquid) {
      if (v.fluid) perTrip = v.fluid;
      else {
        perTrip = v.slots * 100; // packaged fluid: 100 per stack, 1 m³ each
        warn.push('Fluids must be packaged for this transport.');
      }
    } else perTrip = v.slots * (item.stack || 100);
    const roundTrip = (2 * distance) / v.speed + 2 * v.dwell;
    const perVehicle = (perTrip * 60) / roundTrip;
    const count = rate > 0 ? Math.ceil(rate / perVehicle - 1e-9) : 0;
    lines.push(`Round trip ≈ ${Math.round(roundTrip)} s (${Math.round(distance)} m each way)`);
    lines.push(`One ${v.unit} moves ≈ ${fmt(perVehicle)}/min`);
    lines.push(`Needs ${count} ${v.unit}${count === 1 ? '' : 's'}${transport === 'train' ? ' (plus locomotive)' : ''}`);
    if (transport === 'drone') {
      const batteries = (4 + (2 * distance) / 1000) * (60 / roundTrip) * count;
      lines.push(`≈ ${fmt(batteries)} Batteries/min (4 per trip + 1/km, estimate)`);
    }
    if (transport === 'train') lines.push('Freight platform needs 27 s to load or unload');
    const summary = `${count} ${v.unit}${count === 1 ? '' : 's'}`;
    return { lines, warn, summary };
  }

  function fmt(n) {
    return new Intl.NumberFormat('en-US', { maximumFractionDigits: n < 10 ? 2 : n < 100 ? 1 : 0 }).format(n);
  }

  window.Transport = {
    BELTS, PIPES, VEHICLES, TRANSPORTS, PURITY_NAME, MINERS, MAX_CLOCK, WATER_EXTRACTOR,
    beltFor, pipeFor, conveyorLabel, nodeBaseRate, nodeMaxRate, extractorName, extractionPlan, polylineLength, describe,
  };
})();
