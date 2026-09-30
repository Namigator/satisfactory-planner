# Satisfactory Planner

A static, offline web planner for Satisfactory 1.0: from recipes to factory floor plans to the world map, logistics
and trains.

- **Plan production**: an optimizer picks the best mix of the recipes you've unlocked for your target products and
  shows machines, clock speeds, power and raw resources.
- **Lay out each factory**: rows of machines on the 8 m foundation grid, several floors with custom shapes, and
  draggable entrances, exits and conveyor lifts.
- **Plan power plants**: coal, fuel, nuclear and biomass generators, either for a MW target or for the most power
  your fuel gives.
- **Place factories on the real map**: link them to resource nodes (with miner tier and overclock) and to each other
  by belt, pipe, train, truck or drone.
- **Wire power grids**: power lines with Power Towers kept within the maximum span, geothermal generators on geysers,
  and each grid's MW generated against MW used.
- **Draw infrastructure**: conveyors, pipes, hypertubes, railways, truck roads and drone routes, plus stations.
- **Plan trains**: a station planner, a route planner per rail network, and a graphical train editor that shows how
  every train docks at every station, with expected deliveries and build costs.

## Run it

Open `index.html` in a browser. No build step and no server needed. Or serve the folder:

```bash
python -m http.server 8000
```

Your plans are saved in the browser automatically. Use **Export** for backups.

## Documentation

- **[User guide](docs/USER_GUIDE.md)**: how to use every part of the planner, with a keyboard/mouse reference and the
  list of estimates.
- **[Architecture and code design](docs/ARCHITECTURE.md)**: modules, data flow, the saved-state model, algorithms
  (LP solver, floor-plan geometry, map rendering, rail simulation), data pipelines and how to extend it.

## Regenerating game data

```bash
node tools/build-data.js --icons    # recipes, items, buildings, build costs, icons  → js/data.js, img/icons/
node tools/build-mapdata.js         # resource nodes + map source image              → js/mapdata.js, img/map.avif
python tools/build-maptiles.py      # map overview + tiles (needs Pillow)             → img/map/*.webp
```

## Credits

- Game data from [greeny/SatisfactoryTools](https://github.com/greeny/SatisfactoryTools) (derived from the game's
  Docs.json).
- World map image and resource node positions from
  [Tjark-Kuehl/satisfactorymap](https://github.com/Tjark-Kuehl/satisfactorymap).
- Icons and map art are © Coffee Stain Studios. This is a fan-made tool for personal use.
