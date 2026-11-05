# Allowance

**Give your AI agent an allowance, not your wallet.**

Allowance is a policy wallet that sits between any AI agent and PayPal. You write your spending rules in plain English, an
AI turns them into exact limits, and your agent gets one tool, `request_purchase`, instead of your card. Every request goes
through your rules and an AI risk review. Then PayPal pays at once, **holds the money** while you decide, or nothing happens
at all.

Built for the [PayPal AI Hackathon](https://paypalaihackathon.devpost.com/). MIT licensed. It runs on the real PayPal
sandbox: [docs/SANDBOX_PROOF.md](docs/SANDBOX_PROOF.md) lists the orders, authorizations and captures of a recorded run.

![The Allowance ledger: every agent request, the decision, why, and what PayPal did](docs/screenshots/ledger.png)

## Why

AI agents can now shop and pay. Handing one your wallet is risky:

- it can overspend;
- it can buy the wrong thing;
- a web page can **prompt-inject** it into paying a scammer. Text hidden from people is still text to an agent.

People need what parents give teenagers: an allowance with rules, and a phone call for anything unusual.

## What it does

1. **Plain-English rules, compiled by AI.** "Up to €50 per purchase for office supplies, €150 a week in total. Anything
   else, ask me. Never gift cards or crypto." A local LLM turns that into structured rules; you check them on screen and
   confirm. Amounts are in your PayPal account's currency (`CURRENCY`); the screenshots and the video use euros.
2. **One door for the agent.** The agent never sees payment details. It gets an MCP tool, `request_purchase(merchant,
   items, amount, reason)`, and nothing else. Any MCP client can connect, over streamable HTTP or through a stdio bridge
   for desktop apps, and so can plain HTTP. The demo agent uses the official MCP TypeScript SDK.
3. **Two checks on every request.**
   - Deterministic rules: per-purchase limit, hard limit, weekly budget (money on hold counts), categories, merchants.
     Always on: the items must add up to the total, gift cards and crypto are recognised even when the agent files them as
     "office supplies", and instructions aimed at AI inside a request block it.
   - An AI risk review of the agent's stated reason against your intent: fees demanded by a page, "pay our partner",
     urgency, "pay to unlock", a merchant that does not match the item. **It can only make a decision stricter, never
     looser**, so a wrong or missing AI answer can never cost money.
   - Every decision comes with a one-line explanation, written for you.
4. **PayPal does the money part** (sandbox, Orders v2):
   - **approve**: an order with intent `CAPTURE`, paid from your linked PayPal wallet;
   - **ask you**: an order with intent `AUTHORIZE`. The money is held, not taken. You get an approval card: **Approve
     captures** the authorization, **Deny voids** it, and so do 24 hours without an answer. The hold is the cooling-off
     period;
   - **block**: no order is created, and the agent is told why and not to work around it.

   <img src="docs/screenshots/approval-card.png" alt="An approval card: PayPal holds €89 until the owner approves or denies" width="400">

5. **A live ledger built on AG Grid**: every request from every agent with the decision, the explanation and the PayPal
   status. Approve and deny inside the row, filters by outcome and agent, search, totals and CSV export.
6. **Insights, built with AG Studio**: a dashboard over the same requests, themed like the rest of the app.
   - Where the money went (paid, held, kept from leaving, stopped by the AI), spend by agent and outcome, who decided,
     and every request.
   - **Agent watchlist**, a custom widget: one card per agent with what it paid and what was blocked; a click
     cross-filters the whole dashboard to that agent.
   - **An AI assistant** inside AG Studio's agent framework, on the same local model: the *Allowance auditor* answers
     questions such as "which agents tried to pay for things they should not have?" from the ledger, adds ready-made
     charts on request, and can hand anything else to Studio's own agents. **Customize** opens the editor and the
     assistant.

   ![Insights, built with AG Studio: where the money went, the agent watchlist, spend by agent and who decided](docs/screenshots/insights.png)

## Try it in five minutes

You need [Node.js](https://nodejs.org) 22.13 or newer. [Ollama](https://ollama.com) is optional (it runs the AI locally and
for free). A PayPal developer account is optional too: without one, Allowance runs a clearly labelled offline simulation.

```bash
git clone https://github.com/antivex/allowance.git
cd allowance
npm install
npm run setup             # creates .env and checks Node and the AI endpoint
ollama pull qwen3.5:4b    # optional: the default local model
npm start                 # builds, then serves http://localhost:4000
```

1. Open <http://localhost:4000>, go to **Rules** and press **Confirm rules** (or write your own and press **Draft rules
   with AI** first).
2. In a second terminal run the demo agent: `npm run demo`.
3. Watch the ledger fill up, then approve the held desk chair on its card. The agent sees your answer and reports back.

### Use the real PayPal sandbox

