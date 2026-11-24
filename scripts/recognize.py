"""文物容器截图识别：从手机截图里读出每个槽位的神器类型 / 等级 / 加成% / 量子模块 / 光暗。"""
import base64
import os
import subprocess
import tempfile
from concurrent.futures import ThreadPoolExecutor

import cv2
import numpy as np

TYPES = [
    ("运输舰", (232, 195, 74), "trade", 23),
    ("采矿", (167, 107, 240), "mining", 134),
    ("支援", (95, 196, 106), "support", 63),
    ("战斗", (226, 87, 76), "weapon", 2),
    ("护盾", (76, 194, 240), "shield", 98),
    ("无人机", (240, 154, 60), "drone", 16),
]

MODULES = [
    ("tradeburst", "贸易爆发"),
    ("crunch", "矿物粉碎"),
    ("hydro", "氢气火箭"),
    ("fortify", "固若金汤"),
    ("delta", "德尔塔火箭"),
    ("laser", "激光武器"),
    ("bomber", "火箭发射器"),
    ("shields", "奥米加护盾"),
    ("alpha", "火箭无人机"),
    ("cerb", "地狱犬无人机"),
]
MODULE_NAMES = dict(MODULES)


def _chroma(rgb):
    s = float(sum(rgb)) + 1e-6
    return np.array([c / s for c in rgb])


REFS = [(_chroma(rgb), name, key, hue) for name, rgb, key, hue in TYPES]


# ---------------- OCR ----------------

def _ocr(img, psm, whitelist=None, h=300, thr=0):
    g = cv2.cvtColor(img, cv2.COLOR_RGB2GRAY) if img.ndim == 3 else img
    if g.shape[0] < 1 or g.shape[1] < 1:
        return ""
    g = cv2.resize(g, (max(1, int(g.shape[1] * h / g.shape[0])), h), interpolation=cv2.INTER_CUBIC)
    if thr:
        _, g = cv2.threshold(g, thr, 255, cv2.THRESH_BINARY)
    else:
        _, g = cv2.threshold(g, 0, 255, cv2.THRESH_BINARY + cv2.THRESH_OTSU)
    fd, path = tempfile.mkstemp(suffix=".png")
    os.close(fd)
    cv2.imwrite(path, g)
    cmd = ["tesseract", path, "stdout", "-l", "eng", "--psm", str(psm)]
    if whitelist:
        cmd += ["-c", "tessedit_char_whitelist=%s" % whitelist]
    try:
        r = subprocess.run(cmd, capture_output=True, text=True, timeout=20)
        return r.stdout.strip()
    except Exception:
        return ""
    finally:
        if os.path.exists(path):
            os.unlink(path)


def _digits(t):
    return "".join(c for c in (t or "") if c.isdigit())


# ---------------- 版面定位 ----------------

def find_plates(img):
    hsv = cv2.cvtColor(img, cv2.COLOR_RGB2HSV)
    mask = ((hsv[:, :, 1] > 55) & (hsv[:, :, 2] > 80)).astype(np.uint8) * 255
    mask = cv2.morphologyEx(mask, cv2.MORPH_CLOSE, np.ones((9, 9), np.uint8))
    n, _l, stats, cents = cv2.connectedComponentsWithStats(mask, 8)
    plates = []
    for i in range(1, n):
        x, y, w, h, area = stats[i]
        if not (90 <= w <= 220 and 90 <= h <= 220):
            continue
        if area < 5000 or area < 0.3 * w * h:
            continue
        plates.append({"cx": float(cents[i][0]), "cy": float(cents[i][1]), "w": float(w), "h": float(h)})
    plates.sort(key=lambda p: -p["w"] * p["h"])
    keep = []
    for p in plates:
        if all(abs(p["cx"] - k["cx"]) > 0.6 * k["w"] or abs(p["cy"] - k["cy"]) > 0.6 * k["h"] for k in keep):
            keep.append(p)
    return keep


def order_plates(plates):
    plates = sorted(plates, key=lambda p: p["cy"])
    rows = []
    for p in plates:
        if rows and abs(p["cy"] - np.mean([q["cy"] for q in rows[-1]])) < 0.8 * p["h"]:
            rows[-1].append(p)
        else:
            rows.append([p])
    out = []
    for r in rows:
        r.sort(key=lambda p: p["cx"])
        out += r
    return out


