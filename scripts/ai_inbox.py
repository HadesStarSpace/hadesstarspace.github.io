"""AI 识别（跑在 GitHub Actions 里）：RapidOCR 读文字，不依赖截图分辨率。

inbox 里的文件名格式：<base64url 用户名>__<时间戳>_<序号>.png
"""
import base64
import hashlib
import json
import os
import re
import sys
import time

import cv2
import numpy as np
from rapidocr_onnxruntime import RapidOCR

HERE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DATA = os.path.join(HERE, "data.json")
INBOX = os.path.join(HERE, "inbox")
OUT = os.path.join(HERE, "inbox_out")
IMG = os.path.join(HERE, "img")

ENGINE = RapidOCR()

TYPES = [("运输舰", "trade"), ("武器", "weapon"), ("战斗", "weapon"), ("护盾", "shield"),
         ("采矿", "mining"), ("支援", "support"), ("无人机", "drone")]

ICON_MATCH = 0.13


# ---------- 签名：与浏览器端 recog.js 的 gradSig 保持一致 ----------
def grad_sig(icon_bgr):
    if icon_bgr is None or icon_bgr.size == 0:
        return b""
    g = cv2.cvtColor(cv2.resize(icon_bgr, (32, 32), interpolation=cv2.INTER_AREA), cv2.COLOR_BGR2GRAY)
    g = g.astype(np.float64)
    lo, hi = np.percentile(g, 5), np.percentile(g, 95)
    span = max(8.0, hi - lo)
    g = np.clip((g - lo) * 255.0 / span, 0, 255)
    raw = np.zeros((16, 16), dtype=np.float64)
    for y in range(16):
        for x in range(16):
            bx, by = x * 2, y * 2
            acc = 0.0
            for dy in range(2):
                for dx in range(2):
                    px, py = bx + dx, by + dy
                    gx = g[py, min(31, px + 1)] - g[py, max(0, px - 1)]
                    gy = g[min(31, py + 1), px] - g[max(0, py - 1), px]
                    acc += abs(gx) + abs(gy)
            raw[y, x] = acc / 4.0
    mx = raw.max()
    out = (raw * (255.0 / mx if mx > 1 else 0)).round().clip(0, 255).astype(np.uint8)
    return base64.b64encode(out.tobytes()).decode()


def sig_bytes(sig):
    try:
        return np.frombuffer(base64.b64decode(sig), dtype=np.uint8).reshape(16, 16).astype(np.int16)
    except Exception:
        return None


def sig_align(a, b):
    A, B = sig_bytes(a), sig_bytes(b)
    if A is None or B is None:
        return 9.0
    best = 9.0
    for dy in range(-2, 3):
        for dx in range(-2, 3):
            xs0, xs1 = max(0, dx), min(16, 16 + dx)
            ys0, ys1 = max(0, dy), min(16, 16 + dy)
            if xs1 <= xs0 or ys1 <= ys0:
                continue
            part = A[ys0:ys1, xs0:xs1] - B[0:ys1 - ys0, 0:xs1 - xs0]
            acc = np.sqrt(np.mean((part / 255.0) ** 2))
            if acc < best:
                best = acc
    return float(best)


def digits_only(t):
    return re.sub(r"\D", "", t or "")


def looks_like_pill(t):
    d = digits_only(t)
    return ("%" in (t or "")) or (len(d) == 3)


def bonus_ok(v):
    return v is not None and 280 <= v <= 420


def read_bonus(img, l):
    """药丸数字：先看整图 OCR，读不准就裁药丸放大+二值化再认（JPEG 压缩常读成 %098 这类）"""
    if l is None:
        return None
    d = digits_only(l["t"])
    if len(d) == 3 and bonus_ok(int(d)):
        return int(d)
    m = re.search(r"(\d{3})", l["t"] or "")
    if m and bonus_ok(int(m.group(1))):
        return int(m.group(1))
    w = max(10.0, l["x1"] - l["x0"]); h = max(8.0, l["h"])
    for pad, sc in [(0.35, 3), (0.6, 4), (0.2, 5)]:
        for t in ocr_region(img, l["x0"] - pad * w, l["cy"] - (0.9 + pad) * h,
                            l["x1"] + pad * w, l["cy"] + (0.9 + pad) * h, scale=sc):
            d2 = digits_only(t["t"])
            if len(d2) == 3 and bonus_ok(int(d2)):
                return int(d2)
    return None


