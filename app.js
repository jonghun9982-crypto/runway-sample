/* 자금 소진(런웨이) 대시보드 + 기록 — 빌드 없는 순수 JS.
   데이터 계층: 기초 데이터(data.js 또는 업로드, 브라우저 저장) + 사용자 기록(localStorage) → 유효 데이터 → KPI/차트/예측 */
'use strict';
const $ = (s) => document.querySelector(s);
const DAY = 86400000, MLEN = 30.4375;
const STORE_KEY = 'runwayApp:v1', SCHEMA = 1;
let BASE = null, RAW = null, D = null, charts = {}, BASE_ORIGIN = '';
const DEFAULTS = { method: 'a', nWin: 3, tWin: 9, basis: 'free', unconf: false, exFin: true, grantPct: 100, grantDelay: 0, expPct: 0,
  exOne: false, oneoffOff: [], fundAmt: '', fundMonth: 0, minCash: '', horizon: 12, unit: 'm' };
let S = { ...DEFAULTS };
let ST = emptyStore();
function emptyStore() { return { schema: SCHEMA, entries: [], duePlans: [], duePaid: {}, base: null, settings: {}, lastSaved: null, lastExport: null }; }

/* ---------------- 유틸 ---------------- */
const pd = (s) => { const [y, m, d] = String(s).split('-').map(Number); return new Date(y, m - 1, d || 1); };
const ymd = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const ym = (d) => ymd(d).slice(0, 7);
const monthEnd = (d) => new Date(d.getFullYear(), d.getMonth() + 1, 0);
const addM = (d, n) => new Date(d.getFullYear(), d.getMonth() + n, 1);
const sum = (o) => Object.values(o || {}).reduce((a, b) => a + (+b || 0), 0);
const avg = (a) => a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0;
const std = (a) => { if (a.length < 2) return 0; const m = avg(a); return Math.sqrt(a.reduce((s, x) => s + (x - m) ** 2, 0) / (a.length - 1)); };
const WD = ['일', '월', '화', '수', '목', '금', '토'];
const won = (v) => (v == null || isNaN(v)) ? '-' : Math.round(v).toLocaleString('ko-KR') + '원';
function fmt(v, unit = S.unit, dig) {
  if (v == null || isNaN(v)) return '-';
  if (unit === 'w') return (v / 1e4).toLocaleString('ko-KR', { maximumFractionDigits: dig ?? 0 }) + '만원';
  return (v / 1e6).toLocaleString('ko-KR', { minimumFractionDigits: dig ?? 1, maximumFractionDigits: dig ?? 1 }) + '백만원';
}
const fmtAxis = (v) => S.unit === 'w' ? (v / 1e4).toLocaleString('ko-KR') : (v / 1e6).toLocaleString('ko-KR');
const unitName = () => S.unit === 'w' ? '만원' : '백만원';
const mLabel = (k) => { const [y, m] = k.split('-'); return `${y.slice(2)}.${m}`; };
const dLabel = (d) => `${d.getFullYear()}.${String(d.getMonth() + 1).padStart(2, '0')}.${String(d.getDate()).padStart(2, '0')}(${WD[d.getDay()]})`;
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const clone = (o) => JSON.parse(JSON.stringify(o));
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
const nowStr = () => { const d = new Date(); return `${ymd(d)} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`; };
function toast(msg) { const t = $('#toast'); t.textContent = msg; t.classList.remove('hidden'); clearTimeout(toast.h); toast.h = setTimeout(() => t.classList.add('hidden'), 2200); }
const KIND = { expense: '지출', income: '수입', transfer: '계좌이체', balance: '잔액확인' };

/* ---------------- 저장소 (localStorage, 스키마 버전) ---------------- */
function loadStore() {
  try {
    const s = JSON.parse(localStorage.getItem(STORE_KEY) || 'null');
    if (s && s.schema === SCHEMA) ST = Object.assign(emptyStore(), s);
    else if (s) ST = migrate(s);
    const old = localStorage.getItem('runwaySettings');
    if (old && !Object.keys(ST.settings || {}).length) { ST.settings = JSON.parse(old); localStorage.removeItem('runwaySettings'); }
  } catch (e) { console.warn('저장 데이터를 읽지 못했습니다', e); }
  Object.assign(S, DEFAULTS, ST.settings || {});
}
function migrate(s) { const n = Object.assign(emptyStore(), s); n.schema = SCHEMA; return n; }
function saveStore(silent) {
  ST.settings = S; ST.lastSaved = nowStr();
  try { localStorage.setItem(STORE_KEY, JSON.stringify(ST)); }
  catch (e) { alert('브라우저 저장 공간에 저장하지 못했습니다(용량 초과 또는 차단). 전체 내보내기로 백업하세요.\n' + e.message); }
  if (!silent) updateStoreInfo();
}
const saveSettings = () => saveStore(true);

/* ---------------- 기초 + 기록 병합 ---------------- */
function incType(name) {
  const t = (RAW?.incomeTypes || BASE?.incomeTypes || {})[name];
  if (t) return t;
  if (/차입|대출|financ/i.test(name)) return 'financing';
  if (/지원금|출연|grant/i.test(name)) return 'grant';
  return 'other';
}
const entryMonth = (e) => e.level === 'monthly' ? e.month : (e.date || '').slice(0, 7);
function isCovered(e, base) {
  const cut = base.meta.asOf;
  return e.level === 'monthly' ? e.month <= cut.slice(0, 7) : e.date <= cut;
}
function buildEffective(base, st) {
  const raw = clone(base);
  const cut = base.meta.asOf;
  raw.meta.baseAsOf = cut;
  const flows = st.entries.filter((e) => e.kind === 'expense' || e.kind === 'income');
  const daily = flows.filter((e) => e.level !== 'monthly');
  const totalChecks = st.entries.filter((e) => e.kind === 'balance' && !e.account && e.date > cut).sort((a, b) => a.date.localeCompare(b.date));
  const latestCheck = totalChecks[totalChecks.length - 1] || null;
  let asOf = cut;
  daily.forEach((e) => { if (e.date > asOf) asOf = e.date; });
  if (latestCheck && latestCheck.date > asOf) asOf = latestCheck.date;
  st.entries.filter((e) => (e.kind === 'transfer' || (e.kind === 'balance' && e.account)) && e.date > asOf).forEach((e) => { asOf = e.date; });
  raw.meta.asOf = asOf;
  const mm = {}; raw.months.forEach((m) => { mm[m.month] = m; m.user = 0; m.userAmt = 0; });
  const ensure = (k) => mm[k] || (mm[k] = { month: k, expense: {}, income: {}, user: 0, userAmt: 0, lastDay: ymd(monthEnd(pd(k + '-01'))) });
  if (raw.months.length) for (let d = pd(raw.months[0].month + '-01'); ym(d) <= asOf.slice(0, 7); d = addM(d, 1)) ensure(ym(d));
  const baseVal = {};
  base.months.forEach((m) => ['expense', 'income'].forEach((g) => Object.entries(m[g] || {}).forEach(([c, v]) => { baseVal[`${m.month}|${g}|${c}`] = v; })));
  const repl = {};
  flows.forEach((e) => {
    const k = entryMonth(e); if (!k) return; const m = ensure(k); const g = e.kind; const amt = +e.amount || 0;
    m.user++; m.userAmt += amt;
    if (isCovered(e, base) && e.mode === 'replace') { const key = `${k}|${g}|${e.category}`; repl[key] = (repl[key] || 0) + amt; return; }
    m[g][e.category] = (m[g][e.category] || 0) + amt;
  });
  Object.entries(repl).forEach(([key, v]) => { const [k, g, c] = key.split('|'); const m = mm[k]; m[g][c] = (m[g][c] || 0) - (baseVal[key] || 0) + v; if (!m[g][c]) delete m[g][c]; });
  raw.months = Object.values(mm).sort((a, b) => a.month.localeCompare(b.month));
  raw.months.forEach((m) => { if (m.month === asOf.slice(0, 7)) m.lastDay = asOf; delete m.partial; });
  // 현금: 앵커(최신 총잔액 확인 또는 기초 기준일 계좌합계) + 이후 일자별 흐름
  const sign = (e) => (e.kind === 'income' ? 1 : -1) * (+e.amount || 0);
  const baseTotal = (base.accounts || []).length ? base.accounts.reduce((a, x) => a + (+x.balance || 0), 0) : null;
  const anchorDate = latestCheck ? latestCheck.date : cut;
  const anchorTotal = latestCheck ? +latestCheck.amount : (baseTotal ?? base.months.reduce((b, m) => b - sum(m.expense) + sum(m.income), +base.opening || 0));
  const after = daily.filter((e) => e.date > anchorDate);
  const total = anchorTotal + after.reduce((a, e) => a + sign(e), 0);
  // 계좌별: 기초 잔액 + 계좌 지정 흐름/이체, 계좌별 잔액확인은 그 날짜 잔액으로 덮어씀
  const accs = (raw.accounts || []).map((a) => ({ ...a }));
  const byName = Object.fromEntries(accs.map((a) => [a.name, a]));
  const accEv = st.entries.filter((e) => e.date && e.date > cut && (e.account || e.toAccount)).sort((a, b) => a.date.localeCompare(b.date) || (a.kind === 'balance' ? -1 : 1));
  accEv.forEach((e) => {
    const A = byName[e.account], B = byName[e.toAccount];
    if (e.kind === 'balance') { if (A) A.balance = +e.amount; }
    else if (e.kind === 'transfer') { if (A) A.balance -= +e.amount; if (B) B.balance += +e.amount; }
    else if (A && e.level !== 'monthly') A.balance += sign(e);
    if (A) A.touched = true; if (B) B.touched = true;
  });
  const accSum = accs.reduce((a, x) => a + x.balance, 0);
  if (accs.length && Math.abs(total - accSum) >= 1) accs.push({ name: '계좌 미지정 (기록/잔액확인 차이)', balance: total - accSum, flag: 'unassigned', virtual: true });
  raw.accounts = accs;
  raw.cashTotal = total;
  raw.anchor = { date: anchorDate, total: anchorTotal, fromCheck: !!latestCheck, after: after.length };
  if (latestCheck) {
    const implied = (baseTotal ?? 0) + daily.filter((e) => e.date > cut && e.date <= latestCheck.date).reduce((a, e) => a + sign(e), 0);
    raw.checkDiff = { date: latestCheck.date, diff: latestCheck.amount - implied };
  }
  raw.oneoffs = (raw.oneoffs || []).map((o, i) => ({ ...o, id: 'b' + i }));
  flows.filter((e) => e.kind === 'expense' && e.oneoff).forEach((e) => raw.oneoffs.push({ id: 'e' + e.id, date: e.level === 'monthly' ? e.month + '-01' : e.date, category: e.category, amount: +e.amount, note: (e.memo || '') + ' (기록)', user: true }));
  raw.scheduled = (raw.scheduled || []).filter((s) => s.date > asOf);
  raw.planned = (st.duePlans || []).filter((p) => p.date > asOf && !st.duePaid[p.key]);
  return raw;
}
function normalize(raw) {
  RAW = raw;
  const asOf = pd(raw.meta.asOf), asOfKey = ym(asOf), isEnd = ymd(asOf) === ymd(monthEnd(asOf));
  const months = (raw.months || []).slice().sort((a, b) => a.month.localeCompare(b.month)).filter((m) => m.month <= asOfKey || sum(m.expense) || sum(m.income)).map((m) => {
    const inc = { grant: 0, other: 0, financing: 0 };
    for (const [k, v] of Object.entries(m.income || {})) inc[incType(k)] += +v || 0;
    const partial = m.month === asOfKey ? !isEnd : m.month > asOfKey;
    return { ...m, partial, future: m.month > asOfKey, gross: sum(m.expense), grant: inc.grant, other: inc.other, fin: inc.financing, income: inc.grant + inc.other + inc.financing };
  });
  let bal = +raw.opening || 0;
  months.forEach((m) => { m.open = bal; bal = bal - m.gross + m.income; m.close = bal; m.net = m.gross - m.income; });
  const accounts = raw.accounts || [];
  const accTotal = raw.cashTotal ?? (accounts.length ? accounts.reduce((a, x) => a + (+x.balance || 0), 0) : bal);
  const plan = (raw.plan || []).map((p) => {
    const inc = { grant: 0, other: 0, financing: 0 };
    for (const [k, v] of Object.entries(p.income || {})) inc[incType(k)] += +v || 0;
    return { ...p, gross: sum(p.expense), grant: inc.grant, other: inc.other + inc.financing };
  });
  const finMonths = new Set((raw.financingEvents || []).map((e) => e.date.slice(0, 7)));
  months.forEach((m) => { if (m.fin >= 1e7) finMonths.add(m.month); });
  return { asOf, asOfKey, months, accounts, accTotal, flowBal: bal, plan, finMonths, oneoffs: raw.oneoffs || [], dues: raw.dues || [],
    scheduled: raw.scheduled || [], planned: raw.planned || [], warnings: raw.warnings || [] };
}
function refresh() { if (!BASE) return; D = normalize(buildEffective(BASE, ST)); syncControls(); render(); renderRecords(); updateStoreInfo(); }

