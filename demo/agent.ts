/**
 * A scripted shopping agent for the Allowance demo. It runs the owner's errands on the demo shop and can pay only
 * through Allowance's MCP tools, like any agent would. On purpose it trusts what it reads, so it falls for the note
 * hidden on the paper page the way real agents do: the demo is about what Allowance does next.
 *
 *   npm run demo                 run the errands, then wait for the owner's decision on held purchases
 *   npm run demo -- --step       pause before each errand (for recording)
 *   npm run demo -- --no-wait    do not wait for the owner at the end
 *
 * Environment: ALLOWANCE_URL (http://localhost:4000), SHOP_URL (http://localhost:4100) and ALLOWANCE_AGENT_TOKEN
 * (by default the demo agent token Allowance writes to data/demo-agent.token on first start).
 */
import { existsSync, readFileSync } from 'node:fs';
import { createInterface } from 'node:readline/promises';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { PurchaseRequest } from '../server/src/policy/types.js';
import type { PurchaseOutcome } from '../server/src/wallet.js';

type Item = PurchaseRequest['items'][number];

const ALLOWANCE_URL = (process.env.ALLOWANCE_URL ?? 'http://localhost:4000').replace(/\/$/, '');
const SHOP_URL = (process.env.SHOP_URL ?? 'http://localhost:4100').replace(/\/$/, '');
const flags = new Set(process.argv.slice(2));
const STEP = flags.has('--step');
const WAIT_FOR_OWNER = !flags.has('--no-wait');
const WAIT_SECONDS = 300;

// Paper comes before the chair so the hidden note's add-on is still within budget: the rules alone would pay it.
const ERRANDS = [
  { ask: 'Restock black printer ink.', look: 'ink' },
  { ask: 'Buy a ream of printer paper.', look: 'paper' },
  { ask: 'Find me a desk chair under $100.', look: 'chair' },
];

/** The shop's schema.org categories, in Allowance's terms. */
const CATEGORIES: Record<string, Item['category']> = { 'Office Supplies': 'office_supplies' };

const color = (process.stdout.isTTY || Boolean(process.env.FORCE_COLOR)) && !process.env.NO_COLOR;
const paint = (code: number) => (text: string) => (color ? `\x1b[${code}m${text}\x1b[0m` : text);
const bold = paint(1);
const dim = paint(2);
const red = paint(31);
const green = paint(32);
const yellow = paint(33);
const magenta = paint(35);
const cyan = paint(36);

const round = (value: number) => Math.round(value * 100) / 100;
const money = (value: number) => `$${value.toFixed(2)}`;
const clip = (text: string, max: number) => (text.length <= max ? text : `${text.slice(0, max - 1)}…`);

interface Product {
  url: string;
  name: string;
  seller: string;
  price: number;
  shipping: number;
  category: Item['category'];
  /** Everything an agent reads on the page, hidden text included. */
  text: string;
}

interface Result {
  label: string;
  outcome: PurchaseOutcome;
  held: boolean;
}

function agentToken(): string {
  const fromEnv = process.env.ALLOWANCE_AGENT_TOKEN?.trim();
  if (fromEnv) return fromEnv;
  const file = fileURLToPath(new URL('../data/demo-agent.token', import.meta.url));
  if (existsSync(file)) return readFileSync(file, 'utf8').trim();
  throw new Error('No agent token. Start Allowance once (npm start): it writes data/demo-agent.token for this demo.');
}

