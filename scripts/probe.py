import json, urllib.request
def get(url):
    try:
        with urllib.request.urlopen(urllib.request.Request(url, headers={"User-Agent":"probe"}), timeout=30) as r:
            return r.status, r.read().decode("utf-8","replace")
    except Exception as e:
        return "ERR", str(e)[:150]
for q in ["Qwen2.5-VL", "SmolVLM", "vision language model", "InternVL"]:
    st, body = get("https://huggingface.co/api/spaces?search=%s&sort=likes&direction=-1&limit=8" % q.replace(" ", "%20"))
    print("==", q, st)
    if st == 200:
        for s in json.loads(body)[:8]:
            print("   ", s.get("id"), s.get("sdk"), s.get("likes"), s.get("runtime", {}).get("stage"))
print("hf.space reach:", get("https://huggingface.co/api/spaces/HuggingFaceTB/SmolVLM-256M-Instruct-Demo")[0])
