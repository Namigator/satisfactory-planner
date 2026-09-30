// Train stations, trains and rail networks: the station planner (one row of Train Station buildings
// and platforms on a single track), the train editor (vehicles and timetable) and the route planner
// side panel for a rail network (trains, expected deliveries, what to build).
window.TrainView = function (App, ctx) {
  'use strict';

  // Append children to a DOM node, flattening arrays and skipping empty values.
  const put = (parent, ...kids) => parent.append(...kids.flat(Infinity).filter((k) => k != null && k !== false));

  const { D, h, fmt, itemIcon, named, itemCombo, iconSelect, itemLists } = App;
  const R = window.Rail;
  const { fmtLen, polylineLength } = window.MapNodes;
  const COLORS = ['#f39a3c', '#5aa9e6', '#5cc98a', '#b58cf0', '#ef6b6b', '#f2c14e', '#4fd1c5', '#e879a6'];
  const PART_NAMES = { station: 'Train Station', freight: 'Freight platform', fluid: 'Fluid freight platform', empty: 'Empty platform' };
  const PART_ICON = { station: 'trainStation', freight: 'freightPlatform', fluid: 'fluidPlatform', empty: 'emptyPlatform' };
  const uid = () => Math.random().toString(36).slice(2, 9);
  const st = () => App.state();

  let planner = null; // { ref: {type, id} } while the route planner is open
  let openTrain = null; // train highlighted on the map
  let overlay = null; // full-screen editor element
  let editor = null; // { kind: 'train', id } | { kind: 'station', id }
  let selectedVeh = null; // train editor: selected vehicle index
  let editPart = null; // part id being edited (station planner, or a platform inside a train stop)
  let selectedPart = null; // station planner: selected part id

  function graph() {
    return R.buildGraph(st().infra.lines, st().infra.stations);
  }
  const trainStations = () => st().infra.stations.filter((s) => s.kind === 'trainStation');
  const stationById = (id) => st().infra.stations.find((s) => s.id === id);
  const stationLabel = (s) => s.name || 'Unnamed station';
  const buildings = (s) => R.buildingsOf(s);
  const buildingLabel = (b) => `${b.name} ${b.facing === 'right' ? '▶' : '◀'}`;
  function stopLabel(stop) {
    const s = stationById(stop.stationId);
    const b = s && buildings(s).find((x) => x.id === stop.subId);
    return s ? `${stationLabel(s)}${b ? ` (${b.name})` : ''}` : 'Removed station';
  }
  const iconImg = (key, size) => h('img', { class: 'icon', src: `img/icons/${D.infraIcons[key]}.png`, width: size || 18, height: size || 18, alt: '' });
  function fmtTime(s) {
    const m = Math.floor(s / 60);
    const r = Math.round(s % 60);
    return m ? `${m} min ${r} s` : `${r} s`;
  }

  // ---------- Model helpers ----------
  const newBuilding = (s, facing) => ({ id: uid(), kind: 'station', name: String.fromCharCode(65 + buildings(s).length), facing: facing || 'left' });
  const newPlatform = (kind) => ({ id: uid(), kind, mode: 'unload', item: null });
  function ensureLayout(s) {
    if (s.kind === 'trainStation' && (!s.layout || !s.layout.length)) s.layout = [newBuilding({ layout: [] }), newPlatform('freight')];
  }
  function stationsOfNetwork(g, net) {
    const list = trainStations().filter((s) => R.networkOf(g, { type: 'station', id: s.id }) === net);
    list.forEach(ensureLayout);
    return list;
  }
  function trainsInNetwork(g, net) {
    return st().trains.filter((t) => (t.stops.length ? t.stops.some((s) => R.networkOf(g, { type: 'station', id: s.stationId }) === net) : t.network === net));
  }
  function stationRemoved(id) {
    st().trains.forEach((t) => (t.stops = t.stops.filter((s) => s.stationId !== id)));
  }
  function removePart(s, part) {
    if (part.kind === 'station') {
      const used = st().trains.some((t) => t.stops.some((x) => x.subId === part.id));
      if (used && !confirm(`Trains stop at building ${part.name}. Remove it and those stops?`)) return false;
      st().trains.forEach((t) => (t.stops = t.stops.filter((x) => x.subId !== part.id)));
    }
    s.layout = s.layout.filter((p) => p !== part);
    return true;
  }
  /** Simulations of every train that stops at a station, with the stop indices there. */
  function trainsAt(s) {
    const g = graph();
    const net = R.networkOf(g, { type: 'station', id: s.id });
    const stations = net == null ? [s] : stationsOfNetwork(g, net);
    return st().trains
      .filter((t) => t.stops.some((x) => x.stationId === s.id))
      .map((t) => ({ t, sim: R.simulate(t, stations, g), stops: t.stops.map((x, i) => (x.stationId === s.id ? i : -1)).filter((i) => i >= 0) }));
  }

  // ---------- Shared drawing pieces ----------
  // A station part (building or platform) as a block on the track. In drawings the layout runs left to right.
  function partBlock(s, p, index, opts) {
    const cls = ['tv-part', p.kind];
    if (p.kind !== 'station' && p.kind !== 'empty') cls.push(p.mode);
    if (opts.selected) cls.push('editing');
    const platNo = p.kind === 'station' ? null : s.layout.slice(0, index + 1).filter((x) => x.kind !== 'station').length;
    const el = h(opts.onclick ? 'button' : 'div', { class: cls.join(' '), title: opts.title || PART_NAMES[p.kind], onclick: opts.onclick },
      h('img', { src: `img/icons/${D.infraIcons[PART_ICON[p.kind]]}.png`, width: 24, height: 24, alt: '' }),
      p.kind === 'station'
        ? [h('span', { class: 'tv-part-label' }, `Station ${p.name}`), h('span', { class: 'tv-face' }, p.facing === 'right' ? 'trains face ▶' : '◀ trains face')]
        : [h('span', { class: 'tv-part-label' }, `P${platNo} · ${p.kind === 'freight' ? 'Freight' : p.kind === 'fluid' ? 'Fluid' : 'Empty'}`),
          p.kind !== 'empty' ? h('span', { class: 'tv-part-mode' }, p.mode === 'load' ? 'Load' : 'Unload', p.item ? itemIcon(p.item, 18) : h('span', { class: 'sub' }, p.mode === 'unload' ? ' any' : ' ?')) : null]);
    return el;
  }

  function vehicleEl(t, v, index, opts) {
    const loco = v.type === 'loco';
    const faceLeft = opts.faceLeft != null ? opts.faceLeft : !v.reversed;
    return h('div', {
      class: 'tv-veh ' + (loco ? 'loco ' + (faceLeft ? 'nose-left' : 'nose-right') : 'car') + (opts.selected ? ' selected' : '') + (opts.warn ? ' warn' : ''),
      style: `--train:${t.color}`,
      title: `${t.name}: ${loco ? 'locomotive' : `freight car ${index + 1}`}`,
    },
    h('div', { class: 'tv-body' },
      h('img', { src: `img/icons/${D.infraIcons[loco ? 'locomotive' : 'freightCar']}.png`, width: 30, height: 30, alt: '' }),
      h('span', { class: 'tv-label' }, loco ? (faceLeft ? '◀ Loco' : 'Loco ▶') : `Car ${index + 1}`),
      opts.cargo ? h('span', { class: 'tv-cargo', title: D.items[opts.cargo].name }, itemIcon(opts.cargo, 20)) : null),
    h('div', { class: 'tv-wheels' }, h('span'), h('span')));
  }

  /**
   * A station's row of parts with trains docked under it. entries: [{ t, stop, info }] (info = a
   * simulated stop). Columns cover the whole layout plus any vehicles standing past its ends.
   */
  function dockScene(s, entries, opts) {
    const layout = s.layout;
    let lo = 0;
    let hi = layout.length - 1;
    entries.forEach((e) => e.info.slots.forEach((x) => {
      lo = Math.min(lo, x.pos);
      hi = Math.max(hi, x.pos);
    }));
    const n = hi - lo + 1;
    const col = (pos) => pos - lo + 1;
    const rows = [];
    for (let pos = lo; pos <= hi; pos++) {
      const p = layout[pos];
      rows.push(p
        ? h('div', { style: `grid-column:${col(pos)};grid-row:1` }, partBlock(s, p, pos, opts.partOpts ? opts.partOpts(p, pos) : {}))
        : h('div', { class: 'tv-part none', style: `grid-column:${col(pos)};grid-row:1` }, 'no platform'));
    }
    entries.forEach((e, ei) => {
      const base = 2 + ei * 3;
      e.info.slots.forEach((slot, k) => {
        const act = slot.action;
        if (act === 'load' || act === 'unload') {
          rows.push(h('div', { class: 'tv-act ' + act, style: `grid-column:${col(slot.pos)};grid-row:${base}`, title: `${act === 'load' ? 'Loads' : 'Unloads'} ${D.items[slot.item].name}` },
            h('span', { class: 'tv-arrow' }, act === 'load' ? '▼' : '▲'), itemIcon(slot.item, 18)));
        } else if (act === 'mismatch' || act === 'error') {
          rows.push(h('div', { class: 'tv-act bad', style: `grid-column:${col(slot.pos)};grid-row:${base}`, title: act === 'error' ? 'Only a locomotive can dock at the station building' : 'Platform type does not match the item' }, '✗'));
        }
        const v = e.t.consist[slot.vehicle];
        const warn = (k === 0 && v.type !== 'loco') || (k > 0 && !slot.platform && v.type !== 'loco');
        const el = vehicleEl(e.t, v, slot.vehicle, { faceLeft: R.facesLeft(v, e.stop, s), cargo: slot.after, warn });
        el.style.gridColumn = String(col(slot.pos));
        el.style.gridRow = String(base + 1);
        rows.push(el);
      });
      if (!e.info.slots.length) rows.push(h('p', { class: 'fp-warn', style: `grid-column:1 / span ${n};grid-row:${base + 1}` }, 'This stop has no Train Station building.'));
      rows.push(h('div', { class: 'tv-track', style: `grid-column:1 / span ${n};grid-row:${base + 2}` }));
    });
    if (!entries.length) rows.push(h('div', { class: 'tv-track', style: `grid-column:1 / span ${n};grid-row:2` }));
    return h('div', { class: 'tv-scene-wrap' }, h('div', { class: 'tv-scene', style: `grid-template-columns:repeat(${n}, var(--slot))` }, rows));
  }

  // Property editor for one part (used in the station planner and inside train stops).
  function partEditor(s, p) {
    if (p.kind === 'station') {
      return h('div', { class: 'part-edit' },
        h('div', { class: 'kv' },
          h('span', {}, 'Building'), h('input', { type: 'text', value: p.name, onchange: (ev) => { p.name = ev.target.value.trim() || p.name; ctx.commit(); } }),
          h('span', {}, 'Trains face'), h('span', { class: 'segmented' },
            h('button', { class: p.facing !== 'right' ? 'active' : '', onclick: () => { p.facing = 'left'; ctx.commit(); } }, '◀ Left (cars to its right)'),
            h('button', { class: p.facing === 'right' ? 'active' : '', onclick: () => { p.facing = 'right'; ctx.commit(); } }, 'Right ▶ (cars to its left)'))),
        h('p', { class: 'hint' }, 'A docked train points the way its building faces; its cars stand on the parts behind it. Put a building at each end, facing outward, to serve trains from both directions on the same platforms.'));
    }
    const kind = iconSelect(['freight', 'fluid', 'empty'].map((k) => ({ value: k, label: PART_NAMES[k], icon: () => iconImg(PART_ICON[k], 20) })), p.kind,
      (v) => { p.kind = v; if (p.item && !!D.items[p.item].liquid !== (p.kind === 'fluid')) p.item = null; ctx.commit(); });
    const mode = p.kind === 'empty' ? null : h('span', { class: 'segmented' },
      h('button', { class: p.mode === 'load' ? 'active' : '', onclick: () => { p.mode = 'load'; ctx.commit(); } }, '▼ Load into trains'),
      h('button', { class: p.mode === 'unload' ? 'active' : '', onclick: () => { p.mode = 'unload'; ctx.commit(); } }, '▲ Unload from trains'));
    return h('div', { class: 'part-edit' },
      h('div', { class: 'kv' },
        h('span', {}, 'Type'), kind,
        mode ? [h('span', {}, 'Mode'), mode, h('span', {}, 'Item'), itemInput(p)] : null),
      p.kind !== 'empty' ? h('p', { class: 'hint' }, p.mode === 'unload' ? 'Leave the item empty to unload anything.' : 'Cars that stop here are filled with this item.') : null);
  }

  function itemInput(p) {
    const input = h('input', { type: 'text', value: p.item ? D.items[p.item].name : '', placeholder: p.mode === 'unload' ? 'Any item' : 'Item to load', spellcheck: false });
    itemCombo(input, itemLists.items.filter((id) => !!D.items[id].liquid === (p.kind === 'fluid')));
    input.addEventListener('change', () => {
      const v = input.value.trim();
      const id = v ? App.resolveItem(v) : null;
      if (v && !id) return input.classList.add('invalid');
      if (id && !!D.items[id].liquid !== (p.kind === 'fluid')) {
        input.classList.add('invalid');
        input.title = p.kind === 'fluid' ? 'Fluid platforms handle fluids only' : 'Freight platforms handle solid items only';
        return;
      }
      p.item = id;
      ctx.commit();
    });
    return h('span', { class: 'named' }, p.item ? itemIcon(p.item, 18) : null, input);
  }

  // ---------- Map side panel for a train station ----------
  function stationSections(s) {
    ensureLayout(s);
    const g = graph();
    const net = R.networkOf(g, { type: 'station', id: s.id });
    const at = trainsAt(s);
    return [
      h('section', { class: 'fp-card' },
        h('h3', {}, 'Layout'),
        h('div', { class: 'consist-strip' }, s.layout.map((p) => h('span', { class: 'veh ' + p.kind, title: PART_NAMES[p.kind] },
          iconImg(PART_ICON[p.kind], 16), p.kind === 'station' ? buildingLabel(p) : p.kind !== 'empty' && p.item ? itemIcon(p.item, 14) : ''))),
        h('p', { class: 'sub' }, `${buildings(s).length} Train Station building${buildings(s).length === 1 ? '' : 's'} · ${s.layout.filter((p) => p.kind !== 'station').length} platforms on one track`),
        h('button', { class: 'btn small primary', onclick: () => openStation(s.id) }, '⤢ Open station planner')),
      h('section', { class: 'fp-card' }, h('h3', {}, 'Trains stopping here'),
        at.length ? at.map(({ t }) => h('button', { class: 'link-item', onclick: () => { open({ type: 'station', id: s.id }); openEditor(t.id); } },
          h('span', { class: 'train-dot', style: `background:${t.color}` }), h('span', {}, t.name),
          h('span', { class: 'sub' }, t.stops.filter((x) => x.stationId === s.id).map((x) => (buildings(s).find((b) => b.id === x.subId) || {}).name).join(', ')), h('span', {})))
          : h('p', { class: 'sub' }, 'None yet.'),
        net != null
          ? h('button', { class: 'btn small', onclick: () => open({ type: 'station', id: s.id }) }, 'Plan routes')
          : h('p', { class: 'hint' }, 'Connect this station to a railway to plan routes: draw a railway that ends at (snaps to) the station.')),
    ];
  }

  // ---------- Full-screen editors ----------
  function ensureOverlay() {
    if (!overlay) {
      overlay = h('div', { class: 'te-overlay', onclick: (ev) => { if (ev.target === overlay) closeEditor(); } });
      document.body.appendChild(overlay);
    }
    return overlay;
  }
  function openEditor(id) {
    editor = { kind: 'train', id };
    openTrain = id;
    selectedVeh = null;
    editPart = null;
    ctx.refresh();
  }
  function openStation(id) {
    editor = { kind: 'station', id };
    selectedPart = null;
    ctx.refresh();
  }
  function closeEditor() {
    editor = null;
    editPart = null;
    if (overlay) overlay.hidden = true;
    ctx.refresh();
  }
  const editorOpen = () => !!editor;

  function renderEditor() {
    if (!editor) {
      if (overlay) overlay.hidden = true;
      return;
    }
    const el = ensureOverlay();
    const main = el.querySelector('.te-main');
    const scroll = main ? main.scrollTop : 0;
    const content = editor.kind === 'train' ? trainEditor() : stationEditor();
    if (!content) {
      editor = null;
      el.hidden = true;
      return;
    }
    el.hidden = false;
    el.replaceChildren(content);
    const m2 = el.querySelector('.te-main');
    if (m2) m2.scrollTop = scroll;
  }

  // Drag and drop for rows of blocks (vehicles or station parts).
  function dragRow(list, render, { make, onChange }) {
    const onDrop = (index, ev) => {
      ev.preventDefault();
      const data = ev.dataTransfer.getData('text/plain');
      if (data.startsWith('new:')) list.splice(index, 0, make(data.slice(4), index));
      else if (data.startsWith('move:')) {
        const from = Number(data.slice(5));
        const [v] = list.splice(from, 1);
        list.splice(from < index ? index - 1 : index, 0, v);
      } else return;
      onChange();
    };
    const strip = h('div', { class: 'tv-strip', ondragover: (ev) => ev.preventDefault(), ondrop: (ev) => onDrop(list.length, ev) },
      list.map((item, i) => {
        const el = render(item, i);
        el.draggable = true;
        el.addEventListener('dragstart', (ev) => ev.dataTransfer.setData('text/plain', 'move:' + i));
        el.addEventListener('dragover', (ev) => {
          ev.preventDefault();
          ev.stopPropagation();
          const r = el.getBoundingClientRect();
          el.classList.toggle('drop-before', ev.clientX < r.left + r.width / 2);
          el.classList.toggle('drop-after', ev.clientX >= r.left + r.width / 2);
        });
        el.addEventListener('dragleave', () => el.classList.remove('drop-before', 'drop-after'));
        el.addEventListener('drop', (ev) => {
          ev.stopPropagation();
          const r = el.getBoundingClientRect();
          onDrop(ev.clientX < r.left + r.width / 2 ? i : i + 1, ev);
        });
        return el;
      }));
    const bin = h('div', { class: 'tv-bin', title: 'Drop here to remove', ondragover: (ev) => ev.preventDefault(), ondrop: (ev) => {
      ev.preventDefault();
      const data = ev.dataTransfer.getData('text/plain');
      if (data.startsWith('move:')) onChange(Number(data.slice(5)));
    } }, '🗑 Remove');
    return { strip, bin };
  }
  function paletteItem(kind, label, icon, onClick) {
    const el = h('div', { class: 'tv-palette-item', draggable: 'true', title: 'Drag into place, or click to add at the end' },
      h('img', { src: `img/icons/${D.infraIcons[icon]}.png`, width: 26, height: 26, alt: '' }), label);
    el.addEventListener('dragstart', (ev) => ev.dataTransfer.setData('text/plain', 'new:' + kind));
    el.addEventListener('click', onClick);
    return el;
  }

  // ---------- Station planner ----------
  function stationEditor() {
    const s = stationById(editor.id);
    if (!s || s.kind !== 'trainStation') return null;
    ensureLayout(s);
    const at = trainsAt(s);
    const name = h('input', { type: 'text', class: 'te-name', value: s.name || '', placeholder: 'Station name', onchange: (ev) => { s.name = ev.target.value.trim(); ctx.commit(); } });

    const { strip, bin } = dragRow(s.layout, (p, i) => {
      const el = partBlock(s, p, i, { selected: selectedPart === p.id });
      el.classList.add('tv-slot');
      el.addEventListener('click', () => {
        selectedPart = selectedPart === p.id ? null : p.id;
        ctx.refresh();
      });
      return el;
    }, {
      make: (kind) => (kind === 'station' ? newBuilding(s, 'right') : newPlatform(kind)),
      onChange: (removeIndex) => {
        if (removeIndex != null && !removePart(s, s.layout[removeIndex])) return;
        ctx.commit();
      },
    });
    const add = (kind) => () => {
      s.layout.push(kind === 'station' ? newBuilding(s, 'right') : newPlatform(kind));
      ctx.commit();
    };
    const sel = s.layout.find((p) => p.id === selectedPart);
    const layoutSection = h('section', { class: 'te-section' },
      h('div', { class: 'te-section-head' }, h('h4', {}, 'Layout on one track (left → right)'),
        h('div', { class: 'tv-palette' },
          paletteItem('station', 'Train Station', 'trainStation', add('station')),
          paletteItem('freight', 'Freight', 'freightPlatform', add('freight')),
          paletteItem('fluid', 'Fluid', 'fluidPlatform', add('fluid')),
          paletteItem('empty', 'Empty', 'emptyPlatform', add('empty')), bin)),
      h('div', { class: 'tv-strip-wrap station' }, strip),
      sel
        ? h('div', { class: 'te-plat-edit' },
          h('div', { class: 'te-section-head' }, h('span', { class: 'strong' }, sel.kind === 'station' ? `Train Station ${sel.name}` : PART_NAMES[sel.kind]),
            h('button', { class: 'btn small danger', onclick: () => { if (removePart(s, sel)) { selectedPart = null; ctx.commit(); } } }, 'Remove')),
          partEditor(s, sel))
        : h('p', { class: 'hint' }, 'Drag parts from the palette onto the track and drag them to reorder. Click a part to edit it. Trains use the same platforms whichever building they dock at: each building sees them from its own end.'));

    // Docking: every train that stops here, drawn at each building it uses.
    const dock = buildings(s).map((b) => {
      const entries = [];
      at.forEach(({ t, sim, stops }) => stops.forEach((si) => {
        if (t.stops[si].subId === b.id) entries.push({ t, stop: t.stops[si], info: sim.stops[si] || { slots: [] } });
      }));
      const reach = (() => {
        const dir = b.facing === 'right' ? -1 : 1;
        let n = 0;
        for (let i = s.layout.indexOf(b) + dir; s.layout[i] && s.layout[i].kind !== 'station'; i += dir) n++;
        return n;
      })();
      return h('div', { class: 'te-stop' },
        h('div', { class: 'te-stop-head' },
          iconImg('trainStation', 22), h('span', { class: 'strong' }, `Building ${b.name}`),
          h('span', { class: 'sub' }, `trains face ${b.facing === 'right' ? 'right ▶' : '◀ left'} · ${reach} platform${reach === 1 ? '' : 's'} behind it`),
          h('span', { class: 'spacer' }),
          entries.length ? entries.map((e) => h('button', { class: 'station-chip', onclick: () => { open({ type: 'station', id: s.id }); openEditor(e.t.id); } },
            h('span', { class: 'train-dot', style: `background:${e.t.color}` }), e.t.name)) : h('span', { class: 'sub' }, 'No trains dock here yet.')),
        dockScene(s, entries, { partOpts: (p) => ({ selected: p.id === selectedPart, onclick: () => { selectedPart = selectedPart === p.id ? null : p.id; ctx.refresh(); } }) }));
    });

    // What happens here, per item.
    const moved = {};
    at.forEach(({ t, sim }) => sim.flows.forEach((f) => {
      const add = (dir) => {
        moved[f.item] = moved[f.item] || { load: 0, unload: 0 };
        moved[f.item][dir] += f.perMin;
      };
      if (t.stops[f.from] && t.stops[f.from].stationId === s.id) add('load');
      if (t.stops[f.to] && t.stops[f.to].stationId === s.id) add('unload');
    }));
    const counts = { station: 0, freight: 0, fluid: 0, empty: 0 };
    s.layout.forEach((p) => counts[p.kind]++);
    const bom = R.billOfMaterials(counts);
    const warnings = [];
    if (!buildings(s).length) warnings.push('Add a Train Station building: trains can only dock at one.');
    at.forEach(({ t, sim, stops }) => stops.forEach((si) => {
      const info = sim.stops[si];
      if (info && info.overhang) warnings.push(`${t.name}: ${info.overhang} car${info.overhang > 1 ? 's' : ''} at no platform (stop ${si + 1}).`);
    }));

    return h('div', { class: 'te-window', role: 'dialog', 'aria-label': 'Station planner' },
      h('header', { class: 'te-head' },
        iconImg('trainStation', 26), name,
        h('span', { class: 'sub' }, `${counts.station} building${counts.station === 1 ? '' : 's'} · ${counts.freight + counts.fluid + counts.empty} platform${counts.freight + counts.fluid + counts.empty === 1 ? '' : 's'} · ${at.length} train${at.length === 1 ? '' : 's'}`),
        h('span', { class: 'spacer' }),
        h('button', { class: 'btn', onclick: closeEditor }, '✕ Close')),
      h('div', { class: 'te-body' },
        h('main', { class: 'te-main' },
          layoutSection,
          h('section', { class: 'te-section' }, h('h4', {}, 'Docked trains'), dock.length ? dock : h('p', { class: 'sub' }, 'No Train Station building yet.'))),
        h('aside', { class: 'te-side' },
          h('h4', {}, 'Through this station'),
          Object.keys(moved).length
            ? Object.entries(moved).map(([i, m]) => h('div', { class: 'fp-lane-row' }, named(itemIcon(i, 18), D.items[i].name),
              h('span', { class: 'num' }, [m.load ? `▼ ${fmt(m.load, 0)}` : '', m.unload ? `▲ ${fmt(m.unload, 0)}` : ''].filter(Boolean).join(' · ') + '/min'), h('span', {})))
            : h('p', { class: 'sub' }, 'Nothing yet.'),
          warnings.map((w) => h('p', { class: 'fp-warn' }, w)),
          h('h4', {}, 'To build'),
          bom.parts.map((p) => h('div', { class: 'fp-lane-row' }, named(h('img', { class: 'icon', src: `img/icons/${p.icon}.png`, width: 18, height: 18, alt: '' }), p.name), h('span', { class: 'num' }, `${p.count}×`), h('span', {}))),
          h('div', { class: 'mat-grid' }, Object.entries(bom.materials).sort((a, b) => b[1] - a[1]).map(([i, n]) => h('span', { class: 'chip' }, itemIcon(i, 18), D.items[i].name, h('span', { class: 'num' }, fmt(n, 0))))),
          h('div', { class: 'kv' }, h('span', {}, 'Power'), h('span', { class: 'num' }, `≈ ${fmt(bom.power, 0)} MW`)))));
  }

  // ---------- Train editor ----------
  function trainEditor() {
    const t = st().trains.find((x) => x.id === editor.id);
    if (!t) return null;
    const g = graph();
    const net = currentNetwork(g) != null ? currentNetwork(g) : t.stops.length ? R.networkOf(g, { type: 'station', id: t.stops[0].stationId }) : t.network;
    const stations = net == null ? [] : stationsOfNetwork(g, net);
    const sim = R.simulate(t, stations, g);
    const name = h('input', { type: 'text', class: 'te-name', value: t.name, onchange: (ev) => { t.name = ev.target.value.trim() || t.name; ctx.commit(); } });
    const color = h('span', { class: 'color-pick' }, COLORS.map((c) => h('button', { class: 'swatch' + (t.color === c ? ' active' : ''), style: `background:${c}`, onclick: () => { t.color = c; ctx.commit(); } })));

    // Vehicles.
    const { strip, bin } = dragRow(t.consist, (v, i) => {
      const el = vehicleEl(t, v, i, { selected: selectedVeh === i });
      el.addEventListener('click', () => {
        selectedVeh = selectedVeh === i ? null : i;
        ctx.refresh();
      });
      return el;
    }, {
      make: (kind, index) => (kind === 'loco' ? { type: 'loco', reversed: index > 0 } : { type: 'car' }),
      onChange: (removeIndex) => {
        if (removeIndex != null) t.consist.splice(removeIndex, 1);
        selectedVeh = null;
        ctx.commit();
      },
    });
    const apply = (fn) => {
      fn();
      ctx.commit();
    };
    const sel = selectedVeh != null && t.consist[selectedVeh];
    const swap = (d) => {
      const j = selectedVeh + d;
      if (j < 0 || j >= t.consist.length) return;
      [t.consist[j], t.consist[selectedVeh]] = [t.consist[selectedVeh], t.consist[j]];
      selectedVeh = j;
    };
    const vehicles = h('section', { class: 'te-section' },
      h('div', { class: 'te-section-head' }, h('h4', {}, 'Train (front ◀ · back ▶)'),
        h('div', { class: 'tv-palette' },
          paletteItem('loco', 'Locomotive', 'locomotive', () => apply(() => t.consist.push({ type: 'loco', reversed: t.consist.length > 0 }))),
          paletteItem('car', 'Freight car', 'freightCar', () => apply(() => t.consist.push({ type: 'car' }))), bin)),
      h('div', { class: 'tv-strip-wrap' }, strip),
      sel ? h('div', { class: 'btn-row' },
        h('span', { class: 'sub' }, `${sel.type === 'loco' ? 'Locomotive' : 'Car'} ${selectedVeh + 1}:`),
        sel.type === 'loco' ? h('button', { class: 'btn small', onclick: () => apply(() => (sel.reversed = !sel.reversed)) }, '⇄ Flip direction') : null,
        h('button', { class: 'btn small', onclick: () => apply(() => swap(-1)) }, '◀ Move forward'),
        h('button', { class: 'btn small', onclick: () => apply(() => swap(1)) }, 'Move back ▶'),
        h('button', { class: 'btn small danger', onclick: () => apply(() => { t.consist.splice(selectedVeh, 1); selectedVeh = null; }) }, 'Remove'))
        : h('p', { class: 'hint' }, 'Drag vehicles to reorder them. Click one to flip or move it. A locomotive at the back (facing backward) lets the train dock rear-first.'));

    // Stops.
    const hasRearLoco = t.consist.length > 1 && t.consist[t.consist.length - 1].type === 'loco';
    const scenes = t.stops.map((stop, i) => {
      const s = stationById(stop.stationId);
      const move = (d) => {
        const j = i + d;
        if (j < 0 || j >= t.stops.length) return;
        [t.stops[i], t.stops[j]] = [t.stops[j], t.stops[i]];
        ctx.commit();
      };
      const stationSel = h('select', { onchange: (ev) => {
        stop.stationId = ev.target.value;
        const ns = stationById(stop.stationId);
        stop.subId = ns && buildings(ns)[0] ? buildings(ns)[0].id : null;
        ctx.commit();
      } }, stations.map((x) => h('option', { value: x.id, selected: x.id === stop.stationId }, stationLabel(x))),
      !s ? h('option', { value: '', selected: true }, 'Removed station') : null);
      const buildingSel = h('select', { title: 'Train Station building the train docks at', onchange: (ev) => { stop.subId = ev.target.value; ctx.commit(); } },
        (s ? buildings(s) : []).map((b) => h('option', { value: b.id, selected: b.id === stop.subId }, `Building ${buildingLabel(b)}`)));
      const info = sim.stops[i] || { slots: [] };
      const leg = sim.legs[i];
      const editing = s && editPart && s.layout.find((p) => p.id === editPart.part && editPart.stop === i);
      return h('section', { class: 'te-stop' },
        h('div', { class: 'te-stop-head' },
          h('span', { class: 'stop-no big' }, i + 1), stationSel, buildingSel,
          hasRearLoco || stop.rear ? h('label', { class: 'check' }, h('input', { type: 'checkbox', checked: !!stop.rear, onchange: (ev) => { stop.rear = ev.target.checked; ctx.commit(); } }), 'Dock rear-first') : null,
          h('span', { class: 'spacer' }),
          s ? h('button', { class: 'btn small ghost', onclick: () => openStation(s.id) }, 'Station planner') : null,
          h('span', { class: 'row-tools' },
            h('button', { class: 'icon-btn', title: 'Earlier', onclick: () => move(-1) }, '↑'),
            h('button', { class: 'icon-btn', title: 'Later', onclick: () => move(1) }, '↓'),
            h('button', { class: 'icon-btn', title: 'Remove stop', onclick: () => { t.stops.splice(i, 1); ctx.commit(); } }, '×'))),
        s ? dockScene(s, [{ t, stop, info }], {
          partOpts: (p) => ({ selected: !!(editPart && editPart.stop === i && editPart.part === p.id), title: 'Click to edit (shared by every train at this station)', onclick: () => {
            editPart = editPart && editPart.stop === i && editPart.part === p.id ? null : { stop: i, part: p.id };
            ctx.refresh();
          } }),
        }) : null,
        info.overhang ? h('p', { class: 'fp-warn' }, `${info.overhang} freight car${info.overhang > 1 ? 's stand' : ' stands'} at no platform and won't be loaded or unloaded here.`) : null,
        editing ? h('div', { class: 'te-plat-edit' },
          h('span', { class: 'sub' }, `${editing.kind === 'station' ? `Building ${editing.name}` : PART_NAMES[editing.kind]} of ${stationLabel(s)} · shared by every train stopping here`),
          partEditor(s, editing)) : null,
        leg && t.stops.length > 1 ? h('div', { class: 'te-leg' }, h('span', { class: 'te-leg-line', style: `background:${t.color}` }),
          leg.dist != null ? `${fmtLen(leg.dist)} · ≈ ${fmtTime(leg.dist / R.TRAIN.speed)} to stop ${leg.to + 1} (${stopLabel(t.stops[leg.to])})` : `No track to stop ${leg.to + 1}`) : null);
    });
    const addStop = h('button', { class: 'btn small', onclick: () => {
      const last = t.stops[t.stops.length - 1];
      const next = stations.find((s) => !last || s.id !== last.stationId) || stations[0];
      if (!next) return;
      t.stops.push({ id: uid(), stationId: next.id, subId: buildings(next)[0] && buildings(next)[0].id, rear: false });
      ctx.commit();
    } }, '+ Add stop');

    const delivered = sim.flows.length
      ? sim.flows.map((f) => h('div', { class: 'flow-row' }, named(itemIcon(f.item, 20), D.items[f.item].name),
        h('span', { class: 'num strong' }, `${fmt(f.perMin, f.perMin < 100 ? 1 : 0)}/min`),
        h('span', { class: 'sub flow-route' }, `stop ${f.from + 1} → stop ${f.to + 1} · ${f.cars} car${f.cars > 1 ? 's' : ''}, ${fmt(f.perTrip, 0)} per trip`)))
      : h('p', { class: 'sub' }, 'Nothing delivered yet. Click a platform in a stop to set what it loads or unloads.');

    return h('div', { class: 'te-window', role: 'dialog', 'aria-label': 'Train editor' },
      h('header', { class: 'te-head' },
        h('span', { class: 'train-dot big', style: `background:${t.color}` }), name, color,
        h('span', { class: 'sub' }, sim.roundTrip ? `Round trip ${fmtLen(sim.distance)} · ≈ ${fmtTime(sim.roundTrip)}` : 'Add stops to see the round trip'),
        h('span', { class: 'spacer' }),
        h('button', { class: 'btn', onclick: closeEditor }, '✕ Close')),
      h('div', { class: 'te-body' },
        h('main', { class: 'te-main' },
          vehicles,
          h('section', { class: 'te-section' },
            h('div', { class: 'te-section-head' }, h('h4', {}, 'Stops'), addStop),
            scenes.length ? scenes : h('p', { class: 'sub' }, 'No stops yet. Add the stations this train visits, in order; after the last stop it returns to the first.'))),
        h('aside', { class: 'te-side' },
          h('h4', {}, 'Expected'),
          h('div', { class: 'kv' },
            h('span', {}, 'Round trip'), h('span', { class: 'num' }, sim.roundTrip ? `${fmtLen(sim.distance)} · ≈ ${fmtTime(sim.roundTrip)}` : '—'),
            h('span', {}, 'Vehicles'), h('span', { class: 'num' }, `${sim.locos} loco + ${sim.cars} car${sim.cars === 1 ? '' : 's'}`),
            h('span', {}, 'Power'), h('span', { class: 'num' }, `up to ${fmt(sim.locos * R.TRAIN.locoPower, 0)} MW`)),
          h('div', { class: 'flow-list' }, delivered),
          sim.warnings.map((w) => h('p', { class: 'fp-warn' }, w)),
          h('h4', {}, 'Cargo after each stop'),
          cargoTimeline(t, sim) || h('p', { class: 'sub' }, '—'),
          h('div', { class: 'btn-row', style: 'margin-top:12px' }, h('button', { class: 'btn small danger', onclick: () => {
            if (!confirm(`Delete ${t.name}?`)) return;
            st().trains = st().trains.filter((x) => x !== t);
            closeEditor();
          } }, 'Delete train')))));
  }

  // What every car carries after each stop.
  function cargoTimeline(t, sim) {
    const cars = t.consist.map((v, i) => ({ v, i })).filter((x) => x.v.type !== 'loco');
    if (!cars.length || !t.stops.length) return null;
    return h('table', { class: 'te-timeline' },
      h('thead', {}, h('tr', {}, h('th', {}, 'Car'), t.stops.map((_, si) => h('th', { class: 'r' }, `Stop ${si + 1}`)))),
      h('tbody', {}, cars.map(({ i }) => h('tr', {}, h('td', {}, `Car ${i + 1}`),
        t.stops.map((_, si) => {
          const slot = (sim.stops[si] || { slots: [] }).slots.find((x) => x.vehicle === i);
          const act = slot && slot.action;
          const moved = act === 'load' || act === 'unload';
          return h('td', { class: 'r' + (moved ? ' ' + act : ''), title: moved ? `${act} ${D.items[slot.item].name}` : '' },
            act === 'load' ? '+' : act === 'unload' ? '−' : '',
            slot && slot.after ? itemIcon(slot.after, 18) : h('span', { class: 'sub' }, 'empty'));
        })))));
  }

  // ---------- Route planner (side panel) ----------
  function open(ref, trainId) {
    planner = { ref };
    if (trainId) openTrain = trainId;
    ctx.refresh();
  }
  function close() {
    planner = null;
    editor = null;
    if (overlay) overlay.hidden = true;
    ctx.refresh();
  }
  const active = () => !!planner;
  const currentNetwork = (g) => (planner ? R.networkOf(g, planner.ref) : null);

  function renderPlanner(side) {
    const g = graph();
    const net = currentNetwork(g);
    if (net == null) {
      put(side, h('button', { class: 'btn ghost small', onclick: close }, '← Back'),
        h('p', { class: 'fp-warn' }, 'This railway or station is no longer part of a rail network.'));
      return;
    }
    const stations = stationsOfNetwork(g, net);
    const lines = st().infra.lines.filter((l) => l.kind === 'rail' && R.networkOf(g, { type: 'line', id: l.id }) === net);
    const track = lines.reduce((a, l) => a + polylineLength(l.points), 0);
    const trains = trainsInNetwork(g, net);
    const sims = new Map(trains.map((t) => [t.id, R.simulate(t, stations, g)]));

    put(side,
      h('div', { class: 'planner-head' },
        h('button', { class: 'btn ghost small', onclick: close }, '✕ Close'),
        h('h3', {}, 'Route planner'),
        h('span', { class: 'sub' }, `${stations.length} station${stations.length === 1 ? '' : 's'} · ${fmtLen(track)} of track · ${trains.length} train${trains.length === 1 ? '' : 's'}`)),
      h('section', { class: 'fp-card' }, h('h3', {}, 'Stations'),
        stations.length ? h('div', { class: 'station-chips' }, stations.map((s) => h('button', { class: 'station-chip', title: 'Open the station planner', onclick: () => openStation(s.id) },
          iconImg('trainStation', 16), stationLabel(s), h('span', { class: 'badge' }, `${buildings(s).length}`))))
          : h('p', { class: 'sub' }, 'No stations on this network yet. Place a Train station on the track.')),
      h('div', { class: 'panel-head' }, h('h3', { class: 'section-title' }, 'Trains'),
        h('button', { class: 'btn small primary', onclick: () => {
          const t = { id: uid(), name: `Train ${st().trains.length + 1}`, color: COLORS[st().trains.length % COLORS.length], network: net,
            consist: [{ type: 'loco', reversed: false }, { type: 'car' }, { type: 'car' }], stops: [] };
          st().trains.push(t);
          openTrain = t.id;
          editor = { kind: 'train', id: t.id };
          ctx.commit();
        } }, '+ New train')),
      trains.length ? trains.map((t) => trainCard(t, sims.get(t.id))) : h('p', { class: 'sub' }, 'No trains yet.'),
      networkSummary(stations, trains, sims, track));
  }

  function trainCard(t, sim) {
    const delivered = {};
    sim.flows.forEach((f) => (delivered[f.item] = (delivered[f.item] || 0) + f.perMin));
    const mini = h('div', { class: 'mini-train' }, t.consist.map((v) => h('span', { class: 'mini-veh ' + (v.type === 'loco' ? 'loco' : 'car'), style: `--train:${t.color}` })));
    return h('section', { class: 'fp-card train-card' + (openTrain === t.id ? ' open' : ''), style: `border-left: 3px solid ${t.color}` },
      h('button', { class: 'train-head', onclick: () => { openTrain = openTrain === t.id ? null : t.id; ctx.refresh(); } },
        h('span', { class: 'train-dot', style: `background:${t.color}` }), h('span', { class: 'strong' }, t.name), mini,
        sim.warnings.length ? h('span', { class: 'warn-dot', title: sim.warnings.join('\n') }, '!') : h('span', {}), h('span', {})),
      h('div', { class: 'sub' }, t.stops.length ? t.stops.map((x) => stopLabel(x)).join(' → ') : 'No stops yet'),
      Object.keys(delivered).length
        ? Object.entries(delivered).map(([i, r]) => h('div', { class: 'fp-lane-row' }, named(itemIcon(i, 18), D.items[i].name), h('span', { class: 'num' }, `${fmt(r, 0)}/min`), h('span', {})))
        : null,
      h('div', { class: 'btn-row' }, h('button', { class: 'btn small primary', onclick: () => openEditor(t.id) }, '⤢ Open train editor'),
        sim.roundTrip ? h('span', { class: 'sub' }, `round trip ≈ ${fmtTime(sim.roundTrip)}`) : null));
  }

  function networkSummary(stations, trains, sims, track) {
    const delivered = {};
    sims.forEach((sim) => sim.flows.forEach((f) => (delivered[f.item] = (delivered[f.item] || 0) + f.perMin)));
    const counts = { loco: 0, car: 0, station: 0, freight: 0, fluid: 0, empty: 0, trackMeters: track };
    trains.forEach((t) => t.consist.forEach((v) => (v.type === 'loco' ? counts.loco++ : counts.car++)));
    stations.forEach((s) => s.layout.forEach((p) => counts[p.kind]++));
    const bom = R.billOfMaterials(counts);
    const mats = Object.entries(bom.materials).sort((a, b) => b[1] - a[1]);
    return h('section', { class: 'fp-card' },
      h('h3', {}, 'Whole network'),
      h('h4', {}, 'Deliveries'),
      Object.keys(delivered).length
        ? Object.entries(delivered).map(([i, r]) => h('div', { class: 'fp-lane-row' }, named(itemIcon(i, 18), D.items[i].name), h('span', { class: 'num' }, `${fmt(r, 0)}/min`), h('span', {})))
        : h('p', { class: 'sub' }, 'Nothing yet.'),
      h('h4', {}, 'To build'),
      bom.parts.map((p) => h('div', { class: 'fp-lane-row' },
        named(h('img', { class: 'icon', src: `img/icons/${p.icon}.png`, width: 18, height: 18, alt: '' }), p.name),
        h('span', { class: 'num' }, `${p.count}${p.unit ? ' ' + p.unit : '×'}`), h('span', {}))),
      h('h4', {}, 'Materials'),
      mats.length ? h('div', { class: 'mat-grid' }, mats.map(([i, n]) => h('span', { class: 'chip' }, itemIcon(i, 18), D.items[i].name, h('span', { class: 'num' }, fmt(n, 0))))) : h('p', { class: 'sub' }, '—'),
      h('div', { class: 'kv', style: 'margin-top:6px' }, h('span', {}, 'Power'), h('span', { class: 'num' }, `≈ ${fmt(bom.power, 0)} MW at most`)),
      h('p', { class: 'hint' }, `Estimates: trains average ${R.TRAIN.speed} m/s, a stop with cargo takes ${R.TRAIN.dockTime} s, track costs 1 Steel Pipe + 1 Steel Beam per ~${R.TRAIN.trackSection} m. Signals and traffic are not modeled.`));
  }

  /** Train routes to draw on the map while the planner is open. */
  function highlight() {
    if (!planner) return [];
    const g = graph();
    const net = currentNetwork(g);
    if (net == null) return [];
    const stations = stationsOfNetwork(g, net);
    return trainsInNetwork(g, net)
      .map((t) => ({ points: R.simulate(t, stations, g).path, color: t.color, width: t.id === openTrain ? 7 : 3 }))
      .filter((x) => x.points.length > 1)
      .sort((a, b) => a.width - b.width);
  }

  return {
    stationSections, renderPlanner, open, close, active, highlight, stationRemoved,
    ensureSubs: ensureLayout, openEditor, openStation, closeEditor, editorOpen,
    renderEditor,
  };
};