/* ---------------- 예측 모델 ---------------- */
function histRows() {
  const off = new Set(S.oneoffOff.map(String));
  return D.months.filter((m) => !m.partial).map((m, idx) => {
    const one = S.exOne ? D.oneoffs.filter((o) => o.date.slice(0, 7) === m.month && !off.has(String(o.id))).reduce((a, o) => a + o.amount, 0) : 0;
    const exp = m.gross - one, other = m.other + (S.exFin ? 0 : m.fin);
    return { month: m.month, idx, exp, grant: m.grant, other, net: exp - m.grant - other, one, fin: m.fin };
  });
}
function linfit(ys) {
  const n = ys.length; if (n < 2) return { a: ys[0] || 0, b: 0 };
  const xm = (n - 1) / 2, ymn = avg(ys); let sxy = 0, sxx = 0;
  ys.forEach((y, x) => { sxy += (x - xm) * (y - ymn); sxx += (x - xm) ** 2; });
  const b = sxx ? sxy / sxx : 0; return { a: ymn - b * xm, b };
}
function cashStart() {
  const restricted = D.accounts.filter((a) => a.flag === 'restricted' || (S.unconf && a.flag === 'unconfirmed')).reduce((s, a) => s + (+a.balance || 0), 0);
  return { total: D.accTotal, restricted, free: D.accTotal - restricted };
}
function forecast() {
  const H = histRows();
  const win = H.slice(-S.nWin), tw = H.slice(-Math.max(3, S.tWin));
  const base = { E: avg(win.map((r) => r.exp)), G: avg(win.map((r) => r.grant)), O: avg(win.map((r) => r.other)) };
  const fits = { E: linfit(tw.map((r) => r.exp)), G: linfit(tw.map((r) => r.grant)), O: linfit(tw.map((r) => r.other)) };
  const cash = cashStart(); const start = S.basis === 'free' ? cash.free : cash.total;
  const T = (+S.minCash || 0) * 1e4, fund = (+S.fundAmt || 0) * 1e4;
  const asOf = D.asOf, m0 = new Date(asOf.getFullYear(), asOf.getMonth(), 1);
  const lastPlan = D.plan[D.plan.length - 1];
  const raw = [];
  for (let i = 0; i < S.horizon; i++) {
    const md = addM(m0, i), key = ym(md), end = monthEnd(md);
    const frac = i === 0 ? (end.getDate() - asOf.getDate()) / end.getDate() : 1;
    let E, G, O, tag = '';
    if (S.method === 'a') ({ E, G, O } = base);
    else if (S.method === 'b') { E = base.E; G = 0; O = 0; }
    else if (S.method === 'c') { const x = tw.length + i; E = Math.max(0, fits.E.a + fits.E.b * x); G = Math.max(0, fits.G.a + fits.G.b * x); O = Math.max(0, fits.O.a + fits.O.b * x); }
    else { const p = D.plan.find((q) => q.month === key) || lastPlan; if (!p) { E = G = O = 0; tag = '계획없음'; } else { E = p.gross; G = p.grant; O = p.other; if (p.month !== key) tag = '반복'; } }
    const P = D.planned.filter((p) => p.date.slice(0, 7) === key).reduce((a, p) => a + (+p.amount || 0), 0);
    raw.push({ key, md, end, frac, E, G, O, P, tag });
  }
  let bal = start, t = 0, prevDate = asOf, prevBal = start, depl = null, prevLo = start, prevHi = start;
  const rows = [], sig = sigma(), crossings = { lo: null, hi: null };
  raw.forEach((r, i) => {
    const j = i - S.grantDelay; const Gs = (j >= 0 ? raw[j].G : 0) * S.grantPct / 100;
    const E = r.E * (1 + S.expPct / 100), net = (E - Gs - r.O) * r.frac + r.P;
    const preFund = bal - net, f = (S.fundMonth === i ? fund : 0);
    t += r.frac; const band = sig.value * Math.sqrt(t);
    if (!depl) depl = cross(prevDate, prevBal, r.end, preFund, T);
    const lo = preFund - band, hi = preFund + band;
    if (!crossings.lo) crossings.lo = cross(prevDate, prevLo, r.end, lo, T);
    if (!crossings.hi) crossings.hi = cross(prevDate, prevHi, r.end, hi, T);
    bal = preFund + f;
    rows.push({ ...r, E, Gs, net, bal, lo: lo + f, hi: hi + f, fund: f, t });
    prevDate = r.end; prevBal = bal; prevLo = lo + f; prevHi = hi + f;
  });
  if (start < T) depl = asOf;
  const monthlyNet = rows.length > 1 ? rows[1].net : (rows[0] ? rows[0].net / (rows[0].frac || 1) : 0);
  const runway = depl ? (depl - asOf) / DAY / MLEN : null;
  const simple = monthlyNet > 0 ? (start - T) / monthlyNet : null;
  return { H, win, base, rows, start, cash, T, depl, runway, simple, monthlyNet, sig, crossings };
}
function cross(d0, b0, d1, b1, T) { if (b0 >= T && b1 < T) { const f = (b0 - T) / (b0 - b1); return new Date(d0.getTime() + f * (d1 - d0)); } return null; }
function sigma() {
  const H = histRows();
  const excl = H.filter((r) => D.finMonths.has(r.month)).map((r) => r.month);
  const vals = H.filter((r) => !D.finMonths.has(r.month)).map((r) => r.net);
  return { value: std(vals), excl, n: vals.length };
}

