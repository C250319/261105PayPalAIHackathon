# Allowance

**Give your AI agent an allowance, not your wallet.**

Allowance lets an AI agent shop for you while a **PayPal authorization hold** caps every cent it can spend. You describe an errand, AI turns it into a spending mandate, you approve the mandate once with PayPal, and the agent then buys on its own — each purchase is a **partial capture** against your hold, checked first by a code-level policy firewall and an independent AI auditor. Whatever the agent doesn't need is released by **voiding** the authorization.

**Live demo:** https://allowance.261105cn.workers.dev (PayPal **sandbox** only — no real money moves)

**Devpost text:** [SUBMISSION.md](SUBMISSION.md) · **License:** [MIT](LICENSE)

![Agent ledger in AG Grid: AI reasoning, policy firewall, AI auditor and PayPal IDs for every attempt](docs/gallery-3-ledger.png)

---

## The problem

AI agents are starting to buy things for people and businesses. Today you can either hand the agent a card (unlimited exposure to a hallucination, a prompt-injected product page or a hijacked chat) or approve every single purchase (no autonomy). Small teams, families and office managers who would happily delegate routine purchasing have no middle ground.

## The idea

Use PayPal's own payment primitives as the agent's leash:

| Step | What happens | PayPal / AI capability |
| --- | --- | --- |
| 1. Describe the errand | "Restock our office kitchen: coffee, oat milk and snacks for 12 people, two are vegan, under $80." | Workers AI drafts a structured **mandate**: hold amount, per-purchase cap, max units, allowed categories, shopping list, notes, expiry |
| 2. Approve once | The human approves the hold in the PayPal popup. Nothing is charged. | PayPal JS SDK v6 + Orders v2 `intent: AUTHORIZE` → `authorize` |
| 3. Agent shops | The agent picks items with tool calls (`buy`, `finish`). | Workers AI tool calling |
| 4. Every buy is checked | 12 deterministic policy checks, then an independent AI auditor. Flagged lines wait for the human. | Code firewall + Workers AI JSON-schema review |
| 5. Money moves | Each approved line becomes a partial capture against the hold. | Payments v2 `authorizations/{id}/capture` with `final_capture: false` |
| 6. Wrap up | Refund any line, then release the rest. AI writes a grounded recap. | `captures/{id}/refund`, `authorizations/{id}/void` |

The budget is not a number in a prompt — it is a PayPal authorization. Even a fully compromised agent cannot capture more than the human approved.

## How to use it

1. Open https://allowance.261105cn.workers.dev and keep the default errand (or pick **Office kitchen / Team picnic / Cleaning run**).
2. Click **Draft mandate with AI**. Review or edit the limits in step 2.
3. Click **Pay with PayPal** and approve the hold in the PayPal sandbox popup (**Complete Purchase**). If popups are blocked, use **Popup blocked? Continue on PayPal**.
4. Click **Start shopping** and watch the **Agent ledger** (AG Grid) fill in: the agent's reasoning, the firewall verdict, the AI auditor's note and the PayPal capture ID for every attempt.
5. Click **Red-team the agent** to simulate a hijacked agent (gift card, prompt-injected "sponsored" listing, $249 espresso machine, runaway quantity, hallucinated product) — all five are blocked and nothing reaches PayPal.
6. Talk to the agent, e.g. click **"Add a gift card"**: the agent tries, the firewall blocks it (gift cards are never allowed).
7. Use **Refund** on any captured line, **Allow / Deny** on lines the auditor flagged, then **Release unused $…** to void the rest of the hold. The **Mandates** tab lists every allowance with PayPal's authorization state and the AI recap; **Store catalog** shows the (deliberately hostile) demo store.

## How to test (judges)

