"""视觉模型识别（Gemini）：整张截图交给模型，模型读字 + 给方框，不做任何 OCR。

需要仓库 Secret：GEMINI_API_KEY（Google AI Studio 免费额度即可）。
ai.yml 会自动判断：有 key 走这里，没 key 走 OCR 老流程。

inbox 文件名：<base64url 用户名>__<时间戳>_<序号>.png
"""
import base64
import hashlib
import json
import os
import re
import time
import urllib.error
import urllib.request

import cv2
import numpy as np

HERE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
INBOX = os.path.join(HERE, "inbox")
OUT = os.path.join(HERE, "inbox_out")
IMG = os.path.join(HERE, "img")
BPINDEX = os.path.join(HERE, "img", "bp", "index.json")

TYPES = [("运输舰", "trade"), ("武器", "weapon"), ("战斗", "support"), ("护盾", "shield"),
         ("采矿", "mining"), ("支援", "support"), ("无人机", "drone")]

KEY = os.environ.get("GEMINI_API_KEY", "")
MODELS = [os.environ.get("VISION_MODEL", "gemini-2.5-flash"), "gemini-2.0-flash"]
MAX_SIDE = int(os.environ.get("VISION_MAX_SIDE", "1600"))

BP_LIST = []

PROMPT = """这是游戏《Hades' Star》的中文截图。图里可能有若干件「神器（遗物/artifact）」，出现在：
1) 星球「货物」列表：每件是「神器名 / 等级N / 吨数 / 右侧图标与 +加成」；
2) 神器容器：网格卡片，上面 +加成，中间量子图纸小方块，下面发光六边形本体与等级小方块；
3) 运输舰详情页「运载的文物」：每张卡片最上是 +N%%，中间量子图纸方块，下面发光本体，最底部薄荷色等级小方块。

逐件列出，字段：
- type：只能是 运输舰 / 采矿 / 武器 / 护盾 / 战斗 / 无人机（黄=运输舰，紫=采矿，红=武器，蓝=护盾，绿=战斗，橙=无人机）
- name：神器名字（如「运输舰神器」），看不清填 null
- level：整数（「等级12」或底部薄荷色小方块里的数字），看不清填 null
- tons：整数（「50吨」里的 50），没有填 null
- bonus：整数（「+360%」填 360），看不清填 null
- bp：量子图纸 key，必须从下面清单里选；没有图纸方块或看不清填 null
- box：这件卡片的外接矩形，归一化整数 [x0,y0,x1,y1]（左上角 [0,0]，右下角 [1000,1000]），
  要包住「加成药丸 + 图纸方块 + 发光本体 + 等级」，但不能包进相邻的另一件。

量子图纸清单（key = 中文名）：
%s

严格返回 JSON（不要解释、不要复制示例里数字）：
{"items":[{"type":"…","name":"…","level":0,"tons":0,"bonus":0,"bp":"…","box":[x0,y0,x1,y1]}]}
图里没有神器就返回 {"items":[]}。"""


def load_blueprints():
    global BP_LIST
    try:
        with open(BPINDEX, encoding="utf-8") as f:
            d = json.load(f)
        BP_LIST = [dict(key=b["key"], name=b["name"], type=b.get("type", "")) for b in d.get("blueprints", [])]
    except Exception as e:
        print("图纸表读取失败", e)
    return BP_LIST


def image_b64(path):
    img = cv2.imread(path)
    if img is None:
        return None
    h, w = img.shape[:2]
    s = min(1.0, MAX_SIDE / float(max(h, w)))
    if s < 1.0:
        img = cv2.resize(img, (int(w * s), int(h * s)), interpolation=cv2.INTER_AREA)
    ok, buf = cv2.imencode(".jpg", img, [int(cv2.IMWRITE_JPEG_QUALITY), 90])
    return base64.b64encode(buf.tobytes()).decode() if ok else None


def call_gemini(b64, keys_hint):
    body = {
        "contents": [{"parts": [
            {"text": PROMPT % keys_hint},
            {"inline_data": {"mime_type": "image/jpeg", "data": b64}},
        ], "role": "user"}],
        "generationConfig": {"temperature": 0, "maxOutputTokens": 2000, "responseMimeType": "application/json"},
    }
    last = None
    for model in MODELS:
        url = "https://generativelanguage.googleapis.com/v1beta/models/%s:generateContent?key=%s" % (model, KEY)
        req = urllib.request.Request(url, data=json.dumps(body).encode(), method="POST",
                                     headers={"Content-Type": "application/json"})
        try:
            with urllib.request.urlopen(req, timeout=120) as r:
                payload = json.loads(r.read().decode("utf-8", "replace"))
            parts = payload["candidates"][0]["content"]["parts"]
            txt = "".join(p.get("text", "") for p in parts)
            print("模型 %s 返回 %d 字" % (model, len(txt)))
            return txt
        except urllib.error.HTTPError as e:
            last = "%s %s" % (e.code, e.read().decode("utf-8", "replace")[:200])
        except Exception as e:
            last = "%s: %s" % (type(e).__name__, e)
        print("模型失败", model, last)
    raise RuntimeError(last or "模型调用失败")


def json_of(txt):
    lo, hi = txt.find("{"), txt.rfind("}")
    if lo < 0 or hi <= lo:
        return {"items": []}
    raw = re.sub(r",\s*([}\]])", r"\1", txt[lo:hi + 1])
    try:
        return json.loads(raw)
    except Exception:
        items = []
        for m in re.finditer(r"\{[^{}]*\}", raw):
            try:
                items.append(json.loads(m.group(0)))
            except Exception:
                pass
        return {"items": items}


