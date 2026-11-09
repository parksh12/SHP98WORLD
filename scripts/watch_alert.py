"""개인 감시 알림 (GitHub Actions에서 실행, 텔레그램 @shp98_bot으로 전송).

설정은 공개 저장소에 두지 않고 시크릿 ALERT_CONFIG(JSON)에서 읽는다. 형식:
  {"price": [{"t": "NVDA", "avg": 180, "qty": 30, "step": 5}], "rsi": ["TQQQ", "SOXL"]}
- price: 평단 대비 ±step% 구간을 새로 넘을 때마다 알림
- rsi:   주봉 RSI(14, Wilder)가 30 이하가 되면 알림, 35 위로 회복하면 다시 대기
- session: 미장 시작·마감 알림 + 당일 시가 대비 ±intraday_step% 구간마다 알림 (구간별 하루 1번)
  예) "session": ["NVDA", "TQQQ", "SOXL"], "intraday_step": 3
상태(구간 번호·알림 여부)만 watch_state.json에 저장한다.
"""
import json
import os
import sys
from datetime import datetime
from pathlib import Path
from zoneinfo import ZoneInfo

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

    check_session(cfg, st, test)
    STATE.write_text(json.dumps(st), encoding="utf-8")


def check_session(cfg, st, test=False):
    """미장 시작·마감 알림 + 당일 시가 대비 ±step% 구간 알림 (뉴욕 시간 기준, 서머타임 자동)."""
    tickers = cfg.get("session", [])
    if not tickers:
        return
    step = float(cfg.get("intraday_step", 3))
    now = datetime.now(ZoneInfo("America/New_York"))
    today = now.date().isoformat()
    day = st.get("day", {})
    if day.get("date") != today:
        day = {"date": today, "open_sent": False, "close_sent": False, "bands": {}}
    st["day"] = day

    rows = {}
    for t in tickers:
        try:
            h = yf.Ticker(t).history(period="5d", interval="1d").dropna(subset=["Open", "Close"])
        except Exception as e:
            print(f"{t} 일봉 실패: {e}", file=sys.stderr)
            continue
        if len(h) >= 2 and h.index[-1].date().isoformat() == today:  # 오늘 장이 열렸음 (휴장일이면 없음)
            rows[t] = {"open": float(h["Open"].iloc[-1]), "last": float(h["Close"].iloc[-1]),
                       "prev": float(h["Close"].iloc[-2])}
    if not rows and not test:
        return

    def line(t, r, closing):
        d = (r["last"] / r["prev"] - 1) * 100
        if closing:
            return f"{t} ${r['last']:,.2f}  전일 {d:+.1f}% · 시가 대비 {(r['last'] / r['open'] - 1) * 100:+.1f}%"
        g = (r["open"] / r["prev"] - 1) * 100
        return f"{t} 시가 ${r['open']:,.2f}  전일 종가 대비 {g:+.1f}%"

    after_close = (now.hour, now.minute) >= (16, 0)
    in_session = (now.hour, now.minute) >= (9, 30) and not after_close

    if test and rows:
        send("🧪 테스트 · 🔔 미장 시작 형식\n" + "\n".join(line(t, r, False) for t, r in rows.items()))
        return

    if after_close and not day["close_sent"]:
        if send("🏁 미장 마감\n" + "\n".join(line(t, r, True) for t, r in rows.items())):
            day["close_sent"] = day["open_sent"] = True
        return
    if not in_session:
        return
    if not day["open_sent"]:
        if send("🔔 미장 시작\n" + "\n".join(line(t, r, False) for t, r in rows.items())):
            day["open_sent"] = True

    for t, r in rows.items():
        pct = (r["last"] / r["open"] - 1) * 100
        band = int(pct / step)  # 0을 향해 버림: +3.4% → 1, -6.2% → -2
        done = day["bands"].setdefault(t, [])
        hi, lo = max(done + [0]), min(done + [0])
        if band > hi or band < lo:  # 그날 처음 닿는 더 높은(낮은) 구간일 때만
            arrow = "📈" if band > 0 else "📉"
            if send(f"{arrow} {t} 시가 대비 {pct:+.1f}% ({band * step:+.0f}% 돌파)\n"
                    f"현재 ${r['last']:,.2f} · 시가 ${r['open']:,.2f} · 전일 {(r['last'] / r['prev'] - 1) * 100:+.1f}%"):
                done.append(band)


if __name__ == "__main__":
    main()
