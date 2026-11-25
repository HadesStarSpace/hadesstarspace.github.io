import base64, json, urllib.request, urllib.error
b64 = open("/tmp/ship_b64.txt").read()
def post(url, body, timeout=120):
    req = urllib.request.Request(url, data=json.dumps(body).encode(), method="POST", headers={"Content-Type":"application/json"})
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r: return r.status, r.read().decode("utf-8","replace")
    except urllib.error.HTTPError as e: return e.code, e.read().decode("utf-8","replace")
    except Exception as e: return "ERR", str(e)
for model in ["openai","openai-large","openai-fast","gemini"]:
    st, body = post("https://text.pollinations.ai/openai", {"model":model,"max_tokens":200,
        "messages":[{"role":"user","content":[
            {"type":"text","text":"这张游戏截图里，每件遗物卡片的加成百分比是多少？各自挂的量子图纸是什么样的小方块？请描述，并说明你确实看到了图片。"},
            {"type":"image_url","image_url":{"url":"data:image/jpeg;base64,"+b64}}]}]})
    print(model, st, body[:400].replace("\n"," "))
