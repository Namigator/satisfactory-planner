// Builds js/data.js from the community game-data dump (SatisfactoryTools, MIT).
// Usage: node tools/build-data.js [path-to-data1.0.json] [--icons]
// Without a path it downloads the file from GitHub. --icons downloads any missing
// 64px item/building icons into img/icons/.
const fs = require('fs');
const path = require('path');

const SRC_URL = 'https://raw.githubusercontent.com/greeny/SatisfactoryTools/master/data/data1.0.json';
const ICON_URL = 'https://raw.githubusercontent.com/greeny/SatisfactoryTools/master/www/assets/images/items/';
const ICON_DIR = path.join(__dirname, '..', 'img', 'icons');

// Approximate world extraction limits (items or m³ per minute) in 1.0; used for weighting.
const RESOURCE_LIMITS = {
  Desc_OreIron_C: 92100, Desc_OreCopper_C: 36900, Desc_Stone_C: 69900, Desc_Coal_C: 42300,
  Desc_OreGold_C: 15000, Desc_RawQuartz_C: 13500, Desc_Sulfur_C: 10800, Desc_OreBauxite_C: 12300,
  Desc_OreUranium_C: 2100, Desc_NitrogenGas_C: 12000, Desc_SAM_C: 10200, Desc_LiquidOil_C: 12600,
  Desc_Water_C: 2000000,
};
const POWER = 'Power_MW';
// Waste per fuel item burnt in a Nuclear Power Plant (game knowledge; not in the data dump).
const WASTE = { Desc_NuclearFuelRod_C: ['Desc_NuclearWaste_C', 50], Desc_PlutoniumFuelRod_C: ['Desc_PlutoniumWaste_C', 10] };

async function load(file) {
  if (file) return JSON.parse(fs.readFileSync(file, 'utf8'));
  const res = await fetch(SRC_URL);
  if (!res.ok) throw new Error('Download failed: ' + res.status);
  return res.json();
}

async function downloadIcons(entries) {
  fs.mkdirSync(ICON_DIR, { recursive: true });
  const missing = [];
  for (const { icon } of entries) {
    const file = path.join(ICON_DIR, `${icon}.png`);
    if (fs.existsSync(file)) continue;
    const res = await fetch(`${ICON_URL}${icon}_64.png`);
    if (res.ok) fs.writeFileSync(file, Buffer.from(await res.arrayBuffer()));
    else missing.push(icon);
  }
  if (missing.length) console.warn('Icons not found:', missing.join(', '));
}

