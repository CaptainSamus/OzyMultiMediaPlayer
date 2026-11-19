// To-do blocks (Mark, 2026-11-17): a goal at the top and the tasks that get it done under it,
// each with as many sub-tasks as it needs, as deep as needed. A block is a text tile with
// tile.todo = { title, color, items }, each item { id, text, done, color, open, kids }. This file is
// its rules: cleaning a saved list, finding an item, adding, indenting, outdenting, moving and
// removing items, ticking (a task with sub-tasks is done when all of them are), the progress, the
// order the rows show in, and the plain-text form an older Ozy shows in its place.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.TodoList = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  const DEFAULT_TITLE = 'To-do';
  const MAX_ITEMS = 2000;
  const MAX_DEPTH = 12;
  const okColor = (c) => (typeof c === 'string' && /^#[0-9a-f]{6}$/i.test(c) ? c.toLowerCase() : '');
  const str = (v, max) => (typeof v === 'string' ? v : v == null ? '' : String(v)).slice(0, max);
  let idSeq = 0;
  const newId = () => 't' + Date.now().toString(36) + (idSeq++).toString(36) + Math.random().toString(36).slice(2, 5);

  function item(text = '', extra = {}) {
    return { id: extra.id || newId(), text: str(text, 2000), done: !!extra.done, color: okColor(extra.color), open: extra.open !== false, kids: [] };
  }
  function normalize(raw) {
    const r = raw && typeof raw === 'object' ? raw : {};
    const seen = new Set();
    let count = 0;
    const walk = (list, depth) => {
      const out = [];
      if (!Array.isArray(list)) return out;
      for (const x of list) {
        if (!x || typeof x !== 'object' || count >= MAX_ITEMS) continue;
        count++;
        let id = /^[a-z0-9_-]{1,40}$/i.test(String(x.id || '')) ? String(x.id) : newId();
        while (seen.has(id)) id += 'x';
        seen.add(id);
        const it = item(x.text, { id, done: x.done, color: x.color, open: x.open });
        if (depth < MAX_DEPTH) { it.kids = walk(x.kids, depth + 1); out.push(it); }
        else { out.push(it); for (const k of walk(x.kids, depth)) out.push(k); } // deeper than allowed: its sub-tasks join it at the last level
      }
      return out;
    };
    const items = walk(r.items, 1);
    settle(items);
    const title = str(r.title, 300).replace(/\s+/g, ' ').trim();
    return { title: title || (r.title === '' ? '' : DEFAULT_TITLE), color: okColor(r.color), items };
  }
  const clone = (m) => JSON.parse(JSON.stringify(m));

  // where an item is: its list, its place in it, and its parent (null at the top)
  function find(items, id, parent = null) {
    for (let i = 0; i < items.length; i++) {
      const it = items[i];
      if (it.id === id) return { list: items, index: i, item: it, parent };
      const f = find(it.kids, id, it);
      if (f) return f;
    }
    return null;
  }
  function depthOf(items, id) {
    let d = 0;
    let f = find(items, id);
    if (!f) return -1;
    while (f && f.parent) { d++; f = find(items, f.parent.id); }
    return d;
  }
  // A task with sub-tasks is done exactly when all of them are (deepest first).
  function settle(items) {
    for (const it of items) {
      if (it.kids.length) { settle(it.kids); it.done = it.kids.every((k) => k.done); }
    }
    return items;
  }
  const setAll = (it, done) => { it.done = done; for (const k of it.kids) setAll(k, done); };
  // Each of these takes a model (changed in place) and returns true when it changed something.
  function toggle(m, id, done) {
    const f = find(m.items, id);
    if (!f) return false;
    const to = done == null ? !f.item.done : !!done;
    setAll(f.item, to); // ticking a goal ticks everything under it; unticking it opens them all again
    settle(m.items);
    return true;
  }
  // a new item after this one (or, when it shows its sub-tasks, as the first of them)
  function addAfter(m, id, text = '', { asFirstChild = false } = {}) {
    if (count(m.items) >= MAX_ITEMS) return null;
    const it = item(text);
    const f = id ? find(m.items, id) : null;
    if (!f) { m.items.push(it); settle(m.items); return it.id; }
    if (asFirstChild && depthOf(m.items, id) < MAX_DEPTH - 1) { f.item.open = true; f.item.kids.unshift(it); }
    else f.list.splice(f.index + 1, 0, it);
    settle(m.items);
    return it.id;
  }
  function addBefore(m, id, text = '') {
    const f = find(m.items, id);
    if (!f || count(m.items) >= MAX_ITEMS) return null;
    const it = item(text);
    f.list.splice(f.index, 0, it);
    settle(m.items);
    return it.id;
  }
  function addChild(m, id, text = '') {
    const f = find(m.items, id);
    if (!f || count(m.items) >= MAX_ITEMS || depthOf(m.items, id) >= MAX_DEPTH - 1) return null;
    const it = item(text);
    f.item.open = true;
    f.item.kids.push(it);
    settle(m.items);
    return it.id;
  }
  // Tab: becomes the last sub-task of the task above it (at its level)
  function indent(m, id) {
    const f = find(m.items, id);
    if (!f || f.index === 0) return false;
    const prev = f.list[f.index - 1];
    if (depthOf(m.items, prev.id) + 1 + height(f.item) > MAX_DEPTH - 1) return false;
    f.list.splice(f.index, 1);
    prev.open = true;
    prev.kids.push(f.item);
    settle(m.items);
    return true;
  }
  // Shift+Tab: goes up a level, just after the task it was under
  function outdent(m, id) {
    const f = find(m.items, id);
    if (!f || !f.parent) return false;
    const p = find(m.items, f.parent.id);
    f.list.splice(f.index, 1);
    p.list.splice(p.index + 1, 0, f.item);
    settle(m.items);
    return true;
  }
  function move(m, id, delta) {
    const f = find(m.items, id);
    if (!f) return false;
    const j = f.index + delta;
    if (j < 0 || j >= f.list.length) return false;
    f.list.splice(f.index, 1);
    f.list.splice(j, 0, f.item);
    return true;
  }
  function remove(m, id) {
    const f = find(m.items, id);
    if (!f) return false;
    f.list.splice(f.index, 1);
    settle(m.items);
    return true;
  }
  function setText(m, id, text) {
    const f = find(m.items, id);
    if (!f) return false;
    const t = str(text, 2000);
    if (f.item.text === t) return false;
    f.item.text = t;
    return true;
  }
  function setColor(m, id, color) {
    const f = find(m.items, id);
    if (!f) return false;
    f.item.color = okColor(color);
    return true;
  }
  function setOpen(m, id, open) {
    const f = find(m.items, id);
    if (!f || !f.item.kids.length) return false;
    f.item.open = open == null ? !f.item.open : !!open;
    return true;
  }
  function setAllOpen(m, open) {
    const walk = (l) => { for (const it of l) { if (it.kids.length) it.open = open; walk(it.kids); } };
    walk(m.items);
    return true;
  }
  // done tasks that have nothing left under them go
  function clearDone(m) {
    let n = 0;
    const walk = (l) => { for (let i = l.length - 1; i >= 0; i--) { if (l[i].done) { n += 1 + count(l[i].kids); l.splice(i, 1); } else walk(l[i].kids); } };
    walk(m.items);
    settle(m.items);
    return n;
  }
  function uncheckAll(m) { for (const it of m.items) setAll(it, false); return true; }
  function count(items) { let n = 0; for (const it of items) n += 1 + count(it.kids); return n; }
  function height(it) { return it.kids.length ? 1 + Math.max(...it.kids.map(height)) : 0; }
  // how far along: the tasks with no sub-tasks (the real work), done of all
  function progress(items) {
    let done = 0, total = 0;
    const walk = (l) => { for (const it of l) { if (it.kids.length) walk(it.kids); else { total++; if (it.done) done++; } } };
    walk(items);
    return { done, total };
  }
  // the rows as shown: each item with its depth, skipping what is inside a folded task
  function visible(items, depth = 0, out = []) {
    for (const it of items) {
      out.push({ item: it, depth });
      if (it.kids.length && it.open) visible(it.kids, depth + 1, out);
    }
    return out;
  }
  function neighbour(items, id, dir) {
    const v = visible(items);
    const i = v.findIndex((x) => x.item.id === id);
    const j = i + dir;
    return i >= 0 && j >= 0 && j < v.length ? v[j].item.id : null;
  }
  // as text: what an older Ozy shows in its place, and what Find (Ctrl+F) searches
  function summary(m) {
    const lines = [m.title || DEFAULT_TITLE];
    const walk = (l, d) => { for (const it of l) { lines.push(`${'  '.repeat(d)}${it.done ? '☑' : '☐'} ${it.text.replace(/\s+/g, ' ').trim()}`); walk(it.kids, d + 1); } };
    walk(m.items, 0);
    return lines.join('\n').slice(0, 20000);
  }
  // Pasted lines become tasks; leading spaces, tabs, "-", "*", "•" or "[ ]" / "[x]" give the level and state.
  function fromText(text) {
    const out = [];
    const stack = [{ indent: -1, kids: out }];
    for (const raw of str(text, 100000).split(/\r?\n/)) {
      if (!raw.trim()) continue;
      const lead = /^[ \t]*/.exec(raw)[0].replace(/\t/g, '  ').length;
      let t = raw.trim();
      let done = false;
      const box = /^(?:[-*•]\s*)?\[( |x|X)\]\s*/.exec(t);
      if (box) { done = box[1] !== ' '; t = t.slice(box[0].length); } else t = t.replace(/^(?:[-*•]|\d+[.)]|[☐☑✓✔])\s+/, '');
      if (/^☑|^✓|^✔/.test(raw.trim())) done = true;
      while (stack.length > 1 && stack[stack.length - 1].indent >= lead) stack.pop();
      const it = item(t, { done });
      stack[stack.length - 1].kids.push(it);
      if (stack.length <= MAX_DEPTH) stack.push({ indent: lead, kids: it.kids });
      if (out.length + 1 > MAX_ITEMS) break;
    }
    settle(out);
    return out;
  }

  return { DEFAULT_TITLE, MAX_DEPTH, okColor, item, normalize, clone, find, depthOf, settle, toggle, addAfter, addBefore, addChild, indent, outdent, move, remove, setText, setColor, setOpen, setAllOpen, clearDone, uncheckAll, count, progress, visible, neighbour, summary, fromText };
});