# ---------- OCR → 条目 ----------
def ocr_lines(path):
    res, _ = ENGINE(path)
    lines = []
    for box, txt, score in (res or []):
        if score is None or float(score) < 0.4:
            continue
        xs = [p[0] for p in box]
        ys = [p[1] for p in box]
        lines.append(dict(x0=min(xs), x1=max(xs), cy=sum(ys) / 4.0,
                          h=max(ys) - min(ys), t=str(txt)))
    return lines


def parse_items(path, img):
    H = img.shape[0]
    lines = ocr_lines(path)
    names = sorted([l for l in lines if "神器" in l["t"]], key=lambda l: l["cy"])
    levels = [l for l in lines if "等级" in l["t"]]
    pills = [l for l in lines if looks_like_pill(l["t"])]
    items = []
    for nm in names:
        lv = None
        for l in levels:
            if nm["cy"] < l["cy"] < nm["cy"] + 3 * nm["h"]:
                if lv is None or l["cy"] < lv["cy"]:
                    lv = l
        bn = None
        for l in pills:
            if l["x0"] > nm["x1"] and nm["cy"] < l["cy"] < nm["cy"] + 3 * nm["h"]:
                if bn is None or abs(l["cy"] - nm["cy"]) < abs(bn["cy"] - nm["cy"]):
                    bn = l
        tkey = next((k for kw, k in TYPES if kw in nm["t"]), None)
        lvl = None
        if lv:
            m = re.search(r"(\d{1,2})", lv["t"])
            if m:
                lvl = int(m.group(1))
        bns = read_bonus(img, bn) if bn else None
        it = dict(type=tkey, level=lvl, bonus=bns, name_y=nm["cy"], name_h=nm["h"],
                  text_x=nm["x1"], pill=bn)
        prev_y = (items[-1]["band_mid"] if items else 0)
        it["band_mid"] = nm["cy"] + nm["h"] * 1.3
        it["band"] = (int(max(0, prev_y)), int(min(H, it["band_mid"] + nm["h"] * 0.9)))
        items.append(it)
    return items


# ---------- 小区域识别（容器截图的小字号等级必须裁小图放大+二值化） ----------
def ocr_texts_on(bgr, min_score=0.4):
    res, _ = ENGINE(bgr)
    out = []
    for box, txt, score in (res or []):
        if score is None or float(score) < min_score:
            continue
        xs = [p[0] for p in box]
        ys = [p[1] for p in box]
        out.append(dict(x0=min(xs), x1=max(xs), y0=min(ys), y1=max(ys),
                        cy=sum(ys) / 4.0, h=max(ys) - min(ys), t=str(txt)))
    return out


def ocr_region(img, x0, y0, x1, y1, scale=3):
    H, W = img.shape[:2]
    x0 = max(0, int(x0)); y0 = max(0, int(y0))
    x1 = min(W, int(x1)); y1 = min(H, int(y1))
    if x1 - x0 < 6 or y1 - y0 < 6:
        return []
    crop = img[y0:y1, x0:x1]
    up = cv2.resize(crop, None, fx=scale, fy=scale, interpolation=cv2.INTER_CUBIC)
    g = cv2.cvtColor(up, cv2.COLOR_BGR2GRAY).astype(np.float32)
    b = np.clip((g - 135.0) * 255.0 / 115.0, 0, 255).astype(np.uint8)
    bgr = cv2.cvtColor(255 - b, cv2.COLOR_GRAY2BGR)
    out = []
    for t in ocr_texts_on(bgr):
        # 坐标换回原图
        out.append(dict(x0=x0 + t["x0"] / scale, x1=x0 + t["x1"] / scale,
                        cy=y0 + t["cy"] / scale, h=t["h"] / scale, t=t["t"]))
    return out


def pill_box(l):
    return dict(x0=l["x0"], x1=l["x1"], y0=l["cy"] - l["h"] / 2.0, y1=l["cy"] + l["h"] / 2.0,
                cy=l["cy"], h=l["h"], w=l["x1"] - l["x0"])


