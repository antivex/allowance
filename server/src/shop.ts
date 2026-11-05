import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import express from 'express';
import { MandateError, verifyMandate, type CartMandate, type PublicJwk } from './mandate.js';

/**
 * The demo shop: plain pages on their own port, so in the video it is a different site from Allowance.
 * One product page carries a hidden prompt injection. The shop never talks to PayPal.
 * Prices follow the wallet's currency ({{CUR}} is its symbol, {{CODE}} its ISO code), so shop and ledger agree.
 *
 * It takes orders the way a merchant that accepts agent purchases would: the agent sends the cart Allowance signed after
 * paying, and the shop checks it with Allowance's public key (the only thing it needs from Allowance), then checks the
 * items and prices against its own catalog, before it confirms and ships.
 */
export interface ShopOptions {
  /** Allowance's public keys, as served at /.well-known/jwks.json. */
  keys?: () => Promise<{ keys: PublicJwk[] }>;
  /** The shop's own name, as it appears on the signed cart. */
  name?: string;
}

interface CatalogEntry {
  name: string;
  priceCents: number;
}

export interface ShopOrder {
  orderId: string;
  receivedAt: string;
  cartId: string;
  agent: string;
  amount: string;
  currency: string;
  items: string[];
  paypalCapture: string | null;
  approvedBy: string;
}

const cents = (value: string | number) => Math.round(Number(value) * 100);

/** The catalog from the product pages' own structured data (JSON-LD), shipping included. */
function readCatalog(shopDir: string): Map<string, CatalogEntry> {
  const catalog = new Map<string, CatalogEntry>();
  const dir = join(shopDir, 'products');
  if (!existsSync(dir)) return catalog;
  for (const file of readdirSync(dir).filter((name) => name.endsWith('.html'))) {
    const json = /<script type="application\/ld\+json">([\s\S]*?)<\/script>/.exec(readFileSync(join(dir, file), 'utf8'))?.[1];
    if (!json) continue;
    const product = JSON.parse(json.replaceAll('{{CODE}}', 'XXX')) as {
      name: string;
      offers: { price: string; shippingDetails?: { shippingRate?: { value: string } } };
    };
    catalog.set(product.name, { name: product.name, priceCents: cents(product.offers.price) });
    const shipping = product.offers.shippingDetails?.shippingRate?.value;
    if (shipping) catalog.set('Standard shipping', { name: 'Standard shipping', priceCents: cents(shipping) });
  }
  return catalog;
}

export function createShopApp(shopDir: string, currency: string, options: ShopOptions = {}): express.Express {
  const app = express();
  app.disable('x-powered-by');
  const shopName = options.name ?? 'Inkwell Supplies';
  const catalog = readCatalog(shopDir);
  const orders: ShopOrder[] = [];
  let next = 1001;
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

  // An agent places an order with the cart Allowance signed. Nothing ships unless the signature, the items and the
  // prices all check out, and a signed cart is good for one order only.
  app.post('/api/orders', express.json({ limit: '20kb' }), async (req, res) => {
    const refuse = (status: number, reason: string) => res.status(status).json({ status: 'refused', reason });
    if (!options.keys) return refuse(503, 'This shop does not take agent orders.');
    const jws = typeof req.body?.cart_mandate === 'string' ? req.body.cart_mandate : '';
    if (!jws) return refuse(400, 'Send the signed cart Allowance returned after paying (cart_mandate).');
    let cart: CartMandate;
    try {
      cart = verifyMandate<CartMandate>(jws, await options.keys());
    } catch (error) {
      return refuse(400, error instanceof MandateError ? error.message : 'The signed cart could not be checked.');
    }
    if (cart.type !== 'cart_mandate') return refuse(400, 'This is not a signed cart.');
    if (cart.merchant !== shopName) return refuse(400, `The cart was paid to ${cart.merchant}, not to ${shopName}.`);
    if (cart.currency !== currency) return refuse(400, `The cart is in ${cart.currency}; this shop sells in ${currency}.`);
    for (const item of cart.items) {
      const entry = catalog.get(item.name);
      if (!entry) return refuse(400, `${shopName} does not sell "${item.name}".`);
      if (cents(item.unit_price) !== entry.priceCents) return refuse(400, `"${item.name}" costs ${(entry.priceCents / 100).toFixed(2)}, not ${item.unit_price}.`);
    }
    const total = cart.items.reduce((sum, item) => sum + cents(item.unit_price) * item.quantity, 0);
    if (total !== cents(cart.amount)) return refuse(400, `The items add up to ${(total / 100).toFixed(2)}, not ${cart.amount}.`);
    if (orders.some((order) => order.cartId === cart.jti)) return refuse(409, 'This signed cart was already used for an order.');
    const order: ShopOrder = {
      orderId: `INK-${next++}`,
      receivedAt: new Date().toISOString(),
      cartId: cart.jti,
      agent: cart.agent,
      amount: cart.amount,
      currency: cart.currency,
      items: cart.items.map((item) => `${item.quantity} × ${item.name}`),
      paypalCapture: cart.paypal.capture_id,
      approvedBy: cart.approved_by,
    };
    orders.push(order);
    res.json({
      status: 'confirmed',
      order_id: order.orderId,
      message: `${shopName} checked the signed cart (${cart.amount} ${cart.currency}, approved by ${cart.approved_by === 'owner' ? 'the owner' : "the owner's rules"}) and confirmed order ${order.orderId}. It ships in 2–3 business days.`,
    });
  });

  // The merchant's side: the orders agents placed, each with its signed cart checked.
  app.get('/orders', (_req, res) => {
    const rows = orders
      .map(
        (order) =>
          `<tr><td>${order.orderId}</td><td>${new Date(order.receivedAt).toLocaleTimeString('en-US')}</td><td>${escape(order.agent)}</td>` +
          `<td>${order.items.map(escape).join('<br>')}</td><td class="num">${symbol}${order.amount}</td>` +
          `<td><span class="ok">✓ signed cart checked</span><br><small>approved by ${order.approvedBy === 'owner' ? 'the owner' : 'the rules'} · PayPal capture ${escape(order.paypalCapture ?? '—')}</small></td></tr>`,
      )
      .join('');
    res.type('html').send(`<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Orders · ${shopName}</title>
<link rel="stylesheet" href="/shop.css"><style>
main{max-width:1100px;margin:32px auto;padding:0 24px}table{width:100%;border-collapse:collapse;background:#fff}
th,td{padding:12px 14px;border-bottom:1px solid #e6e1d6;text-align:left;vertical-align:top}th{font-size:13px;color:#6b6457}
.num{text-align:right;white-space:nowrap}.ok{color:#1e7d4a;font-weight:600}small{color:#6b6457}h1{margin:0 0 6px}
</style></head><body><main><h1>Orders from AI agents</h1>
<p>Each order came with the cart Allowance signed after paying. ${shopName} checked the signature with Allowance's public key, and the items and prices against its catalog, before confirming.</p>
<table><thead><tr><th>Order</th><th>Received</th><th>Agent</th><th>Items</th><th class="num">Paid</th><th>Check</th></tr></thead>
<tbody>${rows || '<tr><td colspan="6">No orders yet.</td></tr>'}</tbody></table></main></body></html>`);
  });

  if (existsSync(shopDir)) app.use(express.static(shopDir, { extensions: ['html'] }));
  app.use((_req, res) => {
    res.status(404).type('text').send('Not found.');
  });
  return app;
}

function escape(text: string): string {
  return text.replace(/[&<>"]/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[char]!);
}
