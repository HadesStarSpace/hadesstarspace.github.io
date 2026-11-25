"""AI 识别（跑在 GitHub Actions 里）：整张截图交给视觉模型，模型直接给出
「神器类型 / 名字 / 等级 / 吨数 / 加成 / 量子图纸」以及这件卡片在图里的方框。
不再做任何 OCR：文字、坐标都由模型给，识别不到就留空让用户手填。

inbox 里的文件名格式：<base64url 用户名>__<时间戳>_<序号>.png
"""
import base64
import hashlib
import json
import os
import sys
import time
import urllib.request

import cv2
import numpy as np

HERE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DATA = os.path.join(HERE, "data.json")
INBOX = os.path.join(HERE, "inbox")
OUT = os.path.join(HERE, "inbox_out")
IMG = os.path.join(HERE, "img")
BPINDEX = os.path.join(HERE, "img", "bp", "index.json")

TYPES = [("运输舰", "trade"), ("武器", "weapon"), ("战斗", "support"), ("护盾", "shield"),
         ("采矿", "mining"), ("支援", "support"), ("无人机", "drone")]

MODEL = os.environ.get("VISION_MODEL", "openai/gpt-4o")
ENDPOINT = "https://models.github.ai/inference/chat/completions"

BP_LIST = []


def load_blueprints():
    """图纸对照表：只把 key + 中文名 交给模型，模型只允许从这里面挑，认不出就留空。"""
    global BP_LIST
    BP_LIST = []
    try:
        with open(BPINDEX, encoding="utf-8") as f:
            d = json.load(f)
        BP_LIST = [dict(key=b["key"], name=b["name"], type=b.get("type", "")) for b in d.get("blueprints", [])]
    except Exception as e:
        print("图纸表读取失败", e)
    return BP_LIST


# ---------- 视觉模型 ----------
def _b64_jpeg(path, max_side=1600):
    img = cv2.imread(path)
    if img is None:
        return None, None
    h, w = img.shape[:2]
    scale = min(1.0, max_side / float(max(h, w)))
    if scale < 1.0:
        img = cv2.resize(img, (int(w * scale), int(h * scale)), interpolation=cv2.INTER_AREA)
    ok, buf = cv2.imencode(".jpg", img, [int(cv2.IMWRITE_JPEG_QUALITY), 88])
    if not ok:
        return None, None
    return base64.b64encode(buf.tobytes()).decode(), img.shape[:2]


PROMPT = """这是游戏《Hades' Star》的中文截图。图里有若干件「神器（遗物/artifact）」，可能出现在：
1) 星球的「货物」列表（每行：神器名 / 等级N / 吨数 / 右侧图标和 +加成）；
2) 神器容器（网格卡片：上面 +加成、中间量子图纸小方块、下面发光六边形本体和等级小方块）；
3) 运输舰详情页的「运载的文物」（每张卡片：上方 +N%%、中间图纸方块、下面发光本体、最底部左侧薄荷色等级小方块）。

请把图里每一件神器都列出来，逐件给出：
- type：只能是这几个中文词之一：运输舰 / 采矿 / 武器 / 护盾 / 战斗 / 无人机（按神器的颜色判断：黄=运输舰，紫=采矿，红=武器，蓝=护盾，绿=战斗，橙=无人机）
- name：神器名字（如「运输舰神器」「无人机神器」），看不清就 null
- level：等级整数（截图里写作「等级12」或底部薄荷色小方块里的数字），看不清就 null
- tons：吨数整数（如「50吨」里的 50；容器卡片没有吨数就 null）
- bonus：加成百分比的数字（如「+360%%」就是 360；「+720%%」就是 720），看不清就 null
- bp：这件神器挂的「量子图纸」key，必须从下面清单里选一个；没有量子图纸方块、或方块看不清，一律 null
- boxes：这件卡片在图上的外接矩形，坐标用 0-1000 的归一化整数 [x0,y0,x1,y1]（左上角是 [0,0]，右下角是 [1000,1000]）。
  要求：box 要把这一件的「加成药丸 + 量子图纸方块（若有）+ 发光本体 + 等级（文字或小方块）」全部包住，
  但不要包进相邻的另一件；运输舰「运载的文物」卡片里没有神器名，box 也不用包含它。

量子图纸清单（key = 中文名）：
%s

只输出 JSON，不要任何解释，格式：
{"items":[{"type":"无人机","name":"无人机神器","level":12,"tons":50,"bonus":360,"bp":null,"boxes":[120,680,320,880]}]}
图里没有任何神器就返回 {"items":[]}。"""


