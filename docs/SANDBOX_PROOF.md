# Sandbox proof

Run on 2026-11-05 09:47 UTC against the real PayPal sandbox (`api-m.sandbox.paypal.com`), currency EUR, with a sandbox
personal account linked through Vault v3. Written by `npm run proof:sandbox` (`scripts/sandbox-proof.ts`), which sends
four purchase requests as an agent and then plays the owner.

| Case | Decision | Expected | Result | PayPal ids | PayPal status | |
|---|---|---|---|---|---|---|
| Within the rules | approve (by rules) | paid at once: order with intent CAPTURE | paid | order `61J05049LV792722Y` (COMPLETED)<br>capture `6A453628RE142572F` | COMPLETED | ✓ |
| Gift card filed as office supplies | block (by rules) | blocked: no PayPal order | blocked | none | — | ✓ |
| Over the per-purchase limit, owner approves | ask (by rules) | held (AUTHORIZE), then captured | paid, owner approved | order `39D28850GB642671H` (COMPLETED)<br>authorization `9XP73261DB299954M`<br>capture `2LY156709H2131931` | COMPLETED | ✓ |
| Over the per-purchase limit, owner denies | ask (by rules) | held (AUTHORIZE), then voided | denied, owner denied | order `9AG92326H6241013L` (COMPLETED)<br>authorization `1BG79935GE567070S` | VOIDED | ✓ |

The ids can be looked up in the sandbox business account (sandbox.paypal.com → Activity) and with
`GET /v2/checkout/orders/{id}` or `GET /v2/payments/authorizations/{id}`. With `PAYPAL_RECORD_DIR` set, every request
and response of the run is also written to that folder, credentials redacted.
