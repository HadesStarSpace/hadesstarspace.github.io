import json, os, urllib.request, urllib.error

tok = os.environ.get("GITHUB_TOKEN", "")
print("token len", len(tok))

def hit(method, url, body=None, extra=None):
    hdr = {"Accept": "application/json", "Authorization": "Bearer " + tok}
    if extra:
        hdr.update(extra)
    data = json.dumps(body).encode() if body else None
    if data:
        hdr["Content-Type"] = "application/json"
    req = urllib.request.Request(url, data=data, method=method, headers=hdr)
    try:
        with urllib.request.urlopen(req, timeout=45) as r:
            raw = r.read().decode("utf-8", "replace")
            return r.status, dict(r.headers).get("Content-Type"), raw[:200]
    except urllib.error.HTTPError as e:
        return e.code, dict(e.headers).get("Content-Type"), e.read().decode("utf-8","replace")[:200]
    except Exception as e:
        return "ERR", "-", str(e)[:150]

print("catalog", hit("GET", "https://models.github.ai/catalog/models"))
print("inference-models", hit("GET", "https://models.github.ai/inference/models"))
print("inference-cc-get", hit("GET", "https://models.github.ai/inference/chat/completions"))
print("inference-cc-post", hit("POST", "https://models.github.ai/inference/chat/completions",
      {"model": "openai/gpt-4o-mini", "messages": [{"role": "user", "content": "hi"}], "max_tokens": 5}))
print("api-models", hit("GET", "https://api.github.com/models"))
print("ua", hit("GET", "https://models.github.ai/inference/models", extra={"User-Agent": "curl/8.5.0"}))