def _call_model(b64, keys_hint):
    token = os.environ.get("GITHUB_TOKEN") or os.environ.get("GH_TOKEN") or ""
    if not token:
        raise RuntimeError("缺少 GITHUB_TOKEN")
    body = {
        "model": MODEL,
        "temperature": 0,
        "max_tokens": 1500,
        "messages": [{
            "role": "user",
            "content": [
                {"type": "text", "text": PROMPT % keys_hint},
                {"type": "image_url", "image_url": {"url": "data:image/jpeg;base64," + b64}},
            ],
        }],
    }
    req = urllib.request.Request(ENDPOINT, data=json.dumps(body).encode(), method="POST",
                                 headers={"Authorization": "Bearer " + token,
                                          "Content-Type": "application/json",
                                          "Accept": "application/json"})
    with urllib.request.urlopen(req, timeout=180) as r:
        payload = json.loads(r.read().decode())
    txt = payload["choices"][0]["message"]["content"]
    if isinstance(txt, list):      # 少数模型返回分段内容
        txt = "".join(p.get("text", "") for p in txt if isinstance(p, dict))
    txt = str(txt).strip()
    lo, hi = txt.find("{"), txt.rfind("}")
    if lo >= 0 and hi > lo:
        txt = txt[lo:hi + 1]
    return json.loads(txt)