# ---------- 裁预览 ----------
def icon_blob(img, box):
    x, y, w, h = [int(v) for v in box]
    x, y = max(0, x), max(0, y)
    sub = img[y:y + max(1, h), x:x + max(1, w)]
    if sub.size == 0:
        return None
    hsv = cv2.cvtColor(sub, cv2.COLOR_BGR2HSV)
    S, V = hsv[:, :, 1].astype(np.int16), hsv[:, :, 2].astype(np.int16)
    m = ((S > 60) & (V > 80)).astype(np.uint8)
    m = cv2.morphologyEx(m, cv2.MORPH_CLOSE, np.ones((7, 7), np.uint8))
    n, _, st, _ = cv2.connectedComponentsWithStats(m, 8)
    best = None
    for j in range(1, n):
        bx, by, bw, bh, area = st[j]
        if area < 400 or bw < 0.2 * h or bh < 0.2 * h or bw > 0.95 * w or bh > 0.95 * h:
            continue
        ar = bw / float(max(bh, 1))
        if ar < 0.5 or ar > 2.2:
            continue
        s = int(max(bw, bh))
        key = (abs(ar - 1.0), -area)
        if best is None or key < best[0]:
            best = (key, x + bx + bw // 2 - s // 2, y + by + bh // 2 - s // 2, s)
    return None if not best else (max(0, best[1]), max(0, best[2]), best[3])


def crop_card(img, box):
    H, W = img.shape[:2]
    if not (isinstance(box, (list, tuple)) and len(box) == 4):
        return None, None
    try:
        x0, y0, x1, y1 = [float(v) for v in box]
        if max(x0, y0, x1, y1) <= 1.5:
            x0, y0, x1, y1 = x0 * 1000, y0 * 1000, x1 * 1000, y1 * 1000
    except Exception:
        return None, None
    if x1 - x0 < 40 or y1 - y0 < 40:
        return None, None
    X0 = max(0, int(x0 * W / 1000)); Y0 = max(0, int(y0 * H / 1000))
    X1 = min(W, int(x1 * W / 1000)); Y1 = min(H, int(y1 * H / 1000))
    blob = icon_blob(img, (X0, Y0, X1 - X0, Y1 - Y0))
    if blob:
        bx, by, bs = blob
        Y0 = max(0, min(Y0, by - int(0.15 * bs)))
        X0 = max(0, min(X0, bx - int(0.12 * bs)))
        Y1 = min(H, max(Y1, by + int(1.95 * bs)))
        X1 = min(W, max(X1, bx + int(1.15 * bs)))
    return img[Y0:Y1, X0:X1], (X0, Y0, X1, Y1)


def grad_sig(icon):
    if icon is None or icon.size == 0:
        return ""
    g = cv2.cvtColor(cv2.resize(icon, (32, 32), interpolation=cv2.INTER_AREA), cv2.COLOR_BGR2GRAY).astype(np.float64)
    lo, hi = np.percentile(g, 5), np.percentile(g, 95)
    g = np.clip((g - lo) * 255.0 / max(8.0, hi - lo), 0, 255)
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


def to_int(v):
    try:
        if v is None or v == "":
            return None
        return int(round(float(str(v).replace("%", "").replace("吨", "").strip())))
    except Exception:
        return None


def norm_type(t):
    if not t:
        return ""
    for kw, key in TYPES:
        if kw in str(t):
            return key
    return ""


def main():
    if not KEY:
        print("没有 GEMINI_API_KEY，跳过视觉识别")
        return 1
    load_blueprints()
    keys_hint = "\n".join("- %s = %s" % (b["key"], b["name"]) for b in BP_LIST) or "- （暂无）"
    keys = {b["key"] for b in BP_LIST}
    batches = {}
    failed = []
    for fn in sorted(os.listdir(INBOX)) if os.path.isdir(INBOX) else []:
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
        b64 = image_b64(path)
        try:
            if not b64:
                raise RuntimeError("图片读不出")
            data = json_of(call_gemini(b64, keys_hint))
        except Exception as e:
            print("视觉识别失败", fn, e)
            failed.append(fn)
            continue
        items = data.get("items") or []
        if isinstance(items, dict):
            items = [items]
        print("识别", fn, len(items), "件")
        for it in items:
            if not isinstance(it, dict):
                continue
            plate, cbox = crop_card(img, it.get("box") or it.get("boxes"))
            if plate is None:
                continue
            icon = None
            if cbox:
                blob = icon_blob(img, (cbox[0], cbox[1], cbox[2] - cbox[0], cbox[3] - cbox[1]))
                if blob:
                    icon = img[blob[1]:blob[1] + blob[2], blob[0]:blob[0] + blob[2]]
            bpk = it.get("bp") if isinstance(it.get("bp"), str) and it.get("bp") in keys else ""
            nm = it.get("name") or ""
            res["items"].append({
                "type_key": norm_type(it.get("type")) or norm_type(nm),
                "level": to_int(it.get("level")), "bonus": to_int(it.get("bonus")), "tons": to_int(it.get("tons")),
                "side": "光" if (plate.size and float((cv2.cvtColor(plate, cv2.COLOR_BGR2HSV)[:, :, 2] > 230).mean()) > 0.10) else "暗",
                "sig": grad_sig(icon), "lum": (int(cv2.cvtColor(icon, cv2.COLOR_BGR2GRAY).mean()) if icon is not None and icon.size else None),
                "plate": save_img(plate, "p"), "badge_img": save_img(icon, "b"),
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
    if failed:
        print("有 %d 张图识别失败，留给 OCR 兜底：%s" % (len(failed), ", ".join(failed)))
        return 2
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
