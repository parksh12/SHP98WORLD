"""개인 감시 알림 (GitHub Actions에서 실행, 텔레그램 @shp98_bot으로 전송).

설정은 공개 저장소에 두지 않고 시크릿 ALERT_CONFIG(JSON)에서 읽는다. 형식:
  {"price": [{"t": "NVDA", "avg": 180, "qty": 30, "step": 5}], "rsi": ["TQQQ", "SOXL"]}
- price: 평단 대비 ±step% 구간을 새로 넘을 때마다 알림
- rsi:   주봉 RSI(14, Wilder)가 30 이하가 되면 알림, 35 위로 회복하면 다시 대기
상태(구간 번호·알림 여부)만 watch_state.json에 저장한다.
"""
import json
import os
import sys
from pathlib import Path

import requests
import yfinance as yf

ROOT = Path(__file__).resolve().parent.parent
STATE = ROOT / "watch_state.json"
RSI_TRIGGER, RSI_RESET = 30.0, 35.0
TOKEN, CHAT = os.environ.get("SHP98_TOKEN"), os.environ.get("SHP98_CHAT_ID")


def send(text):
    if not (TOKEN and CHAT):
        print("SHP98 시크릿 없음 → 전송 생략")
        return False
    r = requests.post(f"https://api.telegram.org/bot{TOKEN}/sendMessage",
                      data={"chat_id": CHAT, "text": "[💹 가격 알림]\n" + text}, timeout=20)
    return r.ok


def weekly_rsi(t, n=14):
    c = yf.Ticker(t).history(period="5y", interval="1wk")["Close"].dropna()
    d = c.diff()
    up = d.clip(lower=0).ewm(alpha=1 / n, adjust=False).mean()
    dn = (-d.clip(upper=0)).ewm(alpha=1 / n, adjust=False).mean()
    return float(c.iloc[-1]), float((100 - 100 / (1 + up / dn)).iloc[-1])


def main():
    raw = os.environ.get("ALERT_CONFIG", "").strip()
    if not raw:
        print("ALERT_CONFIG 없음 → 건너뜀")
        return
    cfg = json.loads(raw)
    st = json.loads(STATE.read_text(encoding="utf-8")) if STATE.exists() else {}
    lv, rs = st.setdefault("level", {}), st.setdefault("rsi", {})
    test = os.environ.get("TEST_ALERT") == "true"

    for w in cfg.get("price", []):
        t = w["t"]
        try:
            price = float(yf.Ticker(t).fast_info.last_price)
        except Exception as e:
            print(f"{t} 시세 실패: {e}", file=sys.stderr)
            continue
        pct = (price / w["avg"] - 1) * 100
        level = int(pct / w["step"])
        if t not in lv:
            lv[t] = level  # 처음엔 기준만 저장
        elif level != lv[t] or test:
            arrow = "📈" if level >= lv[t] else "📉"
            msg = f"{arrow} {t} ${price:,.2f} (평단 대비 {pct:+.1f}%)\n{level * w['step']:+.0f}% 구간"
            if "qty" in w:
                msg += f" · 평가손익 {(price - w['avg']) * w['qty']:+,.0f}$"
            if test:
                msg = "🧪 테스트\n" + msg
            if send(msg) and not test:
                lv[t] = level

    for t in cfg.get("rsi", []):
        try:
            price, rsi = weekly_rsi(t)
        except Exception as e:
            print(f"{t} RSI 실패: {e}", file=sys.stderr)
            continue
        print(f"{t} 주봉 RSI {rsi:.1f}")
        if not rs.get(t) and rsi <= RSI_TRIGGER:
            if send(f"🚨 {t} 주봉 RSI(14) {rsi:.1f} — {RSI_TRIGGER:.0f} 터치\n현재가 ${price:,.2f} (이번 주 봉은 진행 중 값)"):
                rs[t] = True
        elif rs.get(t) and rsi >= RSI_RESET:
            rs[t] = False

    STATE.write_text(json.dumps(st), encoding="utf-8")


if __name__ == "__main__":
    main()