def parse_grid(path, img):
    """容器版式：没有「XX神器」文字，靠 +NNN% 药丸 + 邻近的等级数字按格配对。

    等级数字字号太小，整图 det 会漏，所以另按药丸几何裁小图放大+二值化再认一遍。
    """
    lines = ocr_lines(path)
    pills = [pill_box(l) for l in lines if looks_like_pill(l["t"])]
    if len(pills) < 2:
        return []
    # 只认「纯 1~2 位数字」或「等级N」，别把药丸自己的 +360% 当成等级
    cands = [l for l in lines if re.fullmatch(r"\s*(?:等级)?\s*\d{1,2}\s*", l["t"])]
    items = []
    for p in pills:
        w, h = p["w"], p["h"]
        lv = None
        # 1) 先用整图里读到的等级数字
        for l in cands:
            if l["x0"] >= p["x0"] - 0.8 * w and l["x1"] <= p["x1"] + 1.2 * w:
                if p["y1"] - 3.0 * h <= l["cy"] <= p["y1"] + 8.0 * h:
                    if lv is None or abs(l["cy"] - p["y1"]) < abs(lv["cy"] - p["y1"]):
                        lv = l
        # 2) 读不到就在药丸下方裁小图单独认
        lvl = None
        if lv is not None:
            m = re.search(r"(\d{1,2})", lv["t"])
            if m:
                lvl = int(m.group(1))
        if lvl is not None and not (1 <= lvl <= 15):   # 「10」被拆成「0」这类，别采信
            lvl = None
        if lvl is None:
            for dx0, dx1, dy0, dy1 in [(-0.6, 0.9, 4.4, 7.6), (-0.6, 0.9, 6.0, 9.5)]:
                reg = ocr_region(img, p["x0"] + dx0 * w, p["y1"] + dy0 * h,
                                 p["x1"] + dx1 * w, p["y1"] + dy1 * h)
                got = None
                for t in reg:
                    m = re.fullmatch(r"\s*(\d{1,2})\s*", t["t"])
                    if m and 1 <= int(m.group(1)) <= 15:
                        got = int(m.group(1)); break
                if got is not None:
                    lvl = got
                    break
        src_line = next((l for l in lines if l["x0"] == p["x0"] and l["cy"] == p["cy"]), None)
        bns = read_bonus(img, src_line) if src_line else None
        items.append(dict(type=None, level=lvl, bonus=bns if bonus_ok(bns) else None,
                          layout="grid", pill=p))
    return items


def badge_square(img, pill, layout):
    """量子强化图标：按药丸定位到图标方块本体，直接裁成正方形（图标铺满卡片小方框、居中不偏移）"""
    if not pill:
        return None
    w = pill["x1"] - pill["x0"]; h = pill["h"]
    if w < 10 or h < 8:
        return None
    if layout == "grid":
        cx = pill["x1"] - 0.027 * w
        cy = pill["y1"] + 1.06 * h
        side = 0.66 * w
    else:
        cx = pill["x1"] - 0.23 * w
        cy = pill["cy"] - 1.54 * h
        side = 0.70 * w
    s = max(12, int(side))
    x0 = int(cx - s / 2); y0 = int(cy - s / 2)
    x1 = min(img.shape[1], x0 + s); y1 = min(img.shape[0], y0 + s)
    x0 = max(0, x0); y0 = max(0, y0)
    if x1 - x0 < 8 or y1 - y0 < 8:
        return None
    return img[y0:y1, x0:x1]


def windows(img, it):
    """药丸定位：图标窗口固定挂在药丸左上方（同一张图的版式一致，跨分辨率无影响）"""
    pill = it.get("pill")
    if not pill:
        return None
    w = pill["x1"] - pill["x0"]
    h = pill["h"]
    if w < 10 or h < 8:
        return None
    def cut(xa, xb, ya, yb):
        x0 = int(pill["x0"] + xa * w); x1 = int(pill["x0"] + xb * w)
        y0 = int(pill["cy"] + ya * h); y1 = int(pill["cy"] + yb * h)
        x0 = max(0, x0); y0 = max(0, y0)
        x1 = min(img.shape[1], x1); y1 = min(img.shape[0], y1)
        if x1 - x0 < 6 or y1 - y0 < 6:
            return None
        return img[y0:y1, x0:x1]
    icon = badge_square(img, pill, "list")       # 量子图标本体（正方形，铺满小方框）
    card = cut(-1.10, 1.95, -3.6, 0.35)         # 整条神器预览
    side = "暗"
    if card is not None:
        v = cv2.cvtColor(card, cv2.COLOR_BGR2HSV)[:, :, 2]
        if float((v > 230).mean()) > 0.10:
            side = "光"
    return dict(icon=icon, card=card, side=side)