/* ---------------- 대시보드 렌더링 ---------------- */
function render() {
  if (!D) return;
  const F = forecast();
  renderKpis(F); renderBal(F); renderExp(); renderIE(); renderAcc(F); renderDues(); renderMonthTable(); renderFcTable(F); renderWarn(F); renderUserNote();
}
function kpi(t, v, s, cls = '') { return `<div class="kpi ${cls}"><div class="t">${t}</div><div class="v">${v}</div><div class="s">${s}</div></div>`; }
function renderKpis(F) {
  const c = F.cash, n = F.win.length, wl = n ? `${mLabel(F.win[0].month)}~${mLabel(F.win[n - 1].month)}` : '';
  const net = avg(F.win.map((r) => r.net)), gross = avg(F.win.map((r) => r.exp));
  const methodName = { a: `(a) 최근 ${S.nWin}개월 평균`, b: '(b) 수입 0 가정', c: '(c) 선형 추세', d: '(d) 파일 계획' }[S.method];
  const rw = F.runway, lo = F.crossings.lo, hi = F.crossings.hi;
  const range = F.sig.value ? `±1σ 범위: ${lo ? ymd(lo) : '기간 내 없음'} ~ ${hi ? ymd(hi) : '기간 내 없음'}` : '';
  const anc = RAW.anchor || {};
  const src = anc.fromCheck ? `잔액확인 ${anc.date}${anc.after ? ` + 이후 기록 ${anc.after}건` : ''}` : `기초 ${anc.date || ymd(D.asOf)} 계좌 합계${anc.after ? ` + 기록 ${anc.after}건` : ''}`;
  $('#kpis').innerHTML = [
    kpi('현재 총현금', fmt(c.total), `${won(c.total)}<br>기준일 ${ymd(D.asOf)} · ${src}`),
    kpi('가용현금', fmt(c.free), `${won(c.free)}<br>제한성 ${fmt(c.restricted)} 제외${S.unconf ? ' (미확인 계좌 포함)' : ''}`),
    kpi(`최근 ${n}개월 Net burn`, fmt(net), `${won(net)}/월<br>${wl} 평균 (지출−수입${S.exFin ? ', 차입 제외' : ''}${S.exOne ? ', 일회성 제외' : ''})`),
    kpi(`최근 ${n}개월 Gross burn`, fmt(gross), `${won(gross)}/월<br>수입 제외 순수 지출 평균`),
    kpi('런웨이', rw != null ? rw.toFixed(1) + '개월' : `${S.horizon}개월+`, `${methodName} · ${S.basis === 'free' ? '가용현금' : '총현금'} 기준<br>단순식 (현금−최소유지)÷월 Net burn = ${F.simple != null ? F.simple.toFixed(2) + '개월' : '순유입'}`, rw != null && rw < 3 ? 'warn' : rw != null && rw < 6 ? 'caution' : ''),
    kpi('예상 소진일', F.depl ? dLabel(F.depl) : '전망기간 내 없음', `${F.T ? '최소유지현금 ' + fmt(F.T) + ' 미만 기준' : '잔액 0 미만 기준'} (월 내 일자 보간)<br>${range}`, F.depl ? 'warn' : ''),
  ].join('');
}
function renderUserNote() {
  const um = D.months.filter((m) => m.user);
  const el = $('#userNote');
  if (!um.length && !D.planned.length && !(RAW.anchor || {}).fromCheck) { el.classList.add('hidden'); return; }
  el.classList.remove('hidden');
  el.innerHTML = `✎ 사용자 기록 반영 중: ${um.map((m) => `${mLabel(m.month)}(${m.user}건)`).join(', ') || '월 기록 없음'}` +
    `${(RAW.anchor || {}).fromCheck ? ` · 출발 잔액 = ${RAW.anchor.date} 잔액확인` : ''}${D.planned.length ? ` · 계획 출금 ${D.planned.length}건 ${fmt(D.planned.reduce((a, p) => a + +p.amount, 0))}` : ''}` +
    ` · 기초 데이터 기준일 ${RAW.meta.baseAsOf}`;
}
function baseOpts(extra = {}) {
  return Object.assign({ responsive: true, maintainAspectRatio: false, animation: false, interaction: { mode: 'index', intersect: false },
    plugins: { legend: { labels: { boxWidth: 12, font: { size: 11 } } }, tooltip: { callbacks: { label: (c) => `${c.dataset.label}: ${c.raw == null ? '-' : fmt(c.raw)}` } } },
    scales: { y: { ticks: { callback: fmtAxis }, title: { display: true, text: unitName() } } } }, extra);
}
function mk(id, cfg) { if (charts[id]) charts[id].destroy(); charts[id] = new Chart(document.getElementById(id), cfg); }
const mTag = (m) => (m.user ? '✎' : '');
function renderBal(F) {
  const full = D.months.filter((m) => !m.partial);
  const labels = [`${mLabel(D.months[0].month)} 기초`, ...full.map((m) => mLabel(m.month) + '말' + mTag(m)), `${ymd(D.asOf).slice(5).replace('-', '/')} 기준일`, ...F.rows.map((r) => mLabel(r.key) + '말')];
  const nA = full.length + 1;
  const act = [RAW.opening, ...full.map((m) => m.close), D.accTotal, ...F.rows.map(() => null)];
  const pad = Array(nA).fill(null);
  const fc = [...pad, F.start, ...F.rows.map((r) => r.bal)];
  const lo = [...pad, F.start, ...F.rows.map((r) => r.lo)], hi = [...pad, F.start, ...F.rows.map((r) => r.hi)];
  mk('balChart', { type: 'line', data: { labels, datasets: [
    { label: '실적 잔액(총현금)', data: act, borderColor: '#1F3864', backgroundColor: '#1F3864', borderWidth: 2.5, pointRadius: 3 },
    { label: `전망 (${S.basis === 'free' ? '가용현금' : '총현금'})`, data: fc, borderColor: '#C55A11', backgroundColor: '#C55A11', borderDash: [6, 4], borderWidth: 2, pointRadius: 2 },
    { label: '−1σ', data: lo, borderColor: 'rgba(197,90,17,.25)', pointRadius: 0, borderWidth: 1, fill: false },
    { label: '+1σ 밴드', data: hi, borderColor: 'rgba(197,90,17,.25)', backgroundColor: 'rgba(197,90,17,.12)', pointRadius: 0, borderWidth: 1, fill: '-1' },
    { label: F.T ? '최소유지현금' : '0원', data: labels.map(() => F.T), borderColor: '#C00000', borderWidth: 1.2, pointRadius: 0, borderDash: F.T ? [3, 3] : [] },
  ] }, options: baseOpts() });
  $('#bandNote').textContent = F.sig.value ? `밴드: ±1σ·√t, σ=${fmt(F.sig.value)}/월 (${F.sig.n}개월${F.sig.excl.length ? ', 이상치 제외: ' + F.sig.excl.map((m) => (+m.slice(5)) + '월(차입 입금)').join(', ') : ''})` : '';
  const pl = D.plan.length ? `파일 계획: ${D.plan.map((p) => mLabel(p.month)).join(', ')}` : '파일 계획 없음';
  const P = F.rows.reduce((a, r) => a + r.P, 0);
  $('#forecastNote').innerHTML = `출발점: 기준일 ${ymd(D.asOf)} ${S.basis === 'free' ? '가용현금' : '총현금'} ${won(F.start)}. 기준일이 속한 달은 남은 ${Math.round(F.rows[0]?.frac * monthEnd(D.asOf).getDate())}일분(${Math.round((F.rows[0]?.frac || 0) * 100)}%)만 반영. ` +
    `월 기준값(${{ a: '평균', b: '평균 지출', c: '추세', d: '계획' }[S.method]}): 지출 ${fmt(F.rows[1]?.E ?? F.rows[0]?.E)}, 지원금 ${fmt(F.rows[1]?.Gs ?? 0)}, 기타수입 ${fmt(F.rows[1]?.O ?? 0)}.${P ? ` 납기 계획 출금 ${fmt(P)} 추가 반영.` : ''} ${S.method === 'd' ? pl : ''} ✎ = 사용자 기록 포함 월.`;
}
const PAL = ['#1F3864', '#2F5597', '#5B9BD5', '#9DC3E6', '#C55A11', '#F4B183', '#548235', '#A9D18E', '#7F6000', '#FFD966', '#7030A0', '#BFBFBF'];
const mLab2 = (m) => mLabel(m.month) + (m.partial ? `(~${+m.lastDay.slice(8)}일)` : '') + mTag(m);
function renderExp() {
  const tot = {}; D.months.forEach((m) => Object.entries(m.expense).forEach(([k, v]) => tot[k] = (tot[k] || 0) + v));
  const top = Object.entries(tot).sort((a, b) => b[1] - a[1]).slice(0, 10).map((x) => x[0]);
  const ds = top.map((k, i) => ({ label: k, data: D.months.map((m) => m.expense[k] || 0), backgroundColor: PAL[i], stack: 's' }));
  ds.push({ label: '그 외 항목', data: D.months.map((m) => Object.entries(m.expense).filter(([k]) => !top.includes(k)).reduce((a, [, v]) => a + v, 0)), backgroundColor: PAL[11], stack: 's' });
  mk('expChart', { type: 'bar', data: { labels: D.months.map(mLab2), datasets: ds }, options: baseOpts({ scales: { x: { stacked: true }, y: { stacked: true, ticks: { callback: fmtAxis }, title: { display: true, text: unitName() } } },
    plugins: { legend: { position: 'bottom', labels: { boxWidth: 10, font: { size: 10.5 } } }, tooltip: { callbacks: { label: (c) => `${c.dataset.label}: ${fmt(c.raw)}` } } } }) });
}
function renderIE() {
  mk('ieChart', { type: 'bar', data: { labels: D.months.map(mLab2), datasets: [
    { label: '지출', data: D.months.map((m) => m.gross), backgroundColor: '#C55A11', stack: 'e' },
    { label: '수입: 지원금', data: D.months.map((m) => m.grant), backgroundColor: '#548235', stack: 'i' },
    { label: '수입: 기타', data: D.months.map((m) => m.other), backgroundColor: '#A9D18E', stack: 'i' },
    { label: '수입: 차입', data: D.months.map((m) => m.fin), backgroundColor: '#9DC3E6', stack: 'i' },
    { label: 'Net burn (지출−수입)', type: 'line', data: D.months.map((m) => m.net), borderColor: '#1F3864', backgroundColor: '#1F3864', borderWidth: 2, pointRadius: 3 },
  ] }, options: baseOpts({ scales: { x: { stacked: true }, y: { stacked: true, ticks: { callback: fmtAxis }, title: { display: true, text: unitName() } } } }) });
  const fe = RAW.financingEvents || [];
  $('#ieNote').textContent = fe.length ? `차입 입금 포함 월: ${fe.map((e) => `${e.date} ${fmt(e.amount)}`).join(', ')} (하늘색 막대)` : '';
}
const FLAG = { free: '자유', restricted: '제한성', unconfirmed: '용도 미확인', deposit: '예치금', unassigned: '미지정' };
function renderAcc(F) {
  const acc = D.accounts.slice().sort((a, b) => b.balance - a.balance);
  $('#accDate').textContent = `${ymd(D.asOf)} 기준`;
  const col = { free: '#548235', restricted: '#C00000', unconfirmed: '#BF9000', deposit: '#2F5597', unassigned: '#7F7F7F' };
  const pos = acc.filter((a) => a.balance > 0);
  mk('accChart', { type: 'bar', data: { labels: pos.map((a) => a.name.split(' ')[0]), datasets: [{ label: '잔액', data: pos.map((a) => a.balance), backgroundColor: pos.map((a) => col[a.flag] || '#888') }] },
    options: baseOpts({ indexAxis: 'y', plugins: { legend: { display: false }, tooltip: { callbacks: { label: (c) => `${fmt(c.raw)} (${won(c.raw)})` } } },
      scales: { x: { type: 'logarithmic', ticks: { callback: (v) => [1e3, 1e4, 1e5, 1e6, 1e7, 1e8, 1e9].includes(v) ? fmtAxis(v) : '' }, title: { display: true, text: unitName() + ' (로그축, 양수만)' } } } }) });
  $('#accTable').innerHTML = `<table><tr><th>계좌</th><th>구분</th><th>잔액</th></tr>${acc.map((a) => `<tr><td>${esc(a.name)}${a.touched ? '<span class="ubadge">기록</span>' : ''}</td><td><span class="tag ${a.flag}">${FLAG[a.flag] || a.flag}</span></td><td>${won(a.balance)}</td></tr>`).join('')}
    <tr><th>합계</th><th></th><th>${won(F.cash.total)}</th></tr></table>`;
}
function dueDates(rule, from, to) {
  const out = [], r = rule.replace(/\s+/g, '');
  for (let d = new Date(from.getFullYear(), from.getMonth(), 1); d <= to; d = addM(d, 1)) {
    const last = monthEnd(d).getDate(); let day = null, m;
    if ((m = r.match(/분기말차월(\d+)일/))) { if ([0, 3, 6, 9].includes(d.getMonth())) day = +m[1]; }
    else if ((m = r.match(/매년(\d+)월/))) { if (d.getMonth() + 1 === +m[1]) day = 'month'; }
    else if (/말일/.test(r)) day = last;
    else if ((m = r.match(/매월(\d+)일/))) day = Math.min(+m[1], last);
    if (day === 'month') { const dd = new Date(d.getFullYear(), d.getMonth(), 1); if (monthEnd(dd) >= from && dd <= to) out.push({ date: dd, monthOnly: true }); }
    else if (day) { const dd = new Date(d.getFullYear(), d.getMonth(), day); if (dd >= from && dd <= to) out.push({ date: dd }); }
  }
  return out;
}
const dueKey = (item, date) => `${item}|${ymd(date)}`;
function guessCat(item) {
  const R = [[/임차료/, '임차료'], [/4대보험|보험/, '보험료'], [/원천세/, '원천세'], [/통신/, '통신비'], [/세무대행|수수료|네이버/, '지급수수료'],
    [/카드/, '신용카드 결제'], [/관리비/, '서비스요금']];
  const hit = R.find(([re]) => re.test(item)); const cats = allCats().expense;
  return hit && cats.includes(hit[1]) ? hit[1] : '';
}
let dueOpen = null;
function renderDues() {
  const base = document.querySelector('input[name=dueBase]:checked').value;
  const t0 = new Date(); const from = base === 'today' ? new Date(t0.getFullYear(), t0.getMonth(), t0.getDate()) : new Date(D.asOf.getTime() + DAY);
  const to = new Date(from.getTime() + (+$('#dueDays').value) * DAY);
  $('#dueRange').textContent = `${ymd(from)} ~ ${ymd(to)}`;
  const items = [];
  D.dues.forEach((x) => dueDates(x.rule, from, to).forEach((o) => items.push({ ...o, item: x.item, rule: x.rule, group: x.group, key: dueKey(x.item, o.date) })));
  D.scheduled.filter((s) => pd(s.date) >= from && pd(s.date) <= to).forEach((s) => items.push({ date: pd(s.date), item: `${s.category} (파일 입력 예정액)`, rule: s.type === 'income' ? '예정 입금' : '예정 출금', group: '일별 열 입력', amount: s.amount, key: dueKey(s.category + '(예정)', pd(s.date)), cat: s.category }));
  items.sort((a, b) => a.date - b.date);
  const plans = Object.fromEntries((ST.duePlans || []).map((p) => [p.key, p]));
  if (dueOpen && !items.some((i) => i.key === dueOpen)) dueOpen = null;
  const row = (i, n) => {
    const wk = !i.monthOnly && (i.date.getDay() === 0 || i.date.getDay() === 6);
    const paid = ST.duePaid[i.key], pl = plans[i.key], open = dueOpen === i.key;
    const dt = i.monthOnly ? `${i.date.getFullYear()}.${String(i.date.getMonth() + 1).padStart(2, '0')} 중` : dLabel(i.date);
    const amt = i.amount ? won(i.amount) : pl ? won(pl.amount) : '<span class="hint">금액 없음</span>';
    const st = paid ? '<span class="ubadge ok">납부 완료</span>' : pl ? '<span class="ubadge">계획 반영됨</span>' : '';
    let h = `<tr class="duerow ${paid ? 'paid' : ''} ${open ? 'open' : ''}" data-key="${esc(i.key)}">
      <td class="c-d">${dt}${wk ? ' <span class="wk" title="토·일요일입니다. 실제 출금은 다음 영업일일 수 있으니 확인하세요.">휴일→익영업일</span>' : ''}</td>
      <td class="c-i">${esc(i.item)}</td><td class="c-r">${esc(i.rule)}</td><td class="c-a">${amt}</td>
      <td class="c-x no-print">${st}<button type="button" class="btn small dueopen" data-open="${n}" aria-expanded="${open}" title="금액 입력 · 계획 반영 · 납부 완료">처리 ${open ? '▴' : '▾'}</button></td></tr>`;
    if (open) {
      h += `<tr class="duepanel no-print"><td colspan="5"><div class="dpbox">
        <b>${esc(i.item)}</b> <span class="hint">${dt}</span>
        ${paid ? `<span class="hint">이 납기는 지출 기록으로 처리되었습니다.</span> <button type="button" class="btn small" data-undo="${n}">납부 완료 취소</button>`
        : `<label>금액(원) <input type="number" class="dueamt" data-n="${n}" inputmode="numeric" placeholder="${i.amount ? '' : '예: 5000000'}" value="${i.amount || (pl ? pl.amount : '')}"${i.amount ? ' disabled' : ''}></label>
           ${i.amount ? '<span class="hint">파일 입력 예정액(이미 표시용)</span>' : `<button type="button" class="btn small" data-plan="${n}" title="예정일에 출금될 금액으로 전망에 반영">계획 반영</button>`}
           <button type="button" class="btn small primary" data-pay="${n}" title="실제 납부 — 지출 기록 생성">납부 완료</button>
           ${pl ? `<button type="button" class="btn small" data-unplan="${n}">계획 삭제</button>` : ''}`}
        <button type="button" class="btn small" data-close="1">닫기</button></div></td></tr>`;
    }
    return h;
  };
  $('#dueList').innerHTML = items.length ? `<table class="duetable"><thead><tr><th class="c-d">일자</th><th class="c-i">항목</th><th class="c-r">규칙</th><th class="c-a">금액</th><th class="c-x no-print">처리</th></tr></thead><tbody>${items.map(row).join('')}</tbody></table>`
    : '<p class="hint">해당 기간 일정 없음</p>';
  const L = $('#dueList'), it = (b, k) => items[+b.dataset[k]];
  L.querySelectorAll('[data-open]').forEach((b) => b.addEventListener('click', () => { const k = it(b, 'open').key; dueOpen = dueOpen === k ? null : k; renderDues();
    const inp = $('#dueList .dueamt:not([disabled])'); if (inp) inp.focus(); }));
  L.querySelectorAll('[data-close]').forEach((b) => b.addEventListener('click', () => { dueOpen = null; renderDues(); }));
  L.querySelectorAll('[data-plan]').forEach((b) => b.addEventListener('click', () => {
    const i = it(b, 'plan'), v = +L.querySelector(`.dueamt[data-n="${b.dataset.plan}"]`).value;
    if (!(v > 0)) { toast('금액을 입력하세요'); return; }
    ST.duePlans = (ST.duePlans || []).filter((p) => p.key !== i.key);
    ST.duePlans.push({ key: i.key, item: i.item, date: ymd(i.date), amount: v, category: guessCat(i.item), createdAt: nowStr() });
    dueOpen = null; saveStore(); refresh(); toast('계획 출금으로 반영했습니다');
  }));
  L.querySelectorAll('[data-unplan]').forEach((b) => b.addEventListener('click', () => { const k = it(b, 'unplan').key; ST.duePlans = ST.duePlans.filter((p) => p.key !== k); saveStore(); refresh(); }));
  L.querySelectorAll('[data-undo]').forEach((b) => b.addEventListener('click', () => {
    const k = it(b, 'undo').key, id = ST.duePaid[k]; delete ST.duePaid[k];
    if (id && ST.entries.some((e) => e.id === id) && confirm('납부 완료로 만든 지출 기록도 삭제할까요?')) ST.entries = ST.entries.filter((e) => e.id !== id);
    dueOpen = null; saveStore(); refresh();
  }));
  L.querySelectorAll('[data-pay]').forEach((b) => b.addEventListener('click', () => {
    const i = it(b, 'pay'), inp = L.querySelector(`.dueamt[data-n="${b.dataset.pay}"]`);
    const amt = i.amount || (inp && +inp.value) || (plans[i.key] && plans[i.key].amount) || '';
    dueOpen = null; renderDues();
    openEntry({ level: 'daily', kind: 'expense', date: ymd(i.date), category: i.cat || guessCat(i.item), amount: amt, memo: `${i.item} 납부`, paidKey: i.key });
  }));
}
function renderMonthTable() {
  const rows = D.months.map((m) => `<tr class="${m.partial ? 'partial' : ''} ${m.user ? 'usr' : ''}"><td>${m.month}${m.partial ? ` (~${m.lastDay.slice(5)})` : ''}${m.user ? ` <span class="ubadge" title="사용자 기록 ${m.user}건 포함">✎${m.user}</span>` : ''}</td><td>${won(m.open)}</td><td>${won(m.gross)}</td><td>${won(m.grant)}</td><td>${won(m.other)}</td><td>${won(m.fin)}</td><td>${won(m.net)}</td><td>${won(m.close)}</td><td>${m.closeFile == null ? '-' : m.user ? '<span class="hint">기록 반영</span>' : Math.abs(m.closeFile - m.close) < 1 ? '✔ 일치' : '✖ ' + won(m.closeFile)}</td></tr>`).join('');
  const full = D.months.filter((m) => !m.partial);
  const tot = (k) => full.reduce((a, m) => a + m[k], 0);
  $('#monthTable').innerHTML = `<table><tr><th>월</th><th>기초잔액</th><th>지출(Gross)</th><th>지원금</th><th>기타수입</th><th>차입</th><th>Net burn</th><th>월말잔액</th><th>계좌 마감행 대조</th></tr>${rows}
  <tr><th>마감월 합계</th><th></th><th>${won(tot('gross'))}</th><th>${won(tot('grant'))}</th><th>${won(tot('other'))}</th><th>${won(tot('fin'))}</th><th>${won(tot('net'))}</th><th></th><th></th></tr></table>`;
}
function renderFcTable(F) {
  $('#fcTable').innerHTML = `<table><tr><th>월</th><th>반영 비율</th><th>지출</th><th>지원금</th><th>기타수입</th><th>계획 출금(납기)</th><th>추가 조달</th><th>Net burn</th><th>월말잔액</th><th>−1σ</th><th>+1σ</th></tr>${F.rows.map((r) =>
    `<tr class="${r.bal < F.T ? 'neg' : ''} ${r.tag ? 'repeat' : ''}"><td>${r.key}${r.tag ? ` (${r.tag})` : ''}</td><td>${Math.round(r.frac * 100)}%</td><td>${won(r.E * r.frac)}</td><td>${won(r.Gs * r.frac)}</td><td>${won(r.O * r.frac)}</td><td>${r.P ? won(r.P) : '-'}</td><td>${r.fund ? won(r.fund) : '-'}</td><td>${won(r.net)}</td><td>${won(r.bal)}</td><td>${won(r.lo)}</td><td>${won(r.hi)}</td></tr>`).join('')}</table>`;
}
function renderWarn(F) {
  const w = [...D.warnings];
  const userMonths = D.months.some((m) => m.user);
  if (!userMonths && !(RAW.anchor || {}).fromCheck && Math.abs(D.flowBal - D.accTotal) > 1) w.push(`흐름 누적 잔액(${won(D.flowBal)})과 기준일 계좌 합계(${won(D.accTotal)})가 다릅니다.`);
  if (RAW.checkDiff && Math.abs(RAW.checkDiff.diff) >= 1) w.push(`잔액확인(${RAW.checkDiff.date})이 기초 잔액+기록 합계보다 ${won(RAW.checkDiff.diff)} ${RAW.checkDiff.diff > 0 ? '많습니다' : '적습니다'} — 누락된 기록이 있을 수 있습니다(차이는 '계좌 미지정'으로 표시).`);
  if (D.accounts.some((a) => a.flag === 'unconfirmed')) w.push('용도 미확인 계좌가 있습니다 — 전용계좌 여부 확인 필요 (설정에서 제한성 간주 가능).');
  if (D.finMonths.size) w.push(`차입 입금: ${[...D.finMonths].join(', ')} — burn 계산 시 제외 옵션, σ 계산에서는 이상치로 제외.`);
  if (!D.planned.length) w.push('부가세·원천세(반기납) 등 금액 정보가 없는 납기는 납기 목록에서 금액을 입력해야 예측에 반영됩니다.');
  $('#warnList').innerHTML = w.map((x) => `<li>${esc(x)}</li>`).join('');
}

