// Allowance web client: AG Grid Community ledger, AG Charts donut, PayPal JS SDK v6 button,
// and the loop that drives the agent (think -> capture approved lines -> think ...).
/* global agGrid, agCharts */

const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => Array.from(el.querySelectorAll(s));
const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const usd = (cents) => `${cents < 0 ? '-' : ''}$${(Math.abs(cents || 0) / 100).toFixed(2)}`;
const fmtTime = (iso) => (iso ? new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false }) : '');
const fmtDate = (iso) => (iso ? new Date(iso).toLocaleDateString([], { month: 'short', day: 'numeric', year: 'numeric' }) : '—');
const fmtDateTime = (iso) => (iso ? new Date(iso).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : '—');

// ---------------------------------------------------------------- API
class ApiError extends Error {
  constructor(message, status, code) {
    super(message);
    this.status = status;
    this.code = code;
  }
}
async function req(method, path, body) {
  const res = await fetch(path, {
    method,
    headers: body ? { 'content-type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  let data = null;
  try {
    data = await res.json();
  } catch {
    /* empty */
  }
  if (!res.ok) throw new ApiError(data?.error?.message || `Request failed (${res.status})`, res.status, data?.error?.code);
  return data;
}
const api = {
  config: () => req('GET', '/api/config'),
  quota: () => req('GET', '/api/quota'),
  catalog: () => req('GET', '/api/catalog'),
  create: (errand, mode) => req('POST', '/api/mandates', mode ? { errand, mode } : { errand }),
  get: (id) => req('GET', `/api/mandates/${id}`),
  patch: (id, patch) => req('PATCH', `/api/mandates/${id}`, patch),
  order: (id) => req('POST', `/api/mandates/${id}/order`),
  approve: (id, orderId) => req('POST', `/api/mandates/${id}/approve`, { orderId }),
  think: (id, instruction) => req('POST', `/api/mandates/${id}/think`, instruction ? { instruction } : {}),
  line: (id, rowId, action) => req('POST', `/api/mandates/${id}/lines/${rowId}/${action}`),
  release: (id) => req('POST', `/api/mandates/${id}/release`),
  redteam: (id) => req('POST', `/api/mandates/${id}/redteam`),
  sync: (id) => req('POST', `/api/mandates/${id}/sync`),
  batch: (ids) => req('POST', '/api/mandates/batch', { ids }),
};

// ---------------------------------------------------------------- state
let cfg = null;
let M = null; // current mandate (public view)
let busy = false;
let activity = '';
let paypalSession = null;
let paypalReady = false;
let catLabels = {};
let ledgerApi = null;
let historyApi = null;
let storeApi = null;
let donut = null;
let ledgerFilter = 'all';
let patchTimer = null;
let pendingPatch = null;
let lastEventCount = 0;

const LS_KEY = 'allowance.mandates.v1';
function knownIds() {
  try {
    return JSON.parse(localStorage.getItem(LS_KEY) || '[]');
  } catch {
    return [];
  }
}
function remember(id) {
  try {
    const ids = knownIds().filter((x) => x !== id);
    ids.unshift(id);
    localStorage.setItem(LS_KEY, JSON.stringify(ids.slice(0, 30)));
  } catch {
    /* storage unavailable */
  }
}
const hashId = () => (location.hash.match(/m=([a-f0-9]{32})/) || [])[1] || null;
const setHash = (id) => history.replaceState(null, '', id ? `${location.pathname}#m=${id}` : location.pathname);

function toast(msg, kind = '') {
  const t = $('#toast');
  t.textContent = msg;
  t.className = `toast ${kind}`;
  t.hidden = false;
  clearTimeout(toast._t);
  toast._t = setTimeout(() => (t.hidden = true), kind === 'error' ? 6500 : 3800);
}

function setLoading(btn, on) {
  btn.classList.toggle('loading', on);
  btn.disabled = on;
}

// ---------------------------------------------------------------- AG Grid setup
function gridTheme() {
  return agGrid.themeQuartz.withParams({
    fontFamily: 'Inter, ui-sans-serif, system-ui, sans-serif',
    fontSize: 13,
    headerFontSize: 11.5,
    headerFontWeight: 650,
    accentColor: '#0d7a5f',
    foregroundColor: '#0d1726',
    backgroundColor: '#ffffff',
    headerBackgroundColor: '#f7f9fb',
    headerTextColor: '#5b6678',
    borderColor: '#e3e7ee',
    rowHoverColor: '#f3f8f6',
    wrapperBorderRadius: 12,
    spacing: 6,
    cellHorizontalPadding: 12,
    columnBorder: false,
    headerColumnBorder: false,
  });
}

const STATUS_LABEL = {
  approved: 'Capturing',
  captured: 'Captured',
  blocked: 'Blocked',
  needs_approval: 'Needs you',
  declined: 'Declined',
  refunded: 'Refunded',
  failed: 'Failed',
  authorized: 'Hold placed',
  voided: 'Released',
};
const badge = (cls, text) => `<span class="badge b-${esc(cls)}">${esc(text)}</span>`;

function itemRenderer(p) {
  const d = p.data;
  if (!d) return '';
  if (p.node.rowPinned) return `<div class="cell-item"><b>${esc(d.item)}</b><small>${esc(d.sub || '')}</small></div>`;
  if (d.kind === 'hold') return `<div class="cell-item"><b>${esc(d.item)}</b><small>Authorization ${esc(d.paypal?.id || '')} · approved by you</small></div>`;
  if (d.kind === 'release') return `<div class="cell-item"><b>${esc(d.item)}</b><small>Unused money returned to the buyer</small></div>`;
  const qty = d.quantity && d.unitCents ? `${d.quantity} × ${usd(d.unitCents)}` : `qty ${esc(d.quantity ?? '?')}`;
  const red = d.redteam ? '<span class="cat red">red team</span>' : '';
  return `<div class="cell-item"><b>${esc(d.item)}</b><small>${red}<span class="cat">${esc(catLabels[d.category] || d.category || 'unknown')}</span>${qty} · ${esc(d.productId || '')}</small></div>`;
}
function amountRenderer(p) {
  const d = p.data;
  if (!d) return '';
  const struck = ['blocked', 'declined', 'failed'].includes(d.status);
  const sign = d.kind === 'release' ? '↩ ' : '';
  return `<span class="amount ${struck ? 'struck' : ''}">${sign}${usd(d.amountCents)}</span>`;
}
function statusRenderer(p) {
  const d = p.data;
  if (!d) return '';
  if (p.node.rowPinned) return badge(M?.status || 'draft', M?.status === 'active' ? 'Hold active' : M?.status === 'closed' ? 'Closed' : 'Draft');
  return badge(d.status, STATUS_LABEL[d.status] || d.status);
}
function reasonRenderer(p) {
  const d = p.data;
  if (!d || p.node.rowPinned) return d?.reasonText ? `<span class="reason">${esc(d.reasonText)}</span>` : '';
  if (d.kind !== 'purchase') return '<span class="muted">—</span>';
  return `<span class="reason">“${esc(d.agentReason || '')}”</span>`;
}
function policyRenderer(p) {
  const d = p.data;
  if (!d?.policy || p.node.rowPinned) return '';
  const pol = d.policy;
  if (d.kind === 'hold') return `<div class="cell-two">${badge('ok', 'Signed')}<span class="line2">${esc(pol.detail)}</span></div>`;
  const n = pol.checks?.length || 0;
  const budget = pol.checks?.find((c) => c.rule === 'BUDGET')?.detail || pol.detail;
  return pol.ok
    ? `<div class="cell-two">${badge('ok', `Pass · ${n} checks`)}<span class="line2">${esc(budget)}</span></div>`
    : `<div class="cell-two">${badge('blocked', pol.rule)}<span class="line2">${esc(pol.detail)}</span></div>`;
}
function auditRenderer(p) {
  const d = p.data;
  if (!d || p.node.rowPinned) return '';
  if (!d.audit) return d.kind === 'purchase' && d.status === 'blocked' ? '<span class="muted small">Not reached — blocked by code first</span>' : '';
  const a = d.audit;
  const b = a.verdict === 'ok' ? badge('ok', 'OK') : a.verdict === 'flag' ? badge('warn', 'Flagged') : badge('skipped', 'Skipped');
  return `<div class="cell-two">${b}<span class="line2">${esc(a.note)}</span></div>`;
}
function paypalText(d) {
  if (!d?.paypal) return '';
  const pp = d.paypal;
  return [pp.id, pp.status, pp.refundId ? `refund ${pp.refundId} ${pp.refundStatus || ''}` : '', pp.error || ''].filter(Boolean).join(' · ');
}
function paypalRenderer(p) {
  const d = p.data;
  if (!d || p.node.rowPinned) return d?.paypalText ? `<span class="small muted">${esc(d.paypalText)}</span>` : '';
  const pp = d.paypal;
  if (!pp) return d.status === 'blocked' ? '<span class="muted small">No money moved</span>' : '';
  if (pp.error) return `<div class="cell-two"><span class="badge b-failed">Error</span><span class="line2">${esc(pp.error)}</span></div>`;
  const kind = d.kind === 'hold' ? 'Authorization' : d.kind === 'release' ? 'Voided' : 'Capture';
  const wh = pp.webhook ? `<span class="wh" title="Verified PayPal webhook: ${esc(pp.webhook)}">✓ webhook</span>` : '';
  const ref = pp.refundId ? `<br><span class="small muted">Refund <span class="mono">${esc(pp.refundId)}</span> ${esc(pp.refundStatus || '')}</span>` : '';
  return `<div class="cell-two"><span class="small muted">${kind} · ${esc(pp.status || '')}${wh}</span><span class="mono">${esc(pp.id || '')}</span>${ref}</div>`;
}
function actionsRenderer(p) {
  const d = p.data;
  if (!d || p.node.rowPinned) return '';
  const wrap = document.createElement('div');
  wrap.className = 'row-actions';
  const add = (label, cls, fn, title) => {
    const b = document.createElement('button');
    b.className = `mini ${cls}`;
    b.textContent = label;
    if (title) b.title = title;
    b.disabled = busy;
    b.addEventListener('click', (e) => {
      e.stopPropagation();
      fn();
    });
    wrap.appendChild(b);
  };
  if (d.status === 'needs_approval' && M?.status === 'active') {
    add('Allow', 'go', () => decide(d.id, 'approve'), 'Override the auditor and let PayPal capture this line');
    add('Deny', 'no', () => decide(d.id, 'decline'), 'Decline this line');
  }
  if (d.status === 'captured') add('Refund', '', () => refundLine(d.id), 'Refund this capture through PayPal');
  return wrap;
}

function initLedgerGrid() {
  const columnDefs = [
    {
      headerName: '#',
      field: 'n',
      width: 88,
      pinned: 'left',
      sort: 'asc',
      cellRenderer: (p) => (p.node.rowPinned ? '' : `<div class="cell-two"><b>${esc(p.value)}</b><span class="line2 mono">${fmtTime(p.data.ts)}</span></div>`),
    },
    { headerName: 'Time', field: 'ts', hide: true },
    { headerName: 'Item', field: 'item', minWidth: 200, flex: 2, cellRenderer: itemRenderer, tooltipField: 'item' },
    { headerName: 'Amount', field: 'amountCents', width: 100, cellRenderer: amountRenderer, cellClass: 'ag-right-aligned-cell', headerClass: 'ag-right-aligned-header' },
    { headerName: 'Status', colId: 'status', width: 122, valueGetter: (p) => p.data?.status, cellRenderer: statusRenderer },
    {
      headerName: "Agent's reasoning (AI)",
      colId: 'reason',
      minWidth: 170,
      flex: 1.6,
      valueGetter: (p) => p.data?.agentReason || '',
      cellRenderer: reasonRenderer,
      tooltipValueGetter: (p) => p.data?.agentReason || null,
    },
    {
      headerName: 'Policy firewall (code)',
      colId: 'policy',
      minWidth: 190,
      flex: 1.6,
      valueGetter: (p) => (p.data?.policy ? `${p.data.policy.ok ? 'PASS' : 'BLOCKED'} ${p.data.policy.rule}: ${p.data.policy.detail}` : ''),
      cellRenderer: policyRenderer,
      tooltipValueGetter: (p) => (p.data?.policy?.checks?.length ? p.data.policy.checks.map((c) => `${c.ok ? '✓' : '✗'} ${c.rule} — ${c.detail}`).join('\n') : null),
    },
    {
      headerName: 'AI auditor',
      colId: 'audit',
      minWidth: 160,
      flex: 1.4,
      valueGetter: (p) => (p.data?.audit ? `${p.data.audit.verdict.toUpperCase()}: ${p.data.audit.note}` : ''),
      cellRenderer: auditRenderer,
      tooltipValueGetter: (p) => (p.data?.audit ? `${p.data.audit.note} (${p.data.audit.by})` : null),
    },
    { headerName: 'PayPal', colId: 'paypal', width: 196, valueGetter: (p) => paypalText(p.data), cellRenderer: paypalRenderer },
    { headerName: '', colId: 'actions', width: 112, pinned: 'right', cellRenderer: actionsRenderer, sortable: false, resizable: false },
  ];
  ledgerApi = agGrid.createGrid($('#ledger-grid'), {
    theme: gridTheme(),
    columnDefs,
    rowData: [],
    domLayout: 'autoHeight',
    defaultColDef: { sortable: true, resizable: true, enableCellChangeFlash: true, suppressHeaderMenuButton: true },
    getRowId: (p) => p.data.id,
    rowHeight: 60,
    headerHeight: 40,
    animateRows: true,
    tooltipShowDelay: 250,
    rowClassRules: {
      'row-blocked': (p) => p.data?.status === 'blocked',
      'row-captured': (p) => p.data?.status === 'captured',
      'row-needs_approval': (p) => p.data?.status === 'needs_approval',
      'row-system': (p) => !!p.data && !p.node.rowPinned && p.data.kind !== 'purchase',
    },
    isExternalFilterPresent: () => ledgerFilter !== 'all',
    doesExternalFilterPass: (node) => node.data?.status === ledgerFilter,
    overlayNoRowsTemplate: '<span style="color:#5b6678">No activity yet — draft a mandate, approve the hold with PayPal, and let the agent shop.</span>',
  });
}

function initHistoryGrid() {
  historyApi = agGrid.createGrid($('#history-grid'), {
    theme: gridTheme(),
    rowData: [],
    domLayout: 'autoHeight',
    getRowId: (p) => p.data.id,
    rowHeight: 58,
    headerHeight: 40,
    animateRows: true,
    tooltipShowDelay: 250,
    defaultColDef: { sortable: true, resizable: true, filter: true, floatingFilter: false, suppressHeaderMenuButton: true },
    columnDefs: [
      { headerName: 'Created', field: 'createdAt', width: 128, sort: 'desc', valueFormatter: (p) => (p.node.rowPinned ? '' : fmtDateTime(p.value)), filter: false },
      { headerName: 'Mandate', field: 'title', minWidth: 170, flex: 1.1, cellRenderer: (p) => `<div class="cell-item"><b>${esc(p.value)}</b><small>${p.node.rowPinned ? '' : `Drafted by ${esc(String(p.data.draftedBy || '').split('/').pop())}`}</small></div>` },
      { headerName: 'Status', field: 'status', width: 96, cellRenderer: (p) => (p.node.rowPinned ? '' : badge(p.value, p.value)) },
      { headerName: 'Hold', field: 'authorizedCents', width: 90, cellRenderer: (p) => `<span class="amount">${usd(p.value)}</span>`, filter: 'agNumberColumnFilter' },
      { headerName: 'Spent', field: 'netSpentCents', width: 90, cellRenderer: (p) => `<span class="amount">${usd(p.value)}</span>`, filter: 'agNumberColumnFilter' },
      { headerName: 'Released', field: 'releasedCents', width: 96, cellRenderer: (p) => `<span class="amount">${usd(p.value)}</span>` },
      { headerName: 'Buys', field: 'purchases', width: 72 },
      { headerName: 'Blocked', field: 'blocked', width: 84 },
      { headerName: 'PayPal authorization', field: 'authorizationId', width: 176, cellRenderer: (p) => (p.value ? `<div class="cell-two"><span class="mono">${esc(p.value)}</span><span class="line2">${esc(p.data.authorizationStatus || '')}</span></div>` : '<span class="muted">—</span>') },
      {
        headerName: 'AI recap',
        field: 'agentSummary',
        minWidth: 250,
        flex: 2.4,
        cellRenderer: (p) => (p.value ? `<span class="reason" title="${esc(p.data.summaryBy || '')}">${esc(p.value)}</span>` : '<span class="muted">—</span>'),
        tooltipField: 'agentSummary',
      },
      {
        headerName: '',
        colId: 'open',
        width: 80,
        pinned: 'right',
        sortable: false,
        filter: false,
        cellRenderer: (p) => {
          if (p.node.rowPinned) return '';
          const b = document.createElement('button');
          b.className = 'mini go';
          b.textContent = 'Open';
          b.addEventListener('click', () => openMandate(p.data.id));
          return b;
        },
      },
    ],
    overlayNoRowsTemplate: '<span style="color:#5b6678">No mandates in this browser yet.</span>',
  });
}

function initStoreGrid(items) {
  storeApi = agGrid.createGrid($('#store-grid'), {
    theme: gridTheme(),
    rowData: items,
    getRowId: (p) => p.data.id,
    rowHeight: 52,
    headerHeight: 40,
    tooltipShowDelay: 250,
    defaultColDef: { sortable: true, resizable: true, filter: true, floatingFilter: true, suppressHeaderMenuButton: true },
    columnDefs: [
      { headerName: 'ID', field: 'id', width: 92, cellClass: 'mono', pinned: 'left' },
      { headerName: 'Product', field: 'name', minWidth: 220, flex: 2, tooltipField: 'name' },
      { headerName: 'Category', field: 'categoryLabel', width: 150 },
      { headerName: 'Price', field: 'price', width: 110, filter: 'agNumberColumnFilter', valueFormatter: (p) => `$${Number(p.value).toFixed(2)}`, cellClass: 'amount' },
      { headerName: 'Unit', field: 'unit', width: 76 },
      { headerName: 'Tags', field: 'tags', width: 150, valueFormatter: (p) => (p.value || []).join(', ') },
      { headerName: 'Rating', field: 'rating', width: 90, filter: 'agNumberColumnFilter', cellRenderer: (p) => `<span class="stars">★</span> ${Number(p.value).toFixed(1)}` },
      { headerName: 'Agent can buy?', colId: 'buyable', width: 130, valueGetter: (p) => (p.data.restricted ? 'Never' : p.data.injection ? 'Blocked' : 'If mandate allows'), cellRenderer: (p) => (p.value === 'Never' ? badge('blocked', 'Never') : p.value === 'Blocked' ? badge('warn', 'Blocked') : badge('ok', 'If allowed')) },
      {
        headerName: 'Seller listing text (untrusted)',
        field: 'listing',
        minWidth: 280,
        flex: 2.4,
        tooltipField: 'listing',
        cellRenderer: (p) => (p.value ? `<span class="${p.data.injection ? 'inj' : ''}">${p.data.injection ? '⚠ Prompt injection: ' : ''}</span><span class="reason">${esc(p.value)}</span>` : '<span class="muted">—</span>'),
      },
    ],
  });
}

function initDonut() {
  if (!window.agCharts) return;
  donut = agCharts.AgCharts.create(donutOptions());
}

const DONUT_COLORS = ['#0d7a5f', '#14b8a6', '#22c55e', '#0ea5e9', '#6366f1', '#84cc16', '#f59e0b', '#a855f7'];
function donutOptions() {
  const byCat = {};
  for (const r of M?.ledger || []) {
    if (r.kind === 'purchase' && r.status === 'captured') byCat[catLabels[r.category] || r.category] = (byCat[catLabels[r.category] || r.category] || 0) + r.amountCents;
  }
  const data = Object.entries(byCat).map(([label, cents], i) => ({ label, value: cents / 100, color: DONUT_COLORS[i % DONUT_COLORS.length] }));
  const t = M?.totals;
  const left = !M ? 0 : M.status === 'active' ? t.remainingCents : M.status === 'closed' ? t.releasedCents : M.terms.budgetCents;
  if (left > 0) data.push({ label: M.status === 'active' ? 'Left on hold' : M.status === 'closed' ? 'Released' : 'Proposed hold', value: left / 100, color: '#e6ebf1' });
  if (!data.length) data.push({ label: 'No hold yet', value: 1, color: '#eef1f5' });
  return {
    container: $('#donut'),
    data,
    background: { visible: false },
    minWidth: 150,
    minHeight: 150,
    padding: { top: 4, right: 4, bottom: 4, left: 4 },
    legend: { enabled: false },
    series: [
      {
        type: 'donut',
        angleKey: 'value',
        legendItemKey: 'label',
        innerRadiusRatio: 0.68,
        strokeWidth: 2,
        itemStyler: ({ datum }) => ({ fill: datum.color, stroke: '#ffffff' }),
        innerLabels: [
          { text: usd(t?.netSpentCents || 0), fontSize: 19, fontWeight: 'bold', color: '#0d1726' },
          { text: 'spent by agent', fontSize: 11, color: '#5b6678' },
        ],
        tooltip: { renderer: ({ datum }) => ({ heading: datum.label, data: [{ label: 'Amount', value: `$${Number(datum.value).toFixed(2)}` }] }) },
      },
    ],
  };
}

// ---------------------------------------------------------------- rendering
let currentView = 'workspace';
function render() {
  $('.hero').hidden = !!M || currentView !== 'workspace';
  renderSteps();
  renderForm();
  renderAgent();
  renderMeter();
  renderLedger();
}

function renderSteps() {
  $('#step1').classList.toggle('done', !!M);
  $('#step2').classList.toggle('is-locked', !M);
  $('#step2').classList.toggle('done', !!M && M.status !== 'draft');
  $('#step3').classList.toggle('is-locked', !M || M.status === 'draft');
  $('#step3').classList.toggle('done', !!M && M.status === 'closed');
}

function renderForm() {
  const draft = M?.status === 'draft';
  const fields = ['#f-title', '#f-list', '#f-budget', '#f-cap', '#f-qty', '#f-exp', '#f-notes'];
  for (const f of fields) $(f).disabled = !draft || busy;
  const focused = document.activeElement;
  const setVal = (sel, v) => {
    if (focused !== $(sel)) $(sel).value = v;
  };
  if (M) {
    const t = M.terms;
    setVal('#f-title', t.title);
    setVal('#f-list', (t.shoppingList || []).join(', '));
    setVal('#f-budget', (t.budgetCents / 100).toFixed(0));
    setVal('#f-cap', (t.perItemCapCents / 100).toFixed(0));
    setVal('#f-qty', t.maxQuantity);
    setVal('#f-exp', t.expiresAt.slice(0, 10));
    setVal('#f-notes', t.notes.join('\n'));
    $('#mandate-sub').textContent = draft
      ? `Drafted by ${M.draftedBy === 'rules' ? 'the rules-only parser' : M.draftedBy.split('/').pop()}. Edit anything, then approve.`
      : 'Approved in PayPal. These terms are signed and locked.';
  } else {
    for (const f of fields) $(f).value = '';
    $('#mandate-sub').textContent = 'Draft a mandate first.';
  }
  const cats = $('#f-cats');
  cats.innerHTML = '';
  for (const c of cfg?.categories || []) {
    if (c.restricted) continue;
    const on = !!M && M.terms.allowedCategories.includes(c.id);
    const b = document.createElement('button');
    b.type = 'button';
    b.className = `chip ${on ? 'on' : ''} ${draft ? '' : 'locked'}`;
    b.textContent = c.label;
    b.title = c.description;
    b.disabled = !draft || busy;
    b.addEventListener('click', () => toggleCategory(c.id));
    cats.appendChild(b);
  }
  const stamp = $('#signed-stamp');
  if (M?.signature && M.status !== 'draft') {
    stamp.hidden = false;
    stamp.innerHTML = `<span>🔏</span><span>Signed mandate <code>HMAC ${esc(M.signature)}…</code> bound to PayPal authorization <code>${esc(M.paypal.authorizationId || '')}</code></span>`;
  } else stamp.hidden = true;

  const btn = $('#paypal-btn');
  const showButton = draft && paypalReady;
  btn.hidden = !showButton;
  $('#approve-copy').innerHTML = M
    ? draft
      ? `PayPal will place a <b>${usd(M.terms.budgetCents)}</b> authorization hold. You are only charged for what the agent actually buys; the rest is released.`
      : `Approved ${fmtDateTime(M.paypal.approvedAt)} · hold <b>${usd(M.totals.authorizedCents)}</b> · authorization <span class="mono">${esc(M.paypal.authorizationId || '')}</span>`
    : 'PayPal will place an authorization hold. You are only charged for what the agent actually buys.';
  if (!draft) $('#btn-redirect').hidden = true;
  if (!M) setPayPalStatus(paypalReady ? 'Draft a mandate to enable PayPal.' : $('#paypal-status').textContent);
  else if (!draft) setPayPalStatus('');
  else if (paypalReady && !$('#paypal-status').dataset.sticky) setPayPalStatus('Sandbox: sign in with the test buyer from the README / Devpost page.');
}

function setPayPalStatus(text, sticky = false) {
  const el = $('#paypal-status');
  el.textContent = text;
  if (sticky) el.dataset.sticky = '1';
  else delete el.dataset.sticky;
}

function renderAgent() {
  const active = M?.status === 'active';
  const runBtn = $('#btn-run');
  const label = runBtn.querySelector('.btn-label');
  if (!M || M.status === 'draft') label.textContent = 'Start shopping';
  else if (M.status === 'closed') label.textContent = 'Mandate closed';
  else if (busy) label.textContent = 'Agent working…';
  else if (M.agent.done) label.textContent = 'Errand done ✓';
  else label.textContent = M.agent.turns ? 'Continue shopping' : 'Start shopping';
  runBtn.disabled = !active || busy || M.agent.done;
  const red = $('#btn-redteam');
  red.disabled = !active || busy || M.ledger.some((r) => r.redteam);
  red.textContent = M?.ledger?.some((r) => r.redteam) ? 'Red-team drill done' : 'Red-team the agent';
  runBtn.classList.toggle('loading', busy && active);
  $('#instruction').disabled = !active || busy;
  $('#btn-send').disabled = !active || busy;
  for (const c of $$('#nudges .chip')) c.disabled = !active || busy;
  $('#agent-sub').textContent = !M || M.status === 'draft'
    ? 'Approve the allowance with PayPal first.'
    : M.status === 'closed'
      ? 'Mandate closed — the authorization was voided.'
      : M.agent.done
        ? 'Errand done. Release the unused money, refund a line, or give the agent a new instruction.'
        : 'The agent buys on its own, inside the hold.';
  const model = M?.agent?.model || cfg?.aiModel || '';
  $('#agent-model').textContent =
    M?.forceRules ? 'Rules-only mode (no AI)' : M?.agent?.mode === 'rules' ? 'Rules-only mode (AI budget used up)' : model ? `Workers AI · ${model.split('/').pop()}` : '';
  renderConsole();
}

const TAGS = { agent: 'AI agent', human: 'You', policy: 'Firewall', audit: 'Auditor', paypal: 'PayPal', system: 'System', tool: 'Tool', error: 'Error' };
function renderConsole() {
  const box = $('#console');
  const events = M?.events || [];
  const html = events
    .map((e) => `<div class="ev ${esc(e.type)}"><span class="tag">${esc(TAGS[e.type] || e.type)}</span><span class="txt">${esc(e.text)}</span></div>`)
    .join('');
  const pending = activity ? `<div class="ev system"><span class="tag">…</span><span class="txt">${esc(activity)}</span></div>` : '';
  box.innerHTML = html + pending;
  if (events.length !== lastEventCount || activity) box.scrollTop = box.scrollHeight;
  lastEventCount = events.length;
}

function renderMeter() {
  const t = M?.totals;
  const st = $('#m-status');
  st.className = `status-pill ${M?.status || ''}`;
  st.textContent = !M ? 'No mandate' : M.status === 'draft' ? 'Draft' : M.status === 'active' ? 'Hold active' : 'Closed';
  $('#m-title').textContent = M ? `${M.terms.title} · ${M.terms.errand}` : "Your agent's spending limit, enforced by a PayPal authorization hold.";
  const hold = M ? (M.status === 'draft' ? M.terms.budgetCents : t.authorizedCents) : 0;
  $('#m-hold').textContent = usd(hold);
  $('#m-spent').textContent = usd(t?.netSpentCents || 0);
  $('#m-left-label').textContent = M?.status === 'closed' ? 'Released' : 'Left on hold';
  $('#m-left').textContent = usd(M?.status === 'closed' ? t.releasedCents : M?.status === 'active' ? t.remainingCents : hold);
  $('#m-blocked').textContent = t ? `${t.blocked}${t.flagged ? ` · ${t.flagged} flagged` : ''}` : '0';
  const base = Math.max(1, t?.authorizedCents || hold || 1);
  $('#bar-spent').style.width = `${Math.min(100, ((t?.capturedCents || 0) / base) * 100)}%`;
  $('#bar-reserved').style.width = `${Math.min(100, ((t?.reservedCents || 0) / base) * 100)}%`;
  $('#m-order').textContent = M?.paypal?.orderId || '—';
  $('#m-auth').textContent = M?.paypal?.authorizationId ? `${M.paypal.authorizationId} · ${M.paypal.authorizationStatus || ''}` : '—';
  $('#m-exp').textContent = M?.paypal?.authorizationExpiresAt ? fmtDate(M.paypal.authorizationExpiresAt) : M ? `mandate ${fmtDate(M.terms.expiresAt)}` : '—';
  $('#m-sig').textContent = M?.signature ? `${M.signature}…` : '—';
  const rel = $('#btn-release');
  rel.disabled = !M || M.status !== 'active' || busy;
  rel.textContent = M?.status === 'active' ? `Release unused ${usd(t.remainingCents)}` : 'Release unused';
  rel.classList.toggle('pulse', !!M && M.status === 'active' && M.agent.done && !busy);
  $('#btn-sync').disabled = !M?.paypal?.authorizationId || busy;
  if (donut) donut.update(donutOptions());
}

function renderLedger() {
  if (!ledgerApi) return;
  const rows = M ? M.ledger : [];
  ledgerApi.setGridOption('rowData', rows);
  const t = M?.totals;
  ledgerApi.setGridOption(
    'pinnedBottomRowData',
    M && M.status !== 'draft'
      ? [
          {
            id: 'total',
            item: `Net spent ${usd(t.netSpentCents)} of ${usd(t.authorizedCents)}`,
            sub: `${t.purchases} captured · ${t.blocked} blocked · ${t.flagged} flagged${t.refundedCents ? ` · ${usd(t.refundedCents)} refunded` : ''}`,
            amountCents: t.netSpentCents,
            reasonText: M.agent.recap || M.agent.summary || '',
            paypalText: M.status === 'closed' ? `Released ${usd(t.releasedCents)}` : `Left on hold ${usd(t.remainingCents)}`,
          },
        ]
      : [],
  );
  // pinned totals and action buttons depend on mandate-level state, so re-render them explicitly
  ledgerApi.refreshCells({ force: true, suppressFlash: true });
}

function setBusy(on, text = '') {
  busy = on;
  activity = on ? text : '';
  render();
}

// ---------------------------------------------------------------- actions
async function draft() {
  const errand = $('#errand').value.trim();
  if (errand.length < 8) return toast('Describe the errand first.');
  const btn = $('#btn-draft');
  setLoading(btn, true);
  try {
    M = await api.create(errand, $('#rules-mode').checked ? 'rules' : undefined);
    remember(M.id);
    setHash(M.id);
    render();
    toast(M.draftedBy === 'rules' ? 'Drafted by the rules-only parser — review it before approving.' : 'Mandate drafted by AI — review the limits, then approve with PayPal.');
  } catch (e) {
    toast(e.message, 'error');
  } finally {
    setLoading(btn, false);
    refreshQuota();
  }
}

function schedulePatch(patch) {
  if (!M || M.status !== 'draft') return;
  pendingPatch = { ...(pendingPatch || {}), ...patch };
  clearTimeout(patchTimer);
  patchTimer = setTimeout(flushPatch, 450);
}
async function flushPatch() {
  clearTimeout(patchTimer);
  if (!pendingPatch || !M) return;
  const patch = pendingPatch;
  pendingPatch = null;
  try {
    M = await api.patch(M.id, patch);
    render();
  } catch (e) {
    toast(e.message, 'error');
  }
}
function toggleCategory(id) {
  if (!M || M.status !== 'draft') return;
  const cur = new Set(M.terms.allowedCategories);
  cur.has(id) ? cur.delete(id) : cur.add(id);
  if (!cur.size) return toast('Keep at least one category.');
  M.terms.allowedCategories = Array.from(cur);
  render();
  schedulePatch({ allowedCategories: Array.from(cur) });
}

async function startPayPal() {
  if (!M || M.status !== 'draft' || busy || !paypalSession) return;
  await flushPatch();
  setPayPalStatus('Waiting for your approval in the PayPal window…', true);
  try {
    const orderPromise = api.order(M.id).then((r) => ({ orderId: r.orderId }));
    await paypalSession.start({ presentationMode: 'auto' }, orderPromise);
  } catch (e) {
    console.error(e);
    setPayPalStatus(`PayPal could not start: ${e.message || e}`, true);
    $('#btn-redirect').hidden = false;
  }
}

async function approveOrder(orderId) {
  setPayPalStatus('Placing the authorization hold…', true);
  setBusy(true, 'PayPal approved — placing the authorization hold…');
  try {
    M = await api.approve(M.id, orderId);
    toast(`Allowance approved — PayPal is holding ${usd(M.totals.authorizedCents)}. Nothing has been charged.`);
  } catch (e) {
    toast(e.message, 'error');
    setPayPalStatus(e.message, true);
  } finally {
    setBusy(false);
  }
}

async function redirectToPayPal() {
  if (!M || M.status !== 'draft') return;
  await flushPatch();
  try {
    const r = await api.order(M.id);
    if (r.approveUrl) location.href = r.approveUrl;
  } catch (e) {
    toast(e.message, 'error');
  }
}

async function captureApproved() {
  for (let i = 0; i < 20; i++) {
    const row = M.ledger.find((r) => r.status === 'approved');
    if (!row) return;
    activity = `Capturing ${usd(row.amountCents)} for ${row.item} through PayPal…`;
    renderConsole();
    M = await api.line(M.id, row.id, 'capture');
    render();
  }
}

async function runAgent(instruction) {
  if (!M || M.status !== 'active' || busy) return;
  setBusy(true, instruction ? 'Sending your message to the agent…' : 'Agent is reading the catalog and planning purchases…');
  try {
    let msg = instruction;
    for (let turn = 0; turn < 5; turn++) {
      M = await api.think(M.id, msg);
      msg = undefined;
      activity = 'Checking the firewall and auditor verdicts…';
      render();
      await captureApproved();
      if (M.agent.done || M.status !== 'active') break;
      activity = 'Agent is reviewing the results…';
      renderConsole();
    }
  } catch (e) {
    toast(e.message, 'error');
  } finally {
    setBusy(false);
    refreshQuota();
  }
}

async function redteam() {
  if (!M || M.status !== 'active' || busy) return;
  setBusy(true, 'Simulating a hijacked agent…');
  try {
    M = await api.redteam(M.id);
    const blocked = M.ledger.filter((r) => r.redteam && r.status === 'blocked').length;
    toast(`Red-team drill: ${blocked} of 5 attacks blocked by the firewall. Nothing reached PayPal.`);
  } catch (e) {
    toast(e.message, 'error');
  } finally {
    setBusy(false);
  }
}

async function decide(rowId, decision) {
  if (!M || busy) return;
  setBusy(true, decision === 'approve' ? 'Approving the flagged line…' : 'Declining…');
  try {
    M = await api.line(M.id, rowId, decision);
    render();
    if (decision === 'approve') await captureApproved();
  } catch (e) {
    toast(e.message, 'error');
  } finally {
    setBusy(false);
  }
}

async function refundLine(rowId) {
  if (!M || busy) return;
  setBusy(true, 'Refunding the capture through PayPal…');
  try {
    M = await api.line(M.id, rowId, 'refund');
    toast('Refunded through PayPal.');
  } catch (e) {
    toast(e.message, 'error');
  } finally {
    setBusy(false);
  }
}

async function release() {
  if (!M || M.status !== 'active' || busy) return;
  setBusy(true, 'Voiding the rest of the authorization…');
  try {
    M = await api.release(M.id);
    toast(`Released ${usd(M.totals.releasedCents)} back to the buyer. Mandate closed.`);
  } catch (e) {
    toast(e.message, 'error');
  } finally {
    setBusy(false);
  }
}

async function syncPayPal(quiet = false) {
  if (!M?.paypal?.authorizationId) return;
  try {
    M = await api.sync(M.id);
    render();
    if (!quiet) toast(`Synced with PayPal: authorization ${M.paypal.authorizationStatus}.`);
  } catch (e) {
    if (!quiet) toast(e.message, 'error');
  }
}

async function openMandate(id) {
  try {
    M = await api.get(id);
    remember(id);
    setHash(id);
    $('#errand').value = M.terms.errand;
    showView('workspace');
    render();
    syncPayPal(true);
  } catch (e) {
    toast(e.message, 'error');
  }
}

function newErrand() {
  M = null;
  setHash(null);
  showView('workspace');
  render();
  $('#errand').focus();
}

async function loadHistory() {
  const ids = knownIds();
  if (!ids.length) {
    historyApi.setGridOption('rowData', []);
    historyApi.setGridOption('pinnedBottomRowData', []);
    return;
  }
  try {
    const rows = await api.batch(ids);
    historyApi.setGridOption('rowData', rows);
    const sum = (k) => rows.reduce((s, r) => s + (r[k] || 0), 0);
    historyApi.setGridOption('pinnedBottomRowData', [
      { id: 'sum', title: `${rows.length} mandates`, authorizedCents: sum('authorizedCents'), netSpentCents: sum('netSpentCents'), releasedCents: sum('releasedCents'), purchases: sum('purchases'), blocked: sum('blocked') },
    ]);
  } catch (e) {
    toast(e.message, 'error');
  }
}

let storeLoaded = false;
async function loadStore() {
  if (storeLoaded) return;
  storeLoaded = true;
  try {
    const risk = (x) => (x.injection ? 3 : x.restricted ? 2 : x.featured ? 1 : 0);
    initStoreGrid((await api.catalog()).sort((a, b) => risk(b) - risk(a)));
  } catch (e) {
    storeLoaded = false;
    toast(e.message, 'error');
  }
}

function showView(name) {
  for (const v of $$('.view')) v.hidden = v.dataset.view !== name;
  for (const t of $$('.tab')) {
    t.classList.toggle('active', t.dataset.view === name);
    t.setAttribute('aria-selected', String(t.dataset.view === name));
  }
  currentView = name;
  $('.hero').hidden = !!M || name !== 'workspace';
  if (name === 'history') loadHistory();
  if (name === 'store') loadStore();
}

async function refreshQuota() {
  try {
    const q = await api.quota();
    const pct = Math.min(100, Math.round((q.neuronsUsed / q.neuronBudget) * 100));
    const pill = $('#quota-pill');
    pill.classList.toggle('exhausted', q.exhausted);
    pill.textContent = q.exhausted ? 'AI budget used up · rules mode' : `AI budget today · ${pct}% used`;
    pill.title = `Workers AI free tier shared by this demo: ${q.neuronsUsed.toLocaleString()} of ${q.neuronBudget.toLocaleString()} neurons used today (resets 00:00 UTC).`;
    const banner = $('#quota-banner');
    banner.hidden = !q.exhausted;
    if (q.exhausted) {
      banner.textContent = `Today's free Workers AI budget (10,000 neurons on Cloudflare's free plan) is used up. Allowance keeps working in rules-only mode: mandates are drafted by a parser, a deterministic shopper picks items, and the same code firewall and PayPal flow still apply. Full AI returns at ${new Date(q.resetsAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })} (00:00 UTC).`;
    }
  } catch {
    /* ignore */
  }
}

function loadScript(src) {
  return new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = src;
    s.async = true;
    s.onload = resolve;
    s.onerror = () => reject(new Error('PayPal SDK failed to load'));
    document.head.appendChild(s);
  });
}

async function initPayPal() {
  try {
    await loadScript(cfg.paypalSdkUrl);
    const sdk = await window.paypal.createInstance({ clientId: cfg.paypalClientId, components: ['paypal-payments'], pageType: 'checkout', locale: 'en-US' });
    const methods = await sdk.findEligibleMethods({ currencyCode: 'USD' });
    if (!methods.isEligible('paypal')) throw new Error('PayPal is not available in this browser');
    paypalSession = sdk.createPayPalOneTimePaymentSession({
      onApprove: (data) => approveOrder(data.orderId),
      onCancel: () => setPayPalStatus('Approval cancelled — no hold was placed.', true),
      onError: (err) => {
        console.error(err);
        setPayPalStatus('PayPal reported an error. Try again, or continue on PayPal.com.', true);
        $('#btn-redirect').hidden = false;
      },
    });
    paypalReady = true;
    $('#paypal-btn').addEventListener('click', startPayPal);
  } catch (e) {
    console.error(e);
    paypalReady = false;
    $('#btn-redirect').hidden = false;
    setPayPalStatus('PayPal buttons could not load here — use “Continue on PayPal”.', true);
  }
  render();
}

// ---------------------------------------------------------------- boot
async function boot() {
  agGrid.ModuleRegistry?.registerModules?.([agGrid.AllCommunityModule]);
  cfg = await api.config();
  catLabels = Object.fromEntries(cfg.categories.map((c) => [c.id, c.label]));
  if (cfg.repoUrl) {
    $('#repo-link').href = cfg.repoUrl;
    $('#repo-link').hidden = false;
  }
  initLedgerGrid();
  initHistoryGrid();
  initDonut();

  $('#btn-draft').addEventListener('click', draft);
  $('#rules-mode').addEventListener('change', (e) => {
    $('#btn-draft .btn-label').textContent = e.target.checked ? 'Draft mandate (rules only)' : 'Draft mandate with AI';
  });
  for (const c of $$('#presets .chip')) c.addEventListener('click', () => ($('#errand').value = c.dataset.errand));
  $('#f-title').addEventListener('input', (e) => schedulePatch({ title: e.target.value }));
  $('#f-list').addEventListener('change', (e) => schedulePatch({ shoppingList: e.target.value.split(',').map((x) => x.trim()).filter(Boolean) }));
  $('#f-budget').addEventListener('change', (e) => schedulePatch({ budgetCents: Math.round(Number(e.target.value) * 100) }));
  $('#f-cap').addEventListener('change', (e) => schedulePatch({ perItemCapCents: Math.round(Number(e.target.value) * 100) }));
  $('#f-qty').addEventListener('change', (e) => schedulePatch({ maxQuantity: Number(e.target.value) }));
  $('#f-exp').addEventListener('change', (e) => schedulePatch({ expiresAt: new Date(`${e.target.value}T23:59:00Z`).toISOString() }));
  $('#f-notes').addEventListener('change', (e) => schedulePatch({ notes: e.target.value.split('\n').map((s) => s.trim()).filter(Boolean) }));
  $('#btn-redirect').addEventListener('click', redirectToPayPal);
  $('#btn-run').addEventListener('click', () => runAgent());
  $('#btn-redteam').addEventListener('click', redteam);
  $('#btn-send').addEventListener('click', () => {
    const v = $('#instruction').value.trim();
    if (!v) return;
    $('#instruction').value = '';
    runAgent(v);
  });
  $('#instruction').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') $('#btn-send').click();
  });
  for (const c of $$('#nudges .chip')) c.addEventListener('click', () => runAgent(c.dataset.say));
  $('#btn-release').addEventListener('click', release);
  $('#btn-sync').addEventListener('click', () => syncPayPal(false));
  $('#btn-csv').addEventListener('click', () =>
    ledgerApi.exportDataAsCsv({
      fileName: `allowance-ledger-${M ? M.id.slice(0, 8) : 'empty'}.csv`,
      columnKeys: ['n', 'ts', 'item', 'amountCents', 'status', 'reason', 'policy', 'audit', 'paypal'],
      allColumns: true,
      processCellCallback: (p) => (p.column.getColId() === 'amountCents' ? (Number(p.value || 0) / 100).toFixed(2) : p.value),
    }),
  );
  $('#ledger-search').addEventListener('input', (e) => ledgerApi.setGridOption('quickFilterText', e.target.value));
  for (const b of $$('#ledger-filter button')) {
    b.addEventListener('click', () => {
      ledgerFilter = b.dataset.f;
      for (const x of $$('#ledger-filter button')) x.classList.toggle('active', x === b);
      ledgerApi.onFilterChanged();
    });
  }
  $('#store-search').addEventListener('input', (e) => storeApi?.setGridOption('quickFilterText', e.target.value));
  for (const t of $$('.tab')) t.addEventListener('click', () => showView(t.dataset.view));
  $('#btn-new').addEventListener('click', newErrand);
  $('#btn-history-refresh').addEventListener('click', loadHistory);

  // Return from the redirect fallback (PayPal sends ?paypal=return&m=<id>&token=<orderId>).
  const q = new URLSearchParams(location.search);
  if (q.get('paypal') && q.get('m')) {
    const id = q.get('m');
    history.replaceState(null, '', `${location.pathname}#m=${id}`);
    try {
      M = await api.get(id);
      if (q.get('paypal') === 'return' && q.get('token') && M.status === 'draft') M = await api.approve(id, q.get('token'));
      else if (q.get('paypal') === 'cancel') toast('PayPal approval cancelled.');
    } catch (e) {
      toast(e.message, 'error');
    }
  } else if (hashId()) {
    try {
      M = await api.get(hashId());
      $('#errand').value = M.terms.errand;
    } catch {
      setHash(null);
    }
  }
  render();
  refreshQuota();
  initPayPal();
  if (M?.paypal?.authorizationId) syncPayPal(true);
}

boot().catch((e) => {
  console.error(e);
  toast(`Could not start: ${e.message}`, 'error');
});