# ---------- 入库 ----------
def save_img(bgr, prefix):
    ok, buf = cv2.imencode(".jpg", bgr, [int(cv2.IMWRITE_JPEG_QUALITY), 82])
    if not ok:
        return ""
    name = "%s_%s.jpg" % (prefix, hashlib.sha1(buf.tobytes()).hexdigest()[:12])
    os.makedirs(IMG, exist_ok=True)
    with open(os.path.join(IMG, name), "wb") as f:
        f.write(buf.tobytes())
    return "img/" + name


def ensure_player(data, name):
    for p in data.get("players", []):
        if p.get("name") == name:
            return p["id"]
    pid = "p%d" % (int(time.time() * 1000) % 100000000)
    data.setdefault("players", []).append({"id": pid, "name": name, "note": ""})
    return pid


def next_aid(data):
    n = 1
    for a in data.get("artifacts", []):
        try:
            n = max(n, int(str(a["id"])[1:]) + 1)
        except Exception:
            pass
    return "a%d" % n


def icon_id_for(data, sig, tkey):
    """按签名 + 类型找已有图标 id；找不到就新建一个"""
    icons = data.setdefault("icons", {})
    if sig:
        for k, v in icons.items():
            if v.get("type") == tkey and v.get("sig") and sig_align(v["sig"], sig) < ICON_MATCH:
                v["n"] = (v.get("n") or 0) + 1
                return k
    if not sig:
        return ""
    n = 1
    while ("ic" + str(n)) in icons:
        n += 1
    icons["ic" + str(n)] = {"sig": sig, "thumb": "", "n": 1, "type": tkey}
    return "ic" + str(n)


def merge(data):
    """完全相同的（同主人+类型+等级+加成+图标+光暗+状态）合并，累加数量"""
    out, by = [], {}
    for a in data.get("artifacts", []):
        if a.get("status") == "reserved" or a.get("level") is None or a.get("bonus") is None:
            out.append(a)
            continue
        k = "|".join([str(a.get("owner")), str(a.get("type_key")), str(a.get("level")),
                      str(a.get("bonus")), str(a.get("module") or ""), str(a.get("side") or ""),
                      str(a.get("status") or "")])
        if k in by:
            by[k]["qty"] = (by[k].get("qty") or 1) + (a.get("qty") or 1)
        else:
            a["qty"] = a.get("qty") or 1
            by[k] = a
            out.append(a)
    data["artifacts"] = out


def player_from_name(fn):
    stem = os.path.splitext(fn)[0]
    head = stem.split("__")[0]
    try:
        return base64.urlsafe_b64decode(head + "=" * (-len(head) % 4)).decode("utf-8")
    except Exception:
        return head