def _brightest_bbox(img, box, min_area):
    x0, x1, y0, y1 = [max(0, int(v)) for v in box]
    roi = img[y0:y1, x0:x1]
    if roi.size == 0:
        return None
    hsv = cv2.cvtColor(roi, cv2.COLOR_RGB2HSV)
    m = ((hsv[:, :, 2] > 105) & (hsv[:, :, 1] > 40)).astype(np.uint8) * 255
    m = cv2.morphologyEx(m, cv2.MORPH_CLOSE, np.ones((5, 5), np.uint8))
    n, _l, st, _c = cv2.connectedComponentsWithStats(m, 8)
    best = None
    for i in range(1, n):
        x, y, w, h, a = st[i]
        if a < min_area or w < 12 or h < 10:
            continue
        if best is None or a > best[4]:
            best = (x + x0, y + y0, w, h, a)
    return best


# ---------------- 单个槽位 ----------------

def crop_pill(img, p):
    cx, cy, W = p["cx"], p["cy"], p["w"]
    b = _brightest_bbox(img, (cx - 0.75 * W, cx + 0.9 * W, cy - 2.05 * W, cy - 1.02 * W), 900)
    if b and 1.6 < b[2] / b[3] < 3.0:
        return img[b[1] - 3:b[1] + b[3] + 3, b[0] - 3:b[0] + b[2] + 3]
    return img[max(0, int(cy - 1.80 * W)):int(cy - 1.16 * W),
               max(0, int(cx - 0.62 * W)):int(cx + 0.68 * W)]


def crop_level(img, p):
    cx, cy, W = p["cx"], p["cy"], p["w"]
    return img[int(cy + 0.86 * W):int(cy + 1.30 * W), max(0, int(cx - 0.78 * W)):max(0, int(cx - 0.40 * W))]


def parse_bonus(img, p):
    crop = crop_pill(img, p)
    h, w = crop.shape[:2]
    inner = crop[int(h * 0.05):int(h * 0.95), int(w * 0.10):int(w * 0.90)] if h > 12 and w > 12 else crop
    for thr, psm in ((215, 8), (200, 8), (215, 13)):
        d = _digits(_ocr(inner, psm, "0123456789+%", thr=thr))
        if len(d) >= 3:
            v = int(d[:3])
            if 100 <= v <= 999:
                return v
    return None


def parse_level(img, p):
    crop = crop_level(img, p)
    d = _digits(_ocr(crop, 10, "0123456789"))
    if d:
        v = int(d[:2])
        if 8 <= v <= 20:
            return v
    d = _digits(_ocr(crop, 7, "0123456789"))
    if d and 8 <= int(d[:2]) <= 20:
        return int(d[:2])
    return None


def classify(img, p):
    cx, cy, W, H = p["cx"], p["cy"], p["w"], p["h"]
    roi = img[max(0, int(cy - 0.48 * H)):int(cy + 0.48 * H), max(0, int(cx - 0.48 * W)):int(cx + 0.48 * W)]
    if roi.size == 0:
        return None, None, 9
    hsv = cv2.cvtColor(roi, cv2.COLOR_RGB2HSV)
    s = hsv[:, :, 1].reshape(-1)
    v = hsv[:, :, 2].reshape(-1)
    flat = roi.reshape(-1, 3).astype(np.float32)
    keep = (s > 70) & (v > 110)
    if keep.sum() < 20:
        return None, None, 9
    strength = (s.astype(np.float32) * v)[keep]
    idx = np.argsort(strength)[-max(40, int(len(strength) * 0.25)):]
    rgb = np.median(flat[keep][idx], axis=0)
    ch = _chroma(rgb)
    hue = float(np.median(hsv[:, :, 0].reshape(-1)[keep]))
    best = None
    for ref, name, key, rhue in REFS:
        dh = min(abs(hue - rhue), 180 - abs(hue - rhue)) / 90.0
        dc = float(np.linalg.norm(ch - ref))
        score = dh * 1.2 + dc * 3.0
        if best is None or score < best[0]:
            best = (score, name, key)
    return best[1], best[2], round(best[0], 2)


