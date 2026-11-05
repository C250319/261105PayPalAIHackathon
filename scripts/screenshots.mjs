// Captures raw full-page screenshots of every state of a real run against the deployed app
// (2x device scale). scripts/make_gallery.py then crops/composites them into docs/gallery-*.png.
//   SHOTS_DIR=/tmp/shots npm run shots
// Login screens are never captured: only the PayPal review page (no email/password on it).
import { mkdirSync, writeFileSync } from 'node:fs';
import { approveInPayPalPopup, BASE, buyer, chromium, sleep, waitAgentIdle } from './lib/browser.mjs';

const OUT = process.env.SHOTS_DIR || 'shots-output';
mkdirSync(OUT, { recursive: true });
buyer();
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);

const browser = await chromium.launch();
const context = await browser.newContext({ viewport: { width: 1440, height: 960 }, deviceScaleFactor: 2, locale: 'en-US' });
const page = await context.newPage();
const meta = { boxes: {} };
// Full-page screenshot plus the page-relative boxes of the main cards (used for cropping).
const full = async (name) => {
  await page.screenshot({ path: `${OUT}/${name}.png`, fullPage: true });
  meta.boxes[name] = await page.evaluate(() => {
    const out = {};
    for (const sel of ['.hero', '#step1', '#step2', '#step3', '#meter', '#ledger-card', '#view-history .card', '#view-store .card', '.topbar']) {
      const el = document.querySelector(sel);
      if (!el || el.offsetParent === null) continue;
      const r = el.getBoundingClientRect();
      out[sel] = { x: r.left + scrollX, y: r.top + scrollY, w: r.width, h: r.height };
    }
    return out;
  });
};

await page.goto(BASE, { waitUntil: 'networkidle' });
await sleep(800);
await full('01-landing');

await page.locator('#btn-draft').click();
await page.waitForFunction(() => document.querySelector('#f-budget')?.value !== '', null, { timeout: 60000 });
await sleep(700);
await full('02-drafted');
meta.mandateId = await page.evaluate(() => (location.hash.match(/m=([a-f0-9]{32})/) || [])[1]);
log('drafted', meta.mandateId);

const [popup] = await Promise.all([context.waitForEvent('page'), page.locator('paypal-button').click()]);
await approveInPayPalPopup(popup, {
  beforeSubmit: async (p) => {
    await p.screenshot({ path: `${OUT}/03-paypal-popup.png` });
    meta.popupViewport = p.viewportSize();
    await page.screenshot({ path: `${OUT}/03-paypal-main.png` });
  },
});
await page.waitForFunction(() => document.querySelector('#m-status')?.textContent?.includes('Hold active'), null, { timeout: 90000 });
await sleep(600);
await full('04-approved');
log('approved');

await page.locator('#btn-run').click();
await waitAgentIdle(page);
await sleep(1200);
await full('05-shopped');
log('shopped');

await page.locator('#btn-redteam').click();
await page.waitForFunction(() => document.querySelector('#btn-redteam')?.textContent?.includes('done'), null, { timeout: 60000 });
await sleep(1000);
await full('06-redteam');

await page.locator('#nudges .chip').nth(1).click();
await waitAgentIdle(page);
await sleep(800);
await full('07-instruction');

await page.locator('#btn-release').click();
await page.waitForFunction(() => document.querySelector('#m-status')?.textContent?.includes('Closed'), null, { timeout: 90000 });
await sleep(1500);
await full('08-closed');
log('closed');

await page.locator('.tab[data-view="history"]').click();
await sleep(2500);
await full('09-mandates');
await page.locator('.tab[data-view="store"]').click();
await sleep(2000);
await full('10-store');

writeFileSync(`${OUT}/meta.json`, JSON.stringify(meta, null, 2));
await browser.close();
log('done ->', OUT);