def find_badge(img, x0, y0, x1, y1):
    """在给定窗口里找出量子强化图标本体（亮/有颜色的那块），返回裁好的正方形图"""
    H, W = img.shape[:2]
    x0 = max(0, int(x0)); y0 = max(0, int(y0)); x1 = min(W, int(x1)); y1 = min(H, int(y1))
    if x1 - x0 < 8 or y1 - y0 < 8:
        return None
    sub = img[y0:y1, x0:x1]
    hsv = cv2.cvtColor(sub, cv2.COLOR_BGR2HSV)
    v = hsv[:, :, 2].astype(np.int16)
    sat = hsv[:, :, 1].astype(np.int16)
    mask = ((v > 105) | (sat > 70)).astype(np.uint8) * 255
    mask = cv2.morphologyEx(mask, cv2.MORPH_CLOSE, np.ones((5, 5), np.uint8))
    cnts, _ = cv2.findContours(mask, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    if not cnts:
        return None
    boxes = [cv2.boundingRect(c) for c in cnts]
    # 量子图标是方形小块、位置在神器大图标上方：先筛形状，再取最上面那个
    cand = [b for b in boxes if b[2] * b[3] >= 300 and 0.55 <= (b[2] / max(1, b[3])) <= 2.2]
    if not cand:
        cand = [b for b in boxes if b[2] * b[3] >= 300]
    if not cand:
        return None
    bx, by, bw, bh = min(cand, key=lambda b: b[1])
    if bw < 10 or bh < 10:
        return None
    pad = int(max(bw, bh) * 0.12) + 3
    cx0 = max(0, bx - pad); cy0 = max(0, by - pad)
    cx1 = min(sub.shape[1], bx + bw + pad); cy1 = min(sub.shape[0], by + bh + pad)
    crop = sub[cy0:cy1, cx0:cx1]
    side = max(crop.shape[:2]) + 6
    out = np.zeros((side, side, 3), dtype=np.uint8)
    oy = (side - crop.shape[0]) // 2; ox = (side - crop.shape[1]) // 2
    out[oy:oy + crop.shape[0], ox:ox + crop.shape[1]] = crop
    return out


def grid_windows(img, it):
    p = it["pill"]
    w, h = p["w"], p["h"]
    def cut(xa, xb, ya, yb, base="y1"):
        x0 = max(0, int(p["x0"] + xa * w)); x1 = min(img.shape[1], int(p["x0"] + xb * w))
        by = p["y1"] if base == "y1" else p["y0"]
        y0 = max(0, int(by + ya * h)); y1 = min(img.shape[0], int(by + yb * h))
        if x1 - x0 < 6 or y1 - y0 < 6:
            return None
        return img[y0:y1, x0:x1]
    # 固定窗口（药丸右下方，留足边距）：尺寸随药丸缩放，跨分辨率一致；再居中裁成正方形贴卡片方框
    icon = badge_square(img, p, "grid")
    # 整格预览：从药丸上方一点往下到格底，横向别越到下一格
    card = cut(-0.60, 0.50, -0.30, 9.60, "y0")
    side = "暗"
    if card is not None:
        v = cv2.cvtColor(card, cv2.COLOR_BGR2HSV)[:, :, 2]
        if float((v > 230).mean()) > 0.10:
            side = "光"
    return dict(icon=icon, card=card, side=side)


def square_center(bgr, keep=0.88):
    """裁成正方形：卡片上的小方框是正方形、按铺满显示，图不方就会“没对准”"""
    if bgr is None or bgr.size == 0:
        return bgr
    h, w = bgr.shape[:2]
    side = max(8, int(min(h, w) * keep))
    cy, cx = h // 2, w // 2
    y0 = max(0, cy - side // 2); y1 = y0 + side
    x0 = max(0, cx - side // 2); x1 = x0 + side
    return bgr[y0:y1, x0:x1]


def bp_tone(icon):
    """量子图纸：只认「黑底方块（暗物质）/白底方块（光物质）」那两种图标；
    灰色伞状那种（旧量子强化图标）以及空槽裁到的卡片底色都不算。
    只看中心 62%：黑底方块中心灰度中位数≈3~10，白底≈250，卡片底色≈58，灰图≈137。"""
    if icon is None or icon.size == 0:
        return ""
    h, w = icon.shape[:2]
    side = int(min(h, w) * 0.62)
    cy, cx = h // 2, w // 2
    y0 = max(0, cy - side // 2); x0 = max(0, cx - side // 2)
    core = icon[y0:y0 + side, x0:x0 + side]
    if core.size == 0:
        return ""
    med = float(np.median(cv2.cvtColor(core, cv2.COLOR_BGR2GRAY)))
    if med <= 25:
        return "暗"
    if med >= 235:
        return "光"
    return ""


def crop_at(img, pill, layout, dx=0.0, dy=0.0):
    w = pill["x1"] - pill["x0"]; h = pill["h"]
    if layout == "grid":
        cx = pill["x1"] + (-0.027 + dx) * w
        cy = pill["y1"] + (1.06 + dy) * h
        side = 0.66 * w
    else:
        cx = pill["x1"] + (-0.23 + dx) * w
        cy = pill["cy"] + (-1.54 + dy) * h
        side = 0.70 * w
    s = max(12, int(side))
    x0 = int(cx - s / 2); y0 = int(cy - s / 2)
    x1 = min(img.shape[1], x0 + s); y1 = min(img.shape[0], y0 + s)
    x0 = max(0, x0); y0 = max(0, y0)
    if x1 - x0 < 8 or y1 - y0 < 8:
        return None
    return img[y0:y1, x0:x1]


def bp_tone(icon):
    """单个方块的判定：中心 62% 灰度中位数；黑底≈3~10、白底≈250、卡片底≈58、灰伞≈137"""
    if icon is None or icon.size == 0:
        return ""
    h, w = icon.shape[:2]
    side = int(min(h, w) * 0.62)
    cy, cx = h // 2, w // 2
    y0 = max(0, cy - side // 2); x0 = max(0, cx - side // 2)
    core = icon[y0:y0 + side, x0:x0 + side]
    if core.size == 0:
        return ""
    med = float(np.median(cv2.cvtColor(core, cv2.COLOR_BGR2GRAY)))
    if med <= 25:
        return "暗"
    if med >= 235:
        return "光"
    return ""


def bp_of(img, pill, layout):
    """量子图纸：在药丸定位点周围小范围扫一遍，结果一致才认，避免裁偏一点就认错"""
    if not pill:
        return ""
    votes = {"暗": 0, "光": 0, "": 0}
    for dx in (-0.08, -0.04, 0.0, 0.04, 0.08):
        for dy in (-0.08, -0.04, 0.0, 0.04, 0.08):
            votes[bp_tone(crop_at(img, pill, layout, dx, dy))] += 1
    tot = sum(votes.values())
    if not tot:
        return ""
    for k in ("暗", "光"):
        if votes[k] >= 0.32 * tot and votes[k] > votes["" ]:
            return k
    return ""


def lum_of(bgr):
    if bgr is None or bgr.size == 0:
        return None
    g = cv2.cvtColor(bgr, cv2.COLOR_BGR2GRAY)
    return int(float(g.mean()))


def main():
    files = sorted(f for f in os.listdir(INBOX) if not f.startswith("."))
    if not files:
        print("inbox empty")
        return
    os.makedirs(OUT, exist_ok=True)
    batches = {}
    for fn in files:
        path = os.path.join(INBOX, fn)
        img = cv2.imread(path)
        print("处理", fn, img.shape if img is not None else None)
        if img is None:
            os.remove(path)
            continue
        player = player_from_name(fn)
        batch = "__".join(fn.rsplit("_", 1)[0].split("__")[:2])
        res = batches.setdefault(batch, dict(player=player, items=[], images=0, t=int(time.time())))
        res["images"] += 1
        try:
            items = parse_items(path, img)
        except Exception as e:
            print("识别异常", e)
            items = []
        if not items:
            try:
                items = parse_grid(path, img)
            except Exception as e:
                print("容器版式异常", e)
                items = []
        for it in items:
            loc = grid_windows(img, it) if it.get("layout") == "grid" else windows(img, it)
            icon = loc.get("icon") if loc else None
            icon = square_center(icon) if icon is not None else None
            sig = grad_sig(icon) if icon is not None else ""
            res["items"].append({
                "type_key": it.get("type"), "level": it.get("level"), "bonus": it.get("bonus"),
                "side": loc.get("side") if loc else "暗",
                "sig": sig, "lum": lum_of(icon),
                "plate": save_img(loc["card"], "p") if loc and loc.get("card") is not None else "",
                "badge_img": save_img(icon, "b") if icon is not None else "",
                "bp": bp_of(img, it.get("pill"), "grid" if it.get("layout") == "grid" else "list"),
            })
        os.remove(path)
        print("认出", len(items), "件")
    if os.path.isdir(OUT):
        olds = sorted((os.path.join(OUT, f) for f in os.listdir(OUT)), key=os.path.getmtime)
        for f in olds[:-40]:
            os.remove(f)
    for batch, res in batches.items():
        res["t"] = int(time.time())
        with open(os.path.join(OUT, batch + ".json"), "w", encoding="utf-8") as f:
            json.dump(res, f, ensure_ascii=False)
        print("写结果", batch, len(res["items"]))


if __name__ == "__main__":
    main()
