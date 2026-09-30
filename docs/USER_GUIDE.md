# Satisfactory Planner — User Guide

Satisfactory Planner helps you plan a Satisfactory 1.0 game from the recipe up to the world:

1. **Planner**: pick what a factory should make and let the optimizer work out the machines, power and raw
   resources. Then lay the factory out on the 8 m foundation grid, floor by floor.
2. **World map**: place your factory buildings on the real map, connect them to resource nodes and to each other,
   draw your belts, pipes, hypertubes, railways, roads and drone routes, and plan your trains.

Everything runs in your browser and works offline. Your plans are saved automatically in the browser.

- [Getting started](#getting-started)
- [Planner](#planner)
  - [Factories](#factories)
  - [Products, inputs, optimization, limits](#products-inputs-optimization-limits)
  - [Power plants](#power-plants)
  - [Overview](#overview-tab) · [Production](#production-tab) · [Graph](#graph-tab) · [Recipes](#recipes-tab)
  - [Floor plan](#floor-plan-tab)
- [World map](#world-map)
  - [Moving around](#moving-around) · [Resource nodes](#resource-nodes)
  - [Placing factories](#placing-factories) · [Links](#links-supplying-a-factory) · [Miners](#miners-and-overclocking)
  - [Drawing infrastructure](#drawing-infrastructure)
  - [Power lines and grids](#power-lines-and-grids)
- [Trains](#trains)
  - [Station planner](#station-planner) · [Route planner](#route-planner) · [Train editor](#train-editor)
- [Saving, sharing, backups](#saving-sharing-and-backups)
- [Keyboard and mouse reference](#keyboard-and-mouse-reference)
- [Estimates and limits](#estimates-and-limits)
- [Glossary](#glossary)

---

## Getting started

Open `index.html` in a modern browser (Chrome, Edge or Firefox). No installation or server is needed. If your
browser blocks local files, serve the folder instead:

```bash
python -m http.server 8000
```

then open <http://localhost:8000>.

A first factory, "Factory 1" making 5 Modular Frames per minute, is created for you. Change the product and the
rate in the sidebar and every view updates right away.

The switch at the top left toggles between the **Planner** (one factory at a time) and the **World map** (all
factories together).

---

## Planner

### Factories

Each tab along the top is one factory, meaning one building in your world.

| To… | Do this |
| --- | --- |
| Add a factory | Click **+ New**. |
| Add a power plant | Click **+ Power plant**. Its tab shows ⚡. |
| Switch factory | Click its tab. |
| Rename | Click the name of the active tab, type, press **Enter** (Escape cancels). |
| Delete | Hover the tab and click **×**. This also removes its links on the map. |

### Products, inputs, optimization, limits

The sidebar describes what the factory should do.

- **Products**: the items the factory must output, with a rate per minute. Type to search any item. Fluids are
  in m³/min.
- **Available inputs**: items you already have, for example from another factory, with the rate available. The
  optimizer uses them before producing more. On the world map, these are the inputs you connect to other factories.
- **Optimize for** picks what the optimizer minimizes:
  - **Resources**: raw resources, weighted by how scarce they are on the map. Uranium, SAM, sulfur and the like count
    more than iron. This is the default.
  - **Power**: total power draw; resources only break ties.
  - **Buildings**: the number of machines.
- **Resource limits**: cap how much of each raw resource the factory may use. Leave a field blank for no limit. If
  the targets can't be met within the limits you'll see "No plan can meet these targets".

### Power plants

A power plant is a factory whose main product is electricity (MW). The **Power plant** panel at the top of its
sidebar sets the goal:

- **Target MW**: generate this much power. The optimizer picks among the ticked generators and fuels and, like any
  factory, makes the fuel from raw resources (e.g. Crude Oil → Fuel → Fuel-Powered Generators). Water for coal and
  nuclear generators comes from on-site extractors.
- **Max from inputs**: list the fuel or raw resources you have under **Available inputs** (or cap resources under
  **Resource limits**) and the plan makes as much power from them as it can. For example, 600 Coal/min gives 40 Coal
  generators and 3,000 MW.

**Generators and fuels** lists every generator (Biomass Burner, Coal-Powered, Fuel-Powered, Nuclear Power Plant) with
each fuel it burns and the burn rate per generator. Tick the ones you want the plan to use. With none ticked, any may
be used. These choices belong to the plant and are not part of the shared Recipes tab.

The Overview shows **Power generated**, the generator count and the net power (generated minus what the plant's own
machines use). Nuclear plants warn about the waste they produce. Power never travels on a belt: it has no wall port
in the floor plan, and on the world map it reaches other buildings over [power lines](#power-lines-and-grids).
Geothermal generators are placed directly on the map.

### Overview tab

A summary of the solved plan:

- **Power** (at the suggested clock speeds), **machine count**, **solid resources** (and fluids), and the sink value
  of any surplus.
- **Raw resources**: each resource with its rate and what share of the whole map's supply it uses.
- **Outputs**: your products plus byproducts (surplus) with their AWESOME Sink points.
- **Machines**: count and power per building type.
- **External inputs needed**: shown when an item has no enabled recipe. Click it to pick a recipe.
- **Building materials**: what one copy of the building costs to build, in two parts plus a total:
  - **Structural**: 1 m foundations, one per 8 m square of the floor plan on every floor (5 Concrete each);
  - **Machines**: every production building and generator, plus Water Extractors (120 m³/min each) when the plan
    uses water, in case you extract it on site.

  Walls, belts, pipes, lifts, power poles and the miners on resource nodes aren't included.

### Production tab

One row per production step:

- **Machines**: the exact number (e.g. 2.5) and a suggested build, e.g. `3 × 83.33%`: three machines, each clocked
  to 83.33%. This gives the same output with round machine counts.
- **Power** for that build, and the **inputs** and **outputs** per minute.
- **Recipes…** lists every recipe that makes that item. Tick or untick them to control what the optimizer may use.

Below the table, the **Item balance** shows, for every item, how much is made, extracted or supplied versus used.

### Graph tab

A flow diagram from raw resources (blue) through production steps (orange) to products (green) and surplus (grey).
Edge labels show item and rate. Scroll to zoom, drag to pan, and hover a box to highlight its flows. Dashed edges
are loops, for example a recycling cycle.

### Recipes tab

All 276 machine recipes. Alternates are marked **ALT**, and a green dot means the recipe is used in the current
plan.

- Tick the alternates you have unlocked in your game; the optimizer then picks the best mix.
- The recipe selection is **shared by all factories**, because unlocks are save-wide.
- **Enable all alternates**, **Disable all alternates** and **Reset to defaults** work in bulk. By default all
  standard recipes are on, except the Converter's ore-to-ore conversions.

### Floor plan tab

An automatic layout of the factory on the 8 m foundation grid, which you can then edit.

**How it's drawn**

- Each production step is a **row of machines** (a manifold). Ingredients arrive on belts along one side of the row
  and products leave along the other. Long steps are split into several rows.
- Coloured lines between rows are belts (or dotted pipes), labelled with the rate and the belt/pipe tier needed,
  e.g. `60 · Mk1`.
- Squares with item icons on the walls are the **building's entrances and exits**: green for items coming in,
  orange for items going out.
- **▲ / ▼** squares are **conveyor lifts** to the floor above or below.
- Rows that overlap, or stick out of the floor, turn red.

**Editing rows**

| Action | How |
| --- | --- |
| Move a row | Drag it (snaps to 1 m). |
| Rotate | Select it and press **R** (Shift+R rotates the other way), or use the buttons in the side panel. |
| Nudge | Arrow keys (1 m), Shift + arrow keys (8 m). |
| Split a long row | Change **Machines per row** in the side panel. |
| Move a row to another floor | Pick the floor in the side panel. |
| Re-arrange everything | Choose the number of floors next to **Re-arrange** and click it. This replaces manual placement. |
| Pan / zoom | Right-drag (or drag on empty space) / mouse wheel. **Fit to view** recentres. |

**Entrances, exits and lifts**

- **Drag an entrance or exit** along the outer wall to where you want the belt to come in. It snaps to the nearest
  wall edge in 1 m steps, including notches in custom shapes.
- **Drag a lift** to move it; the belts on both floors re-route to it.
- **Double-click** an entrance, exit or lift to put it back automatically.
- In the side panel, each input and output has a **wall picker**: *Auto* puts it on the wall facing its link on the
  world map, or pick North/East/South/West. North is the top of the floor plan, marked by a white arrow on the map.

**Floors and shapes**

- The floor buttons switch floors; **+** adds one.
- **Show: floor below / above / both** overlays the other floors' walls and rows as ghosts (blue below, purple above).
  Dashed rings mark where lifts arrive, so you can line them up.
- **Edit floor shape** turns the grid into a foundation editor for the current floor:
  - click a square to add or remove a foundation;
  - drag to paint;
  - **Shift+click two corners** to fill a rectangle using the **Add** or **Remove** brush;
  - **Copy floor below** and **Auto shape** (back to a rectangle around the rows).

  Each floor can have a different shape. The side panel counts real foundations per floor.

The **Building** card shows footprint, foundations, floors and machine count. **Into / Out of the building** lists
every item crossing the walls with the belt tier needed.

> Machine footprints are approximate, e.g. Constructor 8 × 10 m and Assembler 10 × 15 m. Check large buildings in
> game before committing.

---

## World map

### Moving around

Scroll to zoom and drag to pan (with a drawing tool active, a drag still pans and a click draws). **Fit map** shows
the whole world. The scale bar is at the bottom left.

### Resource nodes

Every resource node and resource-well satellite of the 1.0 map is shown. The ring colour is the purity: red impure,
yellow normal, green pure. Nodes already in use get an orange outer ring. In the side panel's **Resource nodes**
section you can hide resource types or show only normal-and-pure / pure nodes. Water and nitrogen are hidden by
default.

### Placing factories

In the overview panel, click **Place** next to a factory, then click on the map.

- **Each placement is a separate building**: click **+ Copy** (or **+ Place a copy**) to build the same factory again
  elsewhere. Copies are labelled `#1`, `#2`… and each has its own links.
- **Select a building** by clicking its label or footprint. The footprint is drawn to scale from the floor plan
  (all floors combined).
- **Move** it by dragging it once selected, or with **Move (click on map)**, or by typing a position.
- **Rotate** it with the rotation field or **⟳ 90°**. The white arrow on the footprint marks the top (north) of the
  floor plan.
- **Remove** takes this copy off the map, together with its links.
- Click the factory's name in its panel to rename it (all copies).

### Links: supplying a factory

A selected building lists its **Inputs** (what it needs per copy) with a delivered/needed badge, and its **Outputs**
with how much is shipped.

1. Click **+ Link** next to an input.
2. Pick a source:
   - another placed factory that makes the item;
   - one of the nearest resource nodes, with distance, purity and maximum rate;
   - for water, **On-site water extractors**.
3. The link appears on the map and in the side panel.

For a selected link:

- **Rate** and **Transport**: belt, pipe, train, truck or drone.
- **What to build**: belt/pipe tier and length, vehicle counts and round-trip time, drone batteries, and for node
  sources the miner and overclock.
- **Route**: drag the small dots on the selected link to add bends, drag bends to move them, double-click a bend to
  remove it. The length updates.
- **Delete link**, or press **Delete**.

Links attach to the building's wall ports. With *Auto*, each port moves to the wall facing its link.

> To feed factory B from factory A, first add the item under **Available inputs** in B's planner, then link it on
> the map.

### Miners and overclocking

Click a resource node that has links. The **Extraction** card shows:

- **Total draw** from all links (one miner serves them all);
- **Build**: the extractor and clock speed, e.g. *Miner Mk.3 at 166.67%*;
- **Power Shards** needed and **power**;
- a table comparing every extractor tier (★ marks the recommended one; *max N* means that tier can't supply the
  draw here).

The recommendation avoids Power Shards if possible (then the lowest power), otherwise uses the fewest shards. Use
**Extractor** to pin a tier, e.g. if you only have Mk.2. You'll get a warning if it can't keep up. Oil nodes use the
Oil Extractor. For resource wells, the value is the **Resource Well Pressurizer** clock, which applies to every
satellite of that well.

### Drawing infrastructure

The toolbar at the top of the map:

| Tool | What it draws |
| --- | --- |
| **Select** | Select, move and edit things (Esc returns here). |
| **Belt, Pipe, Hypertube, Rail, Road** | A line: click to add points; double-click, right-click or Enter to finish; Backspace removes the last point; Esc cancels. |
| **Drone route** | A straight line between two points (finishes after the second click). |
| **Power** | A power line: click to add points (each point is a Power Tower), finish like other lines. |
| **Train station, Truck station, Drone port** | Click to place. |
| **Geothermal** | A geothermal generator: click on (or near) a geyser. |

- **Cancelling**: with a tool active (or while placing a factory) and no line in progress, right-click the map to go
  back to the **Select** tool. Right-dragging still pans.
- **Snapping**: points snap to stations, factory ports and centres, resource nodes, and other lines' points (a green
  ring shows a snap). While drawing, a point also snaps onto an existing line of the same kind, which is how you make
  a **rail T-junction**.
- **Editing a line**: select it, then drag its points, drag the small mid-dots to add points, and double-click a
  point to remove it. The side panel sets the type and name and shows the length and what to build.
- **Editing a station**: select it, then drag it (lines ending at it follow). The side panel sets its name, type,
  position and facing.
- The overview's **Infrastructure** card totals lengths per type and lists everything you've named.

### Power lines and grids

Draw power lines with the **Power** tool from a power plant to the buildings it feeds. A line **connects** to a
building when one of its points is on the building: on its footprint, its centre or one of its ports. It connects to a
geothermal generator or a resource node you extract from when a point snaps onto it.

**Span limit.** Power Towers can only be a limited distance apart (**Max span**, 300 m by default, set in the
overview's **Power grids** card). Every point you place is a tower; points on a building connect to the building
instead.

- With **Auto-place towers on long spans** on (the default), longer spans get evenly spaced extra towers, drawn as
  hollow dots. **Convert auto towers to points** turns them into normal points you can move.
- With it off, you place every tower yourself. Spans that are too long are drawn red and listed as warnings.
- While drawing, the label shows the current span and how many towers it needs.

**Grids.** Lines that share a point, or where a point lies on another line (a T-junction), form one **power grid**
together with every building they connect. The overview's **Power grids** card lists each grid as MW generated /
used and the net, red when short, plus any placed building that isn't on a grid. Selecting a power line shows its
grid: what's connected, towers, cable length and materials.

Power used on a grid: each factory's machines, the Water Extractors of its on-site water links (20 MW each), and the
extractors on connected resource nodes. Power generated: power plants and geothermal generators.

**Geysers and geothermal.** Geysers appear on the map as resource nodes (Geyser layer). Click one to see its average
output (impure 100, normal 200, pure 400 MW) and **+ Place a geothermal generator**, or use the **Geothermal** tool.
A geothermal generator snaps onto a geyser within 30 m.

---

## Trains

Trains are built from three pieces: **stations** (where trains load and unload), a **rail network** (the tracks
linking stations), and **trains** (vehicles plus a timetable).

### Station planner

Place a **Train station** on the map, preferably on the end of a railway or snapped onto it, then select it and click
**⤢ Open station planner**.

A station is **one row of parts on a single track**, drawn left to right:

- **Train Station building**: where the locomotive docks. Each building faces **left** or **right**; a docked train
  points that way and its cars stand on the parts behind it.
- **Freight platform** (solid items), **Fluid freight platform** (fluids) and **Empty platform** (spacer).
- Each freight or fluid platform is set to **Load** (fill cars with an item) or **Unload** (empty cars; leave the item
  blank to unload anything).

To serve trains from **both directions on the same platforms**, put a building at each end facing outward:
`[A ◀][P1][P2][B ▶]`. A train at A stands on P1 then P2; a train at B stands on P2 then P1. **Platforms are shared,
so if you need a different layout, make a different station.**

In the planner:

- Drag parts from the palette onto the track, or click a palette part to add it at the end. Drag parts to reorder
  them, or drop one on **Remove**.
- Click a part to edit it: a building's name and facing, or a platform's type, mode and item.
- **Docked trains**: under each building, every train that stops there is drawn in its real docking position, with
  **▼ load** / **▲ unload** arrows and the item each car leaves with. Cars with no platform are marked red.
- The side column shows items loaded and unloaded here per minute, warnings, what to build, materials and power.

### Route planner

Select a **railway** or a **train station** on the map and click **Plan routes**. The planner covers the whole
**rail network**: all railways connected at shared points or T-junctions, and every station within 40 m of them.
Train routes are drawn on the map in each train's colour.

It shows:

- **Stations** on the network (click one to open its station planner);
- **Trains**: each card shows a mini picture of the train, its stops, deliveries, round-trip time and warnings, plus
  **⤢ Open train editor**. **+ New train** creates one and opens the editor;
- **Whole network**: deliveries per item, what to build (locomotives, freight cars, station buildings, platforms,
  track sections), materials and maximum power.

### Train editor

A full-screen editor for one train.

**Vehicles** (front on the left):

- Drag a **Locomotive** or **Freight car** from the palette into place, or click it to add at the back.
- Drag vehicles to reorder them, or drop one on **Remove**.
- Click a vehicle to **flip** a locomotive's direction, or to move or remove it.
- A locomotive at the back facing backward lets the train **dock rear-first**.

**Stops**: **+ Add stop**, then choose the station and the **building** to dock at. After the last stop the train
returns to the first. Each stop is drawn as the station's row with the train docked under it, so you see exactly
which car stands at which platform and what's loaded or unloaded.

- **Dock rear-first** (when the train has a rear locomotive): the train arrives back first and the drawing flips.
- **Click a platform** in a stop to edit it right there. The change applies to that station for every train.
- Between stops: track distance and travel time.
- **Station planner** jumps to that station.

**Expected** (right column): round-trip distance and time, vehicles, power, deliveries per route (e.g. *1,555 Iron
Ingot/min, stop 1 → stop 2*), warnings, and a **cargo timeline** showing what each car carries after each stop
(**+** load, **−** unload).

Typical warnings:

- *No track from stop 1 to stop 2*: the stations aren't on the same connected railway.
- *The first vehicle must be a locomotive* / *cannot dock*.
- *N freight cars stand at no platform*: the train is longer than the platforms behind that building.
- *Car N is loaded … but never unloaded*.

---

## Saving, sharing and backups

- **Automatic saving**: everything is saved in your browser's local storage as you work. Clearing site data or using
  another browser starts fresh, so export backups.
- **Export** downloads all factories, links, infrastructure, trains and settings as `satisfactory-plans.json`.
- **Import** loads such a file and replaces the current state after asking.
- **Share link** (Planner view) copies a URL containing the active factory and your recipe selection. Opening it adds
  the factory as a new tab (without map placements) and offers to apply the recipes.

---

## Keyboard and mouse reference

| Where | Keys / mouse | Action |
| --- | --- | --- |
| Factory tab | Click the name | Rename (Enter saves, Escape cancels) |
| Floor plan | Drag row | Move |
| Floor plan | **R** / **Shift+R** | Rotate the selected row |
| Floor plan | Arrow keys / Shift+arrows | Nudge by 1 m / 8 m |
| Floor plan | Drag / double-click port or lift | Move / reset |
| Floor plan | Right-drag, wheel | Pan, zoom |
| Floor shape | Click / drag / Shift+click corners | Toggle / paint / fill a rectangle |
| Map | Wheel / drag | Zoom / pan |
| Map | Click | Select (or draw with a tool) |
| Map | Drag selected building or station | Move |
| Map (drawing) | Double-click, right-click or **Enter** | Finish the line |
| Map (drawing) | **Backspace** | Remove the last point |
| Map (tool or placing, nothing drawn yet) | Right-click | Cancel and go back to the Select tool (right-drag still pans) |
| Map | **Esc** | Steps back one level: cancel the line being drawn → close the train editor or station planner → close the route planner → cancel placing → back to the Select tool → deselect |
| Map | **Delete** | Delete the selected link, line or station |
| Selected line or link | Drag point / mid-dot, double-click point | Move / add / remove a bend |
| Editors | **Esc** or ✕ | Close the train editor or station planner |

---

## Estimates and limits

The production maths (recipes, rates, power at clock speed) comes from the game's data. A few things are estimates:

- **Machine footprints** in the floor plan are approximate.
- **Vehicles**: truck and train average speeds, station dwell times and drone batteries are estimates. Train cars
  hold 32 stacks or 1,600 m³; trucks 48 stacks; drones 9 stacks.
- **Trains** average 28 m/s including acceleration, each stop with cargo takes 27 s, and track costs 1 Steel Pipe + 1
  Steel Beam per ~12 m. Signals, traffic and one-way track aren't modelled; tracks are usable in both directions.
- **Extractor power** (Miner Mk.1/2/3: 5/15/45 MW, Oil Extractor 40 MW, Pressurizer 150 MW) is from game knowledge,
  not the data files.
- **Belt routes** inside the floor plan are simple right-angle paths. They show where items go, not an exact belt
  layout.
- **Power**: generator rates come from the game data. Nuclear waste per fuel rod (50 Uranium Waste, 10 Plutonium
  Waste), geothermal averages (100/200/400 MW, fluctuating ±50%), Water Extractor power (20 MW), the Power Tower span
  (300 m) and cable per metre (1 Cable per 25 m) are estimates. Power Storage, Power Switches and Power Shards on
  generators aren't modelled.
- Pipe height and pumps and Somersloops aren't modelled.

---

## Glossary

| Term | Meaning |
| --- | --- |
| Factory | A planned building: its products, recipes, floor plan and map placements. |
| Placement / copy | One instance of a factory built at a location on the map. |
| Step / row | One recipe running on a group of identical machines; drawn as a row in the floor plan. |
| Port | Where an item enters or leaves a building, on one of its walls. |
| Link | A planned supply of an item from a node, factory or on-site extractors to a factory placement. |
| Infrastructure | Drawn belts, pipes, hypertubes, rails, roads, drone routes, power lines and stations on the map. |
| Power plant | A factory whose product is power (MW): generators plus, optionally, their fuel production. |
| Power grid | Power lines connected at shared points or T-junctions, plus the buildings they connect. |
| Span | The stretch of power line between two Power Towers; limited to the max span. |
| Station building | A Train Station building inside a station; trains dock at a specific one. |
| Rail network | Railways connected at shared points or T-junctions, plus the stations on them. |
| Rear-first | A train docking with its rear locomotive at the station building. |
