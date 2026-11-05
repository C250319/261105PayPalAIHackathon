// Records the demo against the deployed app: CDP screencast frames (1920x1080) of the main page
// and of the PayPal popup, plus timestamped markers. scripts/make_video.py turns them into the
// narrated, subtitled MP4. The PayPal login screens are recorded but never used in the video
// (a "credentials hidden" card covers that part), so no email or password appears.
//   VIDEO_DIR=/tmp/video npm run record
import { mkdirSync, writeFileSync } from 'node:fs';
import { approveInPayPalPopup, BASE, buyer, chromium, sleep, waitAgentIdle } from './lib/browser.mjs';

const OUT = process.env.VIDEO_DIR || 'video-output';
const ZOOM = 1.2; // 1600x900 CSS layout rendered crisply at 1920x1080
for (const d of ['main', 'popup', 'cards']) mkdirSync(`${OUT}/${d}`, { recursive: true });
buyer();
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
const markers = [];
const mark = (name, extra = {}) => {
  markers.push({ name, t: Date.now() / 1000, ...extra });
  log('mark', name);
};

const ERRAND = 'Restock our office kitchen for next week: coffee, oat milk and snacks for 12 people. Two of us are vegan. Keep it under $80.';

async function screencast(context, page, dir) {
  const client = await context.newCDPSession(page);
  const frames = [];
  client.on('Page.screencastFrame', ({ data, metadata, sessionId }) => {
    const file = `${dir}/${String(frames.length).padStart(6, '0')}.jpg`;
    writeFileSync(`${OUT}/${file}`, Buffer.from(data, 'base64'));
    frames.push({ file, t: metadata.timestamp });
    client.send('Page.screencastFrameAck', { sessionId }).catch(() => {});
  });
  await client.send('Page.startScreencast', { format: 'jpeg', quality: 92, everyNthFrame: 1 });
  return { frames, stop: () => client.send('Page.stopScreencast').catch(() => {}) };
}

const browser = await chromium.launch();
const context = await browser.newContext({ viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 1, locale: 'en-US' });
// Zoom + a visible fake cursor, only on the Allowance page itself (not PayPal's pages).
await context.addInitScript(({ zoom, host }) => {
  if (window.top !== window || location.host !== host) return;
  document.addEventListener('DOMContentLoaded', () => {
    document.documentElement.style.zoom = String(zoom);
    const st = document.createElement('style');
    st.textContent = `#__cur{position:fixed;left:0;top:0;width:30px;height:30px;z-index:2147483647;pointer-events:none;transition:transform .7s cubic-bezier(.3,.7,.2,1)}
      .__rip{position:fixed;width:44px;height:44px;margin:-22px 0 0 -22px;border-radius:50%;background:rgba(13,122,95,.38);pointer-events:none;z-index:2147483646;animation:__r .65s ease-out forwards}
      @keyframes __r{from{transform:scale(.25);opacity:1}to{transform:scale(1.5);opacity:0}}
      .card{scroll-margin-top:78px}`;
    document.head.appendChild(st);
    const c = document.createElement('div');
    c.id = '__cur';
    c.innerHTML = '<svg width="30" height="30" viewBox="0 0 24 24"><path d="M4 2.5l15 8.2-6.6 1.6-3.3 6.2z" fill="#0d1726" stroke="#fff" stroke-width="1.6" stroke-linejoin="round"/></svg>';
    c.style.transform = 'translate(800px, 450px)';
    document.body.appendChild(c);
  });
  window.__moveCursor = (x, y) => {
    const c = document.getElementById('__cur');
    if (c) c.style.transform = `translate(${x - 4}px, ${y - 3}px)`;
  };
  window.__ripple = (x, y) => {
    const r = document.createElement('div');
    r.className = '__rip';
    r.style.left = `${x}px`;
    r.style.top = `${y}px`;
    document.body.appendChild(r);
    setTimeout(() => r.remove(), 800);
  };
}, { zoom: ZOOM, host: new URL(BASE).host });

const page = await context.newPage();
const mainCast = await screencast(context, page, 'main');
let popupCast = null;
let popupBox = null;

/** Move the fake cursor to an element (coordinates are converted into the zoomed CSS space), then click it. */
async function clickEl(locator, { pause = 450 } = {}) {
  await locator.scrollIntoViewIfNeeded();
  const b = await locator.boundingBox();
  const x = (b.x + b.width / 2) / ZOOM;
  const y = (b.y + b.height / 2) / ZOOM;
  await page.evaluate(([x, y]) => window.__moveCursor(x, y), [x, y]);
  await sleep(750);
  await page.evaluate(([x, y]) => window.__ripple(x, y), [x, y]);
  await sleep(120);
  await locator.click();
  await sleep(pause);
}
const scrollTo = async (y) => {
  await page.evaluate((y) => window.scrollTo({ top: y, behavior: 'smooth' }), y);
  await sleep(900);
};
/** Smooth-scroll a card into view (cards get a scroll margin below the sticky top bar). */
const scrollToEl = async (sel, block = 'start') => {
  await page.evaluate(([sel, block]) => document.querySelector(sel)?.scrollIntoView({ behavior: 'smooth', block }), [sel, block]);
  await sleep(1000);
};

