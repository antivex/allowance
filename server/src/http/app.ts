import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { localhostHostValidation } from '@modelcontextprotocol/sdk/server/middleware/hostHeaderValidation.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import express, { type NextFunction, type Request, type Response } from 'express';
import { z } from 'zod';
import type { ChatClient } from '../ai/chat.js';
import { EXAMPLE_RULES, EXAMPLE_RULES_TEXT, describeRules, normalizeRules, type RulesCompiler } from '../ai/compiler.js';
import type { Config } from '../config.js';
import type { EventBus } from '../events.js';
import { createMcpServer, type PurchaseApi } from '../mcp/tools.js';
import { RulesSchema } from '../policy/types.js';
import type { Agent, Store } from '../store.js';
import { VERSION } from '../version.js';
import { ConflictError, InvalidRequestError, NotFoundError, type Wallet } from '../wallet.js';

export interface AppDeps {
  config: Config;
  store: Store;
  wallet: Wallet;
  bus: EventBus;
  chat: ChatClient | null;
  compiler: RulesCompiler | null;
  /** Built dashboard (vite build output), if any. */
  webDir: string;
  /** Absolute path of the stdio MCP entry, shown in the Claude Desktop snippet. */
  stdioEntry: string;
}

type AgentRequest = Request & { agent?: Agent };

const LOCAL_HOSTS = new Set(['127.0.0.1', 'localhost', '::1']);