/* ---------------- 대시보드 컨트롤 ---------------- */
const IDS = ['method', 'nWin', 'tWin', 'basis', 'unconf', 'exFin', 'grantPct', 'grantDelay', 'expPct', 'exOne', 'fundAmt', 'fundMonth', 'minCash', 'horizon'];
function syncControls() {
  const fm = $('#fundMonth'); fm.innerHTML = '';
  const m0 = new Date(D.asOf.getFullYear(), D.asOf.getMonth(), 1);
  for (let i = 0; i < S.horizon; i++) fm.add(new Option(mLabel(ym(addM(m0, i))) + '월말', i));
  const nFull = D.months.filter((m) => !m.partial).length;
  $('#nWin').max = Math.max(1, nFull); $('#tWin').max = Math.max(3, nFull);
  S.nWin = Math.min(S.nWin, nFull); S.tWin = Math.min(S.tWin, nFull);
  IDS.forEach((id) => { const el = document.getElementById(id); if (el.type === 'checkbox') el.checked = !!S[id]; else el.value = S[id]; });
  $('#unitSel').value = S.unit;
  $('#oneoffList').innerHTML = D.oneoffs.map((o) => `<label><input type="checkbox" data-oid="${o.id}" ${S.oneoffOff.includes(String(o.id)) ? '' : 'checked'}> ${o.date} ${esc(o.category)} ${fmt(o.amount)}${o.note ? ' · ' + esc(o.note) : ''}</label>`).join('') || '<span class="hint">일회성 후보 없음</span>';
  $('#oneoffList').querySelectorAll('input').forEach((el) => el.addEventListener('change', () => { S.oneoffOff = [...$('#oneoffList').querySelectorAll('input:not(:checked)')].map((e) => e.dataset.oid); saveSettings(); render(); }));
  outputs();
}
function outputs() {
  $('#nOut').textContent = S.nWin + '개월'; $('#tOut').textContent = S.tWin + '개월'; $('#gOut').textContent = S.grantPct + '%';
  $('#dOut').textContent = S.grantDelay + '개월'; $('#eOut').textContent = (S.expPct > 0 ? '+' : '') + S.expPct + '%'; $('#hOut').textContent = S.horizon + '개월';
}
function bindControls() {
  IDS.forEach((id) => { const el = document.getElementById(id);
    el.addEventListener(el.type === 'range' ? 'input' : 'change', () => {
      let v = el.type === 'checkbox' ? el.checked : el.value;
      if (['nWin', 'tWin', 'grantPct', 'grantDelay', 'expPct', 'fundMonth', 'horizon'].includes(id)) v = +v;
      S[id] = v; if (id === 'horizon') syncControls(); outputs(); saveSettings(); render(); }); });
  $('#unitSel').addEventListener('change', (e) => { S.unit = e.target.value; saveSettings(); render(); syncControls(); renderRecords(); });
  $('#btnReset').addEventListener('click', () => { S = { ...DEFAULTS, unit: S.unit }; saveSettings(); syncControls(); render(); });
  document.querySelectorAll('input[name=dueBase]').forEach((el) => el.addEventListener('change', renderDues));
  $('#dueDays').addEventListener('change', renderDues);
}

