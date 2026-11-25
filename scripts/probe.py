import urllib.request, urllib.error
hosts = ["https://huggingface.co/api/models/Qwen/Qwen2.5-VL-3B-Instruct",
         "https://cdn-lfs.huggingface.co/",
         "https://api-inference.huggingface.co/",
         "https://openrouter.ai/api/v1/models",
         "https://api.deepseek.com/",
         "https://generativelanguage.googleapis.com/",
         "https://ark.cn-beijing.volces.com/",
         "https://dashscope.aliyuncs.com/",
         "https://api.openai.com/v1/models",
         "https://models.github.ai/"]
for u in hosts:
    try:
        with urllib.request.urlopen(urllib.request.Request(u, headers={"User-Agent":"probe"}), timeout=25) as r:
            print(u, "->", r.status, dict(r.headers).get("Content-Type"), r.read()[:120])
    except urllib.error.HTTPError as e:
        print(u, "->", e.code, e.read()[:120])
    except Exception as e:
        print(u, "-> ERR", e)
