"""S&P500 고점 대비 하락률이 기준선(-15/-25/-35%)을 처음 넘으면 GITHUB_OUTPUT으로 알린다.

한 번 알린 기준선은 alerts.json에 기록해 다시 보내지 않고, 고점 대비 -5% 안으로 회복하면 초기화한다.
"""
import json
import os
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
LEVELS = [-15, -25, -35]
spx = json.loads((ROOT / "prices.json").read_text(encoding="utf-8")).get("spx")
state_path = ROOT / "alerts.json"
state = json.loads(state_path.read_text(encoding="utf-8")) if state_path.exists() else {"sent": []}

hit = None
if spx and spx.get("dd") is not None:
    dd = spx["dd"]
    if dd > -5:
        state["sent"] = []
    for lv in LEVELS:
        if dd <= lv and lv not in state["sent"]:
            state["sent"].append(lv)
            hit = lv

state_path.write_text(json.dumps(state), encoding="utf-8")
if os.environ.get("TEST_ALERT") == "true" and spx:
    hit = "테스트"
if hit is not None and os.environ.get("GITHUB_OUTPUT"):
    with open(os.environ["GITHUB_OUTPUT"], "a", encoding="utf-8") as f:
        f.write(f"level={hit}\ndd={spx['dd']}\nlast={spx['last']}\nath={spx['ath']}\n")
print("alert:", hit, spx)
