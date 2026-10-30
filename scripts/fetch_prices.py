"""tickers.json의 종목 시세와 환율을 받아 prices.json으로 저장한다 (GitHub Actions에서 실행).

미국: yfinance / 한국: 네이버 증권 → 실패하면 yfinance(.KS)
"""
import json
from datetime import datetime, timezone
from pathlib import Path

import requests
import yfinance as yf

ROOT = Path(__file__).resolve().parent.parent
T = json.loads((ROOT / "tickers.json").read_text(encoding="utf-8"))
OUT = ROOT / "prices.json"
UA = {"User-Agent": "Mozilla/5.0"}


def us(t):
    try:
        p = yf.Ticker(t).fast_info.last_price
        return round(float(p), 4) if p and p == p else None
    except Exception:
        return None


def kr(code):
    try:
        j = requests.get(f"https://m.stock.naver.com/api/stock/{code}/basic", headers=UA, timeout=10).json()
        return float(j["closePrice"].replace(",", ""))
    except Exception:
        return us(f"{code}.KS")


old = json.loads(OUT.read_text(encoding="utf-8")) if OUT.exists() else {"prices": {}}
prices = dict(old.get("prices", {}))
for t in T["us"]:
    prices[t] = us(t) or prices.get(t)
for c in T["kr"]:
    prices[c] = kr(c) or prices.get(c)

fx = us("KRW=X") or old.get("fx")

# S&P500 사상 최고치 대비 하락률 (역사적 기회 알림용)
spx = old.get("spx")
try:
    h = yf.Ticker("^GSPC").history(period="10y")["Close"].dropna()
    spx = {"last": round(float(h.iloc[-1]), 2), "ath": round(float(h.max()), 2),
           "dd": round(float(h.iloc[-1] / h.max() - 1) * 100, 2)}
except Exception:
    pass
OUT.write_text(json.dumps({
    "updated": datetime.now(timezone.utc).isoformat(timespec="seconds"),
    "fx": round(fx, 2) if fx else None,
    "prices": prices,
    "spx": spx,
}, ensure_ascii=False, indent=1), encoding="utf-8")
print(OUT.read_text(encoding="utf-8"))
