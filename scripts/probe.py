import base64, json, urllib.request, urllib.error, subprocess
def post(url, body, headers=None, timeout=60):
    req = urllib.request.Request(url, data=json.dumps(body).encode(), method="POST",
        headers=headers or {"Content-Type":"application/json"})
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return r.status, r.read().decode("utf-8","replace")
    except urllib.error.HTTPError as e:
        return e.code, e.read().decode("utf-8","replace")
    except Exception as e:
        return "ERR", str(e)

img = base64.b64encode(b"\xff\xd8\xff\xe0" + b"\x00"*40).decode()
tests = [
 ("pollinations-openai", "https://text.pollinations.ai/openai", {"model":"openai","messages":[{"role":"user","content":"say hi in one word"}],"max_tokens":10}),
 ("pollinations-raw", "https://text.pollinations.ai/hello%20say%20hi", None),
]
for name, url, body in tests:
    if body is None:
        try:
            with urllib.request.urlopen(url, timeout=40) as r:
                print(name, r.status, r.read()[:150])
        except Exception as e:
            print(name, "ERR", e)
        continue
    print(name, *post(url, body))
# 权重直链能否下载
try:
    out = subprocess.run(["curl","-sIL","-o","/dev/null","-w","%{http_code} %{url_effective}","https://huggingface.co/HuggingFaceTB/SmolVLM-256M-Instruct/resolve/main/config.json"], capture_output=True, text=True, timeout=40)
    print("hf-resolve", out.stdout, out.stderr[:80])
except Exception as e:
    print("hf-resolve ERR", e)