(async () => {
  const args = process.argv.slice(2);
  const d = await load(args.find((a) => !a.startsWith('--')));
  const round = (n) => Math.round(n * 1e6) / 1e6;

  const machineRecipes = Object.values(d.recipes).filter((r) => r.inMachine && !r.forBuilding);
  const buildingIds = new Set(machineRecipes.map((r) => r.producedIn[0]));

  const buildings = {};
  for (const id of buildingIds) {
    const b = d.buildings[id];
    buildings[id] = { name: b.name, icon: b.icon, power: b.metadata.powerConsumption || 0 };
  }

  const itemIds = new Set(Object.keys(d.resources));
  machineRecipes.forEach((r) => [...r.ingredients, ...r.products].forEach((p) => itemIds.add(p.item)));

  // Power generators become recipes that output the virtual Power item (MW), one per fuel.
  // With time = 60 s, "per minute" rates equal MW. Water is waterToPowerRatio litres per MJ.
  const genRecipes = [];
  for (const g of Object.values(d.generators)) {
    const b = d.buildings[g.className];
    const mw = g.powerProduction;
    buildings[g.className] = { name: b.name, icon: b.icon, power: 0, gen: mw };
    for (const fuel of g.fuel) {
      const it = d.items[fuel];
      if (!it || !it.energyValue) continue;
      const burn = (mw * 60) / it.energyValue;
      itemIds.add(fuel);
      const ins = [[fuel, round(burn)]];
      if (g.waterToPowerRatio > 0) ins.push(['Desc_Water_C', round(mw * g.waterToPowerRatio * 0.06)]);
      const outs = [[POWER, mw]];
      if (WASTE[fuel]) {
        itemIds.add(WASTE[fuel][0]);
        outs.push([WASTE[fuel][0], round(burn * WASTE[fuel][1])]);
      }
      const short = (id) => id.replace(/^Desc_|_C$/g, '');
      genRecipes.push({ id: `Gen_${short(g.className)}_${short(fuel)}`, name: `${b.name} (${it.name})`, alt: false, time: 60,
        building: g.className, gen: true, in: ins, out: outs });
    }
  }
  // Geothermal generators sit on geysers and need no fuel; they are placed on the world map.
  const geo = d.buildings.Desc_GeneratorGeoThermal_C;
  buildings.Desc_GeneratorGeoThermal_C = { name: geo.name, icon: geo.icon, power: 0, gen: 200 };

  const items = {};
  for (const id of [...itemIds].sort((a, b) => d.items[a].name.localeCompare(d.items[b].name))) {
    const it = d.items[id];
    items[id] = { name: it.name, icon: it.icon, liquid: !!it.liquid, stack: it.stackSize, sink: it.sinkPoints || 0 };
    if (RESOURCE_LIMITS[id]) items[id].limit = RESOURCE_LIMITS[id];
  }
  // Geysers appear on the map as nodes for geothermal generators; nothing carries them on a belt.
  items.Desc_Geyser_C = { name: 'Geyser', icon: geo.icon, liquid: false, stack: 0, sink: 0, virtual: true };
  // Electricity, carried by power lines rather than belts. Rates of this item are MW.
  items[POWER] = { name: 'Power', icon: 'desc-powerline-c', liquid: false, stack: 0, sink: 0, unit: 'MW', virtual: true };

  const nameCount = {};
  machineRecipes.forEach((r) => (nameCount[r.name] = (nameCount[r.name] || 0) + 1));

  const recipes = machineRecipes
    .map((r) => {
      const b = r.producedIn[0];
      const rec = {
        id: r.className,
        name: nameCount[r.name] > 1 ? `${r.name} (${buildings[b].name})` : r.name,
        alt: !!r.alternate,
        time: r.time,
        building: b,
        in: r.ingredients.map((p) => [p.item, round(p.amount)]),
        out: r.products.map((p) => [p.item, round(p.amount)]),
      };
      if (r.isVariablePower) rec.power = [r.minPower, r.maxPower];
      return rec;
    })
    .concat(genRecipes)
    .sort((a, b) => a.name.localeCompare(b.name));

  // Icons for logistics pieces drawn on the world map and floor plan.
  const infraIcons = {
    conveyor: 'desc-conveyorbeltmk1-c', lift: 'desc-conveyorliftmk1-c', pipe: 'desc-pipeline-c',
    hypertube: 'desc-pipehyper-c', rail: 'desc-railroadtrack-c', road: 'desc-foundation-asphalt-8x1-c',
    drone: 'desc-dronestation-c', trainStation: 'desc-trainstation-c', freightPlatform: 'desc-traindockingstation-c',
    truckStation: 'desc-truckstation-c', dronePort: 'desc-dronestation-c', foundation: 'desc-foundation-8x1-01-c',
    locomotive: 'desc-locomotive-c', freightCar: 'desc-freightwagon-c', fluidPlatform: 'desc-traindockingstationliquid-c',
    emptyPlatform: 'desc-trainplatformempty-c', power: 'desc-powertower-c', geothermal: 'desc-generatorgeothermal-c',
  };

  // Build costs of logistics buildings used by the train and power planners, of every production building and
  // generator, and of the structural parts counted in a factory's building materials.
  const FOUNDATION = 'Desc_Foundation_8x1_01_C'; // 8 m × 8 m × 1 m, one floor-plan cell
  const COST_OF = ['Desc_Locomotive_C', 'Desc_FreightWagon_C', 'Desc_TrainStation_C', 'Desc_TrainDockingStation_C',
    'Desc_TrainDockingStationLiquid_C', 'Desc_TrainPlatformEmpty_C', 'Desc_RailroadTrack_C', 'Desc_PowerTower_C', 'Desc_PowerLine_C',
    'Desc_GeneratorGeoThermal_C', 'Desc_WaterPump_C', FOUNDATION, ...Object.keys(buildings)];
  const buildCosts = {};
  for (const r of Object.values(d.recipes)) {
    if (!r.forBuilding) continue;
    const id = r.products[0].item;
    if (!COST_OF.includes(id)) continue;
    const b = d.buildings[id] || d.items[id];
    buildCosts[id] = {
      name: b.name,
      icon: b.icon,
      power: (d.buildings[id] && d.buildings[id].metadata.powerConsumption) || 0,
      cost: r.ingredients.map((i) => [i.item, i.amount]),
    };
    r.ingredients.forEach((i) => {
      if (items[i.item]) return;
      const it = d.items[i.item];
      items[i.item] = { name: it.name, icon: it.icon, liquid: !!it.liquid, stack: it.stackSize, sink: it.sinkPoints || 0 };
    });
  }

  const out = `// Generated by tools/build-data.js from SatisfactoryTools game data (Satisfactory 1.0). Do not edit.\n` +
    `window.SF_DATA = ${JSON.stringify({ items, buildings, recipes, infraIcons, buildCosts })};\n`;
  const dest = path.join(__dirname, '..', 'js', 'data.js');
  fs.writeFileSync(dest, out);
  if (args.includes('--icons')) await downloadIcons([...Object.values(items), ...Object.values(buildings), ...Object.values(buildCosts), ...Object.values(infraIcons).map((icon) => ({ icon }))]);
  console.log(`Wrote ${dest}: ${Object.keys(items).length} items, ${recipes.length} recipes, ${Object.keys(buildings).length} buildings`);
})();
