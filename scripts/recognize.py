"""截图识别（纯图形，不跑 OCR、不调外部模型）。

步骤：
1. 找薄荷色加成药丸（一行「+NNN%」亮字），数字用游戏字体的字形模板逐字比对；
2. 找发光六边形本体，用色相判类型（黄/紫/红/蓝/绿/橙）；
3. 本体下方薄荷小方块里的数字当等级；
4. 本体上方的量子图纸小方块，与 img/bp 对照表做图案比对；
5. 把这几块并起来裁预览图。

认不出的字段一律留空（null），不猜。

inbox 文件名：<base64url 用户名>__<时间戳>_<序号>.png(jpg)
"""
import base64
import hashlib
import json
import os
import time

import cv2
import numpy as np

HERE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
INBOX = os.path.join(HERE, "inbox")
OUT = os.path.join(HERE, "inbox_out")
IMG = os.path.join(HERE, "img")
DIGITS = os.path.join(IMG, "digits")
BPINDEX = os.path.join(IMG, "bp", "index.json")

# 色相中心（OpenCV H 0..180）：黄=运输舰，紫=采矿，红=武器，蓝=护盾，绿=战斗，橙=无人机
TYPE_BY_HUE = [("trade", 34), ("mining", 138), ("weapon", 176), ("shield", 104), ("support", 70), ("drone", 22)]

_DIG = {}
_BP = []


def norm_tile(g, size=32):
    g = cv2.resize(g, (size, size), interpolation=cv2.INTER_AREA).astype(np.float32)
    lo, hi = np.percentile(g, 3), np.percentile(g, 97)
    return np.clip((g - lo) * 255.0 / max(6.0, hi - lo), 0, 255)


def load_digits():
    _DIG.clear()
    if not os.path.isdir(DIGITS):
        return _DIG
    for fn in os.listdir(DIGITS):
        name = os.path.splitext(fn)[0]
        ch = {"plus": "+", "pct": "%"}.get(name, name)
        g = cv2.imread(os.path.join(DIGITS, fn), 0)
        if g is not None:
            _DIG[ch] = g
    return _DIG


def load_blueprints():
    _BP.clear()
    try:
        with open(BPINDEX, encoding="utf-8") as f:
            d = json.load(f)
    except Exception as e:
        print("图纸表读取失败", e)
        return _BP
    for b in d.get("blueprints", []):
        for path in [b.get("img", "")] + list(b.get("alts") or []):
            p = os.path.join(HERE, path) if not os.path.isabs(path) else path
            g = cv2.imread(p, 0)
            if g is None:
                continue
            _BP.append(dict(key=b["key"], name=b.get("name", ""), v=norm_tile(g), dim=(path != b.get("img"))))
        print("图纸", b["key"], "载入")
    return _BP


def masks(img):
    hsv = cv2.cvtColor(img, cv2.COLOR_BGR2HSV)
    H, S, V = hsv[:, :, 0].astype(int), hsv[:, :, 1].astype(int), hsv[:, :, 2].astype(int)
    mint = ((H >= 65) & (H <= 105) & (S >= 25) & (V >= 180)).astype(np.uint8) * 255
    white = ((S < 80) & (V >= 205)).astype(np.uint8) * 255
    return mint, white


def split_glyphs(m):
    cols = (m > 0).sum(0) > 0
    spans, run = [], None
    for i, v in enumerate(cols):
        if v and run is None:
            run = i
        if not v and run is not None:
            if i - run >= 3:
                spans.append((run, i))
            run = None
    if run is not None and len(cols) - run >= 3:
        spans.append((run, len(cols)))
    out = []
    for a, b in spans:
        sub = m[:, a:b]
        ys = np.where(sub.any(1))[0]
        if len(ys) == 0:
            continue
        sub = sub[ys.min():ys.max() + 1]
        if sub.shape[0] < 10:
            continue
        out.append(sub)
    return out


def norm_glyph(g, W=20, H=26):
    h, w = g.shape
    sc = min(W / float(w), H / float(h))
    nw, nh = max(1, int(round(w * sc))), max(1, int(round(h * sc)))
    r = cv2.resize(g, (nw, nh), interpolation=cv2.INTER_AREA)
    out = np.zeros((H, W), np.uint8)
    oy, ox = (H - nh) // 2, (W - nw) // 2
    out[oy:oy + nh, ox:ox + nw] = r
    return out


