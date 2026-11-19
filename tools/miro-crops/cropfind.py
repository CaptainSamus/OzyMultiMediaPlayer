# Recover Miro crop positions from screenshots of the board.
#   python -I cropfind.py <board dir> <out json> <shot1> [<shot2> ...]
# For each screenshot: find where it sits on the board (scale + offset), from uncropped pictures
# whose look is known (the file, scaled); then for every cropped picture in it, search its file at
# many scales for the area that looks like what Miro shows. Writes { itemId: {x,y,w,h,score,shot} }.
import json, sys, os, math
import numpy as np
import cv2

board_dir, out_path, shots = sys.argv[1], sys.argv[2], sys.argv[3:]
items = json.load(open(os.path.join(board_dir, 'miro-items.json'), encoding='utf-8'))['items']
files = json.load(open(os.path.join(board_dir, 'miro-import.json'), encoding='utf-8'))['files']
byid = {i['id']: i for i in items}

def box(i, seen=()):
    g = i.get('geometry') or {}; p = i.get('position') or {}
    w = g.get('width') or 0; h = g.get('height') or w
    x, y = p.get('x', 0), p.get('y', 0)
    par = i.get('parent') and byid.get(i['parent']['id'])
    if par and p.get('relativeTo') == 'parent_top_left' and i['id'] not in seen:
        px, py, pw, ph = box(par, seen + (i['id'],)); x += px; y += py
    return (x - w / 2, y - h / 2, w, h)

_cache = {}
def load(path, bg=(176, 176, 176)):
    if path in _cache: return _cache[path]
    im = cv2.imdecode(np.fromfile(path, dtype=np.uint8), cv2.IMREAD_UNCHANGED)
    if im is None: _cache[path] = None; return None
    if im.ndim == 2: im = cv2.cvtColor(im, cv2.COLOR_GRAY2BGR)
    if im.shape[2] == 4:  # see-through parts: on the board's grey, as Miro shows them
        a = im[:, :, 3:4].astype(np.float32) / 255
        im = (im[:, :, :3].astype(np.float32) * a + np.array(bg, np.float32) * (1 - a)).astype(np.uint8)
    _cache[path] = im
    return im

pics = []
for i in items:
    if i['type'] != 'image': continue
    f = files.get(i['id'])
    if not f or not f.get('path') or not os.path.exists(f['path']): continue
    rot = abs(((i.get('geometry') or {}).get('rotation') or 0) % 360)
    x, y, w, h = box(i)
    size = f.get('size')
    pics.append({'id': i['id'], 'x': x, 'y': y, 'w': w, 'h': h, 'path': f['path'], 'rot': rot, 'size': size})
for p in pics:
    if not p['size']:
        im = load(p['path']); p['size'] = {'w': im.shape[1], 'h': im.shape[0]} if im is not None else None
pics = [p for p in pics if p['size']]
for p in pics:
    fa = p['size']['w'] / p['size']['h']; ba = p['w'] / p['h']
    p['cropped'] = abs(ba - fa) / fa > 0.01

def ncc(img, tpl):
    r = cv2.matchTemplate(img, tpl, cv2.TM_CCOEFF_NORMED)
    _, mx, _, loc = cv2.minMaxLoc(r)
    return mx, loc

def place(shot, s, X0, Y0, p):
    return ((p['x'] - X0) * s, (p['y'] - Y0) * s, p['w'] * s, p['h'] * s)

