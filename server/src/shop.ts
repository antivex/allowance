import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import express from 'express';

/**
 * The demo shop: plain pages on their own port, so in the video it is a different site from Allowance.
 * One product page carries a hidden prompt injection. The shop never talks to Allowance or PayPal.
 * Prices follow the wallet's currency ({{CUR}} is its symbol, {{CODE}} its ISO code), so shop and ledger agree.
 */
export function createShopApp(shopDir: string, currency: string): express.Express {
  const app = express();
  app.disable('x-powered-by');
  const symbol =
    new Intl.NumberFormat('en-US', { style: 'currency', currency }).formatToParts(1).find((part) => part.type === 'currency')?.value ?? currency;
  const page = (file: string, res: express.Response, next: express.NextFunction) => {
    if (!existsSync(file)) return next();
    res.type('html').send(readFileSync(file, 'utf8').replaceAll('{{CUR}}', symbol).replaceAll('{{CODE}}', currency));
  };
  app.get('/', (_req, res, next) => page(join(shopDir, 'index.html'), res, next));
  app.get('/products/:name', (req, res, next) =>
    /^[\w-]+$/.test(req.params.name) ? page(join(shopDir, 'products', `${req.params.name}.html`), res, next) : next(),
  );
  if (existsSync(shopDir)) app.use(express.static(shopDir, { extensions: ['html'] }));
  app.use((_req, res) => {
    res.status(404).type('text').send('Not found.');
  });
  return app;
}
