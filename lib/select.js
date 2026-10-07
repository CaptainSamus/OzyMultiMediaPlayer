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
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = Select;
  else window.Select = Select;
}
