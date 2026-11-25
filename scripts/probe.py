import json
from gradio_client import Client, handle_file
Q = "这张游戏截图里有几件遗物？每件的加成百分比是多少？只答事实。"
img = handle_file("scripts/_probe.jpg")
for sid in ["HuggingFaceTB/SmolVLM", "HuggingFaceTB/SmolVLM2"]:
    try:
        c = Client(sid, verbose=False)
        api = c.view_api(return_format="dict", print_info=False)
        print("==", sid, json.dumps(api["named_endpoints"]["/chat"]["parameters"], ensure_ascii=False)[:800])
        for payload in [{"text": Q, "files": [img]}, {"text": Q, "image": img}]:
            try:
                out = c.predict(payload, api_name="/chat")
                print("   ok", json.dumps(str(out)[:400], ensure_ascii=False))
                break
            except Exception as e:
                print("   payload fail", list(payload), type(e).__name__, str(e)[:150])
    except Exception as e:
        print("==", sid, "FAIL", type(e).__name__, str(e)[:200])
