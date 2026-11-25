import json, urllib.request, urllib.error
try:
    with urllib.request.urlopen("https://text.pollinations.ai/models", timeout=40) as r:
        d = json.loads(r.read().decode())
    for m in d:
        print(m.get("name"), "|input:", m.get("input_modalities") or m.get("vision"), "|", (m.get("description") or "")[:90])
except Exception as e:
    print("ERR", e)
