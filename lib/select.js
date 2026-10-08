// What a pointerdown on a board tile does to the selection. Pure, so the one rule Mark asked for
// (a plain click picks one tile) sits next to the ones that already existed and can't drift.
{
  const Select = {
    // inSelection: the tile is already selected; grouped/sticky: its group, if any; mod: Ctrl/Cmd
    onPointerDown({ inSelection, grouped, sticky, mod, shift }) {
      if (shift) return 'toggle';
      if (mod) return 'only';
      if (inSelection) return 'keep';          // a drag will move everything selected
      if (grouped && sticky) return 'group';   // the group's bar should show
      return 'only';
    },
    // What moves, or scales, together when `tile` is grabbed. `selected` is the current selection;
    // a tile outside it is on its own (plus its sticky group). single (Ctrl/Cmd): just that tile.
    // A move leaves the selected members of a non-sticky group behind - they move on their own -
    // except the one grabbed. keepSelected (a corner resize) keeps every selected tile: a selection
    // is explicit, and pulling a corner is expected to scale all of it. Either way a sticky group
    // that is touched comes whole. Only tiles on the board; the grabbed tile first.
    dragSet(tile, selected, single, { keepSelected = false } = {}) {
      if (single) return [tile];
      const base = selected.includes(tile) ? selected : [];
      const set = new Set([tile, ...base.filter((t) => keepSelected || !t.group || t.group.sticky)]);
      for (const t of [...set]) if (t.group && t.group.sticky) for (const m of t.group.members) set.add(m);
      return [...set].filter((t) => t === tile || t.board);
    },
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = Select;
  else window.Select = Select;
}
