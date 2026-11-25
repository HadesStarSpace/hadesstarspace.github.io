import json, urllib.request
with urllib.request.urlopen("https://text.pollinations.ai/models", timeout=40) as r:
    d = json.loads(r.read().decode())
print("TOTAL", len(d))
print("VISION:", [m.get("name") for m in d if "image" in str(m.get("input_modalities", ""))])
print("NAMES:", [m.get("name") for m in d])