export function createApp(deps: AppDeps): express.Express {
  const { config, store, wallet, bus, chat, compiler } = deps;
  const app = express();
  app.disable('x-powered-by');
  // DNS-rebinding protection: a hostile page cannot reach this server through another host name.
  if (LOCAL_HOSTS.has(config.host)) app.use(localhostHostValidation());
  app.use(express.json({ limit: '200kb' }));

  // ---------- Agent side: bearer token ----------

  const agentAuth = (req: AgentRequest, res: Response, next: NextFunction) => {
    const header = req.get('authorization') ?? '';
    const token = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
    const agent = token ? store.findAgentByToken(token) : null;
    if (!agent) {
      res.status(401).json({ error: 'Missing or unknown agent token. Create an agent in the Allowance dashboard.' });
      return;
    }
    req.agent = agent;
    next();
  };

  const apiFor = (agent: Agent): PurchaseApi => ({
    requestPurchase: (input) => wallet.requestPurchase(agent, input),
    getPurchase: async (requestId) => wallet.outcomeFor(agent.id, requestId),
  });

  // Streamable HTTP MCP endpoint, stateless: one short-lived server per request, bound to the calling agent.
  app.post('/mcp', agentAuth, async (req: AgentRequest, res) => {
    const server = createMcpServer(apiFor(req.agent!), VERSION);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    res.on('close', () => {
      void transport.close();
      void server.close();
    });
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  });
  const mcpMethodNotAllowed = (_req: Request, res: Response) => {
    res.status(405).set('Allow', 'POST').json({ jsonrpc: '2.0', error: { code: -32000, message: 'Method not allowed.' }, id: null });
  };
  app.get('/mcp', mcpMethodNotAllowed);
  app.delete('/mcp', mcpMethodNotAllowed);

  // Plain HTTP for agents without MCP, and for the stdio bridge.
  app.post('/api/agent/purchases', agentAuth, async (req: AgentRequest, res) => {
    res.json(await wallet.requestPurchase(req.agent!, req.body));
  });
  app.get('/api/agent/purchases/:id', agentAuth, (req: AgentRequest, res) => {
    res.json(wallet.outcomeFor(req.agent!.id, String(req.params.id)));
  });

  // PayPal sends the owner back here after the wallet approval (a top-level GET navigation).
  let linkError: string | null = null;
  app.get('/api/paypal/return', async (req, res) => {
    const returned = req.query.approval_token_id ?? req.query.approval_session_id ?? req.query.token;
    try {
      await wallet.finishLink(typeof returned === 'string' ? returned : null);
      res.redirect('/?paypal=linked');
    } catch (error) {
      linkError = error instanceof Error ? error.message : String(error);
      res.redirect('/?paypal=error');
    }
  });
  app.get('/api/paypal/cancel', (_req, res) => {
    res.redirect('/?paypal=cancelled');
  });

  // ---------- Owner side: the dashboard, same origin only ----------

  app.use('/api', (req, res, next) => {
    if (req.method === 'GET' || req.method === 'HEAD') return next();
    const site = req.get('sec-fetch-site');
    const origin = req.get('origin');
    const sameOrigin = !origin || origin.replace(/^https?:\/\//, '') === req.get('host');
    if ((site && site !== 'same-origin' && site !== 'none') || !sameOrigin) {
      res.status(403).json({ error: 'Cross-site requests are refused.' });
      return;
    }
    if (!req.is('application/json')) {
      res.status(415).json({ error: 'Send a JSON body.' });
      return;
    }
    next();
  });

  let aiHealth: { at: number; value: { ok: boolean; detail: string } } | null = null;
  const health = async () => {
    if (!chat) return { ok: false, detail: 'AI review is turned off (AI_ENABLED=false).' };
    if (!aiHealth || Date.now() - aiHealth.at > 15_000) aiHealth = { at: Date.now(), value: await chat.health() };
    return aiHealth.value;
  };

  app.get('/api/state', async (_req, res) => {
    const record = store.activeRules();
    res.json({
      version: VERSION,
      mode: wallet.mode,
      currency: config.currency,
      holdMinutes: config.holdMinutes,
      wallet: { ...wallet.linkState(), lastError: linkError },
      ai: { enabled: Boolean(chat), model: config.ai.model, baseUrl: config.ai.baseUrl, onFailure: config.ai.onFailure, ...(await health()) },
      rules: record ? { ...record, summary: describeRules(record.rules) } : null,
      example: { text: EXAMPLE_RULES_TEXT, rules: EXAMPLE_RULES, summary: describeRules(EXAMPLE_RULES) },
      budget: wallet.budget(),
      agents: store.listAgents().filter((agent) => !agent.revokedAt),
      mcp: { httpUrl: `${config.publicUrl}/mcp`, stdioEntry: deps.stdioEntry, nodePath: process.execPath, serverUrl: config.publicUrl },
      shopUrl: config.shopPort ? `http://localhost:${config.shopPort}` : null,
    });
  });

  app.get('/api/purchases', (_req, res) => {
    res.json(store.listPurchases());
  });

  app.get('/api/purchases/:id', (req, res) => {
    const purchase = wallet.get(String(req.params.id));
    res.json({ purchase, events: store.listEvents(purchase.id) });
  });

  app.post('/api/purchases/:id/approve', async (req, res) => {
    res.json(await wallet.approve(String(req.params.id)));
  });

  app.post('/api/purchases/:id/deny', async (req, res) => {
    res.json(await wallet.deny(String(req.params.id)));
  });

  app.get('/api/events', (req, res) => {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.write('retry: 2000\n\n');
    const unsubscribe = bus.subscribe((event) => {
      res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
    });
    const ping = setInterval(() => res.write(': ping\n\n'), 25_000);
    req.on('close', () => {
      clearInterval(ping);
      unsubscribe();
    });
  });

  const RulesTextSchema = z.object({ text: z.string().trim().min(3).max(2000) });

  app.post('/api/rules/compile', async (req, res) => {
    const { text } = RulesTextSchema.parse(req.body);
    if (!compiler) {
      res.status(503).json({ error: 'The AI is turned off, so rules cannot be drafted from text. Edit the fields by hand.' });
      return;
    }
    res.json(await compiler.compile(text));
  });

  app.post('/api/rules', (req, res) => {
    const body = z.object({ text: z.string().trim().max(2000), rules: RulesSchema, compiledBy: z.string().max(100) }).parse(req.body);
    const { rules, warnings } = normalizeRules(body.rules, config.currency);
    const record = store.saveRules(body.text, rules, body.compiledBy || 'manual', new Date());
    bus.emit({ type: 'state', reason: 'rules' });
    res.json({ ...record, summary: describeRules(record.rules), warnings });
  });

  app.post('/api/rules/check', async (req, res) => {
    const body = z.object({ request: z.unknown(), rules: RulesSchema.optional(), text: z.string().max(2000).optional() }).parse(req.body);
    const override = body.rules ? { rules: body.rules, sourceText: body.text ?? '' } : undefined;
    res.json(await wallet.preview(body.request, override));
  });

  app.post('/api/agents', (req, res) => {
    const { name } = z.object({ name: z.string().trim().min(1).max(60) }).parse(req.body);
    const created = store.createAgent(name, new Date());
    bus.emit({ type: 'state', reason: 'agents' });
    res.json(created);
  });

  app.post('/api/agents/:id/revoke', (req, res) => {
    if (!store.revokeAgent(String(req.params.id), new Date())) throw new NotFoundError('No such agent.');
    bus.emit({ type: 'state', reason: 'agents' });
    res.json({ ok: true });
  });

  app.post('/api/paypal/link', async (_req, res) => {
    linkError = null;
    const approveUrl = await wallet.startLink(`${config.publicUrl}/api/paypal/return`, `${config.publicUrl}/api/paypal/cancel`);
    res.json({ approveUrl });
  });

  app.post('/api/paypal/unlink', async (_req, res) => {
    await wallet.unlink();
    res.json({ ok: true });
  });

  app.use('/api', (_req, res) => {
    res.status(404).json({ error: 'Not found.' });
  });

  // ---------- The dashboard ----------

  const indexHtml = join(deps.webDir, 'index.html');
  if (existsSync(indexHtml)) {
    app.use(express.static(deps.webDir, { index: false, maxAge: '1h' }));
    app.get('/{*path}', (_req, res) => {
      res.sendFile(indexHtml);
    });
  } else {
    app.get('/', (_req, res) => {
      res.type('text').send('The dashboard is not built yet. Run "npm run build", or "npm run dev" for development.');
    });
  }

  app.use((error: unknown, _req: Request, res: Response, _next: NextFunction) => {
    if (error instanceof InvalidRequestError) {
      res.status(400).json({ error: error.message, issues: error.issues });
    } else if (error instanceof z.ZodError) {
      res.status(400).json({ error: 'Invalid input.', issues: error.issues.map((i) => `${i.path.join('.') || 'body'}: ${i.message}`) });
    } else if (error instanceof NotFoundError) {
      res.status(404).json({ error: error.message });
    } else if (error instanceof ConflictError) {
      res.status(409).json({ error: error.message });
    } else if (error instanceof SyntaxError && 'body' in error) {
      res.status(400).json({ error: 'The body is not valid JSON.' });
    } else {
      console.error(error);
      res.status(500).json({ error: error instanceof Error ? error.message : 'Unexpected error.' });
    }
  });

  return app;
}
