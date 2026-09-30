// Floor plan tab: toolbar and side panel around the Layout.FloorPlan editor.
window.FloorView = function (App) {
  'use strict';

  const { D, h, $, fmt, itemIcon, buildingIcon, named, displayName } = App;
  // Power leaves by power line, not by belt: it has no lane or wall port.
  const onBelt = ([item]) => !D.items[item].virtual;
  const L = window.Layout;
  const T = window.Transport;
  const canvas = $('#floorplan');
  const side = $('#fp-side');
  let plan = null;
  let selected = null;

  function ensure() {
    if (plan) return;
    plan = new L.FloorPlan(canvas, {
      fmt,
      onChange: (layout) => {
        App.factory().layout = layout;
        App.layoutChanged();
        render();
      },
      onSelect: (id) => {
        selected = id;
        renderSide();
      },
    });
  }

  function current() {
    const f = App.factory();
    const r = App.resultFor(f);
    if (!r || r.status !== 'optimal') return { f, r: null };
    f.layout = L.reconcile(f.layout, r);
    return { f, r };
  }

  function render() {
    const { f, r } = current();
    const empty = $('#fp-empty');
    empty.hidden = !!r;
    canvas.hidden = !r;
    if (!r) {
      side.textContent = '';
      renderToolbar(null);
      return;
    }
    ensure();
    const geo = L.compute(f.layout, r);
    plan.setData(f.layout, r, geo, App.portSides(f));
    renderToolbar(geo);
    renderSide();
  }

  function renderToolbar(geo) {
    const floors = $('#fp-floors');
    floors.textContent = '';
    if (!geo) return;
    const f = App.factory();
    for (let i = 1; i <= geo.floors; i++) {
      floors.appendChild(h('button', {
        class: plan.floor === i ? 'active' : '',
        onclick: () => {
          plan.floor = i;
          plan.draw();
          renderToolbar(L.compute(f.layout, App.resultFor(f)));
          renderSide();
        },
      }, `Floor ${i}`));
    }
    floors.appendChild(h('button', {
      title: 'Add a floor',
      onclick: () => {
        f.layout.floors = geo.floors + 1;
        plan.floor = f.layout.floors;
        App.layoutChanged();
        render();
      },
    }, '+'));
  }

  function lane(item, rate, wall) {
    return h('div', { class: 'fp-lane-row' + (wall ? ' with-wall' : '') },
      named(itemIcon(item, 18), D.items[item].name),
      h('span', { class: 'num' }, fmt(rate)),
      h('span', { class: 'badge' }, T.conveyorLabel(rate, D.items[item].liquid)),
      wall || null);
  }

  function renderSide() {
    const { f, r } = current();
    side.textContent = '';
    if (!r) return;
    const geo = L.compute(f.layout, r);
    const counts = Array.from({ length: geo.floors }, (_, i) => geo.cells[i + 1].size);
    const foundations = counts.reduce((a, b) => a + b, 0);
    const perFloor = counts.map((c, i) => `F${i + 1}: ${c}${geo.custom(i + 1) ? '' : ' auto'}`).join(' · ');
    const machines = r.steps.reduce((a, s) => a + s.machines, 0);

    side.appendChild(h('section', { class: 'fp-card' },
      h('h3', {}, 'Building'),
      h('div', { class: 'kv' },
        h('span', {}, 'Footprint'), h('span', { class: 'num' }, `${geo.w} × ${geo.h} m`),
        h('span', {}, 'Foundations'), h('span', { class: 'num' }, `${foundations} (${perFloor})`),
        h('span', {}, 'Floors'), h('span', { class: 'num' }, geo.floors),
        h('span', {}, 'Machines'), h('span', { class: 'num' }, machines)),
      geo.overlaps.size ? h('p', { class: 'fp-warn' }, `${geo.overlaps.size} rows overlap. Drag them apart (shown in red).`) : null,
      geo.outside.size ? h('p', { class: 'fp-warn' }, `${geo.outside.size} row${geo.outside.size > 1 ? 's stick' : ' sticks'} out of the floor shape (shown in red).`) : null));

    const step = selected && r.steps.find((s) => s.recipe.id === selected);
    if (step) {
      const b = f.layout.blocks[step.recipe.id];
      const g = L.blockGeometry(step, b.perRow);
      const clock = step.machines === step.count ? '100%' : `${fmt(step.clock * 100, 2)}%`;
      const perRow = h('input', {
        type: 'number', min: 1, max: step.machines, value: g.per, class: 'num',
        onchange: () => {
          b.perRow = Math.max(1, Math.min(step.machines, Number(perRow.value) || 1));
          App.layoutChanged();
          render();
        },
      });
      const floorSel = h('select', {
        onchange: () => {
          b.floor = Number(floorSel.value);
          plan.floor = b.floor;
          App.layoutChanged();
          render();
        },
      }, Array.from({ length: geo.floors }, (_, i) => h('option', { value: i + 1, selected: b.floor === i + 1 }, `Floor ${i + 1}`)));
      side.appendChild(h('section', { class: 'fp-card' },
        h('h3', { class: 'named' }, step.recipe.gen ? buildingIcon(step.recipe.building, 22) : itemIcon(step.recipe.out[0][0], 22), displayName(step.recipe)),
        h('p', { class: 'sub named' }, buildingIcon(step.recipe.building, 16),
          `${step.machines} × ${D.buildings[step.recipe.building].name} @ ${clock}`),
        h('div', { class: 'kv' },
          h('span', {}, 'Machines per row'), perRow,
          h('span', {}, 'Rows'), h('span', { class: 'num' }, g.rows),
          h('span', {}, 'Size'), h('span', { class: 'num' }, `${g.W} × ${g.H} m`),
          h('span', {}, 'Floor'), floorSel),
        h('div', { class: 'btn-row' },
          h('button', { class: 'btn small', onclick: () => plan.rotateSelected(-90) }, '⟲ Rotate'),
          h('button', { class: 'btn small', onclick: () => plan.rotateSelected(90) }, 'Rotate ⟳')),
        h('h4', {}, 'Input manifold'), step.inputs.filter(onBelt).map(([i, q]) => lane(i, q)),
        h('h4', {}, 'Output manifold'), step.outputs.filter(onBelt).map(([i, q]) => lane(i, q))));
    } else {
      side.appendChild(h('p', { class: 'hint' }, 'Click a row of machines to edit it. Drag to move, R to rotate, arrow keys to nudge (Shift = one foundation).'));
    }

    const incoming = [...r.imports.map((x) => [x.item, x.rate]), ...r.supplies.map((x) => [x.item, x.rate])].filter(onBelt);
    const outgoing = [...r.targets.map((x) => [x.item, x.rate]), ...r.surplus.map((x) => [x.item, x.rate])].filter(onBelt);
    const wall = (dir, item) => App.sideSelect(f, dir, item, render);
    side.appendChild(h('section', { class: 'fp-card' },
      h('h3', {}, 'Into the building'), incoming.length ? incoming.map(([i, q]) => lane(i, q, wall('in', i))) : h('p', { class: 'sub' }, 'Nothing.'),
      h('h3', { style: 'margin-top:10px' }, 'Out of the building'), outgoing.length ? outgoing.map(([i, q]) => lane(i, q, wall('out', i))) : h('p', { class: 'sub' }, 'Nothing.'),
      r.generated > 0 ? h('p', { class: 'sub' }, `${fmt(r.generated, 1)} MW leave by power line (see the world map).`) : null,
      h('p', { class: 'hint' }, 'Auto puts each port on the wall facing its link on the world map. North is the top of this plan. Drag ports and lifts on the plan to move them; double-click one to put it back.')));
  }

  function autoLayout() {
    const { f, r } = current();
    if (!r) return;
    const floors = Number($('#fp-auto-floors').value) || 1;
    if (!confirm(`Re-arrange all rows automatically on ${floors} floor${floors > 1 ? 's' : ''}? Your manual placement will be replaced.`)) return;
    f.layout = { ...L.autoLayout(r, floors), shapes: (f.layout && f.layout.shapes) || {}, portPos: (f.layout && f.layout.portPos) || {}, lifts: {} };
    if (plan) plan.floor = 1;
    App.layoutChanged();
    render();
    if (plan) plan.fit();
  }

  $('#fp-auto').addEventListener('click', autoLayout);
  $('#fp-overlay').addEventListener('change', (ev) => {
    ensure();
    plan.overlay = ev.target.value;
    plan.draw();
  });
  function setShapeMode(on) {
    ensure();
    plan.setShapeMode(on);
    $('#fp-shape').classList.toggle('primary', on);
    $('#fp-shape').textContent = on ? 'Done editing shape' : 'Edit floor shape';
    $('#fp-shape-tools').hidden = !on;
    $('#fp-hint').textContent = on
      ? 'Click a square to add or remove a foundation. Drag to paint. Shift+click two corners to fill a rectangle with the Add/Remove brush. Right-drag to pan.'
      : 'Grid: 8 m foundations. Each row is a manifold: inputs enter on one side, outputs leave on the other. Right-drag to pan.';
  }
  $('#fp-shape').addEventListener('click', () => setShapeMode(!(plan && plan.shapeMode)));
  document.querySelectorAll('#fp-brush button').forEach((b) => b.addEventListener('click', () => {
    ensure();
    plan.brush = b.dataset.brush === 'add';
    document.querySelectorAll('#fp-brush button').forEach((x) => x.classList.toggle('active', x === b));
  }));
  $('#fp-shape-auto').addEventListener('click', () => {
    const f = App.factory();
    if (f.layout.shapes) delete f.layout.shapes[plan.floor];
    App.layoutChanged();
    render();
  });
  $('#fp-shape-copy').addEventListener('click', () => {
    const f = App.factory();
    if (plan.floor <= 1) return;
    const geo = L.compute(f.layout, App.resultFor(f));
    f.layout.shapes = f.layout.shapes || {};
    f.layout.shapes[plan.floor] = [...geo.cells[plan.floor - 1]];
    App.layoutChanged();
    render();
  });
  $('#fp-fit').addEventListener('click', () => plan && plan.fit());
  document.addEventListener('keydown', (ev) => {
    if (!App.isFloorVisible() || !plan || !selected) return;
    if (ev.target.closest && ev.target.closest('input, select, textarea')) return;
    const step = ev.shiftKey ? 8 : 1;
    const keys = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] };
    if (ev.key === 'r' || ev.key === 'R') plan.rotateSelected(ev.shiftKey ? -90 : 90);
    else if (keys[ev.key]) plan.nudgeSelected(...keys[ev.key]);
    else if (ev.key === 'Escape') plan.select(null);
    else return;
    ev.preventDefault();
  });

  return {
    render,
    fit: () => plan && plan.fit(),
    reset: () => {
      selected = null;
      if (plan && plan.shapeMode) setShapeMode(false);
      if (plan) {
        plan.selected = null;
        plan.floor = 1;
        plan.geo = null; // refit on next render
      }
    },
  };
};