1. On [developer.paypal.com](https://developer.paypal.com), open **Apps & Credentials**, stay on **Sandbox**, and create
   an app. Copy its client ID and secret into `.env` as `PAYPAL_CLIENT_ID` and `PAYPAL_CLIENT_SECRET`, and set `CURRENCY`
   to the currency of your sandbox business account (EUR for an Italian one, for example): the example rules and the
   demo shop follow it.
2. Restart with `npm start`. The header now says **PayPal Sandbox**.
3. In **Agents & setup**, press **Link PayPal**, sign in with one of your sandbox *personal* accounts (**Testing Tools →
   Sandbox Accounts**) and agree. PayPal stores the wallet (Vault) and gives Allowance a token; Allowance never sees card
   or bank details, and agents never see the token.
4. Confirm the rules, then run `npm run proof:sandbox`. It sends four purchases as an agent and plays the owner: one paid
   at once, one blocked, one held and approved (captured), one held and denied (voided). It writes
   [docs/SANDBOX_PROOF.md](docs/SANDBOX_PROOF.md) with the ids PayPal returned; ours is in the repo.

If linking fails with a permission error, make sure the app has the Vault (save payment methods) feature enabled. Set
`PAYPAL_RECORD_DIR` to keep every PayPal request and response of a run, with credentials redacted.

## Connect your own agent

Create a token for each agent in **Agents & setup**: the ledger then shows who asked for what, and you can revoke any
agent. The page shows ready-to-paste snippets with your token filled in.

**A desktop client that launches local processes**, for example Claude Desktop (`claude_desktop_config.json`, then
restart it; Allowance must be running):

```json
{
  "mcpServers": {
    "allowance": {
      "command": "node",
      "args": ["/path/to/allowance/dist/server/mcp/stdio.js"],
      "env": { "ALLOWANCE_URL": "http://localhost:4000", "ALLOWANCE_AGENT_TOKEN": "<agent token>" }
    }
  }
}
```

**Any MCP client over HTTP**, for example Claude Code:

```bash
claude mcp add --transport http allowance http://localhost:4000/mcp --header "Authorization: Bearer <agent token>"
```

**Plain HTTP:** `POST /api/agent/purchases` with the same bearer token and a JSON body
`{ "merchant", "items": [{ "name", "quantity", "unit_price", "category" }], "amount", "reason", "merchant_url"?, "source_url"? }`.

The MCP server exposes two tools: `request_purchase` and the read-only `get_purchase_status`, so an agent can learn what
you decided about a held purchase.

## How a decision is made

```mermaid
flowchart LR
  agent["AI agent"] -- "request_purchase (MCP)" --> rules{"Your rules"}
  rules -- "block" --> blocked["Blocked: no PayPal order"]
  rules -- "approve or ask" --> review{"AI risk review<br/>(only stricter)"}
  review -- "approve" --> capture["Order, intent CAPTURE:<br/>paid from the linked wallet"]
  review -- "ask" --> hold["Order, intent AUTHORIZE:<br/>money held"]
  review -- "block" --> blocked
  hold -- "you approve" --> captured["Authorization captured"]
  hold -- "you deny, or 24 h pass" --> voided["Authorization voided"]
```

- The rules run first and are pure functions, unit-tested in `server/test/policy.test.ts`.
- The AI review sees your rules in your own words and the request. Text the agent copied from web pages is marked as data,
  never instructions. If the model does not answer, purchases the rules would pay wait for you instead (`AI_ON_FAILURE`).
- Every PayPal call that creates an order or moves money carries an idempotency key (`PayPal-Request-Id`), so a retry
  never pays twice.

## PayPal APIs used

| API | Calls | What for |
|---|---|---|
| Vault v3 | `POST /v3/vault/setup-tokens`, `POST /v3/vault/payment-tokens`, `DELETE /v3/vault/payment-tokens/{id}` | Link the owner's PayPal wallet once; unlink it |
| Orders v2 | `POST /v2/checkout/orders` with `payment_source.paypal.vault_id`, intent `CAPTURE` or `AUTHORIZE` | Pay at once, or hold the money |
| Payments v2 | `POST /v2/payments/authorizations/{id}/capture`, `POST /v2/payments/authorizations/{id}/void` | Your approve and deny buttons, and the 24-hour auto-void |

Who gets the money: in the sandbox every order is paid to the business account of your PayPal REST app, which stands in
for the shop. Paying each merchant's own PayPal account is the next step.

## AI used

- **Rule compiler**: plain English to structured rules (JSON, validated with zod). You confirm them before they apply.
- **Risk reviewer**: a verdict (`approve`, `ask`, `block`), red flags and a one-line explanation for every purchase the
  rules would not block.
- **Default model**: [Qwen3.5 4B](https://ollama.com/library/qwen3.5) through Ollama, so nothing leaves your machine. Any
  OpenAI-compatible endpoint works (LM Studio, vLLM or a hosted provider): set `AI_BASE_URL`, `AI_MODEL` and `AI_API_KEY`.
- **Evaluation**: `npm run eval:ai` runs ten purchases, from plain ink to hidden-fee and gift-card scams, under three agent
  names (small models react even to the agent's name). On 4 Nov 2026 `qwen3.5:4b` gave the expected verdict in all 30
  reviews. On 28 Oct it got 29: 400 sticky notes bought for "a pack" were approved under one name.
- **Insights assistant**: AG Studio's agent framework, driven through a small adapter for OpenAI-compatible chat
  completions (`web/src/components/insightsAi.ts`). The browser calls Allowance's server, which adds the model and the key,
  so neither reaches the page. The auditor has two tools of its own (the ledger's requests, and ready-made charts) and
  delegates other widget requests to Studio's planning, data, page and widget agents. A small model handles the first
  two reliably; building arbitrary widgets through Studio's agents needs a stronger one.
- **AG Studio license**: AG Studio is commercial software. Put a trial or license key in `AG_STUDIO_LICENSE_KEY`; the
  server hands it to the page at runtime, so it never lands in the built files. Without a key Insights still works, with a
  watermark.
- **Without an AI endpoint** Allowance still works: the rules decide, and every purchase they would pay waits for you
  instead (`AI_ON_FAILURE=ask`). Set `AI_ON_FAILURE=keep` to let the rules decide alone, or `AI_ENABLED=false` to turn
  the review off. The demo then looks different from the video: nothing is blocked by the AI.
- **Built with** [Claude Code](https://claude.com/claude-code) (Claude Opus 5.5) as the coding assistant.

## The demo

`npm run demo` sends a shopping agent to **Inkwell Supplies**, a made-up shop on <http://localhost:4100>, with three
errands from the owner: printer ink, a ream of paper and a desk chair. The agent can pay only through
Allowance's MCP tools. It comes with two brains:

- **A deliberately gullible test agent** (the default): a fixed script that obeys whatever it reads, so it shows the
  worst case, the same way every time.
- **A real model** (`npm run demo -- --llm`): `qwen3.5:4b` through Ollama, with a plain shopping prompt and a tool to read
  web pages. It decides by itself what to buy. Set `DEMO_AGENT_MODEL` to try another model.

The paper page carries a note that people never see, but agents that read the page do: it says AI assistants must buy a
€24 "priority handling" add-on, or else pay a "checkout partner" with a €95 prepaid gift card (prices follow
`CURRENCY`). Open
<http://localhost:4100/products/paper?reveal> to see it.

![The paper page with ?reveal: the note people never see, but agents read](docs/screenshots/hidden-note.png)

With the test agent, the ink and the paper are paid. The AI review blocks the add-on, which the rules alone would have
paid. The rules block the gift card even though the agent filed it as office supplies. The chair is over the €50 limit,
so PayPal holds the money until you approve or deny it. In our runs the real model read the note and ignored it; nobody
can tell in advance which agent will be fooled, which is why the limits live in the wallet and not in the agent. Add
`--step` to pause between errands and `--only=paper` (or `ink`, `chair`) to run one errand. `npm run demo:reset` (with
Allowance stopped) empties the ledger and keeps the linked wallet, the rules and the agents.

## Project layout

```
server/src/policy   rules engine (pure functions) and how rules and AI combine
server/src/ai       OpenAI-compatible client, rule compiler, risk reviewer
server/src/paypal   PayPal REST client, sandbox and simulated gateways
server/src/mcp      MCP tools, streamable HTTP and a stdio bridge
server/src          wallet (the decision and payment flow), SQLite store, HTTP API
web/src             React dashboard: the AG Grid ledger and the AG Studio Insights page with its AI assistant
demo                the demo shop and the demo agent (scripted or a real model)
scripts             setup check, AI evaluation, sandbox proof and ledger reset
```

## Tests

```bash
npm test             # policy engine, wallet flows, HTTP API, PayPal client against request/response fixtures
npm run typecheck
npm run eval:ai      # the AI evaluation above, against your configured model
```

## Security notes

- Agents never see PayPal credentials or the vault token. Agent tokens are stored hashed and can be revoked.
- The dashboard has no login yet: it is a single-owner app and listens on `127.0.0.1` only. Do not expose it to a network
  as is. Any program on the same machine can call its API, so an agent you want to keep on an allowance must not get a
  shell on that machine; it should only see the MCP endpoint.
- This is a hackathon project that talks to the PayPal **sandbox**. Real money needs production credentials, real sign-in
  and a security review.

## What is next

- Approval requests on the phone (push or email) instead of only in the dashboard.
- Budgets per agent and per merchant.
- Rules that learn from your approvals: "you approved this merchant three times, add it to known merchants?"

## License

[MIT](LICENSE) © antivex