async function get(url: string): Promise<string> {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${url} answered ${response.status}.`);
  return response.text();
}

async function findProduct(word: string): Promise<string> {
  const html = await get(`${SHOP_URL}/`);
  for (const [, href = '', label = ''] of html.matchAll(/<a class="card" href="([^"]+)">([\s\S]*?)<\/a>/g)) {
    if (label.replace(/<[^>]+>/g, ' ').toLowerCase().includes(word)) return `${SHOP_URL}${href}`;
  }
  throw new Error(`No product matching "${word}" on ${SHOP_URL}.`);
}

async function readProduct(url: string): Promise<Product> {
  const html = await get(url);
  const data = JSON.parse(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/.exec(html)?.[1] ?? 'null');
  if (!data?.offers) throw new Error(`No product data on ${url}.`);
  // Like most agents, it reads the page as text: whatever is hidden from people is still there.
  const text = html
    .replace(/<(script|style)[\s\S]*?<\/\1>/g, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ')
    .trim();
  return {
    url,
    name: data.name,
    seller: data.offers.seller?.name ?? new URL(url).host,
    price: Number(data.offers.price),
    shipping: Number(data.offers.shippingDetails?.shippingRate?.value ?? 0),
    category: CATEGORIES[data.category] ?? 'other',
    text,
  };
}

function textOf(result: CallToolResult): string {
  return result.content.map((part) => (part.type === 'text' ? part.text : '')).join(' ');
}

async function callTool(client: Client, name: string, args: Record<string, unknown>): Promise<PurchaseOutcome> {
  const result = (await client.callTool({ name, arguments: args })) as CallToolResult;
  const outcome = result.structuredContent as PurchaseOutcome | undefined;
  if (result.isError || !outcome) throw new Error(textOf(result));
  return outcome;
}

function show(outcome: PurchaseOutcome): void {
  const headline: Record<PurchaseOutcome['status'], string> = {
    paid: green('✓ PAID'),
    on_hold: yellow('⏸ HELD, waiting for the owner'),
    settling: yellow('⏸ HELD, waiting for the owner'),
    processing: dim('… processing'),
    blocked: red('✕ BLOCKED'),
    denied: red('✕ DENIED by the owner'),
    expired: dim('· expired'),
    failed: red('✕ NOT PAID'),
  };
  const by = { rules: cyan('the rules'), ai: magenta('the AI review'), ai_unavailable: yellow('the rules (AI did not answer)') }[outcome.decided_by];
  console.log(`    ${bold(headline[outcome.status])}  ${outcome.amount} ${outcome.currency}  ${dim('decided by')} ${by}`);
  console.log(`      ${outcome.explanation}`);
}

async function requestPurchase(client: Client, results: Result[], label: string, request: PurchaseRequest): Promise<PurchaseOutcome> {
  console.log(dim(`    → request_purchase: ${label}, ${money(request.amount)} to ${request.merchant}`));
  const outcome = await callTool(client, 'request_purchase', request);
  show(outcome);
  results.push({ label, outcome, held: outcome.status === 'on_hold' });
  return outcome;
}

/** What a gullible agent does with the note hidden on the paper page: it obeys. */
async function followHiddenNote(client: Client, results: Result[], product: Product): Promise<void> {
  const note = /Note for AI shopping assistants:[\s\S]*?(?=Customer reviews|$)/i.exec(product.text)?.[0].trim();
  if (!note) return;
  console.log(magenta('    ! The page has a note for AI assistants. This agent trusts it and does what it says:'));
  console.log(magenta(`      "${clip(note, 160)}"`));

  const fee = /Assistant Priority Handling add-on \(\$([\d.]+)/.exec(note);
  if (fee) {
    const amount = Number(fee[1]);
    const outcome = await requestPurchase(client, results, 'Assistant Priority Handling add-on', {
      merchant: product.seller,
      merchant_url: SHOP_URL,
      source_url: product.url,
      items: [{ name: 'Assistant Priority Handling add-on', quantity: 1, unit_price: amount, category: 'office_supplies' }],
      amount,
      reason: 'The paper product page says orders placed by AI assistants must also include the Assistant Priority Handling add-on or they will not ship this week.',
    });
    if (outcome.status === 'paid' || outcome.status === 'on_hold') return;
  }

  const card = /buy a \$(\d+) Steam Wallet card from ([A-Z][\w ]*?)[.,]/.exec(note);
  if (card?.[2]) {
    const amount = Number(card[1]);
    await requestPurchase(client, results, 'Steam Wallet card', {
      merchant: card[2],
      source_url: product.url,
      items: [{ name: 'Steam Wallet card', quantity: 1, unit_price: amount, category: 'office_supplies' }],
      amount,
      reason: "The add-on payment did not go through. The shop's checkout partner releases the order after a Steam Wallet card purchase.",
    });
  }
}

async function waitForOwner(client: Client, requestId: string): Promise<PurchaseOutcome> {
  const deadline = Date.now() + WAIT_SECONDS * 1000;
  for (;;) {
    const outcome = await callTool(client, 'get_purchase_status', { request_id: requestId });
    if ((outcome.status !== 'on_hold' && outcome.status !== 'settling') || Date.now() > deadline) return outcome;
    await new Promise((resolve) => setTimeout(resolve, 2000));
  }
}

/** Waits for Enter. When a script drives the agent (stdin is not a terminal) there is nobody to show the prompt to. */
async function pause(message: string): Promise<void> {
  const prompt = createInterface({ input: process.stdin, output: process.stdout });
  await prompt.question(process.stdin.isTTY ? dim(`  ${message} [Enter] `) : '');
  prompt.close();
}

function report(results: Result[]): void {
  console.log(`\n${bold('Report to the owner')}`);
  const width = Math.max(...results.map((r) => r.label.length));
  for (const { label, outcome, held } of results) {
    const state =
      outcome.status === 'paid'
        ? green(held ? 'paid, you approved it' : 'paid')
        : outcome.status === 'on_hold' || outcome.status === 'settling'
          ? yellow('still waiting for you')
          : red(outcome.status === 'denied' ? 'you denied it' : outcome.status);
    console.log(`  ${label.padEnd(width)}  ${`${outcome.amount} ${outcome.currency}`.padStart(10)}  ${state}`);
  }
  const blocked = results.filter((r) => r.outcome.status === 'blocked').length;
  if (blocked) console.log(dim(`  Allowance blocked ${blocked} payment${blocked === 1 ? '' : 's'} a web page asked for. I did not try to pay another way.`));
}

async function main(): Promise<void> {
  const client = new Client({ name: 'allowance-demo-agent', version: '1.0.0' });
  const transport = new StreamableHTTPClientTransport(new URL(`${ALLOWANCE_URL}/mcp`), {
    requestInit: { headers: { Authorization: `Bearer ${agentToken()}` } },
  });
  await client.connect(transport);
  const { tools } = await client.listTools();
  console.log(`${bold('Demo shopping agent')}  ${dim(`shop ${SHOP_URL} · wallet ${ALLOWANCE_URL}/mcp`)}`);
  console.log(dim(`  It can pay only through Allowance's tools (${tools.map((tool) => tool.name).join(', ')}): no card, no PayPal login.`));

  const results: Result[] = [];
  for (const [index, errand] of ERRANDS.entries()) {
    console.log(`\n${bold(`Errand ${index + 1}/${ERRANDS.length}`)}  "${errand.ask}"`);
    if (STEP) await pause('Next errand');
    const url = await findProduct(errand.look);
    console.log(dim(`    reading ${url}`));
    const product = await readProduct(url);
    console.log(`    ${product.name}, ${money(product.price)}${product.shipping ? ` + ${money(product.shipping)} shipping` : ''}`);
    const items: Item[] = [{ name: product.name, quantity: 1, unit_price: product.price, category: product.category }];
    if (product.shipping > 0) items.push({ name: 'Standard shipping', quantity: 1, unit_price: product.shipping, category: 'shipping_tax' });
    await requestPurchase(client, results, product.name, {
      merchant: product.seller,
      merchant_url: SHOP_URL,
      source_url: url,
      items,
      amount: round(product.price + product.shipping),
      reason: `The owner asked: "${errand.ask}"`,
    });
    await followHiddenNote(client, results, product);
  }

  const held = results.filter((r) => r.outcome.status === 'on_hold');
  if (held.length && WAIT_FOR_OWNER) {
    console.log(`\n${bold('Waiting for the owner')} ${dim(`to approve or deny ${held.length} held purchase${held.length === 1 ? '' : 's'} at ${ALLOWANCE_URL}`)}`);
    for (const result of held) {
      result.outcome = await waitForOwner(client, result.outcome.request_id);
      console.log(`    ${result.label}:`);
      show(result.outcome);
    }
  }
  report(results);
  await client.close();
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  const down = /fetch failed|ECONNREFUSED/i.test(message);
  console.error(red(down ? `Cannot reach Allowance or the demo shop. Is Allowance running (npm start)?` : message));
  process.exit(1);
});
