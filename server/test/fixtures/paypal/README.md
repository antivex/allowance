# PayPal fixtures

Each file is one request/response pair in the format `PayPalClient` records (`Exchange` in `server/src/paypal/client.ts`).
They are written by hand from the PayPal REST API reference (Orders v2, Payments v2, Vault v3), not recorded: they pin
down what the client sends and how it reads PayPal's answers. Credentials never appear: the `Authorization` header and
the `access_token` say `REDACTED`.

`server/test/paypal.test.ts` replays them through a scripted `fetch`, checking the method, path and body the client
sends and feeding it the response.

To record real exchanges, set `PAYPAL_RECORD_DIR` in `.env` (for example `recordings/paypal`) and run Allowance against
the sandbox: every PayPal call is written to that folder, with the same redactions.
