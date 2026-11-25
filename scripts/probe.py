import time
from gradio_client import Client, handle_file
Q = ("这是《Hades' Star》中文截图，图中有若干件遗物（神器）。先说出总共几件，"
     "再每件一行，格式：类型|等级|加成%|吨数。类型按颜色选一个：运输舰(黄)/采矿(紫)/武器(红)/护盾(蓝)/战斗(绿)/无人机(橙)。"
     "看不清的字段写 ?。不要解释，不要客套。")
c = Client("HuggingFaceTB/SmolVLM", verbose=False)
for i in range(4):
    t0 = time.time()
    try:
        out = c.predict({"text": Q, "files": [handle_file("scripts/_probe%d.jpg" % i)]}, api_name="/chat")
        print("img%d %.0fs: %s" % (i, time.time() - t0, str(out)[:400].replace("\n", " / ")))
    except Exception as e:
        print("img%d FAIL %s %s" % (i, type(e).__name__, str(e)[:150]))