// ---- 1. landing
await page.goto(BASE, { waitUntil: 'networkidle' });
await sleep(1200);
mark('start');
await sleep(3500);

// ---- 2. errand + AI draft
mark('type_start');
const ta = page.locator('#errand');
await clickEl(ta, { pause: 150 });
await page.keyboard.press('Control+A');
await page.keyboard.press('Delete');
await page.keyboard.type(ERRAND, { delay: 22 });
mark('type_end');
await sleep(500);
await clickEl(page.locator('#btn-draft'), { pause: 100 });
mark('draft_click');
await page.waitForFunction(() => document.querySelector('#f-budget')?.value !== '', null, { timeout: 60000 });
mark('drafted');
await sleep(1500);
await scrollToEl('#step2');
mark('mandate_view');
await sleep(5000);

// ---- 3. PayPal approval (popup)
let popupSeen = false;
context.on('page', async (p) => {
  if (popupSeen) return; // only the PayPal popup is recorded
  popupSeen = true;
  popupCast = await screencast(context, p, 'popup');
  mark('popup_open', { viewport: p.viewportSize() });
});
const payBtn = page.locator('paypal-button');
const popupPromise = context.waitForEvent('page', { timeout: 60000 });
await clickEl(payBtn, { pause: 0 });
const popup = await popupPromise;
await approveInPayPalPopup(popup, {
  onLoginEnd: async () => {
    mark('login_end');
    await sleep(3200);
    const b = await popup.locator('#payment-submit-btn, button[data-id="payment-submit-btn"]').first().boundingBox();
    popupBox = b;
    mark('popup_click', { box: b, viewport: popup.viewportSize() });
    await sleep(700);
  },
});
await page.waitForFunction(() => document.querySelector('#m-status')?.textContent?.includes('Hold active'), null, { timeout: 90000 });
mark('hold_active');
await popupCast?.stop();
await sleep(800);
await scrollTo(0);
mark('hold_view');
await sleep(5000);

// ---- 4. agent shops
await clickEl(page.locator('#btn-run'), { pause: 0 });
mark('run_click');
await waitAgentIdle(page);
mark('shopped');
await sleep(2500);
await scrollToEl('#ledger-card');
mark('ledger_view');
await sleep(7000);

// ---- 5. red team
await scrollToEl('#step3');
await clickEl(page.locator('#btn-redteam'), { pause: 0 });
mark('redteam_click');
await page.waitForFunction(() => document.querySelector('#btn-redteam')?.textContent?.includes('done'), null, { timeout: 60000 });
await sleep(2500);
mark('redteam_console');
await scrollToEl('#ledger-card');
mark('redteam_ledger');
await sleep(3000);
const policyCell = page.locator('#ledger-grid .ag-row', { hasText: 'SPONSORED' }).locator('[col-id="policy"]').first();
if (await policyCell.count()) {
  const b = await policyCell.boundingBox();
  await page.evaluate(([x, y]) => window.__moveCursor(x, y), [(b.x + b.width / 2) / ZOOM, (b.y + b.height / 2) / ZOOM]);
  await sleep(700);
  await policyCell.hover();
  mark('tooltip');
  await sleep(4500);
}
mark('redteam_end');

// ---- 6. forbidden instruction in chat
await scrollToEl('#step3');
await clickEl(page.locator('#nudges .chip').nth(1), { pause: 0 });
mark('gift_click');
await waitAgentIdle(page);
await sleep(3500);
mark('gift_done');

// ---- 7. release
await scrollTo(0);
await clickEl(page.locator('#btn-release'), { pause: 0 });
mark('release_click');
await page.waitForFunction(() => document.querySelector('#m-status')?.textContent?.includes('Closed'), null, { timeout: 90000 });
await sleep(4500);
mark('released');
await scrollToEl('#ledger-card', 'end');
mark('ledger_final');
await sleep(4500);

// ---- 8. mandates + store
await scrollTo(0);
await clickEl(page.locator('.tab[data-view="history"]'), { pause: 0 });
mark('mandates_view');
await sleep(5500);
await clickEl(page.locator('.tab[data-view="store"]'), { pause: 0 });
mark('store_view');
await sleep(4500);
mark('end');
await mainCast.stop();

const mandateId = await page.evaluate(() => {
  try {
    return JSON.parse(localStorage.getItem('allowance.mandates.v1') || '[]')[0];
  } catch {
    return null;
  }
});
const state = await (await fetch(`${BASE}/api/mandates/${mandateId}`)).json();

