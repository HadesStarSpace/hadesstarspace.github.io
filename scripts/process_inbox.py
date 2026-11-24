"""GitHub Actions 用：扫描 inbox/ 里的截图，识别后写入 data.json，并把图片搬到 img/。"""
import base64
import json
import os
import sys
import time
import hashlib
import urllib.parse

HERE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import recognize as R

DATA = os.path.join(HERE, "data.json")
INBOX = os.path.join(HERE, "inbox")
IMG = os.path.join(HERE, "img")


def slug(name):
    return "p_" + hashlib.sha1(name.encode("utf-8")).hexdigest()[:8]


def save_data_url(data_url, prefix):
    if not data_url or "," not in data_url:
        return ""
    head, b64 = data_url.split(",", 1)
    ext = ".jpg" if "jpeg" in head else ".png"
    buf = base64.b64decode(b64)
    name = "%s_%s%s" % (prefix, hashlib.sha1(buf).hexdigest()[:12], ext)
    with open(os.path.join(IMG, name), "wb") as f:
        f.write(buf)
    return "img/" + name


def ensure_player(data, name):
    for p in data["players"]:
        if p["name"] == name:
            return p["id"]
    pid = "p%d" % (int(time.time() * 1000) % 100000000)
    data["players"].append({"id": pid, "name": name, "note": ""})
    return pid


def next_id(data, prefix):
    n = 1
    for a in data["artifacts"] if prefix == "a" else data.get("needs", []):
        try:
            n = max(n, int(str(a["id"])[1:]) + 1)
        except Exception:
            pass
    return "%s%d" % (prefix, n)


def main():
    os.makedirs(IMG, exist_ok=True)
    if not os.path.exists(DATA):
        print("no data.json")
        return
    data = json.load(open(DATA, encoding="utf-8"))
    data.setdefault("templates", {})
    data.setdefault("notices", [])
    files = sorted(f for f in os.listdir(INBOX) if not f.startswith("."))
    if not files:
        print("inbox empty")
        return
    for fn in files:
        path = os.path.join(INBOX, fn)
        stem = os.path.splitext(fn)[0]
        parts = stem.split("__")
        player = fn
        if parts and parts[0]:
            try:
                player = base64.urlsafe_b64decode(parts[0] + "=" * (-len(parts[0]) % 4)).decode("utf-8")
            except Exception:
                player = parts[0]
        print("处理", fn, "玩家", player)
        try:
            res = R.recognize(path, data["templates"])
        except Exception as e:
            res = {"ok": False, "note": "识别异常：%s" % e}
        if not res.get("ok"):
            data["notices"].append({"t": int(time.time()), "player": player,
                                   "img": "", "note": res.get("note") or "识别失败"})
            os.remove(path)
            continue
        pid = ensure_player(data, player)
        added = 0
        for s in res["slots"]:
            plate = save_data_url(s.get("plate"), "p")
            badge = save_data_url(s.get("badge"), "b")
            aid = next_id(data, "a")
            data["artifacts"].append({
                "id": aid, "owner": pid, "type_key": s.get("type_key"),
                "level": s.get("level"), "bonus": s.get("bonus"),
                "module": s.get("module_key") or "",
                "side": s.get("side") or "",
                "status": "have", "note": "",
                "img": plate, "badge_img": badge, "sig": s.get("badge_sig") or "",
                "from": fn,
            })
            added += 1
        data["notices"].append({"t": int(time.time()), "player": player, "img": "",
                                "note": "识别完成，%d 件已入库（请到「我的」核对模块）" % added})
        os.remove(path)
        print("入库", added)
    data["updated"] = int(time.time())
    data["notices"] = data["notices"][-30:]
    json.dump(data, open(DATA, "w", encoding="utf-8"), ensure_ascii=False, indent=1)
    print("done")


if __name__ == "__main__":
    main()