def read_glyph(g):
    if not _DIG or g.size == 0:
        return "", 0.0
    g = norm_glyph(g).astype(np.float32)
    best, second = ("", 0.0), 0.0
    for ch, t in _DIG.items():
        tt = t.astype(np.float32)
        sc = float(cv2.matchTemplate(g, tt, cv2.TM_CCOEFF_NORMED)[0, 0])
        if sc > best[1]:
            second = best[1]
            best = (ch, sc)
        elif sc > second:
            second = sc
    return best if best[1] >= 0.40 and best[1] - second >= 0.02 else ("", best[1])


def read_line(m):
    return "".join(read_glyph(g)[0] for g in split_glyphs(m))


def num_of(s):
    d = "".join(c for c in s if c.isdigit())
    return int(d) if d else None


def boxes_of(mask, min_w, min_h, max_w, max_h, kh=11, kv=3):
    m = cv2.morphologyEx(mask, cv2.MORPH_CLOSE, np.ones((3, 3), np.uint8))
    m = cv2.morphologyEx(m, cv2.MORPH_CLOSE, cv2.getStructuringElement(cv2.MORPH_RECT, (kh, kv)))
    out = []
    for c in cv2.findContours(m, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)[0]:
        x, y, w, h = cv2.boundingRect(c)
        if min_w <= w <= max_w and min_h <= h <= max_h:
            out.append((x, y, w, h))
    return out


def dedupe(boxes, tol=0.45):
    keep = []
    for b in sorted(boxes, key=lambda b: -b[2] * b[3]):
        cx, cy, cw, ch = b[0] + b[2] / 2, b[1] + b[3] / 2, b[2], b[3]
        if all(not (abs(cx - (k[0] + k[2] / 2)) < tol * min(cw, k[2]) and
                   abs(cy - (k[1] + k[3] / 2)) < tol * min(ch, k[3])) for k in keep):
            keep.append(b)
    return keep


def find_pills(img):
    mint, _ = masks(img)
    out = []
    for b in dedupe(boxes_of(mint, 55, 26, 220, 52)):
        s = read_line(mint[b[1]:b[1] + b[3], b[0]:b[0] + b[2]])
        if "%" not in s:
            continue
        out.append(dict(box=(max(0, b[0] - 9), max(0, b[1] - 6), b[2] + 18, b[3] + 12), num=num_of(s)))
    return out


def find_bodies(img):
    hsv = cv2.cvtColor(img, cv2.COLOR_BGR2HSV)
    S, V = hsv[:, :, 1].astype(int), hsv[:, :, 2].astype(int)
    m = (((S > 90) & (V > 85)).astype(np.uint8)) * 255
    m = cv2.morphologyEx(m, cv2.MORPH_CLOSE, np.ones((9, 9), np.uint8))
    n, _, st, _ = cv2.connectedComponentsWithStats(m, 8)
    out = []
    for i in range(1, n):
        x, y, w, h, a = st[i]
        if a < 1800 or not (48 <= max(w, h) <= 320):
            continue
        if not (0.6 <= w / float(h) <= 1.7):
            continue
        if a < 0.32 * w * h:
            continue
        out.append((x, y, w, h))
    return dedupe(out, tol=0.6)


def type_of(img, body):
    x, y, w, h = body
    hsv = cv2.cvtColor(img[y:y + h, x:x + w], cv2.COLOR_BGR2HSV)
    S, V = hsv[:, :, 1].astype(int), hsv[:, :, 2].astype(int)
    sel = (S > 110) & (V > 90)
    if sel.sum() < 50:
        return ""
    ang = hsv[:, :, 0][sel].astype(float) * 2 * np.pi / 180.0
    wts = (S * V)[sel].astype(float)
    mean_h = (np.arctan2((np.sin(ang) * wts).sum(), (np.cos(ang) * wts).sum()) * 180.0 / (2 * np.pi)) % 180
    return min(TYPE_BY_HUE, key=lambda t: min(abs(mean_h - t[1]), 180 - abs(mean_h - t[1])))[0]


def find_level(img, body):
    x, y, w, h = body
    x0, y0 = max(0, x - int(0.35 * w)), y + int(0.55 * h)
    x1, y1 = min(img.shape[1], x + int(1.35 * w)), min(img.shape[0], y + int(2.4 * h))
    reg = img[y0:y1, x0:x1]
    if reg.size == 0:
        return None, None
    _, white = masks(reg)
    cands = boxes_of(white, 8, 12, 60, 44, kh=5)
    if not cands:
        return None, None
    bx, by, bw, bh = max(cands, key=lambda b: b[1])
    num = num_of(read_line(white[by:by + bh, bx:bx + bw]))
    return num, (x0 + bx, y0 + by, bw, bh)


