// Bounded undo/redo stacks. Entries are opaque; the renderer decides how to apply them.
const Undo = {
  create(limit = 10) {
    let past = [], future = [];
    return {
      get size() { return past.length; },
      push(entry) { past.push(entry); if (past.length > limit) past.shift(); future = []; },
      undo() { const e = past.pop() || null; if (e) future.push(e); return e; },
      redo() { const e = future.pop() || null; if (e) past.push(e); return e; },
      clear() { past = []; future = []; },
    };
  },
};
if (typeof module !== 'undefined' && module.exports) module.exports = Undo;
else window.Undo = Undo;