/* ---------------- 기록 탭 ---------------- */
function allCats() {
  const ex = new Set(), inc = new Set(['연구지원금', '차입', '기타수입']);
  (BASE?.months || []).concat(BASE?.plan || []).forEach((m) => { Object.keys(m.expense || {}).forEach((k) => ex.add(k)); Object.keys(m.income || {}).forEach((k) => inc.add(k)); });
  ST.entries.forEach((e) => { if (e.kind === 'expense') ex.add(e.category); if (e.kind === 'income') inc.add(e.category); });
  return { expense: [...ex].filter(Boolean), income: [...inc].filter(Boolean) };
}
const accNames = () => (BASE?.accounts || []).map((a) => a.name);
function effLabel(e) {
  if (e.kind === 'balance') { const lc = RAW?.anchor; return e.account ? '계좌 잔액 기준' : (e.date <= BASE.meta.asOf ? '<span class="hint">기초 기준일 이전 — 미반영</span>' : lc && lc.fromCheck && lc.date === e.date ? '<b>전망 출발점</b>' : '이전 잔액확인'); }
  if (e.kind === 'transfer') return '계좌 간 이동(총액 영향 없음)';
  if (isCovered(e, BASE)) return e.mode === 'replace' ? '<span class="ubadge warn">기초값 대체</span>' : '<span class="ubadge">기초값에 추가</span>';
  return e.level === 'monthly' ? '월 합계(기준일 이후)' : '기준일 이후 추가';
}
function renderRecords() {
  if (!BASE) return;
  const f = $('#recFilter'), cur = f.value;
  const months = [...new Set(ST.entries.map(entryMonth).filter(Boolean))].sort().reverse();
  f.innerHTML = '<option value="">전체</option>' + months.map((m) => `<option value="${m}">${m}</option>`).join('');
  f.value = months.includes(cur) ? cur : '';
  const list = ST.entries.filter((e) => !f.value || entryMonth(e) === f.value)
    .sort((a, b) => (b.date || b.month + '-99').localeCompare(a.date || a.month + '-99') || (b.updatedAt || '').localeCompare(a.updatedAt || ''));
  const ex = list.filter((e) => e.kind === 'expense').reduce((a, e) => a + +e.amount, 0), inc = list.filter((e) => e.kind === 'income').reduce((a, e) => a + +e.amount, 0);
  $('#recSummary').textContent = `${list.length}건 · 지출 ${won(ex)} · 수입 ${won(inc)}`;
  $('#recTable').innerHTML = list.length ? `<table class="rec"><tr><th>날짜/월</th><th>구분</th><th>항목</th><th>금액</th><th>계좌</th><th>일회성</th><th>반영</th><th>메모</th><th class="no-print"></th></tr>${list.map((e) =>
    `<tr class="k-${e.kind}"><td class="c-date">${e.level === 'monthly' ? `${e.month} <span class="ubadge">월합계</span>` : e.date}</td><td><span class="kind ${e.kind}">${KIND[e.kind]}</span></td><td class="c-cat">${esc(e.category || '')}</td><td class="num c-amt">${won(e.amount)}</td>
     <td class="c-acc" data-l="계좌">${esc(e.account || '')}${e.toAccount ? ' → ' + esc(e.toAccount) : ''}</td><td data-l="일회성">${e.oneoff ? '✔' : ''}</td><td class="c-eff">${effLabel(e)}</td><td class="c-memo" data-l="메모">${esc(e.memo || '')}</td>
     <td class="no-print nowrap c-act"><button class="btn small" data-edit="${e.id}">수정</button> <button class="btn small danger" data-del="${e.id}">삭제</button></td></tr>`).join('')}</table>`
    : '<p class="hint">아직 기록이 없습니다. 위 버튼으로 지출·수입·잔액확인을 입력하세요.</p>';
  $('#recTable').querySelectorAll('[data-edit]').forEach((b) => b.addEventListener('click', () => openEntry(ST.entries.find((e) => e.id === b.dataset.edit))));
  $('#recTable').querySelectorAll('[data-del]').forEach((b) => b.addEventListener('click', async () => {
    const e = ST.entries.find((x) => x.id === b.dataset.del);
    const r = await ask('기록 삭제', `${e.date || e.month} ${KIND[e.kind]} ${esc(e.category || '')} ${won(e.amount)} 기록을 삭제할까요?`, [['취소', ''], ['삭제', 'del', 'danger']]);
    if (r !== 'del') return;
    ST.entries = ST.entries.filter((x) => x.id !== e.id);
    Object.keys(ST.duePaid).forEach((k) => { if (ST.duePaid[k] === e.id) delete ST.duePaid[k]; });
    saveStore(); refresh(); toast('삭제했습니다');
  }));
  const pl = (ST.duePlans || []).slice().sort((a, b) => a.date.localeCompare(b.date));
  $('#planTable').innerHTML = pl.length ? `<table><tr><th>예정일</th><th>항목</th><th>금액</th><th>상태</th><th class="no-print"></th></tr>${pl.map((p) =>
    `<tr><td>${p.date}</td><td class="c-i">${esc(p.item)}</td><td class="num">${won(p.amount)}</td><td>${ST.duePaid[p.key] ? '납부 완료(지출 기록으로 대체)' : p.date <= ymd(D.asOf) ? '<span class="hint">기준일 경과 — 미반영</span>' : '전망 반영'}</td><td class="no-print"><button class="btn small danger" data-pdel="${esc(p.key)}">삭제</button></td></tr>`).join('')}</table>` : '<p class="hint">계획 출금 없음</p>';
  $('#planTable').querySelectorAll('[data-pdel]').forEach((b) => b.addEventListener('click', () => { ST.duePlans = ST.duePlans.filter((p) => p.key !== b.dataset.pdel); saveStore(); refresh(); }));
}
function updateStoreInfo() {
  const n = ST.entries.length;
  $('#recCount').textContent = n ? String(n) : '';
  const info = `마지막 저장 ${ST.lastSaved || '-'} · 마지막 백업 ${ST.lastExport || '없음'}`;
  $('#storeInfo').textContent = BASE ? `🔒 이 브라우저에만 저장 · ${info}` : '';
  if ($('#saveInfo')) $('#saveInfo').textContent = `기록 ${n}건 · 계획 출금 ${(ST.duePlans || []).length}건 · ${info} · 저장 키 ${STORE_KEY} (스키마 ${SCHEMA})`;
  const bb = $('#backupBanner');
  const days = ST.lastExport ? (Date.now() - pd(ST.lastExport.slice(0, 10)).getTime()) / DAY : null;
  if ((n || (ST.duePlans || []).length) && (days == null || days > 7)) {
    bb.innerHTML = `💾 ${days == null ? '아직 백업한 적이 없습니다.' : `마지막 백업 후 ${Math.floor(days)}일이 지났습니다.`} 기록은 이 브라우저에만 있으니 <button class="btn small primary" id="bbExport">전체 내보내기</button>로 백업하세요.`;
    bb.classList.remove('hidden'); $('#bbExport').addEventListener('click', exportAll);
  } else bb.classList.add('hidden');
  const ba = $('#baseBanner');
  if (BASE && BASE_ORIGIN === 'stored') {
    ba.innerHTML = `📁 업로드한 기초 데이터(기준일 ${esc(BASE.meta.asOf)}, ${esc(BASE.meta.source || '')})를 이 브라우저에 저장해 사용 중입니다. <button class="btn small" id="bbClear">업로드 데이터 삭제</button>`;
    ba.classList.remove('hidden'); $('#bbClear').addEventListener('click', clearBase);
  } else ba.classList.add('hidden');
}

