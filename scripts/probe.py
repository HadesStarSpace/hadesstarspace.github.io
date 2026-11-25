import traceback
try:
    from gradio_client import Client, handle_file
except Exception as e:
    print("no gradio_client", e); raise SystemExit
for sid in ["HuggingFaceTB/SmolVLM", "HuggingFaceTB/SmolVLM2", "Qwen/Qwen2.5-VL-32B-Instruct"]:
    try:
        c = Client(sid, verbose=False)
        api = c.view_api(return_format="dict", print_info=False)
        print("==", sid, "OK named_endpoints:", list(api.get("named_endpoints", {}))[:6],
              "unnamed:", len(api.get("unnamed_endpoints", {})))
        for name, ep in list(api.get("named_endpoints", {}).items())[:3]:
            print("   ", name, [p.get("parameter_name") for p in ep.get("parameters", [])])
    except Exception as e:
        print("==", sid, "FAIL", type(e).__name__, str(e)[:200])