def locate(shot, s_guess=None, X0=None, Y0=None):
    """The board -> screenshot transform: screen = (board - (X0, Y0)) * s."""
    H, W = shot.shape[:2]
    gray = cv2.cvtColor(shot, cv2.COLOR_BGR2GRAY)
    cand = [p for p in pics if not p['cropped'] and p['rot'] < 0.5]
    best = None
    scales = [s_guess] if s_guess else list(np.geomspace(0.006, 0.03, 30))
    for s in scales:
        votes = []
        for p in cand:
            tw, th = int(round(p['w'] * s)), int(round(p['h'] * s))
            if tw < 24 or th < 24 or tw >= W or th >= H: continue
            if X0 is not None:
                sx, sy, _, _ = place(shot, s, X0, Y0, p)
                if sx < -tw or sy < -th or sx > W or sy > H: continue
            im = load(p['path'])
            if im is None: continue
            tpl = cv2.cvtColor(cv2.resize(im, (tw, th), interpolation=cv2.INTER_AREA), cv2.COLOR_BGR2GRAY)
            if tpl.std() < 8: continue  # flat pictures match anywhere
            if X0 is not None:  # near where it should be
                sx, sy = int(round((p['x'] - X0) * s)), int(round((p['y'] - Y0) * s))
                m = 25
                x0, y0 = max(0, sx - m), max(0, sy - m); x1, y1 = min(W, sx + tw + m), min(H, sy + th + m)
                if x1 - x0 < tw or y1 - y0 < th: continue
                sc, loc = ncc(gray[y0:y1, x0:x1], tpl); loc = (loc[0] + x0, loc[1] + y0)
            else:
                sc, loc = ncc(gray, tpl)
            if sc > 0.85: votes.append((p['x'] - loc[0] / s, p['y'] - loc[1] / s, sc, p['id']))
        if not votes: continue
        # the offset most matches agree on
        arr = np.array([(v[0], v[1]) for v in votes])
        bestc = None
        for v in arr:
            n = np.sum(np.hypot(*(arr - v).T) < 3 / s)
            if bestc is None or n > bestc[0]: bestc = (n, v)
        n, v = bestc
        close = arr[np.hypot(*(arr - v).T) < 3 / s]
        X, Y = np.median(close[:, 0]), np.median(close[:, 1])
        if best is None or n > best[0]: best = (n, s, X, Y)
    return best

def refine_scale(shot, s, X0, Y0):
    """Least squares on matched pictures' corners: a better scale and offset."""
    gray = cv2.cvtColor(shot, cv2.COLOR_BGR2GRAY); H, W = gray.shape
    rows = []
    for p in pics:
        if p['cropped'] or p['rot'] >= 0.5: continue
        tw, th = int(round(p['w'] * s)), int(round(p['h'] * s))
        sx, sy = (p['x'] - X0) * s, (p['y'] - Y0) * s
        if tw < 24 or th < 24 or sx < 0 or sy < 0 or sx + tw > W or sy + th > H: continue
        im = load(p['path']); tpl = cv2.cvtColor(cv2.resize(im, (tw, th), interpolation=cv2.INTER_AREA), cv2.COLOR_BGR2GRAY)
        if tpl.std() < 8: continue
        m = 8; x0, y0 = max(0, int(sx) - m), max(0, int(sy) - m); x1, y1 = min(W, int(sx) + tw + m), min(H, int(sy) + th + m)
        sc, loc = ncc(gray[y0:y1, x0:x1], tpl)
        if sc > 0.9: rows.append((p['x'], loc[0] + x0, p['y'], loc[1] + y0))
    if len(rows) < 3: return s, X0, Y0, len(rows)
    r = np.array(rows)
    # screen = s*board - s*X0  (fit x and y together for one s)
    A = np.zeros((2 * len(r), 3)); b = np.zeros(2 * len(r))
    A[0::2, 0] = r[:, 0]; A[0::2, 1] = -1; b[0::2] = r[:, 1]
    A[1::2, 0] = r[:, 2]; A[1::2, 2] = -1; b[1::2] = r[:, 3]
    (s2, a, c), *_ = np.linalg.lstsq(A, b, rcond=None)
    return s2, a / s2, c / s2, len(rows)