/* 확인 대화상자 */
function ask(title, body, btns) {
  return new Promise((res) => {
    $('#cTitle').textContent = title; $('#cBody').innerHTML = body;
    $('#cBtns').innerHTML = btns.map(([t, v, c], i) => `<button type="button" class="btn ${c || ''}" data-i="${i}">${t}</button>`).join('');
    $('#cmodal').classList.remove('hidden');
    $('#cBtns').querySelectorAll('button').forEach((b) => b.addEventListener('click', () => { $('#cmodal').classList.add('hidden'); res(btns[+b.dataset.i][1]); }));
  });
}

/* 입력 모달 */
let editPaidKey = null;
function openEntry(e) {
  e = e || {}; editPaidKey = e.paidKey || null;
  const last = D ? ymd(new Date(D.asOf.getTime() + DAY)) : '';
  $('#fId').value = e.id || '';
  $('#fLevel').value = e.level || 'daily';
  $('#fDate').value = e.date || last;
  $('#fMonth').value = e.month || (e.date || last).slice(0, 7);
  $('#fKind').value = e.kind || 'expense';
  $('#fAmt').value = e.amount ?? '';
  $('#fOne').checked = !!e.oneoff; $('#fMemo').value = e.memo || '';
  const opts = '<option value="">(선택 안 함)</option>' + accNames().map((n) => `<option>${esc(n)}</option>`).join('');
  $('#fAcc').innerHTML = opts; $('#fAcc2').innerHTML = opts;
  $('#fAcc').value = e.account || ''; $('#fAcc2').value = e.toAccount || '';
  $('#fCat').value = e.category || '';
  $('#entryForm').dataset.mode = e.mode || '';
  $('#mTitle').textContent = e.id ? '기록 수정' : e.paidKey ? '납부 완료 기록' : '새 기록';
  formUpdate(); $('#modal').classList.remove('hidden'); setTimeout(() => $('#fAmt').focus(), 30);
}
function formUpdate() {
  const lvl = $('#fLevel').value, kind = $('#fKind').value;
  if (lvl === 'monthly' && (kind === 'balance' || kind === 'transfer')) $('#fKind').value = 'expense';
  const k = $('#fKind').value;
  $('#rowDate').classList.toggle('hidden', lvl === 'monthly'); $('#rowMonth').classList.toggle('hidden', lvl !== 'monthly');
  [...$('#fKind').options].forEach((o) => { o.disabled = lvl === 'monthly' && (o.value === 'balance' || o.value === 'transfer'); });
  $('#rowCat').classList.toggle('hidden', k === 'balance' || k === 'transfer');
  $('#rowAcc2').classList.toggle('hidden', k !== 'transfer');
  $('#rowAcc').classList.toggle('hidden', lvl === 'monthly');
  $('#rowOne').classList.toggle('hidden', k !== 'expense');
  $('#lAcc').textContent = k === 'transfer' ? '보내는 계좌' : k === 'balance' ? '계좌 (비우면 전체 합계)' : '계좌 (선택)';
  $('#lAmt').textContent = k === 'balance' ? '확인한 잔액 (원)' : '금액 (원)';
  const cats = allCats()[k === 'income' ? 'income' : 'expense'];
  $('#catList').innerHTML = cats.map((c) => `<option value="${esc(c)}">`).join('');
  $('#amtHelp').textContent = +$('#fAmt').value ? won(+$('#fAmt').value) : '';
  const hint = { expense: '', income: '지원금은 "연구지원금", 차입은 "차입"을 고르면 지원금/차입으로 분류됩니다.',
    transfer: '내 계좌 간 이동입니다. 총현금·burn에는 영향이 없고 계좌별 잔액만 바뀝니다.',
    balance: '통장에서 확인한 실제 잔액. 계좌를 비우면 "전체 합계"로 보고, 가장 최근 전체 잔액확인이 전망의 출발점이 됩니다(기준일·당월 남은 일수도 그 날짜로 이동).' }[k];
  $('#mHint').textContent = (lvl === 'monthly' ? '월 합계: 그 달 이 항목의 총액을 한 번에 입력합니다(일자별 기록 대신). 총현금에는 반영되지 않고 월별 실적·burn 평균에 반영됩니다. ' : '') + hint;
  // 이중 계산 경고
  const c = $('#conflict'); const tmp = { level: lvl, date: $('#fDate').value, month: $('#fMonth').value, kind: k };
  if (BASE && (k === 'expense' || k === 'income') && (tmp.date || tmp.month) && isCovered(tmp, BASE)) {
    const mk = lvl === 'monthly' ? tmp.month : tmp.date.slice(0, 7), cat = $('#fCat').value;
    const bm = BASE.months.find((m) => m.month === mk), bv = bm ? (bm[k] || {})[cat] : null;
    const mode = $('#entryForm').dataset.mode;
    c.innerHTML = `⚠ 이 ${lvl === 'monthly' ? '월' : '날짜'}는 기초 데이터 기준일(${BASE.meta.asOf}) 이전이라 엑셀에 이미 포함됐을 수 있습니다${cat ? ` (기초값: ${mk} ${esc(cat)} = ${bv ? won(bv) : '없음'})` : ''}. 선택하세요:
      <label><input type="radio" name="fMode" value="replace" ${mode === 'replace' ? 'checked' : ''}> 대체 — 그 달 이 항목 기초값을 내 기록 합계로 바꿈</label>
      <label><input type="radio" name="fMode" value="add" ${mode === 'add' ? 'checked' : ''}> 추가 — 기초값에 더함(엑셀에 빠진 거래)</label>
      <span class="hint">어느 쪽이든 현재 총현금(기준일 계좌 잔액)은 바뀌지 않고 월별 실적·burn만 바뀝니다.</span>`;
    c.classList.remove('hidden');
    c.querySelectorAll('input').forEach((r) => r.addEventListener('change', () => { $('#entryForm').dataset.mode = r.value; }));
  } else if (BASE && k === 'balance' && tmp.date && tmp.date <= BASE.meta.asOf) {
    c.innerHTML = `⚠ 기초 데이터 기준일(${BASE.meta.asOf}) 이전 잔액확인은 전망에 반영되지 않습니다(기초 데이터의 계좌 잔액이 우선).`; c.classList.remove('hidden');
  } else c.classList.add('hidden');
}
function saveEntry(ev) {
  ev.preventDefault();
  const lvl = $('#fLevel').value, k = $('#fKind').value, amt = Math.round(+String($('#fAmt').value).replace(/,/g, ''));
  const e = { id: $('#fId').value || uid(), level: lvl, kind: k, amount: amt, memo: $('#fMemo').value.trim() };
  if (lvl === 'monthly') { e.month = $('#fMonth').value; if (!/^\d{4}-\d{2}$/.test(e.month)) return toast('월을 입력하세요'); }
  else { e.date = $('#fDate').value; if (!/^\d{4}-\d{2}-\d{2}$/.test(e.date)) return toast('날짜를 입력하세요'); }
  if (!(k === 'balance' ? isFinite(amt) && $('#fAmt').value !== '' : amt > 0)) return toast('금액을 입력하세요');
  if (k === 'expense' || k === 'income') { e.category = $('#fCat').value.trim(); if (!e.category) return toast('항목을 선택하세요'); }
  if (lvl !== 'monthly') { e.account = $('#fAcc').value || ''; }
  if (k === 'transfer') { e.toAccount = $('#fAcc2').value; if (!e.account || !e.toAccount || e.account === e.toAccount) return toast('보내는/받는 계좌를 다르게 선택하세요'); }
  if (k === 'expense') e.oneoff = $('#fOne').checked;
  if ((k === 'expense' || k === 'income') && isCovered(e, BASE)) { e.mode = $('#entryForm').dataset.mode; if (!e.mode) return toast('대체/추가 중 하나를 선택하세요'); }
  const old = ST.entries.find((x) => x.id === e.id);
  e.createdAt = old ? old.createdAt : nowStr(); e.updatedAt = nowStr();
  ST.entries = ST.entries.filter((x) => x.id !== e.id).concat(e);
  if (editPaidKey) { ST.duePaid[editPaidKey] = e.id; }
  closeModal(); saveStore(); refresh(); toast(old ? '수정했습니다' : '저장했습니다');
}
function closeModal() { $('#modal').classList.add('hidden'); editPaidKey = null; }
function showTab(t) {
  document.querySelectorAll('#tabs .tab').forEach((b) => b.classList.toggle('active', b.dataset.tab === t));
  $('#tab-dash').classList.toggle('hidden', t !== 'dash'); $('#tab-rec').classList.toggle('hidden', t !== 'rec');
  if (t === 'dash') Object.values(charts).forEach((c) => c.resize());
}
function bindRecords() {
  document.querySelectorAll('#tabs .tab').forEach((b) => b.addEventListener('click', () => showTab(b.dataset.tab)));
  $('#btnAddDaily').addEventListener('click', () => openEntry({ level: 'daily' }));
  $('#btnAddMonthly').addEventListener('click', () => openEntry({ level: 'monthly', month: ymd(D.asOf).slice(0, 7) }));
  $('#btnAddBal').addEventListener('click', () => openEntry({ level: 'daily', kind: 'balance', date: ymd(new Date()) > BASE.meta.asOf ? ymd(new Date()) : '' }));
  ['fLevel', 'fKind', 'fDate', 'fMonth', 'fCat', 'fAmt'].forEach((id) => $('#' + id).addEventListener(id === 'fAmt' || id === 'fCat' ? 'input' : 'change', formUpdate));
  $('#entryForm').addEventListener('submit', saveEntry);
  $('#mCancel').addEventListener('click', closeModal);
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeModal(); });
  $('#recFilter').addEventListener('change', renderRecords);
  $('#btnExportAll').addEventListener('click', exportAll);
  $('#btnExportRecCsv').addEventListener('click', () => download(`runway_기록_${ymd(new Date())}.csv`, entriesToCsv(), 'text/csv;charset=utf-8'));
  $('#importInput').addEventListener('change', async (e) => { const f = e.target.files[0]; e.target.value = ''; if (f) await importFile(f); });
  $('#btnResetAll').addEventListener('click', resetAll);
}
/* ---------------- CSV / JSON 입출력 ---------------- */
const CSV_HEAD = ['record', 'date', 'group', 'name', 'amount', 'flag', 'note'];
function toCsv(raw) {
  const L = [CSV_HEAD];
  if (raw) {
    L.push(['meta', raw.meta.asOf, '', 'asOf', '', '', '데이터 기준일(YYYY-MM-DD)']);
    L.push(['opening', raw.meta.startDate || '', '', '기초잔액', raw.opening, '', '첫 달 기초 현금 합계']);
    Object.entries(raw.incomeTypes || {}).forEach(([k, v]) => L.push(['incometype', '', 'income', k, '', v, 'grant/other/financing']));
    raw.months.forEach((m) => { Object.entries(m.expense).forEach(([k, v]) => L.push(['actual', m.month, 'expense', k, v, '', ''])); Object.entries(m.income).forEach(([k, v]) => L.push(['actual', m.month, 'income', k, v, '', ''])); if (m.closeFile != null) L.push(['closecheck', m.month, '', '월말 계좌합계', m.closeFile, '', '대조용(선택)']); });
    raw.plan.forEach((p) => { Object.entries(p.expense).forEach(([k, v]) => L.push(['plan', p.month, 'expense', k, v, '', ''])); Object.entries(p.income).forEach(([k, v]) => L.push(['plan', p.month, 'income', k, v, '', ''])); });
    raw.accounts.forEach((a) => L.push(['account', raw.meta.asOf, '', a.name, a.balance, a.flag, 'free/restricted/unconfirmed/deposit']));
    raw.oneoffs.forEach((o) => L.push(['oneoff', o.date, 'expense', o.category, o.amount, '', o.note || '']));
    (raw.financingEvents || []).forEach((o) => L.push(['financing', o.date, 'income', '차입', o.amount, '', '']));
    raw.scheduled.forEach((o) => L.push(['scheduled', o.date, o.type, o.category, o.amount, '', o.note || '']));
    raw.dues.forEach((o) => L.push(['due', '', o.group, o.item, '', o.rule, '예: 매월10일 / 매월 말일 / 분기말 차월25일 / 매년9월']));
  } else {
    L.push(['meta', '2026-10-07', '', 'asOf', '', '', '데이터 기준일']);
    L.push(['opening', '2026-01-01', '', '기초잔액', '', '', '첫 달 기초 현금 합계(원)']);
    L.push(['incometype', '', 'income', '연구지원금', '', 'grant', '']); L.push(['incometype', '', 'income', '차입', '', 'financing', '']);
    L.push(['actual', '2026-01', 'expense', '급여', '', '', '월 실적(원)']); L.push(['actual', '2026-01', 'income', '연구지원금', '', '', '']);
    L.push(['plan', '2026-10', 'expense', '급여', '', '', '월 계획(원)']);
    L.push(['account', '2026-10-07', '', '계좌명', '', 'free', 'free/restricted/unconfirmed/deposit']);
    L.push(['oneoff', '2026-07-01', 'expense', '항목', '', '', '일회성 지출 후보']); L.push(['financing', '2026-06-26', 'income', '차입', '', '', '']);
    L.push(['scheduled', '2026-10-12', 'expense', '항목', '', '', '예정 출금']); L.push(['due', '', '자동이체 경비', '항목', '', '매월10일', '']);
  }
  return '\ufeff' + L.map((r) => r.map((x) => { const s = String(x ?? ''); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; }).join(',')).join('\r\n');
}
function parseCsvText(text) {
  const rows = []; let row = [], f = '', q = false;
  for (let i = 0; i < text.length; i++) { const c = text[i];
    if (q) { if (c === '"') { if (text[i + 1] === '"') { f += '"'; i++; } else q = false; } else f += c; }
    else if (c === '"') q = true; else if (c === ',') { row.push(f); f = ''; } else if (c === '\n' || c === '\r') { if (c === '\r' && text[i + 1] === '\n') i++; row.push(f); rows.push(row); row = []; f = ''; } else f += c; }
  if (f || row.length) { row.push(f); rows.push(row); }
  return rows.filter((r) => r.some((x) => x.trim() !== ''));
}
function fromCsv(text) {
  const rows = parseCsvText(text.replace(/^\ufeff/, '')); const h = rows.shift().map((x) => x.trim());
  const ix = Object.fromEntries(CSV_HEAD.map((k) => [k, h.indexOf(k)]));
  if (ix.record < 0) throw new Error('CSV 머리글에 record 열이 없습니다. 템플릿을 사용하세요.');
  const raw = { meta: { source: '업로드 CSV', generated: ymd(new Date()) }, incomeTypes: {}, opening: 0, months: [], accounts: [], plan: [], oneoffs: [], financingEvents: [], scheduled: [], dues: [], warnings: [] };
  const M = {}, P = {}, num = (s) => { const v = +String(s || '').replace(/[,\s원]/g, ''); return isNaN(v) ? 0 : v; };
  rows.forEach((r) => { const g = (k) => (ix[k] >= 0 ? (r[ix[k]] || '').trim() : '');
    const rec = g('record'), amt = num(g('amount'));
    if (rec === 'meta' && g('name') === 'asOf') raw.meta.asOf = g('date');
    else if (rec === 'opening') { raw.opening = amt; raw.meta.startDate = g('date'); }
    else if (rec === 'incometype') raw.incomeTypes[g('name')] = g('flag');
    else if (rec === 'actual' || rec === 'plan') { const T = rec === 'actual' ? M : P; const k = g('date').slice(0, 7); if (!amt) return;
      const o = T[k] = T[k] || { month: k, expense: {}, income: {} }; const grp = g('group') === 'income' ? 'income' : 'expense'; o[grp][g('name')] = (o[grp][g('name')] || 0) + amt; }
    else if (rec === 'closecheck') { const k = g('date').slice(0, 7); (M[k] = M[k] || { month: k, expense: {}, income: {} }).closeFile = amt; }
    else if (rec === 'account') raw.accounts.push({ name: g('name'), balance: amt, flag: g('flag') || 'free' });
    else if (rec === 'oneoff') raw.oneoffs.push({ date: g('date'), category: g('name'), amount: amt, note: g('note') });
    else if (rec === 'financing') raw.financingEvents.push({ date: g('date'), amount: amt });
    else if (rec === 'scheduled') raw.scheduled.push({ date: g('date'), category: g('name'), amount: amt, type: g('group') || 'expense', note: g('note') });
    else if (rec === 'due') raw.dues.push({ group: g('group'), item: g('name'), rule: g('flag') }); });
  raw.months = Object.values(M).sort((a, b) => a.month.localeCompare(b.month));
  raw.plan = Object.values(P).sort((a, b) => a.month.localeCompare(b.month));
  if (!raw.meta.asOf) { const last = raw.months[raw.months.length - 1]; raw.meta.asOf = last ? ymd(monthEnd(pd(last.month + '-01'))) : ymd(new Date()); }
  raw.months.forEach((m) => { m.lastDay = m.month === raw.meta.asOf.slice(0, 7) ? raw.meta.asOf : ymd(monthEnd(pd(m.month + '-01'))); });
  return raw;
}
function validate(raw) {
  if (!raw || !raw.meta || !Array.isArray(raw.months) || !raw.months.length) throw new Error('월별 실적(months/actual) 데이터가 없습니다.');
  raw.accounts = raw.accounts || []; raw.plan = raw.plan || []; raw.oneoffs = raw.oneoffs || []; raw.dues = raw.dues || []; raw.scheduled = raw.scheduled || []; raw.warnings = raw.warnings || [];
  if (!raw.meta.asOf) throw new Error('기준일(meta.asOf)이 없습니다.');
  return raw;
}
async function readText(file) {
  const buf = await file.arrayBuffer();
  try { return new TextDecoder('utf-8', { fatal: true }).decode(buf).replace(/^\ufeff/, ''); } catch (e) { return new TextDecoder('euc-kr').decode(buf); }
}
function download(name, content, type) { const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([content], { type })); a.download = name; document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 1000); }
const csvLine = (r) => r.map((x) => { const s = String(x ?? ''); return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; }).join(',');