# ---------- 图像：找本体 / 站等级方块 / 裁预览 ----------
def icon_blob(img, box):
    """在给定区域里找彩色发光的六边形本体，返回 (x,y,side)。"""
    x, y, w, h = [int(v) for v in box]
    sub = img[max(0, y):y + h, max(0, x):x + w]
    if sub.size == 0:
        return None
    hsv = cv2.cvtColor(sub, cv2.COLOR_BGR2HSV)
    S, V = hsv[:, :, 1].astype(np.int16), hsv[:, :, 2].astype(np.int16)
    m = ((S > 60) & (V > 80)).astype(np.uint8)
    m = cv2.morphologyEx(m, cv2.MORPH_CLOSE, np.ones((7, 7), np.uint8))
    n, lab, st, _ = cv2.connectedComponentsWithStats(m, 8)
    best = None
    for j in range(1, n):
        bx, by, bw, bh, area = st[j]
        if area < 500 or bw < 0.2 * h or bh < 0.2 * h:
            continue
        if bw > 0.95 * w or bh > 0.95 * h:
            continue
        ar = bw / float(max(bh, 1))
        if ar < 0.5 or ar > 2.2:
            continue
        s = int(max(bw, bh))
        key = (abs(ar - 1.0), -area)
        if best is None or key < best[0]:
            best = (key, x + bx + bw // 2 - s // 2, y + by + bh // 2 - s // 2, s)
    if not best:
        return None
    _, cx, cy, s = best
    return (max(0, cx), max(0, cy), s)


def crop_card(img, norm_box):
    """按模型给的归一化方框裁预览；框不可用时返回 None。"""
    H, W = img.shape[:2]
    box = None
    if isinstance(norm_box, (list, tuple)) and len(norm_box) == 4:
        try:
            x0, y0, x1, y1 = [float(v) for v in norm_box]
            if max(x0, y0, x1, y1) <= 1.5:                 # 模型偶尔给 0-1 的比例
                x0, y0, x1, y1 = x0 * 1000, y0 * 1000, x1 * 1000, y1 * 1000
            box = (x0 * W / 1000.0, y0 * H / 1000.0, x1 * W / 1000.0, y1 * H / 1000.0)
        except Exception:
            box = None
    if box is None:
        return None, None
    if box[2] - box[0] < 40 or box[3] - box[1] < 40:
        return None, None
    x0 = max(0, int(box[0])); y0 = max(0, int(box[1]))
    x1 = min(W, int(box[2])); y1 = min(H, int(box[3]))
    # 模型框偶尔少包了底部等级方块/顶部加成：用本体几何补一刀
    blob = icon_blob(img, (x0, y0, x1 - x0, y1 - y0))
    if blob:
        bx, by, bs = blob
        y0 = max(0, min(y0, by - int(0.15 * bs)))
        x0 = max(0, min(x0, bx - int(0.12 * bs)))
        y1 = min(H, max(y1, by + int(1.95 * bs)))
        x1 = min(W, max(x1, bx + int(1.15 * bs)))
    return img[y0:y1, x0:x1], (x0, y0, x1, y1)


def grad_sig(icon_bgr):
    if icon_bgr is None or icon_bgr.size == 0:
        return ""
    g = cv2.cvtColor(cv2.resize(icon_bgr, (32, 32), interpolation=cv2.INTER_AREA), cv2.COLOR_BGR2GRAY).astype(np.float64)
    lo, hi = np.percentile(g, 5), np.percentile(g, 95)
    span = max(8.0, hi - lo)
    g = np.clip((g - lo) * 255.0 / span, 0, 255)
    raw = np.zeros((16, 16))
    for y in range(16):
        for x in range(16):
            acc = 0.0
            for dy in range(2):
                for dx in range(2):
                    px, py = 2 * x + dx, 2 * y + dy
                    gx = g[py, min(31, px + 1)] - g[py, max(0, px - 1)]
                    gy = g[min(31, py + 1), px] - g[max(0, py - 1), px]
                    acc += abs(gx) + abs(gy)
            raw[y, x] = acc / 4.0
    mx = raw.max()
    out = (raw * (255.0 / mx if mx > 1 else 0)).round().clip(0, 255).astype(np.uint8)
    return base64.b64encode(out.tobytes()).decode()


def lum_of(bgr):
    if bgr is None or bgr.size == 0:
        return None
    return int(float(cv2.cvtColor(bgr, cv2.COLOR_BGR2GRAY).mean()))


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


# ---------- 主流程 ----------
def norm_type(t):
    if not t:
        return ""
    for kw, key in TYPES:
        if kw in str(t):
            return key
    return ""


def to_int(v):
    try:
        if v is None or v == "":
            return None
        return int(round(float(v)))
    except Exception:
        return None


def main():
    load_blueprints()
    keys_hint = "\n".join("- %s = %s" % (b["key"], b["name"]) for b in BP_LIST) or "- （暂无）"
    names = sorted(os.listdir(INBOX)) if os.path.isdir(INBOX) else []
    batches = {}
    for fn in names:
        if not fn.lower().endswith((".png", ".jpg", ".jpeg")):
            continue
        path = os.path.join(INBOX, fn)
        img = cv2.imread(path)
        if img is None:
            os.remove(path)
            continue
        head = fn.rsplit("_", 1)[0].split("__")[0]
        try:
            player = base64.urlsafe_b64decode(head + "=" * (-len(head) % 4)).decode()
        except Exception:
            player = head
        batch = "__".join(fn.rsplit("_", 1)[0].split("__")[:2])
        res = batches.setdefault(batch, dict(player=player, items=[], images=0, t=int(time.time())))
        res["images"] += 1
        b64, _ = _b64_jpeg(path)
        raw = []
        if b64:
            try:
                data = _call_model(b64, keys_hint)
                raw = data.get("items") or []
            except Exception as e:
                print("视觉模型失败", fn, e)
        print("识别", fn, len(raw), "件")
        keys = {b["key"] for b in BP_LIST}
        for it in raw:
            if not isinstance(it, dict):
                continue
            nm = it.get("name") or ""
            tkey = norm_type(it.get("type")) or norm_type(nm)
            lvl = to_int(it.get("level"))
            bns = to_int(it.get("bonus"))
            plate, cbox = crop_card(img, it.get("boxes"))
            if plate is None:
                continue
            icon = None
            if cbox:
                blob = icon_blob(img, (cbox[0], cbox[1], cbox[2] - cbox[0], cbox[3] - cbox[1]))
                if blob:
                    bx, by, bs = blob
                    icon = img[by:by + bs, bx:bx + bs]
            bpk = it.get("bp")
            bpk = bpk if isinstance(bpk, str) and bpk in keys else ""
            res["items"].append({
                "type_key": tkey,
                "level": lvl, "bonus": bns, "tons": to_int(it.get("tons")),
                "side": "光" if (plate.size and float((cv2.cvtColor(plate, cv2.COLOR_BGR2HSV)[:, :, 2] > 230).mean()) > 0.10) else "暗",
                "sig": grad_sig(icon), "lum": lum_of(icon),
                "plate": save_img(plate, "p"),
                "badge_img": save_img(icon, "b"),
                "bp": bpk, "bp_saw": bool(bpk), "bp_dark_spot": False, "bp_sug": [],
                "coords": {"card": list(cbox) if cbox else None},
                "name": nm,
            })
        os.remove(path)
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
