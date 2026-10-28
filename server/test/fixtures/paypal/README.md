# PayPal fixtures

Each file is one request/response pair in the format `PayPalClient` records (`Exchange` in `server/src/paypal/client.ts`).
Credentials never land here: the `Authorization` header and the `access_token` are replaced with `REDACTED`.

`server/test/paypal.test.ts` replays them through a scripted `fetch`, checking the method, path and body
the client sends and feeding it the recorded response.

To refresh them from the real sandbox, run `npm run record:paypal` (see `scripts/record-paypal.ts`).
Where each file came from is listed in [docs/SANDBOX_PROOF.md](../../../../docs/SANDBOX_PROOF.md).
