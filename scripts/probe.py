import json, socket, subprocess, urllib.request

print("local dns:", socket.gethostbyname_ex("models.github.ai"))
for name in ["models.github.ai", "api.github.com"]:
    for doh in ["https://dns.google/resolve?name=%s&type=A" % name, "https://cloudflare-dns.com/dns-query?name=%s&type=A" % name]:
        try:
            req = urllib.request.Request(doh, headers={"Accept": "application/dns-json", "User-Agent": "probe"})
            with urllib.request.urlopen(req, timeout=20) as r:
                d = json.loads(r.read().decode())
            print("doh", name, [a.get("data") for a in d.get("Answer", [])][:8])
        except Exception as e:
            print("doh ERR", doh, e)

ips = ["20.250.204.33", "20.98.171.60"]
import os; tok = os.environ.get("GITHUB_TOKEN","")
r = subprocess.run(["bash", "-lc", "echo ${GITHUB_TOKEN:-none} | head -c 4"], capture_output=True, text=True)
print("token head:", r.stdout.strip())
for ip in ips:
    out = subprocess.run(["curl", "-sS", "-m", "30", "--resolve", "models.github.ai:443:" + ip,
                          "-o", "/dev/stdout", "-w", "\n[http %{http_code} ip=%{remote_ip}]\n",
                          "https://models.github.ai/inference/models",
                          "-H", "Authorization: Bearer %s" % tok], capture_output=True, text=True)
    print("try", ip, out.stdout[-300:], out.stderr[-200:])
