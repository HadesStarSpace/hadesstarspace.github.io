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

TYPES = [("运输舰", "trade"), ("武器", "weapon"), ("战斗", "support"), ("护盾", "shield"),
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
    # 加成量级随等级/神器变化，别写死窄区间（12 级的 +720% 曾被判非法而丢掉）
    return v is not None and 100 <= v <= 3000


def read_bonus(img, l):
    """药丸数字：先看整图 OCR，读不准就裁药丸放大+二值化再认（JPEG 压缩常读成 %098 这类）"""
    if l is None:
        return None
    d = digits_only(l["t"])
    # 以 0 开头基本是 OCR 把 +360% 读成 %098 这类残渣，别当加成
    if len(d) in (3, 4) and d[0] != "0" and bonus_ok(int(d)):
        return int(d)
    m = re.search(r"(\d{3,4})", l["t"] or "")
    if m and bonus_ok(int(m.group(1))):
        return int(m.group(1))
    w = max(10.0, l["x1"] - l["x0"]); h = max(8.0, l["h"])
    for pad, sc in [(0.35, 3), (0.6, 4), (0.2, 5)]:
        for t in ocr_region(img, l["x0"] - pad * w, l["cy"] - (0.9 + pad) * h,
                            l["x1"] + pad * w, l["cy"] + (0.9 + pad) * h, scale=sc):
            d2 = digits_only(t["t"])
            if len(d2) in (3, 4) and d2[0] != "0" and bonus_ok(int(d2)):
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


def mint_pill(img, nm):
    """OCR 没认到 +N% 药丸（两列并排时左边的常并到芯片里）时，按薄荷绿底色直接把药丸框找回来"""
    H, W = img.shape[:2]
    x0 = int(max(0, nm["x1"] - 0.2 * nm["h"])); x1 = int(min(W, nm["x1"] + 7.5 * nm["h"]))
    y0 = int(max(0, nm["cy"] - 0.6 * nm["h"])); y1 = int(min(H, nm["cy"] + 3.2 * nm["h"]))
    if x1 - x0 < 20 or y1 - y0 < 12:
        return None
    hsv = cv2.cvtColor(img[y0:y1, x0:x1], cv2.COLOR_BGR2HSV)
    m = ((hsv[:, :, 0] > 55) & (hsv[:, :, 0] < 105) & (hsv[:, :, 1] > 60) & (hsv[:, :, 2] > 70)).astype(np.uint8)
    m = cv2.morphologyEx(m, cv2.MORPH_CLOSE, np.ones((7, 7), np.uint8))
    n, lab, stats, _ = cv2.connectedComponentsWithStats(m, 8)
    best = None
    for j in range(1, n):
        x, y, w, h, area = stats[j]
        if area < 300 or w < 0.12 * (x1 - x0):
            continue
        score = area * (1.0 - 0.3 * abs((y + h / 2) - (nm["cy"] - y0 + 1.6 * nm["h"])) / max(1.0, (y1 - y0)))
        if best is None or score > best[0]:
            best = (score, (x0 + x, y0 + y, w, h))
    if not best:
        return None
    x, y, w, h = best[1]
    return dict(x0=x, x1=x + w, y0=y, y1=y + h, cy=y + h / 2.0, h=h, w=w, t="")


def parse_items(path, img):
    H = img.shape[0]
    lines = ocr_lines(path)
    names = sorted([l for l in lines if "神器" in l["t"]], key=lambda l: l["cy"])
    levels = [l for l in lines if "等级" in l["t"]]
    pills = [l for l in lines if looks_like_pill(l["t"])]
    items = []
    used = set()
    for nm in names:
        lv = None
        for l in levels:
            if nm["cy"] < l["cy"] < nm["cy"] + 3 * nm["h"]:
                if lv is None or l["cy"] < lv["cy"]:
                    lv = l
        bn = None
        for l in pills:
            if l["x0"] > nm["x1"] and nm["cy"] < l["cy"] < nm["cy"] + 3 * nm["h"]:
                if id(l) in used:
                    continue
                if bn is None or abs(l["x0"] - nm["x1"]) < abs(bn["x0"] - nm["x1"]):
                    bn = l
        if bn is not None:
            used.add(id(bn))
        else:
            # 两列并排时左列的 +N% 常被芯片压住/OCR 读丢：按薄荷绿底色补找
            bn = mint_pill(img, nm)
        tkey = next((k for kw, k in TYPES if kw in nm["t"]), None)
        lvl = None
        if lv:
            m = re.search(r"(\d{1,2})", lv["t"])
            if m:
                lvl = int(m.group(1))
        bns = read_bonus(img, bn) if bn else None
        tn = None
        for l in lines:
            if "吨" in l["t"] and nm["cy"] < l["cy"] < nm["cy"] + 6 * nm["h"] \
                    and l["x0"] <= nm["x1"] + 2 * nm["h"]:
                if tn is None or l["cy"] < tn["cy"]:
                    tn = l
        it = dict(type=tkey, level=lvl, bonus=bns, name_y=nm["cy"], name_h=nm["h"],
                  text_x=nm["x1"], pill=bn,
                  tboxes=[(l["x0"], l["cy"] - l["h"] / 2, l["x1"], l["cy"] + l["h"] / 2)
                          for l in (nm, lv, tn) if l])
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
        if lvl is None:
            lvl = level_chip(img, p); chip_ok = lvl is not None
        src_line = next((l for l in lines if l["x0"] == p["x0"] and l["cy"] == p["cy"]), None)
        bns = read_bonus(img, src_line) if src_line else None
        tb = []
        for l in lines:
            if l["x1"] <= p["x0"] + 0.35 * w and l["x0"] >= p["x0"] - 12.0 * w \
                    and p["y0"] - 5.0 * h <= l["cy"] <= p["y1"] + 1.5 * h:
                tb.append((l["x0"], l["cy"] - l["h"] / 2, l["x1"], l["cy"] + l["h"] / 2))
        items.append(dict(type=None, level=lvl, bonus=bns if bonus_ok(bns) else None,
                          layout="grid", pill=p, tboxes=tb, chip_ok=chip_ok))
    return items


def level_chip(img, pill):
    """等级数字是左下角薄荷色小方块里的数字：按颜色找到方块，放大后单独认"""
    w = pill["x1"] - pill["x0"]; h = pill["h"]
    py1 = pill.get("y1", pill.get("cy", 0) + h / 2)
    x0 = max(0, int(pill["x0"] - 0.6 * w)); x1 = min(img.shape[1], int(pill["x0"] + 1.2 * w))
    y0 = max(0, int(py1 + 3.8 * h)); y1 = min(img.shape[0], int(py1 + 7.6 * h))
    if x1 - x0 < 10 or y1 - y0 < 10:
        return None
    sub = img[y0:y1, x0:x1]
    hsv = cv2.cvtColor(sub, cv2.COLOR_BGR2HSV)
    hh, ss, vv = hsv[:, :, 0], hsv[:, :, 1].astype(int), hsv[:, :, 2].astype(int)
    mask = ((hh > 65) & (hh < 112) & (ss > 25) & (ss < 200) & (vv > 170)).astype(np.uint8) * 255
    mask = cv2.morphologyEx(mask, cv2.MORPH_CLOSE, np.ones((5, 5), np.uint8))
    cnts, _ = cv2.findContours(mask, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    picks = []
    for c in cnts:
        x, y, cw, ch = cv2.boundingRect(c)
        if cw < 16 or ch < 16 or cw > 0.55 * w or ch > 0.55 * w:
            continue
        if not (0.6 <= cw / float(ch) <= 1.7):
            continue
        want = 0.32 * w
        picks.append((abs(max(cw, ch) - want), abs((y + ch / 2) - h), cv2.contourArea(c), x, y, cw, ch))
    if not picks:
        print("  等级方块没找到", (x0, y0, x1, y1))
        return None
    picks.sort()
    for _, _, _, x, y, cw, ch in picks[:5]:
        crop = sub[y:y + ch, x:x + cw]
        for scale in (8, 6):
            up = cv2.resize(crop, None, fx=scale, fy=scale, interpolation=cv2.INTER_CUBIC)
            for bgr in (up,
                        cv2.cvtColor((cv2.cvtColor(up, cv2.COLOR_BGR2GRAY) < 110).astype(np.uint8) * 255,
                                    cv2.COLOR_GRAY2BGR)):
                res, _ = ENGINE(bgr)
                for _, txt, sc in (res or []):
                    if sc is None or float(sc) < 0.5:
                        continue
                    m = re.fullmatch(r"\s*(\d{1,2})\s*", str(txt))
                    if m and 1 <= int(m.group(1)) <= 15:
                        return int(m.group(1))
    print("  等级方块认不出", picks[:2])
    return None


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
    card = cut(-4.6, 1.3, -4.4, 1.2)             # 整行预览：神器名 + 等级 + 吨数 + 图标 + 图纸 + 加成
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


def grid_windows(img, it, cellw=None):
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
    cw = cellw or (2.2 * w)
    ax0 = int(p["x0"] + w / 2 - cw / 2); ax1 = ax0 + int(cw)
    card = img[max(0, int(p["y0"] - 0.9 * h)):min(img.shape[0], int(p["y0"] + 9.6 * h)),
              max(0, ax0):min(img.shape[1], ax1)]
    side = "暗"
    if card is not None:
        v = cv2.cvtColor(card, cv2.COLOR_BGR2HSV)[:, :, 2]
        if float((v > 230).mean()) > 0.10:
            side = "光"
    return dict(icon=icon, card=card, side=side)


def artifact_blob(img, pill):
    """在药丸附近找「神器本体」那个发光六边形：返回它的方框（就一个，离药丸最近的那个）。
    神器图标是彩色发光的六边形，量子图纸小方块是黑白方块、薄荷色加成药丸是宽扁圆角条，
    靠饱和度+宽高比就能把后两者排掉。"""
    if not pill:
        return None
    w = pill["x1"] - pill["x0"]; h = pill["h"]
    cx = pill["x0"] + w / 2.0; cyy = pill["cy"]
    rx = int(3.4 * w); ry = int(3.4 * h)
    x0 = max(0, int(cx - rx)); x1 = min(img.shape[1], int(cx + rx))
    y0 = max(0, int(cyy - ry)); y1 = min(img.shape[0], int(cyy + ry))
    if x1 - x0 < 20 or y1 - y0 < 20:
        return None
    sub = img[y0:y1, x0:x1]
    hsv = cv2.cvtColor(sub, cv2.COLOR_BGR2HSV)
    S = hsv[:, :, 1].astype(np.int16); V = hsv[:, :, 2].astype(np.int16)
    mask = ((S > 55) & (V > 70)).astype(np.uint8)
    mask = cv2.morphologyEx(mask, cv2.MORPH_OPEN, np.ones((3, 3), np.uint8))
    mask = cv2.morphologyEx(mask, cv2.MORPH_CLOSE, np.ones((7, 7), np.uint8))
    n, lab, st, _ = cv2.connectedComponentsWithStats(mask, 8)
    pick = None
    for j in range(1, n):
        bx, by, bw, bh, area = st[j]
        if area < 800 or bw < 0.8 * h or bh < 0.8 * h:
            continue
        if bw > 3.4 * w or bh > 3.4 * w:      # 一整条背景/边框，不是图标
            continue
        ar = bw / float(max(bh, 1))
        if ar < 0.55 or ar > 2.7:
            continue
        hue = int(np.median(hsv[:, :, 0][lab == j]))
        if 68 <= hue <= 100 and ar > 1.35:    # 薄荷绿加成药丸：宽扁
            continue
        px = x0 + bx + bw / 2.0; py = y0 + by + bh / 2.0
        d = abs(px - cx) / float(w) + abs(py - cyy) / float(h)
        if pick is None or d < pick[0]:
            pick = (d, x0 + bx, y0 + by, bw, bh)
    if not pick:
        return None
    _, bx, by, bw, bh = pick
    if bw > bh * 1.15:
        # 宽块 = 图标和加成药丸粘连，或两个神器挤在一起：按图标自身高度取方块，贴在离药丸近的那一头
        side = int(bh * 1.05)
        cx0 = bx + bw - side if (x0 + bx + bw / 2.0) > (pill["x0"] + pill["x1"]) / 2.0 else bx
    else:
        side = int(max(bw, bh) * 1.08); cx0 = bx + bw // 2 - side // 2
    cy0 = by + bh // 2 - side // 2
    cx0 = max(0, min(img.shape[1] - side, cx0)); cy0 = max(0, min(img.shape[0] - side, cy0))
    return (cx0, cy0, side, side)


def artifact_crop(img, it, layout=""):
    """预览图只留一件神器本体：离这件药的加成药丸最近的那个发光图标方框"""
    box = artifact_blob(img, it.get("pill"))
    if not box:
        return None
    x, y, w, h = box
    out = img[y:y + h, x:x + w]
    if out is None or out.size == 0:
        return None
    return cv2.resize(out, (256, 256), interpolation=cv2.INTER_AREA)


_LAST_BOX = None


def item_card(img, it, layout, cellw=None, peers=None):
    """核对用预览：这一件的完整卡片——神器本体 + 加成药丸 + 量子图纸小方块 + 等级，
    横向裁到相邻那一件的中间线为止，保证一张图里只有一件神器。"""
    p = it.get("pill")
    if not p:
        return None
    w = p["x1"] - p["x0"]; h = p["h"]
    pcx = p["x0"] + w / 2.0
    if layout == "grid":
        half = min((cellw * 0.5) if cellw else 1.35 * w, 1.5 * w)
        x0 = pcx - half; x1 = pcx + half
        y0 = p.get("y0", p["cy"] - h / 2) - 0.45 * h
        y1 = p.get("y1", p["cy"] + h / 2) + 8.0 * h
    else:
        x0 = p["x0"] - 4.6 * w; x1 = p["x1"] + 1.05 * w
        # 星球货物列表里「神器名/等级/吨数」在这件卡片最左边，按 OCR 读到的名字右缘往左补
        tx = it.get("text_x")
        if tx:
            x0 = min(x0, tx - 0.26 * img.shape[1])
        y0 = p["cy"] - 5.6 * h; y1 = p["cy"] + 1.35 * h
        ny = it.get("name_y")
        if ny:
            y0 = min(y0, ny - 1.5 * h)
        tbx = [b[0] for b in (it.get("tboxes") or [])]
        if tbx:
            # 有名字文字时，左边界贴到文字左缘，不要带上隔壁那件的图标
            x0 = max(x0, min(tbx) - 0.15 * h)
            for q in (peers or []):
                qp = q.get("pill")
                if qp and abs(qp["cy"] - p["cy"]) < 3.0 * h and qp["x1"] < p["x0"]:
                    x0 = max(x0, qp["x1"] + 0.4 * h)
            for q in (peers or []):
                qp = q.get("pill")
                if qp and abs(qp["cy"] - p["cy"]) < 3.0 * h and qp["x0"] > p["x1"]:
                    qtx = [b[0] for b in (q.get("tboxes") or [])]
                    edge = (min(qtx) - 0.2 * h) if qtx else (qp["x0"] - 1.4 * w)
                    x1 = min(x1, edge)
    blob = artifact_blob(img, p)
    if blob:
        bx, by, bw, bh = blob
        if layout == "grid" and blob[1] > p["cy"]:
            # 船上「运载的文物」卡片：药丸在最上、本体在下，横向按药丸+本体并集收，不带隔壁卡片
            x0 = max(x0, min(p["x0"] - 0.15 * w, bx - 0.05 * bw))
            x1 = min(x1, max(p["x1"] + 0.15 * w, bx + bw + 0.05 * bw))
        if layout == "grid":
            # 等级那行字在神器上方一点点，等级小方块在神器下方：按神器高度收口，别拖出大片空白
            y0 = min(y0, by - 1.15 * bh)
            y1 = min(y1, by + bh + 1.75 * bh)
        x0 = min(x0, bx - 0.15 * bw); x1 = max(x1, bx + bw + 0.5 * bw)
        y0 = min(y0, by - 0.15 * bh); y1 = max(y1, by + bh + 0.15 * bh)
    for tx0, ty0, tx1, ty1 in (it.get("tboxes") or []):
        x0 = min(x0, tx0 - 0.15 * h)
        y0 = min(y0, ty0 - 0.35 * h); y1 = max(y1, ty1 + 0.35 * h)
    for q in (peers or []):
        qp = q.get("pill")
        if not qp or qp is p:
            continue
        qcx = qp["x0"] + (qp["x1"] - qp["x0"]) / 2.0
        if layout == "grid" and abs(qp["cy"] - p["cy"]) < 3.0 * h:   # 同一行、左右相邻：切在中间
            if qcx > pcx:
                x1 = min(x1, (pcx + qcx) / 2.0)
            else:
                x0 = max(x0, (pcx + qcx) / 2.0)
        elif abs(qcx - pcx) < 2.5 * w:                      # 同一列、上下相邻：切在中间
            if qp["cy"] > p["cy"]:
                y1 = min(y1, (p["cy"] + qp["cy"]) / 2.0 + 1.0 * h)
            else:
                y0 = max(y0, (p["cy"] + qp["cy"]) / 2.0 + 0.2 * h)
    if it.get("tboxes"):
        y0 = max(y0, min(b[1] for b in it["tboxes"]) - 0.5 * h)
        if layout != "grid":
            y1 = min(y1, int(p.get("y1", p["cy"] + h / 2) + 0.55 * h))
    if it.get("tboxes"):
        # 最后一刀：同一行里右边那件的文字/药丸别带进来
        for q in (peers or []):
            qp = q.get("pill")
            if qp and qp is not p and abs(qp["cy"] - p["cy"]) < 3.0 * h and qp["x0"] > p["x1"]:
                qtx = [b[0] for b in (q.get("tboxes") or [])]
                x1 = min(x1, (min(qtx) - 0.2 * h) if qtx else (qp["x0"] - 1.4 * w))
    x0 = max(0, int(x0)); x1 = min(img.shape[1], int(x1))
    y0 = max(0, int(y0)); y1 = min(img.shape[0], int(y1))
    lim = (x0, x1, y0, y1)   # 生长收缩前的框：收缩后要能把等级/名字文字补回来
    if x1 - x0 < 20 or y1 - y0 < 20:
        return None
    # 以药丸为种子往外长到内容边缘：不切半截文字，也不留大片空白
    sub = img[y0:y1, x0:x1]
    g = cv2.cvtColor(sub, cv2.COLOR_BGR2GRAY).astype(np.int16)
    bg = float(np.median(np.concatenate([g[0], g[-1], g[:, 0], g[:, -1]])) if g.size else 0)
    mask = (np.abs(g - bg) > 20).astype(np.uint8)
    mask = cv2.morphologyEx(mask, cv2.MORPH_CLOSE, np.ones((5, 13), np.uint8))
    if mask.any():
        pcx = int(pcx - x0); pcy = int(p["cy"] - y0)
        pcx = max(0, min(mask.shape[1] - 1, pcx)); pcy = max(0, min(mask.shape[0] - 1, pcy))
        gx0, gy0, gx1, gy1 = _grow_box(mask, max(0, pcy - 2), min(mask.shape[0] - 1, pcy + 2),
                                       max(0, pcx - 2), min(mask.shape[1] - 1, pcx + 2),
                                       int(max(4, 0.5 * h)), int(max(6, 2.4 * h)), int(max(8, 2.2 * w)), int(max(5, 0.55 * w)))
        pad = int(0.12 * h)
        gx0 = max(0, gx0 - pad); gy0 = max(0, gy0 - pad)
        gx1 = min(img.shape[1] - x0 - 1, gx1 + pad); gy1 = min(img.shape[0] - y0 - 1, gy1 + pad)
        if gx1 - gx0 >= 20 and gy1 - gy0 >= 20:
            x0 += gx0; y0 += gy0; x1 = x0 + (gx1 - gx0); y1 = y0 + (gy1 - gy0)
        # 神器本体必须完整留在框里
        blob = artifact_blob(img, p)
        if blob and (blob[0] < x0 - 2 or blob[1] < y0 - 2):
            x0 = min(x0, blob[0]); y0 = min(y0, blob[1])
        # 等级/名字在读到的文字行上方：生长间距不够时也补进来，别让预览缺了等级
        ny = it.get("name_y")
        if ny and ny - 1.15 * h < y0:
            y0 = max(0, int(ny - 1.15 * h))
        if layout == "grid":
            # 下方只放到「等级小方块」为止：再往下就是别的分区，留白太丑
            if blob:
                if it.get("chip_ok"):
                    y1 = min(y1, int(max(blob[1] + blob[3] + 1.75 * blob[3],
                                        p.get("y1", p["cy"]) + 1.15 * h)))
                elif it.get("level") is not None:
                    # 等级读到了但小方块没认出来（船上「运载的文物」卡片：等级方块在本体下方）
                    y1 = min(y1, int(p.get("y1", p["cy"] + h / 2) + 6.4 * h))
                else:
                    y1 = min(y1, int(max(blob[1] + blob[3] + 0.4 * blob[3],
                                        p.get("y1", p["cy"] + h / 2) + 0.6 * h)))
            y1 = max(y1, int(p.get("y1", p["cy"]) + 0.35 * h))
    tb = it.get("tboxes") or []
    if layout != "grid" and tb:
        nx0 = max(min(t[0] for t in tb) - 0.2 * h, lim[0])
        ny0 = max(min(t[1] for t in tb) - 0.3 * h, lim[2])
        ny1 = min(max(t[3] for t in tb) + 0.3 * h, lim[3])
        nx1 = min(max(t[2] for t in tb) + 0.4 * w, lim[1])
        x0 = int(min(x0, nx0)); y0 = int(min(y0, ny0))
        x1 = int(max(x1, nx1)); y1 = int(max(y1, ny1))
    global _LAST_BOX
    _LAST_BOX = (int(x0), int(y0), int(x1), int(y1))
    return img[y0:y1, x0:x1]


def _grow_box(mask, cy0, cy1, cx0, cx1, gap_yu, gap_yd, gap_xl, gap_xr):
    """从种子（药丸所在的几行几列）往外长，遇到连续空白超过 gap 就停：刚好框住这一件的文字+图标"""
    H, W = mask.shape
    ys = mask.any(axis=1)
    y0, y1 = cy0, cy1
    blank = 0
    y = cy0 - 1
    while y >= 0:
        if ys[y]:
            y0 = y; blank = 0
        else:
            blank += 1
            if blank > gap_yu:
                break
        y -= 1
    blank = 0
    y = cy1 + 1
    while y < H:
        if ys[y]:
            y1 = y; blank = 0
        else:
            blank += 1
            if blank > gap_yd:
                break
        y += 1
    xs = mask[y0:y1 + 1].any(axis=0)
    blank = 0
    x = cx0 - 1
    while x >= 0:
        if xs[x]:
            x0 = x; blank = 0
        else:
            blank += 1
            if blank > gap_xl:
                break
        x -= 1
    blank = 0
    x = cx1 + 1
    while x < W:
        if xs[x]:
            x1 = x; blank = 0
        else:
            blank += 1
            if blank > gap_xr:
                break
        x += 1
    return x0, y0, x1, y1


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


def _core_med(bgr):
    h, w = bgr.shape[:2]
    side = int(min(h, w) * 0.62)
    cy, cx = h // 2, w // 2
    y0 = max(0, cy - side // 2); x0 = max(0, cx - side // 2)
    core = bgr[y0:y0 + side, x0:x0 + side]
    if core.size == 0:
        return None
    return float(np.median(cv2.cvtColor(core, cv2.COLOR_BGR2GRAY)))


def bp_of(img, pill, layout):
    """量子图纸：在药丸下方整片区域滑动找「黑底/白底方块」，找不到或分不清就不写（宁可空着让人选）
    黑底方块（暗物质）中心灰度≈3~10，白底（光物质）≈250，卡片底色≈58、灰伞图标≈137 都不算。"""
    if not pill:
        return ""
    w = pill["x1"] - pill["x0"]
    h = pill["h"]
    x0 = max(0, int(pill["x0"] - 0.6 * w)); x1 = min(img.shape[1], int(pill["x1"] + 0.6 * w))
    py1 = pill.get("y1", pill.get("cy", 0) + h / 2)
    y0 = max(0, int(py1)); y1 = min(img.shape[0], int(py1 + 3.2 * h))
    side = max(14, int(0.5 * w))
    if x1 - x0 <= side or y1 - y0 <= side:
        return ""
    dark = light = 0
    stepx = max(1, (x1 - x0 - side) // 8)
    stepy = max(1, (y1 - y0 - side) // 8)
    for yy in range(y0, y1 - side, stepy):
        for xx in range(x0, x1 - side, stepx):
            m = _core_med(img[yy:yy + side, xx:xx + side])
            if m is None:
                continue
            if m <= 15:
                dark += 1
            elif m >= 245:
                light += 1
    if dark >= 6 and dark > light:
        return "暗"
    if light >= 6 and light > dark:
        return "光"
    return ""


# ---------- 量子图纸：与上传的图标做图案比对（图案一致才认） ----------
_BP = []          # [(key, 归一化后的 64x64 参考图)]
BP_MATCH = 0.60   # 比对门槛：真图纸实测 0.74~0.84，异物最高 0.42


def _norm_tile(bgr):
    g = cv2.cvtColor(cv2.resize(bgr, (64, 64), interpolation=cv2.INTER_AREA), cv2.COLOR_BGR2GRAY)
    g = cv2.GaussianBlur(g.astype(np.float32), (3, 3), 0.8)
    return (g - g.mean()) / (g.std() + 1e-6)


def load_blueprints():
    """读 img/bp/index.json：哪个图标对应哪张量子图纸，供图案比对用。"""
    global _BP
    _BP = []
    idx = os.path.join(IMG, "bp", "index.json")
    try:
        with open(idx, encoding="utf-8") as f:
            data = json.load(f)
    except Exception as e:
        print("图纸对照表读不到", e)
        return
    for bp in data.get("blueprints", []):
        imgs = [bp.get("img", "")] + list(bp.get("alts") or [])
        for rel in imgs:
            bgr = cv2.imread(os.path.join(HERE, rel))
            if bgr is None:
                print("图纸图标缺失", bp.get("key"), rel)
                continue
            _BP.append((bp["key"], _norm_tile(bgr)))
    load_shapes()
    print("图纸对照加载", [k for k, _ in _BP])


def bp_match(img, pill, layout=""):
    """量子图纸：在药丸下方区域多尺度找方块，逐个和对照表里的图标算相似度，
    只有和某张图图案一致（>=BP_MATCH）才输出该图纸 key，否则留空（宁可空着不猜）。
    实测真图纸 0.72~0.84，异物最高约 0.44。"""
    if not pill or not _BP:
        return ""
    w = pill["x1"] - pill["x0"]
    h = pill["h"]
    py1 = pill.get("y1", pill.get("cy", 0) + h / 2)
    best, best_key = 0.0, ""
    for lf, rf in ((0.6, 0.6), (0.8, 0.9), (0.5, 0.5), (1.0, 1.0)):
        x0 = max(0, int(pill["x0"] - lf * w)); x1 = min(img.shape[1], int(pill["x1"] + rf * w))
        for top in (0.0, 0.15, 0.3):
            y0 = max(0, int(py1 + top * h)); y1 = min(img.shape[0], int(py1 + 3.2 * h))
            if x1 - x0 < 20 or y1 - y0 < 20:
                continue
            reg = img[y0:y1, x0:x1]
            g = cv2.cvtColor(reg, cv2.COLOR_BGR2GRAY)
            sat = cv2.cvtColor(reg, cv2.COLOR_BGR2HSV)[:, :, 1].astype(int)
            masks = ((g <= 30).astype(np.uint8) * 255, ((g >= 235) & (sat < 40)).astype(np.uint8) * 255)
            for m in masks:
                m = cv2.morphologyEx(m, cv2.MORPH_CLOSE, np.ones((7, 7), np.uint8))
                cs, _ = cv2.findContours(m, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
                for c in cs:
                    x, y, cw, ch = cv2.boundingRect(c)
                    if not (0.15 * w <= cw <= 0.65 * w and 0.15 * w <= ch <= 0.65 * w):
                        continue
                    if not (0.68 <= cw / max(1, ch) <= 1.5):
                        continue
                    if cv2.contourArea(c) / float(cw * ch) < 0.45:
                        continue
                    q = _norm_tile(reg[y:y + ch, x:x + cw])
                    for key, ref in _BP:
                        sc = float((q * ref).mean())
                        if sc > best:
                            best, best_key = sc, key
    print("  图纸比对", round(best, 3), best_key)
    return best_key if best >= BP_MATCH else ""


# ---------- 星球货物列表上的「暗一点」图纸：固定几何带 + 滑动窗口 + 对比度拉伸 ----------
BP_STRETCH = 0.62   # 滑动窗口版门槛
BP_MARGIN = 0.15    # 第一名要比第二名高出这么多才认，否则留空让人手选
BP_STRETCH_LO = 0.58  # 分数略低但和第二名差距很大时也认（暗图纸对比度天然偏低）
BP_MARGIN_LO = 0.22
BP_SAW = 0.45       # 看到「像个图纸方块」的最低分：只用来提示“有图纸但没认准”


def _stretch64(bgr):
    """拉伸 5%~95% 分位再归一化：对付暗背景上几乎看不见的淡图案"""
    g = cv2.cvtColor(bgr, cv2.COLOR_BGR2GRAY).astype(np.float32)
    lo, hi = np.percentile(g, 5), np.percentile(g, 95)
    g = np.clip((g - lo) * 255.0 / max(8.0, float(hi - lo)), 0, 255)
    g = cv2.resize(g, (64, 64), interpolation=cv2.INTER_AREA)
    g = cv2.GaussianBlur(g, (3, 3), 0.8)
    return (g - g.mean()) / (g.std() + 1e-6)


def bp_slide(img, pill, type_key=""):
    """在药丸右上方的带子里滑动找方块（图纸小方块挂在这里），返回 [(分数, key)] 合表"""
    if not pill or not _BP:
        return {}, None
    w = pill["x1"] - pill["x0"]; h = pill["h"]; cy = pill["cy"]
    x0 = max(0, int(pill["x0"] - 0.2 * w)); x1 = min(img.shape[1], int(pill["x1"] + 1.0 * w))
    y0 = max(0, int(cy - 3.2 * h)); y1 = min(img.shape[0], int(cy - 0.15 * h))
    if x1 - x0 < 30 or y1 - y0 < 30:
        return {}, None
    reg = img[y0:y1, x0:x1]
    # 药丸本身是亮薄荷色方块，和“光物质”图纸长得像，滑动时要把它扣掉，不然会把药丸当图纸
    px0 = pill["x0"] - x0 - 0.45 * h; px1 = pill["x1"] - x0 + 0.45 * h
    py0 = (cy - 0.5 * h) - y0 - 0.12 * h; py1 = (cy + 0.5 * h) - y0 + 0.12 * h
    agg = {}
    wins = {}
    best = (0.0, 0, 0, 0)

    def _on_pill(x, y, s):
        # 只排掉“窗口中心落在药丸里”的（药丸本身像光物质方块）；图纸方块压在药丸边角上时不能误杀
        cx = x + s / 2.0; cyy = y + s / 2.0
        return px0 - 0.10 * s <= cx <= px1 + 0.10 * s and py0 - 0.10 * s <= cyy <= py1 + 0.10 * s
    for s in (int(0.45 * w), int(0.55 * w), int(0.65 * w)):
        if s < 16 or s > min(reg.shape[0], reg.shape[1]):
            continue
        st = max(5, s // 5)
        for y in range(0, reg.shape[0] - s + 1, st):
            for x in range(0, reg.shape[1] - s + 1, st):
                if _on_pill(x, y, s):
                    continue
                q = _stretch64(reg[y:y + s, x:x + s])
                for key, ref in _BP:
                    sc = float((q * ref).mean())
                    if sc > agg.get(key, 0.0):
                        agg[key] = sc
                        wins[key] = (x, y, s)
                        if sc > best[0]:
                            best = (sc, x, y, s)
    # 精修：粗扫是 5~6px 步长，图纸方块只有 50 多像素，差 2~3 像素分数会掉一大截。
    # 改成「每个候选 key 精修自己的窗口」，只拿它自己的参考图比：既省算力，
    # 又不会因为全局最佳窗口属于别的 key（同一张图明/暗极性不同）而漏掉真正的匹配。
    rbk = {}
    for key, ref in _BP:
        rbk.setdefault(key, []).append(ref)
    # 方块底色定明/暗：深底认暗物质那套，浅底认光物质那套，同族里先排掉一半候选
    tone = ""
    if best[3]:
        box = reg[best[2]:best[2] + best[3], best[1]:best[1] + best[3]]
        if box.size:
            tone = "_light" if float(np.median(cv2.cvtColor(box, cv2.COLOR_BGR2GRAY))) >= 70 else "_dark"
    # 1) 每个候选 key 用自己的参考图在自己窗口周围找回精确位置（细线条图纸粗扫偏一点分数就塌）
    for key, _sc in sorted(agg.items(), key=lambda kv: -kv[1])[:6]:
        bx, by, bs = wins[key]
        for s2 in range(max(16, bs - 6), bs + 7):
            for yy in range(max(0, by - 8), min(reg.shape[0] - s2, by + 8) + 1, 2):
                for xx in range(max(0, bx - 8), min(reg.shape[1] - s2, bx + 8) + 1, 2):
                    if _on_pill(xx, yy, s2):
                        continue
                    q = _stretch64(reg[yy:yy + s2, xx:xx + s2])
                    for ref in rbk[key]:
                        sc = float((q * ref).mean())
                        if sc > agg.get(key, 0.0):
                            agg[key] = sc
                            wins[key] = (xx, yy, s2)
    # 2) 方块附近最容易找对：以当前分数最高那张图（精修后）的窗口为锚，
    #    用同色调的参考图再细扫一遍——细线条图纸只有在这一带才能扫出真分数
    fam = BP_FAMILY.get(type_key or "", ())
    tref = [(k, r) for k, r in _BP if ((not tone) or k.endswith(tone))
            and ((not fam) or k.split("_")[0] in fam)]
    anchors = []
    if agg:
        anchors.append(wins[max(agg.items(), key=lambda kv: kv[1])[0]])
    if best[3] and best[1:4] != anchors[0]:
        anchors.append((best[1], best[2], best[3]))
    for ax, ay, asz in anchors:
        for s2 in range(max(16, asz - 8), asz + 9, 2):
            for yy in range(max(0, ay - 4), min(reg.shape[0] - s2, ay + 4) + 1):
                for xx in range(max(0, ax - 4), min(reg.shape[1] - s2, ax + 4) + 1):
                    if _on_pill(xx, yy, s2):
                        continue
                    q = _stretch64(reg[yy:yy + s2, xx:xx + s2])
                    for key, ref in tref:
                        sc = float((q * ref).mean())
                        if sc > agg.get(key, 0.0):
                            agg[key] = sc
                            wins[key] = (xx, yy, s2)
    return agg, {k: (x0 + v[0], y0 + v[1], v[2]) for k, v in wins.items()}


def _chip_box(img, win):
    """把 NCC 找到的大致窗口收紧到图纸方块本身（方块只有 54px 左右，窗口留白会稀释图案差异）"""
    if not win:
        return None
    bx, by, sw = win
    m = int(0.45 * sw)
    x0 = max(0, bx - m); y0 = max(0, by - m)
    x1 = min(img.shape[1], bx + sw + m); y1 = min(img.shape[0], by + sw + m)
    g = cv2.cvtColor(img[y0:y1, x0:x1], cv2.COLOR_BGR2GRAY)
    bg = int(np.median(g))
    mask = (np.abs(g.astype(np.int16) - bg) > 6).astype(np.uint8)
    mask = cv2.morphologyEx(mask, cv2.MORPH_CLOSE, np.ones((5, 5), np.uint8))
    n, lab, stats, _ = cv2.connectedComponentsWithStats(mask, 8)
    cxp = bx + sw / 2 - x0; cyp = by + sw / 2 - y0
    pick = None
    for j in range(1, n):
        x, y, w, h, area = stats[j]
        if area < 400:
            continue
        d = abs(x + w / 2 - cxp) + abs(y + h / 2 - cyp)
        sc = area / (1 + 0.6 * d)
        if pick is None or sc > pick[0]:
            pick = (sc, (x0 + x, y0 + y, w, h))
    if not pick:
        return (bx, by, sw, sw)
    x, y, w, h = pick[1]
    if not (0.55 * sw <= w <= 1.45 * sw and 0.55 * sw <= h <= 1.45 * sw):
        return (bx, by, sw, sw)
    return (x, y, w, h)


def _mask_sig(bgr, s=40, frac=0.62):
    """二值化图案（抠掉底色），只留线条形状，用来分同色同框的不同图纸"""
    g = bgr if bgr.ndim == 2 else cv2.cvtColor(bgr, cv2.COLOR_BGR2GRAY)
    h, w = g.shape
    cw = max(10, int(min(h, w) * frac))
    g = g[(h - cw) // 2:(h - cw) // 2 + cw, (w - cw) // 2:(w - cw) // 2 + cw]
    core = g[cw // 5:4 * cw // 5, cw // 5:4 * cw // 5].ravel()
    hist = np.bincount(core, minlength=256).astype(np.float32).reshape(-1, 1)
    bg = float(np.argmax(cv2.GaussianBlur(hist, (1, 7), 0).ravel()))
    d = np.abs(g.astype(np.float32) - bg)
    d = cv2.resize(d, (s, s), interpolation=cv2.INTER_AREA)
    d = (d > 0.45 * float(np.percentile(d, 99.5))).astype(np.float32)
    d = cv2.resize(d, (24, 24), interpolation=cv2.INTER_AREA)
    d = (d > 0.4).astype(np.float32)
    return d if d.sum() >= 10 else None


_SHAPE = []      # [(key, 二值图案)]


def load_shapes():
    global _SHAPE
    _SHAPE = []
    idx = os.path.join(IMG, "bp", "index.json")
    try:
        with open(idx, encoding="utf-8") as f:
            data = json.load(f)
    except Exception:
        return
    for bp in data.get("blueprints", []):
        for rel in [bp.get("img", "")] + list(bp.get("alts") or []):
            bgr = cv2.imread(os.path.join(HERE, rel))
            if bgr is None:
                continue
            for s in (36, 40, 44):
                sig = _mask_sig(bgr, s, 0.62)
                if sig is not None:
                    _SHAPE.append((bp["key"], sig))


def _shape_scores(img, wins):
    """图案重合度：每个图纸 key 在它自己最像的那个窗口里再比一次形状，
    外框、底色一模一样时（暗/光同款、不同图纸同色框），靠这个分高下"""
    if not wins or not _SHAPE:
        return {}
    best = {}
    for key, win in wins.items():
        box = _chip_box(img, win)
        if not box:
            continue
        x, y, w, h = box
        for pad in (0, 1, 2):
            for dy in (0, -1, 1):
                for dx in (0, 1, -1):
                    tile = img[y + dy + pad:y + h + dy - pad, x + dx + pad:x + w + dx - pad]
                    if tile.shape[0] < 20 or tile.shape[1] < 20:
                        continue
                    q = _mask_sig(tile, 40, 0.62)
                    if q is None:
                        continue
                    for key2, ref in _SHAPE:
                        if key2 != key:
                            continue
                        inter = float((q * ref).sum()); uni = float(q.sum() + ref.sum() - inter)
                        sc = inter / uni if uni else 0.0
                        if sc > best.get(key, 0.0):
                            best[key] = sc
    return best


# 图纸归属：运输舰神器（黄）=贸易爆发；采矿舰神器（紫）=矿物粉碎 + 氢气火箭
BP_FAMILY = {"trade": ("trade",), "mining": ("crush", "rocket"), "weapon": ("laser", "launcher"), "shield": ("omega",), "support": ("slauncher", "delta"), "drone": ("drone", "cerberus")}


def bp_scan(img, pill, layout="", type_key="", side=""):
    """两道工序合起来：轮廓法（老逻辑，容器/亮底好用）+ 滑动法（星球列表上的暗图纸）。
    返回 (key, saw)：key 为空但有 saw=True 表示“看到一张图纸但没认准”，前端提示手选。"""
    if not pill or not _BP:
        return "", False, []
    scores = {}
    old = bp_match(img, pill, layout) or ""
    if old:
        scores[old] = 0.80
    agg, wins = bp_slide(img, pill, type_key)
    # 没带图纸的神器有时会被自己的发光六边形蹭出高分：排除落在「神器本体」正中心的窗口
    blob = artifact_blob(img, pill)
    if blob:
        bx, by, bw, bh = blob
        for k, (wx, wy, bs) in list(wins.items()):
            sub = img[max(0, wy):wy + bs, max(0, wx):wx + bs]
            if sub.size == 0:
                continue
            # 空面板也会被归一化硬凑出 0.7 分：窗口里没「墨」（既无亮暗图案，也没起伏）就直接作废
            gg = cv2.cvtColor(sub, cv2.COLOR_BGR2GRAY).astype(np.int16)
            m = float(np.median(gg))
            if float(gg.std()) < 8 or float((np.abs(gg - m) > 25).mean()) < 0.03:
                agg.pop(k, None); wins.pop(k, None)
    shape = _shape_scores(img, wins)
    if not agg and not old:
        return "", False, []
    for k, v in agg.items():
        scores[k] = max(scores.get(k, 0.0), v)
    fam = BP_FAMILY.get(type_key or "", ())
    if fam:
        # 类型已经从神器颜色判出来了，图纸就只在这类里面挑：别让外形相近的别类图纸抢走
        scores = {k: v for k, v in scores.items() if k.split("_")[0] in fam}
    top = sorted(scores.items(), key=lambda kv: -kv[1])[:2]
    best = top[0] if top else ("", 0.0)
    second = top[1][1] if len(top) > 1 else 0.0
    saw = best[1] >= BP_SAW
    if old:
        return old, True, []
    gap = best[1] - second
    if best[0] and ((best[1] >= BP_STRETCH and gap >= BP_MARGIN) or (best[1] >= BP_STRETCH_LO and gap >= BP_MARGIN_LO)
                    or (best[1] >= 0.88 and gap >= 0.08)):
        return best[0], True, []
    # 图纸方块只有两种底色：深底（暗物质）和浅底（光物质）。方块底色亮度是硬信息，
    # 先用它把同族里明/暗两套排掉一半，剩下的同族图纸再用「相似度 + 图案重合度」决出。
    fam = fam
    if fam:
        bw = wins.get(best[0]) or wins.get(max(agg.items(), key=lambda kv: kv[1])[0] if agg else "")
        if bw is None:
            bw = wins[max(agg.items(), key=lambda kv: kv[1])[0]]
        bx, by, bs = bw
        box = img[by:by + bs, bx:bx + bs]
        bg = 137.0
        if box.size:
            bg = float(np.median(cv2.cvtColor(box, cv2.COLOR_BGR2GRAY)))
        tone = "_light" if bg >= 70 else "_dark"
        cand = [(k, v) for k, v in scores.items()
                if k.split("_")[0] in fam and k.endswith(tone)]
        comb = sorted(((k, v + 0.6 * shape.get(k, 0.0)) for k, v in cand), key=lambda kv: -kv[1])
        if len(comb) == 1:
            # 同族同色调只剩一张：分数或图案够像就认（护盾只有一张，方块底色又对得上，错不了）
            if (cand[0][1] >= 0.80 and shape.get(comb[0][0], 0.0) >= 0.12) or comb[0][1] >= 1.10:
                return comb[0][0], True, []
        elif len(comb) >= 2:
            if comb[0][1] >= 1.05 and comb[0][1] - comb[1][1] >= 0.05 \
                    and shape.get(comb[0][0], 0.0) >= 0.25:
                return comb[0][0], True, []
    sug = []
    if best[1] >= 0.80:
        comb = sorted(((k, v + 0.6 * shape.get(k, 0.0)) for k, v in scores.items() if v >= 0.78),
                      key=lambda kv: -kv[1])
        sug = [k for k, _ in comb[:2]]
    return "", saw, sug


def lum_of(bgr):
    if bgr is None or bgr.size == 0:
        return None
    g = cv2.cvtColor(bgr, cv2.COLOR_BGR2GRAY)
    return int(float(g.mean()))


# ---------- 颜色认类型（用图鉴 64 个官方图标当参照）----------
NAME2KEY = {"运输舰": "trade", "采矿": "mining", "战斗": "support",
            "武器": "weapon", "护盾": "shield", "无人机": "drone"}
_CAT = []


def load_catalog():
    """把 data.json 里的图鉴图标读成色相签名，用来按颜色反推类型"""
    global _CAT
    path = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "data.json")
    if not os.path.exists(path):
        return
    try:
        data = json.load(open(path, encoding="utf-8"))
    except Exception:
        return
    for e in data.get("catalog") or []:
        key = NAME2KEY.get(e.get("type") or "")
        img = os.path.join(os.path.dirname(path), e.get("img") or "")
        if not key or not os.path.exists(img):
            continue
        bgr = cv2.imread(img)
        if bgr is None:
            continue
        _CAT.append((key, hue_sig(bgr)))


def hue_sig(bgr):
    """色相直方图（按饱和度加权），只统计够亮的彩色像素，避免背景和青色 UI 干扰"""
    im = cv2.resize(bgr, (32, 32))
    hsv = cv2.cvtColor(im, cv2.COLOR_BGR2HSV)
    h = hsv[:, :, 0].astype(int).ravel()
    s = hsv[:, :, 1].astype(int).ravel()
    v = hsv[:, :, 2].astype(int).ravel()
    w = (s > 90) & (v > 90)
    hist = np.bincount((h[w] // 5), weights=(s[w] / 255.0), minlength=36)
    n = hist.sum()
    return hist / (n if n else 1)


# 神器主色（OpenCV 色相 0~180）：黄=运输舰、紫=采矿、绿=战斗、粉红=武器、青=护盾、橙=无人机
HUE_CENTER = {"trade": 25, "drone": 20, "support": 55, "weapon": 166, "shield": 88, "mining": 122}


def _hue_gap(a, b):
    d = abs(a - b) % 180
    return min(d, 180 - d)


def type_of(card):
    """神器颜色→类型：先按主色相把候选收窄，再和图鉴图标比色相分布；拿不准就留空（宁可空着让人选）"""
    if card is None or not _CAT:
        return ""
    q = hue_sig(card)
    peak_b = int(max(range(36), key=lambda i: q[i]))
    peak = peak_b * 5
    mass = float(q[max(0, peak_b - 2):peak_b + 3].sum())
    # 65~100 是薄荷绿药丸/界面按钮的色相带，卡片里那块会把神器颜色带偏，落在这段就不敢按色相定
    ok_hue = mass >= 0.62 and not (62 <= peak <= 102)
    near = [k for k, c in HUE_CENTER.items() if _hue_gap(peak, c) <= 12] if ok_hue else []
    if len(near) == 1:
        return near[0]
    scores = []
    for key, sig in _CAT:
        den = float(np.linalg.norm(q) * np.linalg.norm(sig)) + 1e-9
        scores.append((float((q * sig).sum() / den), key))
    if near:
        scores = [x for x in scores if x[1] in near]
    scores.sort(reverse=True)
    top = scores[:6]
    votes = {}
    for sc, key in top:
        votes[key] = votes.get(key, 0) + sc
    best, pts = max(votes.items(), key=lambda kv: kv[1])
    total = sum(votes.values())
    if pts / (total + 1e-9) < 0.45:
        return ""
    return best



def bp_pending_tone(img, pill):
    """图纸方块整体偏暗（星球列表那种“暗一点”的图纸）时返回 True，仅用于前端提示文案。"""
    if not pill:
        return False
    w = pill["x1"] - pill["x0"]; h = pill["h"]; cy = pill["cy"]
    cx = int(pill["x0"] + 0.8 * w); cyc = int(cy - 1.55 * h)
    half = int(0.28 * w)
    x0 = max(0, cx - half); x1 = min(img.shape[1], cx + half)
    y0 = max(0, cyc - half); y1 = min(img.shape[0], cyc + half)
    if x1 - x0 < 10 or y1 - y0 < 10:
        return False
    g = cv2.cvtColor(img[y0:y1, x0:x1], cv2.COLOR_BGR2GRAY)
    return float(np.median(g)) < 110


def main():
    files = sorted(f for f in os.listdir(INBOX) if not f.startswith("."))
    if not files:
        print("inbox empty")
        return
    os.makedirs(OUT, exist_ok=True)
    load_catalog()
    load_blueprints()
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
        grid = []
        try:
            grid = parse_grid(path, img)
        except Exception as e:
            print("容器版式异常", e)
            grid = []
        # 两个版式都可能认出一堆东西，挑“读到加成的件数”多的那个（加成=药丸，最容易判对错）
        def score(xs):
            # 先比「等级+加成」都读到的件数，再比读到加成的件数：容器版式靠薄荷色小方块认等级，通常更准
            return (sum(1 for x in xs if x.get("level") is not None and x.get("bonus") is not None),
                    sum(1 for x in xs if x.get("bonus") is not None), len(xs))
        # 打平时优先列表版式：列表的预览带「神器名/等级/吨数」，核对更清楚
        if grid and score(grid) > score(items):
            items = grid
        xs = sorted(it["pill"]["x0"] for it in items if it.get("pill"))
        gaps = [b - a for a, b in zip(xs, xs[1:]) if b - a > 20]
        cellw = sorted(gaps)[len(gaps) // 2] if gaps else None
        for it in items:
            layout = "grid" if it.get("layout") == "grid" else "list"
            loc = grid_windows(img, it, cellw) if layout == "grid" else windows(img, it)
            _side = (loc.get("side") if loc else "暗")
            # 预览图只截这一件神器本体（一个发光六边形），顺带用它判颜色定类型：
            # 先靠神器颜色定类型，再按类型去找量子图纸，比拿整张卡片猜色准得多
            acrop = artifact_crop(img, it, layout)
            tkey = it.get("type") or type_of(acrop) or type_of(loc.get("card") if loc else None)
            card = item_card(img, it, layout, cellw, items)
            if card is None and loc and loc.get("card") is not None:
                card = loc["card"]
            bp_key, bp_saw, bp_sug = bp_scan(img, it.get("pill"), layout, tkey or "", _side)
            bp_dark = bp_pending_tone(img, it.get("pill"))
            icon = loc.get("icon") if loc else None
            icon = square_center(icon) if icon is not None else None
            sig = grad_sig(icon) if icon is not None else ""
            def _bx(d):
                if not d:
                    return None
                y0 = d.get("y0", d["cy"] - d["h"] / 2)
                y1 = d.get("y1", d["cy"] + d["h"] / 2)
                return [int(d["x0"]), int(y0), int(d["x1"]), int(y1)]
            blob = artifact_blob(img, it.get("pill"))
            if layout == "grid" and blob is not None and blob[2] < 1.0 * it["pill"]["h"]:
                # 容器/船上卡片底下一定有神器本体；找不到本体的「药丸」是误检（比如属性栏里的数值条）
                continue
            coords = {
                "pill": _bx(it.get("pill")),
                "text": [[int(v) for v in b] for b in (it.get("tboxes") or [])],
                "icon": [int(blob[0]), int(blob[1]), int(blob[0] + blob[2]), int(blob[1] + blob[3])]
                        if blob else None,
                "card": list(_LAST_BOX) if _LAST_BOX else None,
            }
            res["items"].append({
                "coords": coords,
                "type_key": tkey,
                "level": it.get("level"), "bonus": it.get("bonus"),
                "side": loc.get("side") if loc else "暗",
                "sig": sig, "lum": lum_of(icon),
                "plate": save_img(card, "p") if card is not None else "",
                "badge_img": save_img(icon, "b") if icon is not None else "",
                "bp": bp_key, "bp_saw": bp_saw, "bp_dark_spot": bp_dark, "bp_sug": bp_sug,
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
