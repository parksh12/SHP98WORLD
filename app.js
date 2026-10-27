"use strict";
const KEY_STORE = "asset_key_v1";
let DATA = null, PRICES = null;

// ---------- 암호 ----------
const b64 = s => Uint8Array.from(atob(s), c => c.charCodeAt(0));
const ub64 = buf => btoa(String.fromCharCode(...new Uint8Array(buf)));
async function deriveKey(pw, enc) {
  const base = await crypto.subtle.importKey("raw", new TextEncoder().encode(pw), "PBKDF2", false, ["deriveKey"]);
  return crypto.subtle.deriveKey({ name: "PBKDF2", salt: b64(enc.salt), iterations: enc.iter, hash: "SHA-256" },
    base, { name: "AES-GCM", length: 256 }, true, ["decrypt"]);
}
async function decrypt(key, enc) {
  const pt = await crypto.subtle.decrypt({ name: "AES-GCM", iv: b64(enc.iv) }, key, b64(enc.ct));
  return JSON.parse(new TextDecoder().decode(pt));
}
const getJSON = u => fetch(u + "?t=" + Date.now(), { cache: "no-store" }).then(r => r.json());
function store(fn) { try { return fn(); } catch { return null; } }

async function unlockWith(key, remember) {
  const enc = await getJSON("data.enc.json");
  DATA = await decrypt(key, enc);
  if (remember) { const raw = await crypto.subtle.exportKey("raw", key); store(() => localStorage.setItem(KEY_STORE, ub64(raw))); }
  document.getElementById("lock").style.display = "none";
  document.getElementById("app").style.display = "block";
  await refresh();
  setInterval(refresh, 5 * 60 * 1000);
}

document.getElementById("lockform").addEventListener("submit", async e => {
  e.preventDefault();
  const err = document.getElementById("err"); err.textContent = "여는 중…";
  try {
    const enc = await getJSON("data.enc.json");
    const key = await deriveKey(document.getElementById("pw").value, enc);
    await unlockWith(key, document.getElementById("remember").checked);
  } catch { err.textContent = "비밀번호가 맞지 않아요."; }
});

document.querySelectorAll(".themebtn").forEach(b => b.textContent = themeIcon());
(async () => {
  const saved = store(() => localStorage.getItem(KEY_STORE));
  if (!saved) return;
  try {
    const key = await crypto.subtle.importKey("raw", b64(saved), "AES-GCM", true, ["decrypt"]);
    await unlockWith(key, false);
  } catch { store(() => localStorage.removeItem(KEY_STORE)); }
})();

function toggleTheme() {
  const r = document.documentElement, dark = r.dataset.theme ? r.dataset.theme === "dark" : matchMedia("(prefers-color-scheme: dark)").matches;
  r.dataset.theme = dark ? "light" : "dark";
  store(() => localStorage.setItem("theme", r.dataset.theme));
  document.querySelectorAll(".themebtn").forEach(b => b.textContent = dark ? "다크" : "라이트");
}
function themeIcon() { const r = document.documentElement; return (r.dataset.theme ? r.dataset.theme === "dark" : matchMedia("(prefers-color-scheme: dark)").matches) ? "라이트" : "다크"; }
function lockNow() { store(() => localStorage.removeItem(KEY_STORE)); location.reload(); }

// ---------- 계산 ----------
const won = x => Math.round(x).toLocaleString("ko-KR") + "원";
const man = x => Math.round(x / 1e4).toLocaleString("ko-KR") + "만원";
const esc = s => String(s).replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const signed = (x, pct) => `<span class="${x > 0 ? "up" : x < 0 ? "down" : ""}">${x > 0 ? "+" : ""}${won(x)}${pct == null ? "" : ` (${pct > 0 ? "+" : ""}${pct.toFixed(2)}%)`}</span>`;
const D = s => { const [y, m, d] = s.split("-").map(Number); return new Date(y, m - 1, d); };
const today = () => { const t = new Date(); return new Date(t.getFullYear(), t.getMonth(), t.getDate()); };

