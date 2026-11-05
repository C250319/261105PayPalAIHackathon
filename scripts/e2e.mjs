// End-to-end test against the deployed app, as a real sandbox buyer:
// draft mandate (AI) -> PayPal popup login + approval -> agent shops (captures) ->
// a blocked instruction -> release (void). Credentials are read from the environment and never printed.
//
//   BASE_URL=https://allowance.<subdomain>.workers.dev \
//   PAYPAL_SANDBOX_BUYER_EMAIL=... PAYPAL_SANDBOX_BUYER_PASSWORD=... npm run e2e
import { mkdirSync } from 'node:fs';
import { approveInPayPalPopup, BASE, buyer, chromium, waitAgentIdle } from './lib/browser.mjs';

const OUT = process.env.E2E_OUT || 'e2e-output';
buyer();
mkdirSync(OUT, { recursive: true });

const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);

async function main() {
  const browser = await chromium.launch();
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, locale: 'en-US' });
  const page = await context.newPage();
  page.on('pageerror', (e) => log('pageerror:', e.message));
  page.on('console', (m) => m.type() === 'error' && log('console error:', m.text().slice(0, 200)));

  log('open', BASE);
  await page.goto(BASE, { waitUntil: 'networkidle' });
  await page.locator('#presets .chip').first().click();
  if (process.env.E2E_RULES) await page.locator('#rules-mode').check(); // exercise the no-AI fallback path
  await page.locator('#btn-draft').click();
  await page.waitForFunction(() => document.querySelector('#f-budget')?.value !== '', null, { timeout: 60000 });
  const mandateId = await page.evaluate(() => (location.hash.match(/m=([a-f0-9]{32})/) || [])[1]);
  log('mandate drafted', mandateId, 'budget', await page.locator('#f-budget').inputValue());
  await page.screenshot({ path: `${OUT}/01-drafted.png` });

  const btn = page.locator('paypal-button');
  await btn.waitFor({ state: 'visible', timeout: 60000 });
  const [popup] = await Promise.all([context.waitForEvent('page', { timeout: 60000 }), btn.click()]);
  log('PayPal popup opened');
  await approveInPayPalPopup(popup, { beforeSubmit: (p) => p.screenshot({ path: `${OUT}/02-paypal-review.png` }) });
  await page.waitForFunction(() => document.querySelector('#m-status')?.textContent?.includes('Hold active'), null, { timeout: 90000 });
  log('hold active:', await page.locator('#m-auth').textContent());
  await page.screenshot({ path: `${OUT}/03-hold.png` });

  await page.locator('#btn-run').click();
  await waitAgentIdle(page);
  await page.waitForTimeout(800);
  await page.screenshot({ path: `${OUT}/04-shopped.png` });

  const state1 = await (await fetch(`${BASE}/api/mandates/${mandateId}`)).json();
  const captured = state1.ledger.filter((r) => r.status === 'captured');
  log('agent finished; captured lines:', captured.length, 'blocked:', state1.totals.blocked, 'spent', state1.totals.netSpentCents / 100);
  for (const r of state1.ledger) log('  ', r.id, r.status.padEnd(14), (r.amountCents / 100).toFixed(2).padStart(7), r.item.slice(0, 44), '|', r.policy?.rule || '', '|', r.paypal?.id || '');
  if (!captured.length) throw new Error('Agent captured nothing');

  await page.locator('#btn-redteam').click();
  await page.waitForFunction(() => document.querySelector('#btn-redteam')?.textContent?.includes('done'), null, { timeout: 60000 });
  const stateR = await (await fetch(`${BASE}/api/mandates/${mandateId}`)).json();
  const drill = stateR.ledger.filter((r) => r.redteam);
  log('red-team drill:', drill.map((r) => `${r.productId}:${r.status}/${r.policy?.rule}`).join(' '));
  if (drill.length !== 5 || drill.some((r) => r.paypal)) throw new Error('Red-team drill misbehaved');

  await page.locator('#nudges .chip').nth(1).click();
  await page.waitForFunction(() => !document.querySelector('#btn-send').disabled, null, { timeout: 120000 });
  const state2 = await (await fetch(`${BASE}/api/mandates/${mandateId}`)).json();
  const gift = state2.ledger.find((r) => !r.redteam && r.productId?.startsWith('GC'));
  log('gift card attempt:', gift ? `${gift.status} (${gift.policy?.rule})` : 'agent declined on its own');
  await page.screenshot({ path: `${OUT}/05-instruction.png` });

  await page.locator('#btn-release').click();
  await page.waitForFunction(() => document.querySelector('#m-status')?.textContent?.includes('Closed'), null, { timeout: 60000 });
  await page.locator('#btn-sync').click().catch(() => undefined);
  await page.waitForTimeout(2500);
  const state3 = await (await fetch(`${BASE}/api/mandates/${mandateId}`)).json();
  log('closed:', state3.status, 'authorization', state3.paypal.authorizationStatus, 'released', state3.totals.releasedCents / 100);
  await page.screenshot({ path: `${OUT}/06-released.png`, fullPage: true });
  if (state3.paypal.authorizationStatus !== 'VOIDED') throw new Error('Authorization was not voided');
  await browser.close();
  log('E2E PASSED');
}

main().catch((e) => {
  console.error('E2E FAILED:', e.message);
  process.exit(1);
});
