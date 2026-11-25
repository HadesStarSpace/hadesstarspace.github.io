import json, os, urllib.request, urllib.error
tok = os.environ.get("GITHUB_TOKEN","")
tests = [
  ("GET", "https://models.github.ai/inference/models"),
  ("GET", "https://models.github.ai/inference/chat/completions"),
  ("POST", "https://models.github.ai/inference/chat/completions"),
  ("POST", "https://models.inference.ai.azure.com/chat/completions"),
]
body = json.dumps({"model":"openai/gpt-4o-mini","messages":[{"role":"user","content":"say hi"}],"max_tokens":20}).encode()
for method, url in tests:
    for hname in ("bearer","apikey"):
        hdr = {"Content-Type":"application/json","Accept":"application/json"}
        if hname == "bearer": hdr["Authorization"] = "Bearer " + tok
        else: hdr["api-key"] = tok
        data = body if method == "POST" else None
        req = urllib.request.Request(url, data=data, method=method, headers=hdr)
        try:
            with urllib.request.urlopen(req, timeout=40) as r:
                code, raw = r.status, r.read().decode("utf-8","replace")
                h = dict(r.headers)
        except urllib.error.HTTPError as e:
            code, raw = e.code, e.read().decode("utf-8","replace")
            h = dict(e.headers)
        except Exception as e:
            code, raw, h = "ERR", str(e), {}
        print(method, url, hname, "->", code, "|", {k:v for k,v in h.items() if k.lower() in ("content-type","server","x-trace-id","x-github-request-id")}, "|", raw[:200].replace("\n"," "))
