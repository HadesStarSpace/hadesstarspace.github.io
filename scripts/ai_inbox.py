"""AI 识别（跑在 GitHub Actions 里）：整张截图交给本地视觉模型（Qwen2.5-VL-3B），
模型直接读出「神器类型 / 名字 / 等级 / 加成 / 量子图纸」并给出每件卡片在图里的方框。
全程没有 OCR，也不需要外部 API key：权重从 HuggingFace 取，CPU 上跑。

inbox 里的文件名格式：<base64url 用户名>__<时间戳>_<序号>.png
"""
import base64
import hashlib
import json
import os
import re
import time

import cv2
import numpy as np
from PIL import Image

HERE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DATA = os.path.join(HERE, "data.json")
INBOX = os.path.join(HERE, "inbox")
OUT = os.path.join(HERE, "inbox_out")
IMG = os.path.join(HERE, "img")
BPINDEX = os.path.join(HERE, "img", "bp", "index.json")

TYPES = [("运输舰", "trade"), ("武器", "weapon"), ("战斗", "support"), ("护盾", "shield"),
         ("采矿", "mining"), ("支援", "support"), ("无人机", "drone")]

MODEL_ID = os.environ.get("VLM_MODEL", "Qwen/Qwen2.5-VL-3B-Instruct")
MAX_SIDE = int(os.environ.get("VLM_MAX_SIDE", "1400"))

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


PROMPT = """这是游戏《Hades' Star》的中文截图。图里可能有若干件「神器（遗物/artifact）」，出现在：
1) 星球「货物」列表：每件是「神器名 / 等级N / 吨数 / 右侧图标与 +加成」；
2) 神器容器：网格卡片，上面 +加成，中间量子图纸小方块，下面发光六边形本体与等级小方块；
3) 运输舰详情页「运载的文物」：每张卡片上面是 +N%%，中间图纸方块，下面发光本体，最底部薄荷色等级小方块。

逐件给出：
- type：只能是 运输舰 / 采矿 / 武器 / 护盾 / 战斗 / 无人机（按颜色：黄=运输舰，紫=采矿，红=武器，蓝=护盾，绿=战斗，橙=无人机）
- name：神器名字（如「运输舰神器」），看不清填 null
- level：等级整数（「等级12」或底部薄荷色小方块里的数字），看不清填 null
- tons：吨数整数（「50吨」里的 50），没有就 null
- bonus：加成数字（「+360%%」填 360），看不清填 null
- bp：量子图纸的 key，必须从下面清单里选；没有图纸方块或看不清一律 null
- box：这件卡片的外接矩形，给归一化整数 [x0,y0,x1,y1]（左上角 [0,0]，右下角 [1000,1000]）。
  要包住「加成药丸 + 图纸方块 + 发光本体 + 等级」，但不要包进相邻的另一件；「运载的文物」卡片里没有神器名，框里不用管它。

量子图纸清单（key = 中文名）：
%s

只输出 JSON，不要解释：
{"items":[{"type":"无人机","name":"无人机神器","level":12,"tons":50,"bonus":360,"bp":null,"box":[120,680,320,880]}]}
没有神器就输出 {"items":[]}。"""


# ---------- 视觉模型 ----------
_MODEL = None
_PROC = None


def _load_model():
    global _MODEL, _PROC
    if _MODEL is not None:
        return _MODEL, _PROC
    import torch
    from transformers import AutoProcessor, AutoModelForImageTextToText
    t0 = time.time()
    _PROC = AutoProcessor.from_pretrained(MODEL_ID)
    _MODEL = AutoModelForImageTextToText.from_pretrained(MODEL_ID, torch_dtype=torch.float32)
    _MODEL.eval()
    print("模型载入 %.0fs" % (time.time() - t0))
    return _MODEL, _PROC


def _json_from_text(txt):
    lo, hi = txt.find("{"), txt.rfind("}")
    if lo >= 0 and hi > lo:
        txt = txt[lo:hi + 1]
    txt = re.sub(r",\s*([}\]])", r"\1", txt)
    try:
        return json.loads(txt)
    except Exception:
        pass
    loose = []
    for m in re.finditer(r"\{[^{}]*\}", txt):
        try:
            loose.append(json.loads(m.group(0)))
        except Exception:
            continue
    return {"items": loose}


def analyze(path, keys_hint):
    import torch
    model, proc = _load_model()
    img = Image.open(path).convert("RGB")
    w, h = img.size
    if max(w, h) > MAX_SIDE:
        s = MAX_SIDE / float(max(w, h))
        img = img.resize((int(w * s), int(h * s)), Image.LANCZOS)
    msgs = [{"role": "user", "content": [{"type": "image"}, {"type": "text", "text": PROMPT % keys_hint}]}]
    text = proc.apply_chat_template(msgs, add_generation_prompt=True)
    inputs = proc(text=text, images=[img], return_tensors="pt")
    t0 = time.time()
    with torch.no_grad():
        out = model.generate(**inputs, max_new_tokens=400, do_sample=False, repetition_penalty=1.05)
    gen = out[0][inputs["input_ids"].shape[1]:]
    txt = proc.decode(gen, skip_special_tokens=True).strip()
    print("推理 %.0fs 原文: %s" % (time.time() - t0, txt[:600].replace("\n", " ")))
    data = _json_from_text(txt)
    items = data.get("items") if isinstance(data, dict) else None
    if isinstance(items, dict):
        items = [items]
    return items or []


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
        return int(round(float(str(v).replace("%", "").strip())))
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
        raw = []
        try:
            raw = analyze(path, keys_hint)
        except Exception as e:
            print("视觉模型失败", fn, type(e).__name__, e)
        print("识别", fn, len(raw), "件")
        keys = {b["key"] for b in BP_LIST}
        for it in raw:
            if not isinstance(it, dict):
                continue
            nm = it.get("name") or ""
            tkey = norm_type(it.get("type")) or norm_type(nm)
            lvl = to_int(it.get("level"))
            bns = to_int(it.get("bonus"))
            plate, cbox = crop_card(img, it.get("box") or it.get("boxes"))
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