function depositsSince(asOf, day, t) {
  let y = asOf.getFullYear(), m = asOf.getMonth(), n = 0;
  for (;;) { const d = new Date(y, m, day); if (d > t) return n; if (d > asOf) n++; m++; if (m > 11) { m = 0; y++; } }
}
function nextDeposit(day, t) { let d = new Date(t.getFullYear(), t.getMonth(), day); if (d <= t) d = new Date(t.getFullYear(), t.getMonth() + 1, day); return d; }
function monthsBetween(a, b) { return Math.max(0, (b.getFullYear() - a.getFullYear()) * 12 + b.getMonth() - a.getMonth() - (b.getDate() < a.getDate() ? 1 : 0)); }
function fv(p, mo, r, n) { const i = r / 12; if (!i) return p + mo * n; const g = (1 + i) ** n; return p * g + mo * (g - 1) / i; }
function needed(p, target, r, n) { if (n <= 0) return 0; const i = r / 12; if (!i) return Math.max(0, (target - p) / n); const g = (1 + i) ** n; return Math.max(0, (target - p * g) * i / (g - 1)); }

function build() {
  const fx = PRICES.fx || 1350, t = today(), cats = {}, warn = [];
  DATA.categories.forEach(c => cats[c] = 0);
  const accounts = DATA.accounts.map(a => {
    let value = 0, cost = 0;
    const rows = a.holdings.map(h => {
      const usd = a.currency === "USD", k = usd ? fx : 1;
      let p = PRICES.prices[h.ticker], stale = false;
      if (p == null) { p = h.avg; stale = true; warn.push(`${h.name} 시세가 없어 평단가로 계산했어요.`); }
      const v = p * h.qty * k, c = h.avg * h.qty * k;
      value += v; cost += c; cats[h.category] = (cats[h.category] || 0) + v;
      return { ...h, price: p, value: v, cost: c, usd, stale };
    });
    const cash = (a.cash_usd || 0) * fx + (a.cash_krw || 0);
    cats["단기채·현금"] = (cats["단기채·현금"] || 0) + cash;
    return { name: a.name, rows, value, cost, cash };
  });
  const savings = DATA.savings.map(s => {
    const n = depositsSince(D(s.as_of), s.day, t), now = s.balance + n * s.monthly;
    cats[s.category] += now; return { ...s, now, next: nextDeposit(s.day, t) };
  });
  DATA.cash.forEach(c => cats[c.category] += c.amount);
  const total = Object.values(cats).reduce((a, b) => a + b, 0);
  return { fx, t, cats, accounts, savings, total, warn };
}

// ---------- 그리기 ----------
const pct = (v, c) => c ? (v - c) / c * 100 : 0;
const cls = x => x > 0.05 ? "up" : x < -0.05 ? "down" : "";
const sp = x => (x > 0 ? "+" : "") + x.toFixed(2) + "%";
const sw = x => (x > 0 ? "+" : "") + Math.round(x).toLocaleString("ko-KR") + "원";

function budgetSection() {
  const B = DATA.budget; if (!B) return "";
  const G = ["저축", "투자", "고정비", "생활"], col = { 저축: "var(--s1)", 투자: "var(--s6)", 고정비: "var(--s2)", 생활: "var(--s4)" };
  const sum = g => B.items.filter(i => i.group === g).reduce((s, i) => s + i.amount, 0);
  const used = B.items.reduce((s, i) => s + i.amount, 0), saveRate = (sum("저축") + sum("투자")) / B.income * 100;
  const bar = G.map(g => { const v = sum(g); return v ? `<div class="seg" style="flex:${v};background:${col[g]}" data-tip="${g} ${man(v)} · ${(v / B.income * 100).toFixed(0)}%"></div>` : ""; }).join("");
  const leg = G.map(g => `<span><i style="background:${col[g]}"></i>${g} ${man(sum(g))}</span>`).join("");
  const rows = G.map(g => B.items.filter(i => i.group === g).map(i =>
    `<tr><td><i class="dot" style="background:${col[g]}"></i>${esc(i.name)}</td><td class="mut">${esc(i.day || "")}</td><td class="mut">${esc(i.account || "")}</td><td>${won(i.amount)}</td></tr>`).join("")).join("");
  return `<section class="card"><div class="row"><b>월 자금 계획 · 실수령 ${man(B.income)}</b><span class="mut">저축·투자 ${saveRate.toFixed(0)}%${used !== B.income ? ` · 남는 돈 ${won(B.income - used)}` : ""}</span></div>
<div class="bar">${bar}</div><div class="legend">${leg}</div>
<div class="tbl" style="margin-top:8px"><table><thead><tr><th>항목</th><th>날짜</th><th>통장</th><th>금액</th></tr></thead><tbody>${rows}</tbody></table></div></section>`;
}

