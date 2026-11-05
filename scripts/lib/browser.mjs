// Shared Playwright helpers for the E2E test, gallery screenshots and the demo video.
// Sandbox buyer credentials are read from the environment and never printed or captured:
// screenshots/video only show the PayPal review page, which shows no email or password.
import { createRequire } from 'node:module';

export const { chromium } = createRequire(import.meta.url)('playwright');
export const BASE = process.env.BASE_URL || 'https://allowance.261105cn.workers.dev';

export function buyer() {
  const email = process.env.PAYPAL_SANDBOX_BUYER_EMAIL;
  const password = process.env.PAYPAL_SANDBOX_BUYER_PASSWORD;
  if (!email || !password) throw new Error('Set PAYPAL_SANDBOX_BUYER_EMAIL and PAYPAL_SANDBOX_BUYER_PASSWORD');
  return { email, password };
}

/** Log in inside the PayPal popup and approve. `beforeSubmit` runs on the review page (safe to capture). */
export async function approveInPayPalPopup(popup, { beforeSubmit, onLoginStart, onLoginEnd } = {}) {
  const { email, password } = buyer();
  await popup.waitForLoadState('domcontentloaded');
  const emailBox = popup.locator('#email, #login_email, input[name="login_email"]').first();
  await emailBox.waitFor({ state: 'visible', timeout: 60000 });
  if (onLoginStart) await onLoginStart();
  await emailBox.fill(email);
  const next = popup.locator('#btnNext');
  if (await next.isVisible().catch(() => false)) await next.click();
  const pw = popup.locator('#password, input[name="login_password"]').first();
  await pw.waitFor({ state: 'visible', timeout: 60000 });
  await pw.fill(password);
  await popup.locator('#btnLogin, button[name="btnLogin"]').first().click();
  const submit = popup.locator('#payment-submit-btn, button[data-id="payment-submit-btn"]').first();
  await submit.waitFor({ state: 'visible', timeout: 90000 });
  await popup.waitForTimeout(1000);
  if (onLoginEnd) await onLoginEnd();
  if (beforeSubmit) await beforeSubmit(popup);
  await submit.click();
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function waitAgentIdle(page, timeout = 180000) {
  await page.waitForFunction(() => {
    const btn = document.querySelector('#btn-run');
    const t = btn?.querySelector('.btn-label')?.textContent || '';
    return !btn.classList.contains('loading') && (t.includes('done') || t.includes('Continue') || t.includes('closed'));
  }, null, { timeout });
}