// ---- title / end / login-cover cards rendered as HTML for crisp text
const cardContext = await browser.newContext({ viewport: { width: 1920, height: 1080 } });
const card = async (name, html) => {
  const p = await cardContext.newPage();
  await p.setContent(html, { waitUntil: 'load' });
  await p.evaluate(() => document.fonts.ready);
  await sleep(600);
  await p.screenshot({ path: `${OUT}/cards/${name}.png` });
  await p.close();
};
const logo = `<svg width="120" height="120" viewBox="0 0 64 64"><rect width="64" height="64" rx="16" fill="#0d7a5f"/><path d="M18 15h28" stroke="#a7f3d0" stroke-width="5" stroke-linecap="round"/><circle cx="32" cy="37" r="15" fill="none" stroke="#fff" stroke-width="5"/><path d="M36.5 31.8c-.8-1.6-2.5-2.5-4.6-2.5-2.6 0-4.4 1.4-4.4 3.3 0 4.6 9.3 2.4 9.3 7.3 0 2-1.9 3.5-4.7 3.5-2.2 0-4-1-4.9-2.7M32 26.6v2.7M32 43.4v2.7" fill="none" stroke="#fff" stroke-width="2.8" stroke-linecap="round"/></svg>`;
const shell = (body) => `<!doctype html><html><head><link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;600;800&display=swap" rel="stylesheet"><style>
  body{margin:0;width:1920px;height:1080px;display:flex;align-items:center;justify-content:center;font-family:Inter,sans-serif;color:#ecfdf5;
  background:radial-gradient(120% 140% at 0% 0%,#0f8a6a 0%,#075240 55%,#04362a 100%)}
  .w{display:flex;flex-direction:column;align-items:center;gap:28px;text-align:center}
  h1{font-size:96px;margin:0;font-weight:800;letter-spacing:-.03em;color:#fff} h2{font-size:46px;margin:0;font-weight:600;color:#d1fae5}
  h2 em{font-style:normal;color:#a7f3d0} p{font-size:30px;margin:0;color:#bfe8d8} .pill{font-size:24px;padding:10px 22px;border-radius:999px;background:rgba(255,255,255,.1);border:1px solid rgba(255,255,255,.18)}
  .row{display:flex;gap:16px;flex-wrap:wrap;justify-content:center;margin-top:12px}</style></head><body>${body}</body></html>`;
await card(
  'title',
  shell(`<div class="w">${logo}<h1>Allowance</h1><h2>Give your AI agent an <em>allowance</em>, not your wallet.</h2>
  <div class="row"><span class="pill">PayPal JS SDK v6 + Orders/Payments v2</span><span class="pill">Cloudflare Workers AI</span><span class="pill">AG Grid Community</span></div></div>`),
);
await card(
  'end',
  shell(`<div class="w">${logo}<h1>Allowance</h1><h2>PayPal holds the money. AI runs the errand. <em>You stay in control.</em></h2>
  <p style="margin-top:18px">Live demo: ${BASE.replace('https://', '')}</p><p>PayPal sandbox · open source (MIT)</p></div>`),
);
await cardContext.close();
const loginContext = await browser.newContext({ viewport: { width: 568, height: 750 }, deviceScaleFactor: 2 });
const loginPage = await loginContext.newPage();
const loginCard = async (html) => {
  await loginPage.setContent(html, { waitUntil: 'load' });
  await loginPage.evaluate(() => document.fonts.ready);
  await sleep(500);
  await loginPage.screenshot({ path: `${OUT}/cards/login.png` });
};
await loginCard(
  `<!doctype html><html><head><link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;600;800&display=swap" rel="stylesheet"><style>
  body{margin:0;width:568px;height:750px;display:flex;align-items:center;justify-content:center;background:#fff;font-family:Inter,sans-serif;color:#1f2a3d}
  .w{display:flex;flex-direction:column;align-items:center;gap:22px;text-align:center;padding:40px}
  .pp{font-size:30px;font-weight:700;color:#1f2a3d} .t{font-size:24px;font-weight:600} .s{font-size:18px;color:#5b6678;line-height:1.5}
  .sp{width:44px;height:44px;border-radius:50%;border:5px solid #dbe3ee;border-top-color:#0070e0}</style></head><body><div class="w">
  <div class="pp">PayPal sandbox login</div><div class="sp"></div><div class="t">Logging in as the sandbox test buyer…</div>
  <div class="s">Login screens are hidden in this video.<br>Credentials are in the Devpost testing instructions.</div></div></body></html>`,
);

writeFileSync(
  `${OUT}/recording.json`,
  JSON.stringify({ zoom: ZOOM, markers, main: mainCast.frames, popup: popupCast ? popupCast.frames : [], popupBox, state }, null, 1),
);
await browser.close();
log('frames', mainCast.frames.length, 'popup', popupCast ? popupCast.frames.length : 0, '->', OUT);
