"""A/B test: does forced structured output ("the gag") hurt play vs free-text CoT?

Holds model + maps constant. Each turn is STATELESS ([system, user(obs)] only),
faithfully mirroring bench_common/runtime/inference.py. The ONLY difference:

  gagged : ollama `format` = JSON schema {action: enum NSEW}, ~no room to reason
           (mirrors Anthropic forced tool_choice / OpenAI response_format path)
  free   : free text, model reasons, we parse the "ACTION: X" marker (env already
           supports this via env._parse_action)

Usage: python ab_gag_test.py --model qwen2.5:14b --seeds 1 4 6 --cap 30
"""
import argparse, json, re, sys, time
import requests
from env import SokobanEnv

OLLAMA = "http://localhost:11434/api/chat"
SYS = open("system_prompt.txt", encoding="utf-8").read()
ACTION_MARKER = re.compile(r'\bACTION\s*:\s*([NSEW])\b', re.I)
DIR_TOKEN = re.compile(r'\b([NSEW])\b')
GAG_SCHEMA = {"type": "object",
              "properties": {"action": {"type": "string", "enum": ["N", "S", "E", "W"]}},
              "required": ["action"]}


def user_msg(obs, step):
    # mirrors inference._build_user_content: prefix + json.dumps(full observation)
    return f"[Step {step}]\n{json.dumps(obs, ensure_ascii=False)}"


def call_ollama(model, messages, gagged):
    body = {"model": model, "messages": messages, "stream": False,
            "options": {"temperature": 0.3,
                        "num_predict": 64 if gagged else 1024}}
    if gagged:
        body["format"] = GAG_SCHEMA
    for attempt in range(4):                       # tolerate cold-load 500s
        r = requests.post(OLLAMA, json=body, timeout=300)
        if r.status_code == 500 and attempt < 3:
            time.sleep(5)
            continue
        r.raise_for_status()
        return r.json()["message"]["content"]


def parse_free(text):
    m = ACTION_MARKER.search(text) or DIR_TOKEN.search(text)
    return m.group(1).upper() if m else "?"


def parse_gagged(text):
    try:
        return json.loads(text).get("action", "?").upper()
    except Exception:
        return parse_free(text)


def run_episode(model, seed, gagged, cap):
    env = SokobanEnv()
    obs = env.reset(seed=seed)
    invalid = 0
    first_reasoning = ""
    for step in range(1, cap + 1):
        messages = [{"role": "system", "content": SYS},
                    {"role": "user", "content": user_msg(obs, step)}]
        raw = call_ollama(model, messages, gagged)
        action = parse_gagged(raw) if gagged else parse_free(raw)
        if not gagged and step == 1:
            first_reasoning = raw.strip()[:280]
        res = env.step(action)
        obs = res.observation
        if res.info.get("invalid") == "1.0":
            invalid += 1
        if res.terminated:
            return {"solved": True, "steps": step, "invalid": invalid, "reasoning": first_reasoning}
        if res.truncated:
            break
    return {"solved": False, "steps": step, "invalid": invalid, "reasoning": first_reasoning}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--model", default="qwen2.5:14b")
    ap.add_argument("--seeds", type=int, nargs="+", default=[1, 4, 6])
    ap.add_argument("--cap", type=int, default=30)
    args = ap.parse_args()

    print(f"model={args.model}  seeds={args.seeds}  step_cap={args.cap}\n")
    for mode, gagged in [("GAGGED (forced JSON, no reasoning)", True),
                         ("FREE   (CoT, ACTION: parsed)", False)]:
        print(f"===== {mode} =====")
        solved = 0
        for seed in args.seeds:
            t0 = time.time()
            r = run_episode(args.model, seed, gagged, args.cap)
            solved += r["solved"]
            tag = "WIN " if r["solved"] else "fail"
            print(f"  seed {seed:>2}: {tag} steps={r['steps']:>3} invalid={r['invalid']:>2}  ({time.time()-t0:.0f}s)")
            if r["reasoning"]:
                print(f"          reasoning[0]: {r['reasoning']!r}")
            sys.stdout.flush()
        print(f"  --> solved {solved}/{len(args.seeds)}\n")


if __name__ == "__main__":
    main()