/* 기록 CSV */
const REC_HEAD = ['id', 'level', 'date', 'month', 'kind', 'category', 'amount', 'account', 'toAccount', 'oneoff', 'mode', 'memo', 'createdAt', 'updatedAt', 'planKey', 'planItem', 'paidKey'];
function entriesToCsv() {
  const paidBy = {}; Object.entries(ST.duePaid).forEach(([k, id]) => { paidBy[id] = k; });
  const L = [REC_HEAD];
  ST.entries.forEach((e) => L.push([e.id, e.level, e.date || '', e.month || '', e.kind, e.category || '', e.amount, e.account || '', e.toAccount || '', e.oneoff ? 1 : '', e.mode || '', e.memo || '', e.createdAt || '', e.updatedAt || '', '', '', paidBy[e.id] || '']));
  (ST.duePlans || []).forEach((p) => L.push(['', 'daily', p.date, '', 'planned', p.category || '', p.amount, '', '', '', '', '', p.createdAt || '', '', p.key, p.item, '']));
  return '\ufeff' + L.map(csvLine).join('\r\n');
}
function entriesFromCsv(text) {
  const rows = parseCsvText(text); const h = rows.shift().map((x) => x.trim()); const ix = (k) => h.indexOf(k);
  const num = (s) => { const v = +String(s || '').replace(/[,\s원]/g, ''); return isNaN(v) ? 0 : v; };
  const entries = [], duePlans = [], duePaid = {}, KR = { 지출: 'expense', 수입: 'income', 계좌이체: 'transfer', 잔액확인: 'balance', 계획: 'planned' };
  rows.forEach((r) => {
    const g = (k) => (ix(k) >= 0 ? (r[ix(k)] || '').trim() : '');
    const kind = KR[g('kind')] || g('kind');
    if (kind === 'planned') { duePlans.push({ key: g('planKey') || `${g('planItem') || g('category')}|${g('date')}`, item: g('planItem') || g('category'), date: g('date'), amount: num(g('amount')), category: g('category'), createdAt: g('createdAt') }); return; }
    if (!KIND[kind]) return;
    const e = { id: g('id') || uid(), level: g('level') === 'monthly' || (!g('date') && g('month')) ? 'monthly' : 'daily', kind, amount: num(g('amount')), category: g('category'), memo: g('memo'), createdAt: g('createdAt') || nowStr(), updatedAt: g('updatedAt') || nowStr() };
    if (e.level === 'monthly') e.month = g('month') || g('date').slice(0, 7); else e.date = g('date');
    if (g('account')) e.account = g('account'); if (g('toAccount')) e.toAccount = g('toAccount');
    if (/^(1|true|y|예|✔)$/i.test(g('oneoff'))) e.oneoff = true;
    if (g('mode')) e.mode = g('mode');
    if (BASE && (kind === 'expense' || kind === 'income') && !e.mode && isCovered(e, BASE)) e.mode = 'add';
    entries.push(e); if (g('paidKey')) duePaid[g('paidKey')] = e.id;
  });
  return { entries, duePlans, duePaid };
}

