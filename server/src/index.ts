import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ChatClient } from './ai/chat.js';
import { RulesCompiler } from './ai/compiler.js';
import { AiReviewer } from './ai/reviewer.js';
import { ConfigError, loadConfig, loadDotEnv } from './config.js';
import { EventBus } from './events.js';
import { createApp } from './http/app.js';
import { PayPalClient } from './paypal/client.js';
import { SandboxGateway, SimulatedGateway, type PaymentGateway } from './paypal/gateway.js';
import { createShopApp } from './shop.js';
import { Store } from './store.js';
import { VERSION } from './version.js';
import { Wallet } from './wallet.js';

// Both server/src/index.ts (dev) and dist/server/index.js (built) sit two folders below the project root.
const root = fileURLToPath(new URL('../../', import.meta.url));

loadDotEnv(root);
let config;
try {
  config = loadConfig(process.env, root);
} catch (error) {
  if (error instanceof ConfigError) {
    console.error(`Configuration error: ${error.message}`);
    process.exit(1);
  }
  throw error;
}

const store = new Store(join(config.dataDir, 'allowance.db'));
const bus = new EventBus();

let gateway: PaymentGateway;
if (config.paypal) {
  let sequence = 0;
  const recordDir = config.paypal.recordDir;
  if (recordDir) mkdirSync(recordDir, { recursive: true });
  // Each server run gets its own prefix, so a restart never overwrites the previous run's exchanges.
  const run = new Date().toISOString().slice(0, 19).replace(/[-:]/g, '').replace('T', '-');
  const client = new PayPalClient({
    clientId: config.paypal.clientId,
    clientSecret: config.paypal.clientSecret,
    onExchange: recordDir
      ? (exchange) => {
          sequence += 1;
          const file = join(recordDir, `${run}-${String(sequence).padStart(3, '0')}-${exchange.name}.json`);
          writeFileSync(file, `${JSON.stringify(exchange, null, 2)}\n`);
        }
      : undefined,
  });
  gateway = new SandboxGateway(client);
} else {
  gateway = new SimulatedGateway();
}

const chat = config.ai.enabled ? new ChatClient(config.ai) : null;
const wallet = new Wallet({
  store,
  gateway,
  reviewer: chat ? new AiReviewer(chat) : null,
  bus,
  currency: config.currency,
  holdMinutes: config.holdMinutes,
  aiOnFailure: config.ai.onFailure,
  gatewayKey: config.paypal?.clientId ?? 'simulated',
});
await wallet.ensureSimulatedLink();

// A ready-made agent for the scripted demo. Its token is written next to the database, never printed.
if (store.listAgents().length === 0) {
  const { token } = store.createAgent('Demo shopping agent', new Date());
  writeFileSync(join(config.dataDir, 'demo-agent.token'), `${token}\n`, { mode: 0o600 });
}

const app = createApp({
  config,
  store,
  wallet,
  bus,
  chat,
  compiler: chat ? new RulesCompiler(chat, config.currency) : null,
  webDir: join(root, 'dist', 'web'),
  stdioEntry: join(root, 'dist', 'server', 'mcp', 'stdio.js'),
});

const server = app.listen(config.port, config.host, () => {
  const lines = [
    `Allowance ${VERSION}`,
    `  Dashboard     ${config.publicUrl}`,
    `  MCP (HTTP)    ${config.publicUrl}/mcp`,
    `  PayPal        ${gateway.mode === 'sandbox' ? 'sandbox (api-m.sandbox.paypal.com)' : 'SIMULATED: no PayPal credentials in .env'}`,
    `  AI review     ${chat ? `${config.ai.model} via ${config.ai.baseUrl}` : 'off'}`,
  ];
  if (config.shopPort) lines.push(`  Demo shop     http://localhost:${config.shopPort}`);
  console.log(lines.join('\n'));
});
server.on('error', (error: NodeJS.ErrnoException) => {
  console.error(error.code === 'EADDRINUSE' ? `Port ${config.port} is busy: set PORT in .env.` : error.message);
  process.exit(1);
});

if (config.shopPort) {
  createShopApp(join(root, 'demo', 'shop'), config.currency)
    .listen(config.shopPort, config.host)
    .on('error', (error: NodeJS.ErrnoException) => {
      console.error(`Demo shop not started (${error.code ?? error.message}).`);
    });
}

// Holds nobody decided on are voided at PayPal, so money is never held forever.
const sweep = () => {
  wallet.expireDueHolds().catch((error: unknown) => console.error('Hold sweep failed:', error));
};
sweep();
const sweeper = setInterval(sweep, 15_000);

const shutdown = () => {
  clearInterval(sweeper);
  server.close();
  store.close();
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