def refine_mask(shot, s, X0, Y0, M=int(os.environ.get('MASKM', '60'))):
    """Slide the outline of where every picture should be over the screenshot (and try scales
    near s): the place where the outline and the screenshot's pictures overlap most."""
    H, W = shot.shape[:2]
    px = shot.reshape(-1, 3)
    vals, counts = np.unique((px // 8).astype(np.int32) @ np.array([1024, 32, 1]), return_counts=True)
    v = vals[np.argmax(counts)]; bg = np.array([(v // 1024) * 8 + 4, ((v // 32) % 32) * 8 + 4, (v % 32) * 8 + 4])
    fg = (np.abs(shot.astype(np.int32) - bg).sum(axis=2) > 45).astype(np.float32)
    best = None
    for k in np.linspace(0.94, 1.06, 25):
        s2 = s * k
        # keep the screenshot's middle fixed while trying scales
        cx, cy = X0 + W / 2 / s, Y0 + H / 2 / s
        X2, Y2 = cx - W / 2 / s2, cy - H / 2 / s2
        mask = np.zeros((H + 2 * M, W + 2 * M), np.float32)
        for p in pics:
            x0, y0 = (p['x'] - X2) * s2 + M, (p['y'] - Y2) * s2 + M
            x1, y1 = x0 + p['w'] * s2, y0 + p['h'] * s2
            if x1 < 0 or y1 < 0 or x0 > W + 2 * M or y0 > H + 2 * M: continue
            cv2.rectangle(mask, (int(x0), int(y0)), (int(x1), int(y1)), 1.0, -1)
        r = cv2.matchTemplate(mask, fg, cv2.TM_CCORR_NORMED)
        _, mx, _, loc = cv2.minMaxLoc(r)
        dx, dy = loc[0] - M, loc[1] - M  # the screenshot sits this far into the outline
        cand = (mx, s2, X2 + dx / s2, Y2 + dy / s2)
        if best is None or cand[0] > best[0]: best = cand
    return best


def full_score(shot, s, X0, Y0, p):
    """How much the whole file, at the size Miro shows it, looks like what is there."""
    H, W = shot.shape[:2]
    sx, sy, sw, sh = place(shot, s, X0, Y0, p)
    m = 2
    x0, y0, x1, y1 = int(math.ceil(sx + m)), int(math.ceil(sy + m)), int(math.floor(sx + sw - m)), int(math.floor(sy + sh - m))
    if x0 < 0 or y0 < 0 or x1 > W or y1 > H or x1 - x0 < 16 or y1 - y0 < 16: return None
    patch = cv2.cvtColor(shot[y0:y1, x0:x1], cv2.COLOR_BGR2GRAY)
    im = load(p['path'])
    if im is None: return None
    g = cv2.resize(cv2.cvtColor(im, cv2.COLOR_BGR2GRAY), (int(round(sw)), int(round(sh))), interpolation=cv2.INTER_AREA)
    if g.shape[0] < patch.shape[0] or g.shape[1] < patch.shape[1]: return None
    sc, _ = ncc(g, patch)
    return sc

def find_crop(shot, s, X0, Y0, p):
    H, W = shot.shape[:2]
    sx, sy, sw, sh = place(shot, s, X0, Y0, p)
    m = 2  # leave the edges out: they may catch a neighbour or the board
    x0, y0, x1, y1 = int(math.ceil(sx + m)), int(math.ceil(sy + m)), int(math.floor(sx + sw - m)), int(math.floor(sy + sh - m))
    if x0 < 0 or y0 < 0 or x1 > W or y1 > H or x1 - x0 < 16 or y1 - y0 < 16: return None
    patch = cv2.cvtColor(shot[y0:y1, x0:x1], cv2.COLOR_BGR2GRAY)
    if patch.std() < 6: return None
    # only the part no other picture overlaps: one on top would spoil the comparison
    pmask = None
    if os.environ.get('MASKOVERLAP'):
        pmask = np.full(patch.shape, 255, np.uint8)
        for q in pics:
            if q is p: continue
            qx, qy, qw, qh = place(shot, s, X0, Y0, q)
            ax0, ay0 = int(math.floor(qx - x0)) - 1, int(math.floor(qy - y0)) - 1
            ax1, ay1 = int(math.ceil(qx + qw - x0)) + 1, int(math.ceil(qy + qh - y0)) + 1
            if ax1 <= 0 or ay1 <= 0 or ax0 >= patch.shape[1] or ay0 >= patch.shape[0]: continue
            pmask[max(0, ay0):max(0, ay1), max(0, ax0):max(0, ax1)] = 0
        if pmask.mean() < 255 * 0.25 or pmask.min() == 255: pmask = None  # too little left, or nothing covered
    im = load(p['path'])
    if im is None: return None
    g = cv2.cvtColor(im, cv2.COLOR_BGR2GRAY)
    nW, nH = p['size']['w'], p['size']['h']
    # the scale (screen px per file px) the file is shown at: at least so the frame fits in it
    fmin = max(sw / nW, sh / nH)
    best = None
    wide = float(os.environ.get('WIDE', '8'))
    for f in np.geomspace(fmin * 0.98, fmin * wide, int(os.environ.get('STEPS', '60'))):
        rw, rh = int(round(nW * f)), int(round(nH * f))
        if rw < patch.shape[1] or rh < patch.shape[0] or rw * rh > 2.5e7: continue
        img2 = cv2.resize(g, (rw, rh), interpolation=cv2.INTER_AREA)
        if pmask is not None:
            res = np.nan_to_num(cv2.matchTemplate(img2, patch, cv2.TM_CCOEFF_NORMED, mask=pmask), nan=-1, posinf=-1, neginf=-1)
            _, sc, _, loc = cv2.minMaxLoc(res)
        else:
            sc, loc = ncc(img2, patch)
        if best is None or sc > best[0]: best = (sc, f, loc)
    if not best: return None
    sc, f, (lx, ly) = best
    # back to the whole frame (the patch started m px in), as fractions of the file
    fx, fy = (lx - (x0 - sx)) / f, (ly - (y0 - sy)) / f
    cw, ch = sw / f, sh / f
    return {'x': fx / nW, 'y': fy / nH, 'w': cw / nW, 'h': ch / nH, 'score': round(float(sc), 3)}

out = {}
try: out = json.load(open(out_path, encoding='utf-8'))
except Exception: pass
for k, path in enumerate(shots):
    shot = cv2.imdecode(np.fromfile(path, dtype=np.uint8), cv2.IMREAD_COLOR)
    H, W = shot.shape[:2]
    hint = json.loads(os.environ.get('HINT%d' % (k + 1), 'null'))
    exact = json.loads(os.environ.get('EXACT%d' % (k + 1), 'null'))
    if exact:
        loc = (0, exact['s'], exact['X0'], exact['Y0'])
    elif hint and 'X0' in hint:
        loc = locate(shot, hint['s'], hint['X0'], hint['Y0'])
    elif hint:
        loc = locate(shot, hint['s'])
    else:
        loc = locate(shot)
    if not loc and exact: loc = (0, exact['s'], exact['X0'], exact['Y0'])
    if not loc and hint and 'X0' in hint and os.environ.get('MASKFIT'): loc = (0, hint['s'], hint['X0'], hint['Y0'])  # the outline fit places it
    if not loc: print(path, 'could not be placed on the board'); continue
    n, s, X0, Y0 = loc
    if exact: s, X0, Y0 = exact['s'], exact['X0'], exact['Y0']
    if os.environ.get('MASKFIT') and not exact:
        sc, s, X0, Y0 = refine_mask(shot, s, X0, Y0)
        print('  outline fit %.3f' % sc)
    nfit = 0
    if not exact:
        s, X0, Y0, nfit = refine_scale(shot, s, X0, Y0)
        s, X0, Y0, nfit = refine_scale(shot, s, X0, Y0)
    print('transform', json.dumps({'s': s, 'X0': X0, 'Y0': Y0}))
    print('%s: %dx%d, scale %.6f, offset (%.0f, %.0f), placed by %d pictures, fitted on %d' % (os.path.basename(path), W, H, s, X0, Y0, n, nfit))
    done = good = 0
    for p in pics:
        if p['rot'] >= 0.5: continue
        if not p['cropped'] and not os.environ.get('SAMESHAPE'): continue
        if os.environ.get('ONLYWEAK') and out.get(p['id'], {}).get('score', 0) >= 0.8: continue
        sx, sy, sw, sh = place(shot, s, X0, Y0, p)
        if sx < 0 or sy < 0 or sx + sw > W or sy + sh > H: continue
        if not p['cropped']:
            # the same shape as its file: cropped only if the whole file does not look like what Miro shows
            full = full_score(shot, s, X0, Y0, p)
            if full is None or full >= 0.8: continue
        r = find_crop(shot, s, X0, Y0, p)
        if r and not p['cropped'] and (r['score'] < 0.8 or r['score'] < full + 0.15 or r['w'] > 0.97): r = None  # not clearly a crop
        done += 1
        if not r: continue
        r['shot'] = os.path.basename(path)
        prev = out.get(p['id'])
        if not prev or r['score'] > prev['score']: out[p['id']] = r
        if r['score'] >= 0.8: good += 1
    print('  cropped pictures in it: %d, matched well: %d' % (done, good))
json.dump(out, open(out_path, 'w', encoding='utf-8'), indent=1)
total = sum(1 for p in pics if p['cropped'])
print('crops found: %d (score >= 0.8: %d) of %d cropped pictures on the board' % (len(out), sum(1 for v in out.values() if v['score'] >= 0.8), total))