/* 전체 백업 */
function exportAll() {
  if (!BASE) return;
  ST.lastExport = nowStr(); saveStore();
  const pack = { app: 'runway', schema: SCHEMA, exportedAt: ST.lastExport, baseOrigin: BASE_ORIGIN, base: BASE, entries: ST.entries, duePlans: ST.duePlans, duePaid: ST.duePaid, settings: S };
  download(`runway_전체백업_${ST.lastExport.replace(/[: ]/g, '').slice(0, 12)}.json`, JSON.stringify(pack, null, 1), 'application/json');
  toast('전체 백업 파일을 내려받았습니다'); updateStoreInfo();
}
async function importFile(file) {
  let text; try { text = await readText(file); } catch (e) { alert('파일을 읽지 못했습니다: ' + e.message); return; }
  try {
    if (/\.json$/i.test(file.name) || text.trim().startsWith('{')) {
      const o = JSON.parse(text);
      if (o.app === 'runway' && Array.isArray(o.entries)) return importPack(o);
      return setBase(validate(o), 'stored');
    }
    const head = parseCsvText(text.split(/\r?\n/)[0] || '')[0] || [];
    if (head.includes('record')) return setBase(validate(fromCsv(text)), 'stored');
    if (head.includes('kind')) return importPack({ ...entriesFromCsv(text), csv: true });
    throw new Error('알 수 없는 형식입니다(전체 백업 JSON, 기록 CSV, 기초 데이터 CSV/JSON 중 하나여야 함).');
  } catch (e) { alert('가져오기 실패: ' + e.message); }
}
async function importPack(p) {
  if (p.schema && p.schema > SCHEMA) { alert('더 새로운 버전에서 만든 백업입니다. 앱을 최신으로 업데이트하세요.'); return; }
  if (!BASE && !p.base) { alert('기초 데이터가 없습니다. 먼저 기초 데이터를 업로드하세요.'); return; }
  const n = (p.entries || []).length, m = (p.duePlans || []).length;
  const r = await ask('가져오기', `기록 ${n}건, 계획 출금 ${m}건${p.base ? `, 기초 데이터(기준일 ${esc(p.base.meta?.asOf)})` : ''}을 가져옵니다.<br>현재 기록 ${ST.entries.length}건을 어떻게 할까요?<br><span class="hint">병합: 같은 ID는 가져온 내용으로 덮어씀 · 대체: 현재 기록을 모두 지우고 가져온 것으로 교체</span>`,
    [['취소', ''], ['병합', 'merge', 'primary'], ['대체', 'replace', 'danger']]);
  if (!r) return;
  if (r === 'replace') { ST.entries = []; ST.duePlans = []; ST.duePaid = {}; }
  const byId = Object.fromEntries(ST.entries.map((e) => [e.id, e])); (p.entries || []).forEach((e) => { byId[e.id] = e; }); ST.entries = Object.values(byId);
  const pk = Object.fromEntries((ST.duePlans || []).map((x) => [x.key, x])); (p.duePlans || []).forEach((x) => { pk[x.key] = x; }); ST.duePlans = Object.values(pk);
  Object.assign(ST.duePaid, p.duePaid || {});
  if (p.settings && r === 'replace') Object.assign(S, DEFAULTS, p.settings);
  const uploadOnly = new URLSearchParams(location.search).has('upload');
  if (p.base && (p.baseOrigin === 'stored' || uploadOnly || !window.RUNWAY_DATA || !BASE)) { setBase(validate(p.base), 'stored', true); }
  saveStore(); refresh(); toast(`가져오기 완료 (${r === 'merge' ? '병합' : '대체'})`);
}
async function resetAll() {
  const r = await ask('전체 초기화', `이 브라우저에 저장된 <b>기록 ${ST.entries.length}건, 계획 출금, 설정${ST.base ? ', 업로드한 기초 데이터' : ''}</b>를 모두 삭제합니다. 되돌릴 수 없습니다.`,
    [['취소', ''], ['백업 후 초기화', 'backup', 'primary'], ['초기화', 'reset', 'danger']]);
  if (!r) return;
  if (r === 'backup') exportAll();
  localStorage.removeItem(STORE_KEY); ST = emptyStore(); S = { ...DEFAULTS };
  start(); toast('초기화했습니다');
}
function setBase(raw, origin, noRefresh) {
  BASE = raw; BASE_ORIGIN = origin;
  if (origin === 'stored') { ST.base = raw; saveStore(true); }
  $('#emptyState').classList.add('hidden'); $('#app').classList.remove('hidden'); $('#tabs').classList.remove('hidden');
  $('#metaLine').textContent = `기초 데이터 기준일 ${raw.meta.asOf} · 출처 ${raw.meta.source || '-'}${raw.meta.sheet ? ' / ' + raw.meta.sheet : ''} · 생성 ${raw.meta.generated || '-'}${origin === 'stored' ? ' · 브라우저 저장본' : ''} · 예시 데이터`;
  if (!noRefresh) refresh();
}
async function clearBase() {
  const r = await ask('업로드 데이터 삭제', '이 브라우저에 저장한 업로드 기초 데이터를 삭제합니다. 기록은 남습니다.', [['취소', ''], ['삭제', 'del', 'danger']]);
  if (r !== 'del') return;
  ST.base = null; saveStore(true); start();
}
function showEmpty() {
  D = null; RAW = null; BASE = null; BASE_ORIGIN = '';
  $('#app').classList.add('hidden'); $('#emptyState').classList.remove('hidden'); $('#tabs').classList.add('hidden');
  $('#baseBanner').classList.add('hidden'); $('#backupBanner').classList.add('hidden');
  $('#metaLine').textContent = '데이터 없음 — 업로드 전용 모드' + (ST.entries.length ? ` (저장된 기록 ${ST.entries.length}건 있음 — 기초 데이터를 올리면 다시 표시)` : '');
}

/* ---------------- 시작 ---------------- */
function start() {
  loadStore();
  const uploadOnly = new URLSearchParams(location.search).has('upload');
  if (ST.base) { try { return setBase(validate(ST.base), 'stored'); } catch (e) { console.warn('저장된 기초 데이터 오류', e); } }
  if (window.RUNWAY_DATA && !uploadOnly) return setBase(clone(window.RUNWAY_DATA), 'embedded');
  showEmpty();
}
window.addEventListener('beforeprint', () => { const d = document.getElementById('methods'); if (d) d.open = true; Object.values(charts).forEach((c) => c.resize()); });
window.addEventListener('DOMContentLoaded', () => {
  if (typeof Chart === 'undefined') { document.body.insertAdjacentHTML('afterbegin', '<div class="card" style="margin:16px;color:#c00">Chart.js(CDN)를 불러오지 못했습니다. 인터넷 연결을 확인하세요.</div>'); return; }
  Chart.defaults.font.family = getComputedStyle(document.body).fontFamily; Chart.defaults.color = '#374151';
  bindControls(); bindRecords();
  $('#fileInput').addEventListener('change', async (e) => { const f = e.target.files[0]; e.target.value = ''; if (f) await importFile(f); });
  $('#btnCsv').addEventListener('click', () => BASE && download('runway_data.csv', toCsv(BASE), 'text/csv;charset=utf-8'));
  const empty = () => download('runway_template_empty.csv', toCsv(null), 'text/csv;charset=utf-8');
  $('#btnCsvEmpty').addEventListener('click', empty); $('#btnCsvEmpty2').addEventListener('click', empty);
  $('#btnJson').addEventListener('click', () => BASE && download('runway_data.json', JSON.stringify(BASE, null, 1), 'application/json'));
  $('#btnClear').addEventListener('click', () => { if (ST.base) clearBase(); else toast('업로드해 저장한 기초 데이터가 없습니다'); });
  start();
});
window.__runway = { forecast: () => forecast(), get D() { return D; }, get S() { return S; }, get ST() { return ST; }, toCsv: () => toCsv(BASE), fromCsv, entriesToCsv };