function plannedSection() {
  const P = DATA.planned || []; if (!P.length) return "";
  const t = today();
  const rows = P.map(x => {
    const exact = /^\d{4}-\d{2}-\d{2}$/.test(x.when), d = exact ? D(x.when) : null;
    const dday = d ? Math.round((d - t) / 864e5) : null;
    const when = d ? `${d.getMonth() + 1}/${d.getDate()}${dday >= 0 ? ` <span class="q">D-${dday}</span>` : ""}` : esc(x.when) + "년";
    return `<tr><td><b>${esc(x.name)}</b></td><td class="mut">${when}</td><td>${won(x.amount)}</td></tr>`;
  }).join("");
  return `<section class="card"><div class="row"><b>예정된 큰 지출</b></div>
<div class="tbl"><table><tbody>${rows}</tbody></table></div></section>`;
}

function headerHTML(d) {
  const upd = PRICES.updated ? new Date(PRICES.updated).toLocaleString("ko-KR", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" }) : "-";
  const v = document.body.dataset.view;
  return `<header><nav class="tabs"><a href="index.html" class="${v === "summary" ? "on" : ""}">요약</a><a href="accounts.html" class="${v === "accounts" ? "on" : ""}">계좌별</a><a href="goals.html" class="${v === "goals" ? "on" : ""}">중기 목표</a></nav>
<div class="hbtn"><button class="btn themebtn" onclick="toggleTheme()" title="다크/라이트">${themeIcon()}</button><button class="btn" onclick="lockNow()" title="잠그기">잠금</button></div></header>
<div class="meta">시세 ${upd} · ₩${Math.round(d.fx).toLocaleString()}/$</div>`;
}

function holdingRow(r, acctTotal) {
  const f = x => r.usd ? "$" + x.toFixed(2) : Math.round(x).toLocaleString("ko-KR") + "원", pc = pct(r.value, r.cost);
  const w = acctTotal ? `<div class="q2">${(r.value / acctTotal * 100).toFixed(1)}%</div>` : "";
  return `<tr><td><b>${esc(r.ticker.match(/^\d/) ? r.name.replace(" 미국", " ") : r.ticker)}</b><div class="q2">${r.qty}주</div></td>
    <td>${f(r.price)}${r.stale ? "*" : ""}<div class="q2">${f(r.avg)}</div></td><td>${won(r.value)}${w}</td><td class="${cls(pc)}">${sw(r.value - r.cost)}</td><td class="${cls(pc)}">${sp(pc)}</td></tr>`;
}
const HOLD_HEAD = `<thead><tr><th>종목</th><th>현재가<div class="q2">평단가</div></th><th>평가금액</th><th>수익금</th><th>수익률</th></tr></thead>`;

function render(d) {
  const { cats, total, accounts, savings, fx, t } = d;
  const invVal = accounts.reduce((s, a) => s + a.value, 0), invCost = accounts.reduce((s, a) => s + a.cost, 0);
  const savNow = savings.reduce((s, x) => s + x.now, 0), savMonth = savings.reduce((s, x) => s + x.monthly, 0);
  const cashTotal = DATA.cash.reduce((s, c) => s + c.amount, 0);
  const g = DATA.goal, start = D(g.start), end = D(g.deadline), n = monthsBetween(t, end);
  const prog = Math.min(total / g.target, 1) * 100, elapsed = Math.min(Math.max((t - start) / (end - start), 0), 1) * 100;
  const need = needed(total, g.target, Math.max(...g.returns), n);
  const nextDep = savings.length ? savings[0].next : null;

  const tile = (l, v, sub, c = "") => `<div class="tile"><div class="lbl">${l}</div><div class="val">${v}</div><div class="sub ${c}">${sub}</div></div>`;
  const tiles = accounts.map(a => tile(esc(a.name.replace(/ \(.*\)/, "")), man(a.value + a.cash), a.cost ? `${sw(a.value - a.cost)} (${sp(pct(a.value, a.cost))})` : "", cls(a.value - a.cost))).join("")
    + tile("예적금", man(savNow), nextDep ? `${nextDep.getMonth() + 1}/${nextDep.getDate()} +${man(savMonth)}` : "")
    + tile("비상금", man(cashTotal), "");

  const segs = [], legend = [];
  Object.entries(cats).forEach(([c, v], i) => { if (v <= 0) return; const p = v / total * 100;
    segs.push(`<div class="seg" style="flex:${v.toFixed(0)};background:var(--s${i + 1})" data-tip="${esc(c)} ${man(v)} · ${p.toFixed(1)}%"></div>`);
    legend.push(`<span><i style="background:var(--s${i + 1})"></i>${esc(c)} ${p.toFixed(0)}%</span>`); });

  const rows = accounts.map(a => `<tr class="grp"><td colspan="5">${esc(a.name.replace(/ \(.*\)/, ""))}</td></tr>` +
    [...a.rows].sort((x, y) => y.value - x.value).map(r => holdingRow(r)).join("")
    + (a.cash > 1e4 ? `<tr class="cash"><td>예수금</td><td></td><td>${won(a.cash)}</td><td></td><td></td></tr>` : "")).join("");

  const M = DATA.milestones || {}, held = {};
  accounts.forEach(a => a.rows.forEach(r => held[r.ticker] = (held[r.ticker] || 0) + r.qty));
  const badges = [
    ...Object.entries(M.shares || {}).map(([tk, lv]) => { const q = held[tk] || 0, nx = lv.find(x => x > q);
      return nx ? `<span class="badge">${tk.match(/^\d/) ? "나스닥100" : tk} ${q}/${nx}주</span>` : `<span class="badge on">${tk} ${q}주 ✓</span>`; }),
    (() => { const nx = (M.invest_krw || []).find(x => x > invVal); return nx ? `<span class="badge">투자 ${man(invVal)}/${man(nx)}</span>` : ""; })(),
  ].join("");

  document.getElementById("app").innerHTML = `<main>
${headerHTML(d)}
<div class="hero"><div class="big">${won(total)}</div>
<div class="sub">투자 ${man(invVal)} <span class="${cls(invVal - invCost)}">${signed(invVal - invCost).replace(/<[^>]+>/g, "")} (${sp(pct(invVal, invCost))})</span></div></div>
${d.warn.length ? `<div class="warn">* 시세 없음: 평단가로 표시</div>` : ""}
<div class="tiles">${tiles}</div>
<section class="card"><div class="row"><b>${(g.target / 1e8).toFixed(0)}억 목표 ${prog.toFixed(1)}%</b><span class="mut">D-${Math.max(Math.round((end - t) / 864e5), 0)}</span></div>
<div class="track"><div class="fill" style="width:${prog.toFixed(2)}%"></div><div class="tick" style="left:${elapsed.toFixed(2)}%"></div></div></section>
<section class="card"><div class="bar">${segs.join("")}</div><div class="legend">${legend.join("")}</div></section>
<section class="card"><div class="tbl"><table>${HOLD_HEAD}<tbody>${rows}</tbody></table></div>
${badges ? `<div class="badges">${badges}</div>` : ""}</section>
${budgetSection()}
${plannedSection()}
</main>`;
  bindTips();
}

function renderAccounts(d) {
  const { accounts, savings, total, t } = d;
  const cashTotal = DATA.cash.reduce((s, c) => s + c.amount, 0);
  const C = ["var(--s1)", "var(--s2)", "var(--s3)", "var(--s4)", "var(--s5)", "var(--s6)"];
  const list = [
    ...accounts.map(a => ({ name: a.name.replace(/ \(.*\)/, ""), sub: (a.name.match(/\((.*)\)/) || [])[1] || "투자", value: a.value + a.cash, kind: "inv", a })),
    ...savings.map(s => ({ name: s.name, sub: `매월 ${s.day}일 ${man(s.monthly)}`, value: s.now, kind: "sav", s })),
    { name: "비상금", sub: "원화 현금", value: cashTotal, kind: "cash" },
  ];
  list.forEach((x, i) => { x.color = C[i % C.length]; x.id = "acct" + i; });

  // 도넛 (계좌 비중)
  const R = 70, L = 2 * Math.PI * R, gap = list.length > 1 ? 2.5 : 0;
  let off = 0;
  const arcs = list.map(x => { const len = x.value / total * L, seg = Math.max(len - gap, 0.5);
    const c = `<circle r="${R}" cx="90" cy="90" fill="none" stroke="${x.color}" stroke-width="26" stroke-dasharray="${seg} ${L - seg}" stroke-dashoffset="${-off}" data-tip="${esc(x.name)} ${man(x.value)} · ${(x.value / total * 100).toFixed(1)}%"/>`;
    off += len; return c; }).join("");
  const invVal = accounts.reduce((s, a) => s + a.value, 0), invCost = accounts.reduce((s, a) => s + a.cost, 0);
  const savNow = savings.reduce((s, x) => s + x.now, 0);
  const alist = list.map(x => `<a href="#${x.id}"><i style="background:${x.color}"></i><span class="n">${esc(x.name)}</span><span class="v">${man(x.value)}</span><span class="p">${(x.value / total * 100).toFixed(1)}%</span></a>`).join("");

  const head = (x, right) => `<div class="acct-h"><div class="acct-ic" style="background:${x.color}">${esc(x.name[0])}</div>
    <div class="acct-t"><b>${esc(x.name)}</b></div><div class="acct-v"><b>${won(x.value)}</b>${right || ""}</div></div>`;

  const card = x => {
    if (x.kind === "inv") {
      const a = x.a, pl = a.value - a.cost, pc = pct(a.value, a.cost);
      const holds = [...a.rows].sort((p, q) => q.value - p.value).map(r => {
        const f = v => r.usd ? "$" + v.toFixed(2) : Math.round(v).toLocaleString("ko-KR") + "원", rp = pct(r.value, r.cost), w = r.value / x.value * 100;
        return `<div class="hold"><div class="hold-top"><div><b>${esc(r.ticker.match(/^\d/) ? r.name.replace(" 미국", " ") : r.ticker)}</b><span class="q">${r.qty}주</span></div><span class="v">${won(r.value)}</span></div>
          <div class="hold-sub"><span>${f(r.price)}${r.stale ? "*" : ""} · 평단 ${f(r.avg)}</span><span class="r ${cls(rp)}">${sw(r.value - r.cost)} (${sp(rp)})</span></div>
          <div class="wbar"><div><i style="width:${w.toFixed(1)}%;background:${x.color}"></i></div><span>${w.toFixed(1)}%</span></div></div>`; }).join("")
        + (a.cash > 0 ? `<div class="hold"><div class="hold-top"><span class="mut">예수금</span><span class="v mut">${won(a.cash)}</span></div>
          <div class="wbar"><div><i style="width:${(a.cash / x.value * 100).toFixed(1)}%;background:var(--mut)"></i></div><span>${(a.cash / x.value * 100).toFixed(1)}%</span></div></div>` : "");
      return `<section class="card" id="${x.id}">${head(x, `<span class="${cls(pc)}">${sw(pl)} (${sp(pc)})</span>`)}${holds}</section>`;
    }
    if (x.kind === "sav") {
      const s = x.s, dday = Math.round((s.next - t) / 864e5), vals = Array.from({ length: 13 }, (_, i) => s.now + i * s.monthly), mx = vals[12];
      const cols = vals.map((v, i) => `<i style="height:${(v / mx * 100).toFixed(1)}%;background:${x.color};opacity:${i ? .45 + .55 * i / 12 : 1}" data-tip="${i ? i + "개월 뒤" : "지금"} ${man(v)}"></i>`).join("");
      return `<section class="card" id="${x.id}">${head(x, `<span class="mut">D-${dday}</span>`)}
        <div class="cols">${cols}</div><div class="cols-x"><span>지금</span><span>1년 뒤 ${man(mx)}</span></div></section>`;
    }
    const goal = ((DATA.midterm?.targets || []).find(x => x.key === "비상금") || {}).target || 5000000, p = Math.min(cashTotal / goal, 1) * 100, item = (DATA.budget?.items || []).find(i => i.name === "비상금");
    const left = Math.max(goal - cashTotal, 0), months = item ? Math.ceil(left / item.amount) : null;
    return `<section class="card" id="${x.id}">${head(x, `<span class="mut">${p.toFixed(0)}% / ${man(goal)}</span>`)}
      <div class="track"><div class="fill" style="width:${p.toFixed(1)}%"></div></div>
</section>`;
  };

  document.getElementById("app").innerHTML = `<main>
${headerHTML(d)}
<section class="card"><div class="donut-wrap"><div class="donut"><svg viewBox="0 0 180 180"><circle r="${R}" cx="90" cy="90" fill="none" stroke="var(--soft)" stroke-width="26"/>${arcs}</svg>
<div class="c"><small>총자산</small><b>${man(total)}</b></div></div><div class="alist">${alist}</div></div>
<div class="kpis"><div class="kpi"><span>투자 손익</span><b class="${cls(invVal - invCost)}">${sp(pct(invVal, invCost))}</b></div>
<div class="kpi"><span>예적금</span><b>${man(savNow)}</b></div><div class="kpi"><span>비상금</span><b>${man(cashTotal)}</b></div></div></section>
${list.map(card).join("")}
</main>`;
  bindTips();
}

function countDays(day, from, to) { // from 다음 날 ~ to 까지 매월 day일 횟수
  let n = 0, y = from.getFullYear(), m = from.getMonth();
  for (;;) { const d = new Date(y, m, day); if (d > to) return n; if (d > from) n++; if (++m > 11) { m = 0; y++; } }
}

function renderGoals(d) {
  const M = DATA.midterm;
  if (!M) { document.getElementById("app").innerHTML = `<main>${headerHTML(d)}<div class="card">중기 목표가 없어요.</div></main>`; return; }
  const { accounts, savings, t } = d;
  const start = D(M.start), end = D(M.deadline), elapsed = Math.min(Math.max((t - start) / (end - start), 0), 1);
  const dday = Math.max(Math.round((end - t) / 864e5), 0);
  const cashTotal = DATA.cash.reduce((s, c) => s + c.amount, 0);
  const C = ["var(--s3)", "var(--s4)", "var(--s2)", "var(--s1)", "var(--s5)"];
  const cur = x => x.type === "cash" ? cashTotal
    : x.type === "saving" ? ((savings.find(s => s.name === x.key) || {}).now || 0)
    : (a => a ? a.value + a.cash : 0)(accounts.find(a => a.name.startsWith(x.key)));
  const T = M.targets.map((x, i) => {
    const now = cur(x), keep = x.target < x.base;
    const prog = keep ? Math.min(now / x.target, 1) * 100 : Math.max(0, Math.min((now - x.base) / (x.target - x.base), 1)) * 100;
    const expect = keep ? x.target : x.base + (x.target - x.base) * elapsed;
    const diff = now - expect, tol = x.target * 0.01;
    const status = keep ? (now >= x.target ? ["유지 중", "ok"] : ["부족", "bad"])
      : diff >= tol ? ["앞서감", "ok"] : diff <= -tol ? ["뒤처짐", "bad"] : ["순항", "mid"];
    const sv = DATA.savings.find(s => s.name === x.key);
    const left = x.type === "saving" ? countDays(sv ? sv.day : 25, t, end) : countDays(1, t, end);
    const need = left ? Math.max(x.target - now, 0) / left : 0;
    return { ...x, now, prog, expect, status, left, need, color: C[i % C.length], keep };
  });
  const baseSum = T.reduce((s, x) => s + x.base, 0), tgtSum = T.reduce((s, x) => s + x.target, 0), nowSum = T.reduce((s, x) => s + x.now, 0);
  const allProg = Math.max(0, Math.min((nowSum - baseSum) / (tgtSum - baseSum), 1)) * 100;

  const ring = (p, col) => { const R = 30, L = 2 * Math.PI * R, v = Math.min(p, 100) / 100 * L;
    return `<svg viewBox="0 0 76 76" class="ring"><circle r="${R}" cx="38" cy="38" fill="none" stroke="var(--soft)" stroke-width="8"/>`
      + `<circle r="${R}" cx="38" cy="38" fill="none" stroke="${col}" stroke-width="8" stroke-linecap="round" stroke-dasharray="${v} ${L}" transform="rotate(-90 38 38)"/>`
      + `<text x="38" y="43" text-anchor="middle">${Math.round(p)}%</text></svg>`; };

  const cards = T.map(x => `<section class="card goal">
    <div class="g-top">${ring(x.prog, x.color)}<div class="g-t"><div class="g-name"><b>${esc(x.key)}</b><span class="chip ${x.status[1]}">${x.status[0]}</span></div>
      <div class="g-num"><b>${man(x.now)}</b><span> / ${man(x.target)}</span></div></div></div>
    <div class="track g-track"><div class="fill" style="width:${Math.min(x.prog, 100).toFixed(1)}%;background:${x.color}"></div>${x.keep ? "" : `<div class="tick" style="left:${(elapsed * 100).toFixed(1)}%" title="오늘 있어야 할 위치"></div>`}</div>
</section>`).join("");

  let nextShown = false;
  const tl = M.timeline.map(e => {
    const dt = D(e.date), done = dt < t, isNext = !done && !nextShown;
    if (isNext) nextShown = true;
    const dd = Math.round((dt - t) / 864e5);
    return `<li class="${done ? "done" : isNext ? "next" : ""}"><span class="tl-d">${dt.getFullYear() % 100}.${dt.getMonth() + 1}.${dt.getDate()}</span>`
      + `<span class="tl-t">${esc(e.text)}</span>${isNext ? `<span class="chip mid">D-${dd}</span>` : done ? `<span class="tl-ok">✓</span>` : ""}</li>`; }).join("");

  const B = DATA.budget;
  const monthly = B ? B.items.filter(i => ["청년도약계좌", "주택청약", "비상금", "SGOV 대기자금"].includes(i.name)) : [];
  const routine = monthly.map(i => `<div class="kpi"><span>${esc(i.name)} · ${esc(i.day)}</span><b>${man(i.amount)}</b></div>`).join("");

  document.getElementById("app").innerHTML = `<main>
${headerHTML(d)}
<section class="card g-hero">
  <div class="row"><b style="font-size:17px">${esc(M.name)}</b><span class="chip mid">D-${dday}</span></div>
  <div class="g-big"><b>${man(nowSum)}</b><span> / ${man(tgtSum)}</span></div>
  <div class="track" style="margin-top:10px"><div class="fill" style="width:${allProg.toFixed(1)}%"></div><div class="tick" style="left:${(elapsed * 100).toFixed(1)}%"></div></div>
</section>
${cards}
<section class="card"><h2>매달</h2><div class="kpis k4">${routine}</div></section>
<section class="card"><h2>로드맵</h2><ul class="tl">${tl}</ul></section>
</main>`;
  bindTips();
}

function bindTips() {
  const tip = document.getElementById("tip");
  document.querySelectorAll("[data-tip]").forEach(s => {
    s.addEventListener("mousemove", e => { tip.textContent = s.dataset.tip; tip.style.opacity = 1;
      tip.style.left = Math.min(e.clientX + 12, innerWidth - tip.offsetWidth - 8) + "px"; tip.style.top = (e.clientY + 14) + "px"; });
    s.addEventListener("mouseleave", () => tip.style.opacity = 0);
  });
}

async function refresh() {
  try { PRICES = await getJSON("prices.json"); } catch { PRICES = PRICES || { prices: {}, fx: null }; }
  const d = build();
  ({ accounts: renderAccounts, goals: renderGoals }[document.body.dataset.view] || render)(d);
}