def find_bp(img, body):
    x, y, w, h = body
    x0, y0 = max(0, x - int(0.55 * w)), max(0, y - int(1.2 * h))
    x1, y1 = min(img.shape[1], x + int(0.75 * w)), y + int(0.3 * h)
    reg = img[y0:y1, x0:x1]
    if reg.size == 0:
        return "", [], None
    hsv = cv2.cvtColor(reg, cv2.COLOR_BGR2HSV)
    S, V = hsv[:, :, 1].astype(int), hsv[:, :, 2].astype(int)
    sq = (((S < 70) & (V > 140)) | (V > 205)).astype(np.uint8) * 255
    sq = cv2.morphologyEx(sq, cv2.MORPH_CLOSE, np.ones((5, 5), np.uint8))
    cands = []
    for c in cv2.findContours(sq, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)[0]:
        bx, by, bw, bh = cv2.boundingRect(c)
        if 28 <= bw <= 95 and 28 <= bh <= 95 and 0.7 <= bw / float(bh) <= 1.5 and cv2.contourArea(c) > 0.45 * bw * bh:
            cands.append((bx, by, bw, bh))
    if not cands:
        return "", [], None
    b = min(cands, key=lambda b: abs((y0 + b[1] + b[3] / 2) - y) + abs((x0 + b[0] + b[2] / 2) - (x + w / 2)))
    tile = norm_tile(cv2.cvtColor(reg[b[1]:b[1] + b[3], b[0]:b[0] + b[2]], cv2.COLOR_BGR2GRAY))
    scores = [(float(cv2.matchTemplate(t["v"], tile, cv2.TM_CCOEFF_NORMED).max()), t["key"]) for t in _BP]
    scores.sort(reverse=True)
    bp = scores[0][1] if scores and scores[0][0] >= 0.62 else ""
    return bp, [k for sc, k in scores[:3] if sc >= 0.5], (x0 + b[0], y0 + b[1], b[2], b[3])


def crop(img, box, pad=12):
    x, y, w, h = box
    H, W = img.shape[:2]
    return img[max(0, y - pad):min(H, y + h + pad), max(0, x - pad):min(W, x + w + pad)]


def save_img(bgr, prefix):
    if bgr is None or bgr.size == 0:
        return ""
    ok, buf = cv2.imencode(".jpg", bgr, [int(cv2.IMWRITE_JPEG_QUALITY), 82])
    if not ok:
        return ""
    name = "%s_%s.jpg" % (prefix, hashlib.sha1(buf.tobytes()).hexdigest()[:12])
    os.makedirs(IMG, exist_ok=True)
    with open(os.path.join(IMG, name), "wb") as f:
        f.write(buf.tobytes())
    return "img/" + name


def grad_sig(bgr):
    if bgr is None or bgr.size == 0:
        return ""
    g = cv2.cvtColor(cv2.resize(bgr, (32, 32), interpolation=cv2.INTER_AREA), cv2.COLOR_BGR2GRAY).astype(np.float64)
    lo, hi = np.percentile(g, 5), np.percentile(g, 95)
    g = np.clip((g - lo) * 255.0 / max(8.0, hi - lo), 0, 255)
    raw = np.zeros((16, 16))
    for yy in range(16):
        for xx in range(16):
            acc = 0.0
            for dy in range(2):
                for dx in range(2):
                    px, py = 2 * xx + dx, 2 * yy + dy
                    gx = g[py, min(31, px + 1)] - g[py, max(0, px - 1)]
                    gy = g[min(31, py + 1), px] - g[max(0, py - 1), px]
                    acc += abs(gx) + abs(gy)
            raw[yy, xx] = acc / 4.0
    mx = raw.max()
    out = (raw * (255.0 / mx if mx > 1 else 0)).round().clip(0, 255).astype(np.uint8)
    return base64.b64encode(out.tobytes()).decode()


