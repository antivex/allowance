import { existsSync } from 'node:fs';
import express from 'express';

/**
 * The demo shop: plain static pages on their own port, so in the video it is a different site from Allowance.
 * One product page carries a hidden prompt injection. The shop never talks to Allowance or PayPal.
 */
export function createShopApp(shopDir: string): express.Express {
  const app = express();
  app.disable('x-powered-by');
  if (existsSync(shopDir)) app.use(express.static(shopDir, { extensions: ['html'] }));
  app.use((_req, res) => {
    res.status(404).type('text').send('Not found.');
  });
  return app;
}
