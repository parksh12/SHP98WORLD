// 계좌별 운용 규칙(정책) 검증과 트랙 지표 계산.
// 브라우저(app.js)와 Node(ledger.mjs, site_build.mjs, 테스트)가 같은 코드를 쓴다. 데이터는 넣지 않는다 (공개 저장소).
//
// 계좌 정책 (portfolio.json accounts[].track / policy):
//   track "income"     — ISA: 비정기 보너스 전용 입금 + 배당률 min_yield% 이상만 신규 매수
//   track "aggressive" — 미국주식: 외부 입금 한도(external_deposit_limit, 기본 0) + 손실 한도·비중 경고·매매 기록
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.Policy = factory();
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  const DEFAULTS = {
    income: { allowed_sources: ["상여금", "성과금", "명절 떡값"], min_yield: 7.0, dividend_tax: 0 },
    aggressive: { external_deposit_limit: 0, max_loss_pct: 30, max_position_pct: 50 },
  };
  const policyOf = a => ({ ...(DEFAULTS[a.track] || {}), ...(a.policy || {}) });
  const sum = (xs, f) => xs.reduce((s, x) => s + (Number(f(x)) || 0), 0);

  // ---- 입금 가드 (CLI가 기록 전에, 사이트가 기록을 읽을 때 같은 규칙으로 판정) ----
  // 반환: { ok, level: "ok"|"block", reason }
  function checkDeposit(account, dep) {
    const p = policyOf(account), amt = Number(dep.amount) || 0;
    if (amt <= 0) return { ok: false, level: "block", reason: "입금액은 0보다 커야 해요." };
    if (account.track === "income") {
      if (!p.allowed_sources.includes(dep.source))
        return { ok: false, level: "block", reason: `ISA는 ${p.allowed_sources.join("·")} 입금만 허용 ('${dep.source || "구분 없음"}'은 규칙 위반)` };
      return { ok: true, level: "ok", reason: `${dep.source} 입금` };
    }
    if (account.track === "aggressive") {
      const prev = sum((account.deposits || []).filter(d => d !== dep), d => d.amount);
      if (prev + amt > p.external_deposit_limit)
        return { ok: false, level: "block", reason: `미국주식 계좌는 외부 입금 한도 ${p.external_deposit_limit} (누적 ${prev + amt}) — 신규 자금 동결 규칙 위반` };
      return { ok: true, level: "ok", reason: "한도 안" };
    }
    return { ok: true, level: "ok", reason: "정책 없는 계좌" };
  }

  // ---- 배당 트랙 (ISA) ----
  // rows: [{ ticker, name, value(원), yield(% 또는 null) }]
  function incomeMetrics(account, rows) {
    const p = policyOf(account);
    const items = rows.map(r => {
      const y = r.yield == null || r.yield === "" ? null : Number(r.yield);
      const flag = y == null ? "unknown" : y >= p.min_yield ? "ok" : "low";
      const gross = y == null ? 0 : r.value * y / 100;
      return { ...r, yield: y, flag, annualGross: gross, annualNet: gross * (1 - p.dividend_tax / 100) };
    });
    const value = sum(items, x => x.value), known = items.filter(x => x.yield != null);
    const annualNet = sum(items, x => x.annualNet), annualGross = sum(items, x => x.annualGross);
    const okValue = sum(items.filter(x => x.flag === "ok"), x => x.value);
    const deps = account.deposits || [], divs = account.dividends || [];
    return {
      policy: p, items, value,
      weightedYield: sum(known, x => x.value) ? sum(known, x => x.value * x.yield) / sum(known, x => x.value) : null,
      annualGross, annualNet, monthlyNet: annualNet / 12,
      compliantPct: value ? okValue / value * 100 : 0,
      bonusTotal: sum(deps.filter(d => p.allowed_sources.includes(d.source)), d => d.amount),
      bySource: p.allowed_sources.map(s => ({ source: s, amount: sum(deps.filter(d => d.source === s), d => d.amount) })),
      reinvested: sum(divs.filter(d => d.use === "reinvest"), d => d.amount),
      withdrawn: sum(divs.filter(d => d.use === "withdraw"), d => d.amount),
      dividendsReceived: sum(divs, d => d.amount),
    };
  }

  // ---- 공격 트랙 (미국주식) ----
  // rows: [{ ticker, value($) }], cash($)
  function aggressiveMetrics(account, rows, cash) {
    const p = policyOf(account);
    const value = sum(rows, r => r.value) + (cash || 0);
    const base = Number(p.capital_base) || null;
    const peak = Math.max(Number(p.peak_value) || 0, base || 0, value);
    const lossPct = base ? (value / base - 1) * 100 : null;          // 원금 대비
    const ddPct = peak ? (value / peak - 1) * 100 : 0;                  // 기록된 고점 대비 (현재 낙폭)
    const limitUse = lossPct != null && lossPct < 0 ? -lossPct / p.max_loss_pct * 100 : 0;
    const positions = rows.map(r => ({ ...r, weight: value ? r.value / value * 100 : 0 }))
      .map(r => ({ ...r, over: r.weight > p.max_position_pct }));
    const trades = (account.trades || []).map(t => {
      const pnl = (t.exit - t.entry) * t.qty, ret = (t.exit / t.entry - 1) * 100;
      const r = t.stop != null && t.entry !== t.stop ? (t.exit - t.entry) / (t.entry - t.stop) : null; // R 배수
      return { ...t, pnl, ret, r };
    });
    const wins = trades.filter(t => t.pnl > 0), losses = trades.filter(t => t.pnl < 0);
    const avgWin = wins.length ? sum(wins, t => t.pnl) / wins.length : 0, avgLoss = losses.length ? -sum(losses, t => t.pnl) / losses.length : 0;
    return {
      policy: p, value, base, peak, lossPct, ddPct, limitUse, positions,
      externalDeposits: sum(account.deposits || [], d => d.amount),
      trades, tradeCount: trades.length,
      winRate: trades.length ? wins.length / trades.length * 100 : null,
      payoff: avgWin && avgLoss ? avgWin / avgLoss : null,          // 손익비 = 평균 이익 / 평균 손실
      realized: sum(trades, t => t.pnl),
    };
  }

  // ---- 전체 점검: 경고 목록 ----
  // ctx: { incomeOf(account) → incomeMetrics, aggressiveOf(account) → aggressiveMetrics, budget }
  function audit(accounts, ctx) {
    const out = [];
    const add = (level, acct, text) => out.push({ level, acct, text });
    for (const a of accounts) {
      const p = policyOf(a), short = a.name.replace(/ \(.*\)/, "");
      if (a.track === "income") {
        (a.deposits || []).forEach(d => { const c = checkDeposit(a, d); if (!c.ok) add("bad", short, `${d.date} ${Number(d.amount).toLocaleString("ko-KR")}원 — ${c.reason}`); });
        const m = ctx.incomeOf(a);
        m.items.forEach(x => {
          if (x.flag === "unknown") add("mid", short, `${x.name} 배당률 미입력 → 7% 기준 판정 불가`);
          else if (x.flag === "low") add("mid", short, `${x.name} 배당률 ${x.yield}% < ${p.min_yield}% (원칙 외 종목 — 추가 매수 금지)`);
        });
      }
      if (a.track === "aggressive") {
        const m = ctx.aggressiveOf(a);
        if (m.externalDeposits > p.external_deposit_limit) add("bad", short, `외부 입금 누적 ${m.externalDeposits} > 한도 ${p.external_deposit_limit} (신규 자금 동결 위반)`);
        if (m.limitUse >= 100) add("bad", short, `원금 대비 ${m.lossPct.toFixed(1)}% — 최대 손실 한도 -${p.max_loss_pct}% 도달`);
        else if (m.limitUse >= 70) add("mid", short, `원금 대비 ${m.lossPct.toFixed(1)}% — 손실 한도 -${p.max_loss_pct}%의 ${m.limitUse.toFixed(0)}% 사용`);
        m.positions.filter(x => x.over).forEach(x => add("mid", short, `${x.ticker} 비중 ${x.weight.toFixed(0)}% > 한도 ${p.max_position_pct}%`));
        if (!m.base) add("mid", short, "원금(capital_base) 미설정 → 손실 한도 계산 불가");
      }
    }
    // 월 자금 계획이 규칙과 충돌하는지 (정기 입금 금지 계좌로 매달 돈이 가는 항목)
    for (const i of (ctx.budget?.items || [])) {
      const txt = `${i.name} ${i.account || ""}`;
      const toUS = /메리츠|미국|SGOV|SPYM/i.test(txt), toISA = /ISA/i.test(txt);
      if (toUS) add("bad", "월 자금 계획", `'${i.name}' 매달 ${Number(i.amount).toLocaleString("ko-KR")}원 → 미국주식 계좌 정기 입금 (신규 자금 0 규칙과 충돌)`);
      else if (toISA) add("bad", "월 자금 계획", `'${i.name}' 매달 ${Number(i.amount).toLocaleString("ko-KR")}원 → ISA 정기 입금 (보너스 전용 규칙과 충돌)`);
    }
    return out;
  }

  return { DEFAULTS, policyOf, checkDeposit, incomeMetrics, aggressiveMetrics, audit };
});