def recognize(path):
    img = cv2.imread(path)
    if img is None:
        return []
    pills = find_pills(img)
    print("  药丸", len(pills), [(p["box"], p["num"]) for p in pills])
    items = []
    for body in find_bodies(img):
        bx, by, bw, bh = body
        best, bestd = None, 1e9
        for p in pills:
            px, py, pw, ph = p["box"]
            dx = abs((px + pw / 2) - (bx + bw / 2))
            dy = (by + bh / 2) - (py + ph / 2)
            if dx < 1.5 * bw and -1.0 * bh < dy < 2.8 * bh:
                if dx + abs(dy) < bestd:
                    best, bestd = p, dx + abs(dy)
        lvl, chip = find_level(img, body)
        bp, sug, bpbox = find_bp(img, body)
        tkey = type_of(img, body)
        parts = [(bx - 10, by - 10, bw + 20, bh + 20)]
        if best:
            parts.append(best["box"])
        if chip:
            parts.append((chip[0] - 6, chip[1] - 6, chip[2] + 12, chip[3] + 12))
        if bpbox:
            parts.append((bpbox[0] - 6, bpbox[1] - 6, bpbox[2] + 12, bpbox[3] + 12))
        x0 = min(p[0] for p in parts); y0 = min(p[1] for p in parts)
        x1 = max(p[0] + p[2] for p in parts); y1 = max(p[1] + p[3] for p in parts)
        print("  本体", body, "→", tkey, "level", lvl, "bonus", best["num"] if best else None, "bp", bp or "-")
        items.append(dict(
            type_key=tkey, level=lvl, bonus=best["num"] if best else None,
            side="光" if float((cv2.cvtColor(img[by:by + bh, bx:bx + bw], cv2.COLOR_BGR2HSV)[:, :, 2] > 230).mean()) > 0.10 else "暗",
            sig=grad_sig(img[by:by + bh, bx:bx + bw]), lum=None,
            plate=save_img(crop(img, (x0, y0, x1 - x0, y1 - y0), pad=6), "p"), badge_img="",
            bp=bp, bp_saw=bool(bpbox), bp_dark_spot=any(t["dim"] and t["key"] == bp for t in _BP), bp_sug=sug,
            coords=dict(card=[int(x0), int(y0), int(x1), int(y1)],
                        pill=list(best["box"]) if best else None,
                        chip=list(chip) if chip else None, icon=[bx, by, bw, bh],
                        bp=list(bpbox) if bpbox else None),
        ))
    keep = []
    for it in items:
        r = it["coords"]["card"]
        dup = False
        for k in keep:
            kr = k["coords"]["card"]
            ix = min(r[2], kr[2]) - max(r[0], kr[0])
            iy = min(r[3], kr[3]) - max(r[1], kr[1])
            if ix > 0 and iy > 0 and ix * iy > 0.55 * min((r[2] - r[0]) * (r[3] - r[1]), (kr[2] - kr[0]) * (kr[3] - kr[1])):
                dup = True
                break
        if not dup:
            keep.append(it)
    return sorted(keep, key=lambda i: (i["coords"]["card"][1] // 40, i["coords"]["card"][0]))


def main():
    load_digits()
    load_blueprints()
    print("字形模板", sorted(_DIG), "图纸", len(_BP))
    batches = {}
    for fn in sorted(os.listdir(INBOX)) if os.path.isdir(INBOX) else []:
        if not fn.lower().endswith((".png", ".jpg", ".jpeg")):
            continue
        path = os.path.join(INBOX, fn)
        head = fn.rsplit("_", 1)[0].split("__")[0]
        try:
            player = base64.urlsafe_b64decode(head + "=" * (-len(head) % 4)).decode()
        except Exception:
            player = head
        batch = "__".join(fn.rsplit("_", 1)[0].split("__")[:2])
        res = batches.setdefault(batch, dict(player=player, items=[], images=0, t=int(time.time())))
        res["images"] += 1
        items = recognize(path)
        print("识别", fn, len(items), "件")
        res["items"].extend(items)
        os.remove(path)
    os.makedirs(OUT, exist_ok=True)
    olds = sorted((os.path.join(OUT, f) for f in os.listdir(OUT)), key=os.path.getmtime)
    for f in olds[:-40]:
        os.remove(f)
    for batch, res in batches.items():
        res["t"] = int(time.time())
        with open(os.path.join(OUT, batch + ".json"), "w", encoding="utf-8") as f:
            json.dump(res, f, ensure_ascii=False, default=int)
        print("写结果", batch, len(res["items"]))


if __name__ == "__main__":
    main()
