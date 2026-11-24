"""调用 GitHub Models 的视觉模型，从游戏截图里读神器条目（不依赖分辨率）。"""
import base64
import json
import os
import sys
import urllib.request
import urllib.error

ENDPOINT = "https://models.github.ai/inference/chat/completions"
MODEL = os.environ.get("QS_MODEL", "openai/gpt-4o")

PROMPT = """你是游戏《Hades' Star》(量子星) 的截图识别器。
图中是「货物 / 仓库 / 文物容器」面板里的神器条目列表。每个条目有一行中文名称（如 运输舰神器 / 武器神器 / 护盾神器 / 采矿神器 / 支援神器 / 无人机神器）、一行灰色的「等级NN」小字、一行重量（如 40吨），右侧是一个六边形神器图标；六边形右边可能有一个方形的小图标（量子强化图标），六边形右下方有一个青绿色药丸，写着 +NNN%。

请逐条列出，输出严格 JSON（不要解释、不要 markdown 代码块）：
{"items":[{"type":"运输舰","level":11,"bonus":360,"side":"暗","quantum":true,
"name_box":[x0,y0,x1,y1],"plate_box":[x0,y0,x1,y1],"icon_box":[x0,y0,x1,y1]}]}

规则：
- type 只能是 运输舰/战斗/护盾/采矿/支援/无人机 之一；看不出来就填 null。
- level 是「等级」后面的数字；bonus 是药丸里 + 后面的数字（300~400 之间）。
- side：神器面板整体偏暗的填 "暗"，发光偏亮的填 "光"；不确定就填 null。
- quantum：右侧那个方形小图标存在填 true，没有填 false。
- name_box / plate_box / icon_box 是上面每个元素在你看到的图片像素坐标里的外接框 [左,上,右,下]；icon_box 指量子强化方形图标，没有就填 [0,0,0,0]。坐标宁可粗一点，不要编。
- 有几条就输出几条，不要合并、不要漏。"""


def _b64(path):
    with open(path, "rb") as f:
        buf = f.read()
    ext = os.path.splitext(path)[1].lower()
    mime = "image/jpeg" if ext in (".jpg", ".jpeg") else "image/png"
    return "data:%s;base64,%s" % (mime, base64.b64encode(buf).decode())


def call(path, model=None, prompt=None):
    token = os.environ.get("GITHUB_TOKEN") or os.environ.get("GH_TOKEN")
    body = {
        "model": model or MODEL,
        "temperature": 0,
        "max_tokens": 2000,
        "messages": [{
            "role": "user",
            "content": [
                {"type": "text", "text": prompt or PROMPT},
                {"type": "image_url", "image_url": {"url": _b64(path)}},
            ],
        }],
    }
    req = urllib.request.Request(ENDPOINT, data=json.dumps(body).encode(),
                                 headers={"Authorization": "Bearer " + token,
                                          "Content-Type": "application/json",
                                          "Accept": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=120) as r:
            status = r.status
            raw = r.read()
    except urllib.error.HTTPError as e:
        status = e.code
        raw = e.read()
    print("HTTP", status, "len", len(raw))
    print(raw[:2000].decode("utf-8", "ignore"))
    data = json.loads(raw)
    return data["choices"][0]["message"]["content"]


if __name__ == "__main__":
    for p in sys.argv[1:]:
        print("==", p)
        print(call(p))