- URL: https://allowance.261105cn.workers.dev — works in any desktop or mobile browser, nothing to install.
- PayPal sandbox buyer login: see **[SUBMISSION.md → For judges](SUBMISSION.md#for-judges)** (also in the Devpost testing instructions). Any other PayPal **sandbox** personal account works too.
- Full path in about two minutes: *Draft mandate with AI → Pay with PayPal (log in, Complete Purchase) → Start shopping → Red-team the agent → "Add a gift card" → Release unused → Mandates tab*.
- **Rules-only mode (no AI)** checkbox in step 1 runs the exact path the app falls back to when the shared Workers AI free tier is used up for the day.
- Automated end-to-end check (real sandbox login, captures, red team, void): `npm run e2e` (see below).

## How PayPal is used

All payment logic runs server-side in the Worker against the **PayPal sandbox REST APIs**; the browser uses the **PayPal JavaScript SDK v6**.

- **JS SDK v6** – `paypal.createInstance({ clientId, components: ["paypal-payments"] })`, `findEligibleMethods`, `createPayPalOneTimePaymentSession` with `presentationMode: "auto"` and the `<paypal-button>` web component. A redirect fallback (`payer-action` link → `return_url`) covers blocked popups.
- **Orders v2** – `POST /v2/checkout/orders` with `intent: "AUTHORIZE"` for the whole allowance, `POST /v2/checkout/orders/{id}/authorize` after approval, `GET /v2/checkout/orders/{id}` for reconciliation (**Sync with PayPal**).
- **Payments v2** – `POST /v2/payments/authorizations/{id}/capture` per purchase with `final_capture: false`, a unique `invoice_id` and a `PayPal-Request-Id` idempotency key; `POST /v2/payments/captures/{id}/refund`; `POST /v2/payments/authorizations/{id}/void` to release the rest.
- The authorized amount must equal the mandate's hold, the mandate is HMAC-signed and bound to the authorization ID, and every capture re-runs the policy check right before calling PayPal.
- Optional: `POST /api/paypal/webhook` verifies PayPal webhooks with `/v1/notifications/verify-webhook-signature` and marks ledger rows. It stays disabled unless a webhook ID is configured (not enabled on the hosted demo).

## How AI is used

Cloudflare **Workers AI**, model `@cf/mistralai/mistral-small-3.1-24b-instruct` (fallback `@cf/meta/llama-4-scout-17b-16e-instruct`):

1. **Mandate drafting** – JSON-schema output turns the errand into limits, categories, a shopping list and notes.
2. **Shopping agent** – tool calling (`buy`, `finish`) over the catalog; it sees each tool result (captured / blocked / waiting for human) and adapts. Seller listing text is marked as untrusted data.
3. **Independent auditor** – a second model call reviews every line that passed the firewall and can hold it for human approval ("needs you").
4. **Grounded recap** – when the hold is voided, a facts-only summary of what was bought, blocked and released (shown in the ledger and the Mandates grid).

**Free tier, by design.** The app tracks neurons in a Durable Object and stops at 9,000 of the 10,000 free daily neurons. A full AI run costs roughly 250–350 neurons. When the budget is gone (or Workers AI fails), a banner says so and the app keeps working in **rules-only mode**: a keyword parser drafts the mandate, a deterministic shopper fills the list, and the same firewall and PayPal flow apply. Full AI returns at 00:00 UTC.

## How AG Grid is used

AG Grid Community (v36, MIT, no license key) is the core of the UI; AG Charts Community draws the spend donut. Both are served from the Worker's own static assets, not a CDN.

- **Agent ledger** – one row per attempt with custom cell renderers: item + category chip, struck-through amounts for blocked lines, status badges, the AI agent's reasoning, the **policy firewall** verdict (hover for all 12 checks), the **AI auditor** verdict and note, PayPal capture/authorization/refund IDs, and in-row **Refund / Allow / Deny** buttons. Pinned totals row with the AI recap, quick filter, status filter (external filter), CSV export for accounting, row class rules and cell flashing when PayPal status changes, auto-height layout and a custom Quartz theme via the Theming API.
- **Mandates** – every allowance in this browser with hold, spent, released, blocked counts, PayPal authorization state and the AI recap, plus a pinned totals row.
- **Store catalog** – the demo store with floating filters, number filters and a highlighted "prompt injection" flag on hostile listings.

## Screenshots

| | |
| --- | --- |
| ![Workspace](docs/gallery-1-workspace.png) Workspace after an errand: signed mandate, PayPal-backed meter, agent console | ![PayPal approval](docs/gallery-2-paypal-approval.png) Approving the $80 hold in the PayPal sandbox popup |
| ![Ledger](docs/gallery-3-ledger.png) AG Grid ledger: captures, red-team blocks, release, AI recap | ![Grids](docs/gallery-4-mandates-and-store.png) Mandates history with AI recaps, and the hostile demo store |

## Safety design (defense in depth)

1. **PayPal hold** – the hard ceiling; captures can never exceed what the human authorized.
2. **Signed mandate** – terms are HMAC-SHA256-signed and bound to the PayPal authorization; tampering blocks every capture.
3. **Policy firewall (code)** – `MANDATE_ACTIVE`, `NOT_EXPIRED`, `SIGNATURE`, `KNOWN_PRODUCT`, `PLATFORM_RULES` (gift cards, alcohol), `CATEGORY`, `LISTING_SAFETY` (prompt-injection text in listings), `QUANTITY`, `LINE_CAP`, `NO_REPEAT`, `BUDGET`, `VELOCITY` — re-checked again right before each capture.
4. **AI auditor + human** – semantic review; flagged lines need a human **Allow**.
5. **Operational limits** – per-visitor daily rate limits, max $200 hold, max 14-day mandate, serialized state changes per mandate (Durable Object).

## Architecture

```mermaid
sequenceDiagram
  actor H as Human
  participant UI as Browser (AG Grid UI + PayPal JS SDK v6)
  participant W as Cloudflare Worker + Durable Object
  participant AI as Workers AI
  participant PP as PayPal sandbox
  H->>UI: Describe the errand
  UI->>W: POST /api/mandates
  W->>AI: Draft mandate (JSON schema)
  H->>UI: Pay with PayPal
  UI->>W: POST /order
  W->>PP: Orders v2 create (intent AUTHORIZE)
  H->>PP: Log in and approve in popup
  UI->>W: POST /approve
  W->>PP: Orders v2 authorize (hold placed)
  loop Agent turns
    UI->>W: POST /think
    W->>AI: Agent turn with tools (buy, finish)
    W->>W: Policy firewall (12 checks)
    W->>AI: Independent auditor (JSON schema)
    UI->>W: POST /lines/{id}/capture
    W->>PP: Payments v2 partial capture (final_capture=false)
  end
  H->>UI: Release unused
  W->>PP: Payments v2 void authorization
  W->>AI: Grounded recap
```

- `src/index.ts` – HTTP API router (static assets are served by Workers Static Assets)
- `src/mandate-do.ts` – one Durable Object per mandate: terms, PayPal state, agent transcript, ledger
- `src/guardrails.ts` – the deterministic policy firewall (unit-tested)
- `src/agent.ts` – agent prompt and tools, AI auditor, rules-only shopper, recap
- `src/ai.ts` – Workers AI wrapper: model fallback, tool-call parsing, neuron budget
- `src/paypal.ts` – PayPal REST client (token cache, idempotency keys)
- `src/quota-do.ts` – daily neuron budget and per-visitor rate limits
- `src/catalog.ts` – the fictional demo store, including hostile listings
- `public/` – the single-page app (`app.js`, `styles.css`, `index.html`)
- `scripts/` – E2E test, screenshot capture, demo-video recorder
- `test/` – unit tests for the firewall, parsers and rules-only shopper

## Run it yourself

Requirements: Node.js 20+, a Cloudflare account (free plan is enough), a PayPal developer sandbox REST app.

```bash
npm install
```

```bash
npx wrangler login
```

```bash
npx wrangler secret put PAYPAL_CLIENT_ID
```

```bash
npx wrangler secret put PAYPAL_CLIENT_SECRET
```

```bash
npx wrangler secret put MANDATE_SIGNING_KEY
```

```bash
npm run deploy
```

`MANDATE_SIGNING_KEY` is any long random string. For local development put the same three values in a `.dev.vars` file (git-ignored) and run `npm run dev`. Configuration that is safe to commit (PayPal sandbox endpoints, model names, the neuron budget) lives in `wrangler.jsonc`.

Tests:

```bash
npm test
```

```bash
BASE_URL=https://<your-worker>.workers.dev PAYPAL_SANDBOX_BUYER_EMAIL=... PAYPAL_SANDBOX_BUYER_PASSWORD=... npm run e2e
```

The E2E script needs Playwright with Chromium (`npm i -D playwright && npx playwright install chromium`). `npm run shots` captures the raw screenshots used for the gallery.

## Built with

PayPal JavaScript SDK v6 · PayPal Orders v2 and Payments v2 REST APIs (sandbox) · Cloudflare Workers, Durable Objects (SQLite), Workers Static Assets · Cloudflare Workers AI (Mistral Small 3.1 24B Instruct, Llama 4 Scout fallback) · AG Grid Community · AG Charts Community · TypeScript · Playwright

## License

[MIT](LICENSE) © 2026 Allowance contributors. Store items and brands in the demo catalog are fictional.
