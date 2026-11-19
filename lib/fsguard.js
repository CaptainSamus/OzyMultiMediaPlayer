// Every file call the main process makes on a path the user gave us (a session's videos, a folder
// source, the localvideo:// server) goes through here, so that a share that no longer answers can
// never stall the app: a plain call on an unreachable UNC path blocks for as long as Windows takes
// to give up (~26 s), once per file.
//
// The "every video goes red when lots of programs are open" bug lived here (fixed 2026-11-05).
// It used to give up after 3 s on ANY path and put the path's whole root - a drive letter like
// "d:" - on a dead list for the rest of the session. With the PC busy (RAM paging, the disk queue
// full, Node's few file threads taken by videos streaming), one check on a healthy LOCAL disk could
// take longer than that, and from then on every file on that drive answered "not found" at once:
// every video red, nothing helping until the app was restarted with the PC less busy. Now:
//   - only network roots (UNC shares, mapped network drives) ever go on the dead list;
//   - a local disk gets a long timeout and is never written off: slow there means busy, not gone;
//   - a call that timed out but later succeeds proves its root alive: a network root comes off
//     the dead list, and onRevive tells the windows so whatever failed meanwhile loads again.
{
  const TIMED_OUT = Symbol('timed out');
  // "\\\\server\\share" or "x:" (lower case), or null for a path with neither (macOS, relative)
  const pathRoot = (p) => {
    const s = String(p);
    const unc = /^\\\\[^\\/]+[\\/][^\\/]+/.exec(s);
    if (unc) return unc[0].toLowerCase();
    const drive = /^[A-Za-z]:/.exec(s);
    return drive ? drive[0].toLowerCase() : null;
  };
  // `Get-CimInstance Win32_LogicalDisk` lines ("Z: 4") -> the drive letters that are network drives
  const networkDrivesFrom = (stdout) => {
    const out = new Set();
    for (const line of String(stdout || '').split(/\r?\n/)) {
      const m = /^([A-Za-z]:)\s+(\d+)/.exec(line.trim());
      if (m && Number(m[2]) === 4) out.add(m[1].toLowerCase()); // DriveType 4 = network drive
    }
    return out;
  };
  function create({ networkMs = 3000, localMs = 30000, networkDrives = new Set(), onRevive = () => {}, log = () => {} } = {}) {
    const deadRoots = new Map(); // root -> when it timed out
    const isNetworkRoot = (root) => !!root && (root.startsWith('\\\\') || networkDrives.has(root));
    function revive(root, network) {
      if (network && !deadRoots.delete(root)) return;
      log('info', network ? 'share answered again' : 'slow local path answered', { root: root || '(no root)' });
      onRevive(root || '');
    }
    // Run work() against path p and never wait on it forever: `fallback` when it fails, times out
    // or sits on a network root that already timed out this session.
    async function run(p, work, fallback) {
      if (typeof p !== 'string' || !p) return fallback;
      const root = pathRoot(p);
      const network = isNetworkRoot(root);
      if (network && deadRoots.has(root)) return fallback;
      const limit = network ? networkMs : localMs;
      let timer = null;
      const timeout = new Promise((resolve) => { timer = setTimeout(() => resolve(TIMED_OUT), limit); });
      const job = Promise.resolve().then(work);
      let result;
      try { result = await Promise.race([job, timeout]); }
      catch { clearTimeout(timer); return fallback; } // a normal error (missing file, no permission)
      clearTimeout(timer);
      if (result !== TIMED_OUT) return result;
      if (network) deadRoots.set(root, Date.now()); // the rest of this share answers at once now...
      // ...until this call comes back after all. Only success counts: a dead share fails too, late.
      job.then(() => revive(root, network), () => {});
      log('warn', network ? 'path timed out, treating the share as unreachable for now' : 'local path answered slowly (PC busy?)',
        { root: root || '(no root)', path: p, afterMs: limit });
      return fallback;
    }
    return { run, isNetworkRoot, isDead: (root) => deadRoots.has(root), forget: () => deadRoots.clear(), networkDrives };
  }
  const FsGuard = { create, pathRoot, networkDrivesFrom };
  if (typeof module !== 'undefined' && module.exports) module.exports = FsGuard;
}
