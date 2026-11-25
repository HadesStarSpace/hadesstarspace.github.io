import os, time, torch
from PIL import Image
from transformers import AutoProcessor, AutoModelForImageTextToText

img = Image.open("scripts/_probe.jpg").convert("RGB")
img.thumbnail((1100, 2400))
Q = "请数出图里有几件遗物，每件的加成百分比数字是多少？只回答事实。"

def run(model_id, max_new=200):
    t0 = time.time()
    proc = AutoProcessor.from_pretrained(model_id)
    model = AutoModelForImageTextToText.from_pretrained(model_id, torch_dtype=torch.float32)
    model.eval()
    msgs = [{"role": "user", "content": [{"type": "image"}, {"type": "text", "text": Q}]}]
    text = proc.apply_chat_template(msgs, add_generation_prompt=True)
    inputs = proc(text=text, images=[img], return_tensors="pt")
    with torch.no_grad():
        out = model.generate(**inputs, max_new_tokens=max_new, do_sample=False)
    gen = out[0][inputs["input_ids"].shape[1]:]
    print("===", model_id, "%.1fs" % (time.time() - t0))
    print(proc.decode(gen, skip_special_tokens=True)[:600])

for mid in ["HuggingFaceTB/SmolVLM2-500M-Video-Instruct", "Qwen/Qwen2.5-VL-3B-Instruct"]:
    try:
        run(mid)
    except Exception as e:
        print("=== FAIL", mid, type(e).__name__, str(e)[:300])