def read_badge(img, p):
    cx, cy, W = p["cx"], p["cy"], p["w"]
    crop = img[int(cy - 1.26 * W):int(cy - 0.80 * W), int(cx + 0.28 * W):int(cx + 0.78 * W)]
    if crop.size == 0:
        return None
    g = cv2.cvtColor(crop, cv2.COLOR_RGB2GRAY)
    mean = float(g.mean())
    small = cv2.resize(g, (32, 32), interpolation=cv2.INTER_AREA)
    return {"side": "光" if mean > 110 else "暗", "sig": _sig(small), "thumb": crop}


def _sig(gray32):
    g = gray32.astype(np.float32)
    g = (g - g.mean()) / (g.std() + 1e-6)
    dct = cv2.dct(cv2.resize(g, (16, 16)))
    v = dct[:8, :8].flatten()
    v = v / (np.linalg.norm(v) + 1e-6)
    return "".join("%02x" % max(0, min(255, int((x + 1) * 127.5))) for x in v[:48])


def sig_dist(a, b):
    try:
        va = np.frombuffer(bytes.fromhex(a), dtype=np.uint8).astype(np.float32)
        vb = np.frombuffer(bytes.fromhex(b), dtype=np.uint8).astype(np.float32)
    except Exception:
        return 9
    if va.size == 0:
        return 9
    return float(np.linalg.norm(va - vb) / (np.linalg.norm(vb) + 1e-6))


def _b64(crop, size=140):
    h, w = crop.shape[:2]
    if max(h, w) > size:
        s = size / float(max(h, w))
        crop = cv2.resize(crop, (max(1, int(w * s)), max(1, int(h * s))), interpolation=cv2.INTER_AREA)
    ok, buf = cv2.imencode(".jpg", cv2.cvtColor(crop, cv2.COLOR_RGB2BGR), [int(cv2.IMWRITE_JPEG_QUALITY), 84])
    return "data:image/jpeg;base64," + base64.b64encode(buf.tobytes()).decode() if ok else None


# ---------------- 主流程 ----------------

def recognize(path, templates=None):
    bgr = cv2.imread(path)
    if bgr is None:
        return {"ok": False, "note": "图片读取失败，请换一张截图"}
    img = cv2.cvtColor(bgr, cv2.COLOR_BGR2RGB)
    H, W = img.shape[:2]
    if max(H, W) < 700:
        return {"ok": False, "note": "截图分辨率太低，请直接用手机原图"}
    plates = order_plates(find_plates(img))
    if len(plates) < 2:
        return {"ok": False, "note": "没有找到神器槽位，请上传「文物容器」面板的完整截图"}

    templates = templates or {}
    # OCR 批量并发
    with ThreadPoolExecutor(max_workers=4) as ex:
        fut_b = [ex.submit(parse_bonus, img, p) for p in plates]
        fut_l = [ex.submit(parse_level, img, p) for p in plates]
        bonuses = [f.result() for f in fut_b]
        levels = [f.result() for f in fut_l]

    slots = []
    for i, p in enumerate(plates):
        tname, tkey, score = classify(img, p)
        badge = read_badge(img, p)
        module_key = module_name = side = None
        if badge:
            side = badge["side"]
            best = None
            for k, t in templates.items():
                if t.get("side") != side:
                    continue
                for sg in t.get("sigs", []):
                    d = sig_dist(sg, badge["sig"])
                    if best is None or d < best[0]:
                        best = (d, k)
            if best and best[0] < 0.55:
                module_key = best[1]
                module_name = MODULE_NAMES.get(module_key)
        cx, cy, Wd = p["cx"], p["cy"], p["w"]
        plate = img[int(cy - 0.5 * Wd):int(cy + 0.5 * Wd), int(cx - 0.5 * Wd):int(cx + 0.5 * Wd)]
        slots.append({
            "slot": i + 1,
            "type": tname, "type_key": tkey, "type_score": score,
            "level": levels[i], "bonus": bonuses[i],
            "has_module": badge is not None,
            "side": side,
            "module_key": module_key, "module_name": module_name,
            "badge_sig": badge["sig"] if badge else None,
            "plate": _b64(plate, 160),
            "badge": _b64(badge["thumb"], 60) if badge else None,
        })
    return {"ok": True, "slots": slots,
            "note": "识别出 %d 个槽位，请核对后再入库" % len(slots)}


if __name__ == "__main__":
    import json, sys
    for f in sys.argv[1:]:
        r = recognize(f)
        print(f, r.get("note"))
        for s in r.get("slots", []):
            print("  ", s["slot"], s["type"], s["level"], s["bonus"], s["side"], s["module_name"])
