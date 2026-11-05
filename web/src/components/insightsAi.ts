import {
  createAiHarness,
  directLlmRunner,
  type AgAiEvent,
  type AgAiHarnessSetup,
  type AgAiOutputItem,
  type AgLlmAdapter,
  type AgLlmRequest,
  type AgLlmResponse,
  type AgStudioApi,
} from 'ag-studio';
import type { Purchase, ReconcileResult } from '../types';

interface ChatToolCall {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
}

interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | null;
  tool_calls?: ChatToolCall[];
  tool_call_id?: string;
}

let sequence = 0;
const newId = (prefix: string) => `${prefix}_${Date.now().toString(36)}${(sequence++).toString(36)}`;

/** Studio's conversation in the chat-completions shape that Ollama, LM Studio, vLLM and hosted providers all speak. */
function toMessages(request: AgLlmRequest): ChatMessage[] {
  const messages: ChatMessage[] = request.instructions ? [{ role: 'system', content: request.instructions }] : [];
  for (const item of request.input) {
    if (item.type === 'message') {
      messages.push({ role: item.role, content: item.content.map((part) => ('text' in part ? part.text : '')).join('') });
    } else if (item.type === 'function_call') {
      const call: ChatToolCall = { id: item.callId, type: 'function', function: { name: item.name, arguments: item.arguments } };
      const last = messages.at(-1);
      if (last?.role === 'assistant') (last.tool_calls ??= []).push(call);
      else messages.push({ role: 'assistant', content: null, tool_calls: [call] });
    } else if (item.type === 'function_call_output') {
      messages.push({ role: 'tool', tool_call_id: item.callId, content: item.output });
    }
  }
  return messages;
}

function toolChoice(choice: AgLlmRequest['toolChoice']) {
  if (!choice || typeof choice === 'string') return choice;
  return { type: 'function', function: { name: choice.name } };
}

const failed = (message: string): AgLlmResponse => ({
  id: newId('resp'),
  createdAt: Date.now(),
  status: 'failed',
  error: { code: 'model_error', message },
  output: [],
});

/**
 * An AG Studio LLM adapter for any OpenAI-compatible chat-completions endpoint. It calls Allowance's own server,
 * which adds the model and the key, and turns the answer into Studio's events; Studio runs the tools itself.
 */
export function chatCompletionsAdapter(endpoint: string): AgLlmAdapter {
  return {
    executeTurn(request, options) {
      const turn = (async (): Promise<{ events: AgAiEvent[]; response: AgLlmResponse }> => {
        const format = request.responseFormat;
        const body = {
          messages: toMessages(request),
          tools: request.tools?.length
            ? request.tools.map((tool) => ({ type: 'function', function: { name: tool.name, description: tool.description, parameters: tool.parameters } }))
            : undefined,
          tool_choice: request.tools?.length ? toolChoice(request.toolChoice) : undefined,
          response_format: format.type === 'json' ? { type: 'json_schema', json_schema: { name: format.name, schema: format.schema } } : undefined,
          temperature: 0,
        };
        let data: { id?: string; model?: string; choices?: Array<{ message?: { content?: string | null; tool_calls?: ChatToolCall[] } }> } | null;
        try {
          const response = await fetch(endpoint, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: options?.signal });
          data = await response.json().catch(() => null);
          if (!response.ok || !data) return { events: [], response: failed(`The model answered ${response.status}.`) };
        } catch (error) {
          return { events: [], response: failed(error instanceof Error ? error.message : String(error)) };
        }

        const message = data.choices?.[0]?.message ?? {};
        const events: AgAiEvent[] = [];
        const output: AgAiOutputItem[] = [];
        const text = String(message.content ?? '').replace(/<think>[\s\S]*?<\/think>/g, '').trim();
        if (text) {
          const messageId = newId('msg');
          events.push({ type: 'TEXT_MESSAGE_START', messageId, role: 'assistant' }, { type: 'TEXT_MESSAGE_CONTENT', messageId, delta: text }, { type: 'TEXT_MESSAGE_END', messageId });
          output.push({ id: messageId, kind: 'output', type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'text', text, annotations: [] }] });
        }
        for (const call of message.tool_calls ?? []) {
          const callId = call.id || newId('call');
          const args = typeof call.function.arguments === 'string' ? call.function.arguments : JSON.stringify(call.function.arguments ?? {});
          events.push(
            { type: 'TOOL_CALL_START', toolCallId: callId, toolCallName: call.function.name },
            { type: 'TOOL_CALL_ARGS', toolCallId: callId, delta: args },
            { type: 'TOOL_CALL_END', toolCallId: callId },
          );
          output.push({ id: newId('fc'), kind: 'output', type: 'function_call', callId, name: call.function.name, arguments: args, status: 'completed' });
        }
        return { events, response: { id: data.id ?? newId('resp'), createdAt: Date.now(), status: 'completed', output, model: data.model } };
      })();

      return {
        stream: {
          async *[Symbol.asyncIterator]() {
            yield* (await turn).events;
          },
        },
        complete: turn.then((result) => result.response),
      };
    },
  };
}

/**
 * The whole story of a request in words, so a small model cannot mistake a hold the owner approved for a block, and
 * sees who stopped each attempt: a purchase the AI review held and the owner denied is an attempt that was stopped.
 */
function outcomeInWords(purchase: Purchase): string {
  const heldBy = purchase.decisionSource === 'ai' ? 'held by the AI review' : 'held by the rules';
  switch (purchase.status) {
    case 'paid':
      return purchase.decision === 'ask' ? `${heldBy}, then approved by the owner: paid` : 'paid at once, within the rules';
    case 'on_hold':
    case 'settling':
      return `${heldBy}: the money waits for the owner to approve or deny`;
    case 'blocked':
      return purchase.decisionSource === 'ai' ? 'blocked by the AI review: no payment' : 'blocked by the rules: no payment';
    case 'denied':
      return `${heldBy}, then denied by the owner: stopped, the hold was voided and nothing was paid`;
    case 'expired':
      return `${heldBy}, then expired without an answer: the hold was voided`;
    default:
      return purchase.status;
  }
}

const STOPPED = new Set<Purchase['status']>(['blocked', 'denied', 'expired']);

/** Who kept the money from leaving, in words, or null for a purchase that was paid or is still waiting. */
/** One word per ledger state for the PayPal check, which only has to say what PayPal should show. */
const STATUS_WORD: Partial<Record<Purchase['status'], string>> = {
  paid: 'payment captured',
  on_hold: 'hold waiting for the owner',
  denied: 'hold voided by the owner',
  expired: 'hold voided after 24 hours',
};

function stoppedBy(purchase: Purchase): string | null {
  if (purchase.status === 'blocked') return purchase.decisionSource === 'ai' ? 'the AI review' : 'the rules';
  if (purchase.status === 'denied') return purchase.decisionSource === 'ai' ? 'the AI review held it and the owner denied it' : 'the owner denied it';
  if (purchase.status === 'expired') return 'nobody approved it in time: the hold was voided';
  return null;
}

/** A widget's reference to a field of the requests table (Studio names fields `table.field`). */
const ref = (id: string, aggregation?: 'sum') => ({ id: `requests.${id}`, ...(aggregation ? { aggregation } : {}) });
const legend = { style: { theme: { common: { legend: { enabled: true, position: 'bottom' } } } } };

/** Charts the auditor can add in one reliable step, even on a small local model. */
const CHARTS = {
  money_by_decider: {
    title: 'Money asked for, by agent and who decided',
    widget: { type: 'column-chart-stacked', dataMapping: { categoryKey: [ref('agent')], valueKey: [ref('amount', 'sum')], legendKey: [ref('decidedBy')] } },
  },
  money_by_merchant: {
    title: 'Paid and kept from leaving, by merchant',
    widget: { type: 'bar-chart-grouped', dataMapping: { categoryKey: [ref('merchant')], valueKey: [ref('paid', 'sum'), ref('blockedAmount', 'sum')] } },
  },
  blocked_by_agent: {
    title: 'Blocked attempts by agent',
    widget: { type: 'column-chart-grouped', dataMapping: { categoryKey: [ref('agent')], valueKey: [ref('blocked', 'sum'), ref('aiBlocked', 'sum')] } },
  },
} as const;
type ChartId = keyof typeof CHARTS;

interface LoosePage {
  id: string;
  widgets?: Record<string, unknown>;
  widgetLayout?: Record<string, { xTrack: number; yTrack: number; xSpan: number; ySpan: number } | undefined>;
}

const AUDITOR_INSTRUCTIONS = `You are the Allowance auditor. Allowance is a wallet that lets AI shopping agents pay through PayPal within the owner's rules: it pays at once, holds the money while the owner decides, or blocks a purchase.
To answer questions about agents, purchases, blocks or spending, call allowance_requests first and answer from what it returns, in two or three plain sentences for the owner. When the owner asks what was stopped or which agents tried to pay for the wrong things, repeat the summary sentence as it is, then write one short sentence for each entry of stopped_attempts: which agent tried to buy what (its items, word for word), for how much, and who stopped it (stopped_by). Never call anything in other_requests stopped: those were paid or are waiting.
When the owner asks whether the payments are right, or what PayPal really did, call check_with_paypal and answer with its in_words sentence as it is, then name any order that does not match. When the owner asks what PayPal itself has on record for the account, call paypal_transactions and say how many transactions PayPal lists, how many are Allowance's, and that new ones can take up to three hours to appear.
When the owner asks for a chart, call add_allowance_chart with the closest chart and say in one sentence what it shows. Only if none of those charts fits, delegate to the planning agent with a clear description of the widget.`;

/** The Insights agents: Allowance's auditor in front, AG Studio's own agents behind it to build widgets. */
export function allowanceAi(requests: { current: Purchase[] }): AgAiHarnessSetup {
  const adapter = chatCompletionsAdapter('/api/ai/chat/completions');
  return ({ api: coreApi }) => {
    // The setup is typed with Studio's core API; in the browser it is the full one.
    const api = coreApi as unknown as AgStudioApi;
    const requestsTool = api.defineAiTool({
      name: 'allowance_requests',
      description:
        'The purchase requests Allowance has seen, newest first: agent, merchant, amount, outcome (paid, held, blocked, denied), who decided (rules or the AI review) and why. Optionally filter by outcome or agent.',
      params: (s) => s.object({ outcome: s.string().optional(), agent: s.string().optional() }),
      execute: ({ outcome, agent }, ctx) => {
        const rows = requests.current
          .filter((p) => (!outcome || p.status.includes(outcome.toLowerCase().replace(/^held$/, 'on_hold'))) && (!agent || p.agentName.toLowerCase().includes(agent.toLowerCase())))
          .slice(0, 50)
          .map((p) => ({
            agent: p.agentName,
            merchant: p.merchant,
            items: p.items.map((item) => item.name).join(' + '),
            amount: `${(p.amountCents / 100).toFixed(2)} ${p.currency}`,
            outcome: outcomeInWords(p),
            // Spelled out, so a small model cannot call a paid purchase "stopped" or miss a stopped one.
            stopped: STOPPED.has(p.status),
            stopped_by: stoppedBy(p),
            why: p.explanation,
          }));
        if (!rows.length) return ctx.success('No matching requests.');
        // Stopped attempts come first, in a list of their own, so a small model names every one of them.
        const stopped = rows.filter((row) => row.stopped);
        const others = rows.filter((row) => !row.stopped);
        // Counted here, so the model does not confuse attempts with agents.
        const perAgent = new Map<string, number>();
        for (const row of stopped) perAgent.set(row.agent, (perAgent.get(row.agent) ?? 0) + 1);
        const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;
        const summary = stopped.length
          ? `${plural(stopped.length, 'stopped attempt')} by ${plural(perAgent.size, 'agent')}: ${[...perAgent].map(([name, n]) => `${name} (${n})`).join(', ')}.`
          : 'Nothing was stopped.';
        // Short on purpose, and without a data copy (Studio would pass it to the model too): a local model often runs
        // with a 4096-token context, and the whole chat has to fit in it.
        const brief = (text: string) => (text.length > 110 ? `${text.slice(0, 107)}...` : text);
        return ctx.success(
          JSON.stringify({
            summary,
            stopped_attempts: stopped.map(({ agent, items, amount, stopped_by, why }) => ({ agent, items, amount, stopped_by, why: brief(why) })),
            other_requests: others.map(({ agent, items, amount, outcome }) => ({ agent, items, amount, outcome })),
          }),
        );
      },
    });
    const paypalTool = api.defineAiTool({
      name: 'check_with_paypal',
      description:
        "Check the ledger against PayPal's own records, through PayPal's Agent Toolkit (its get_order tool, read-only): for every purchase that reached PayPal, what PayPal says about the order, the hold and the capture, and whether that matches the ledger. Blocked purchases never reach PayPal.",
      params: (s) => s.object({}),
      execute: async (_args, ctx) => {
        const response = await fetch('/api/paypal/reconcile', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
        const data = (await response.json().catch(() => ({}))) as ReconcileResult & { error?: string };
        if (!response.ok || !data.available || !data.checks) return ctx.success(data.reason ?? data.error ?? 'PayPal could not be checked.');
        const byId = new Map(requests.current.map((purchase) => [purchase.id, purchase]));
        const rows = data.checks.map((check) => {
          const purchase = byId.get(check.purchaseId);
          return {
            item: purchase ? purchase.items.map((item) => item.name).join(' + ') : check.merchant,
            amount: check.amount,
            ledger: purchase ? STATUS_WORD[purchase.status] ?? purchase.status : check.ledger,
            matches_ledger: check.matches,
            // What PayPal says, in full, only where it disagrees with the ledger.
            ...(check.matches ? {} : { paypal_says: check.paypal }),
          };
        });
        // Counted here, in words: a small model reads a voided hold as a payment if left to count by itself.
        const kinds = new Map<string, number>();
        for (const check of data.checks) {
          const status = byId.get(check.purchaseId)?.status;
          const kind = status === 'paid' ? 'payment captured' : status === 'on_hold' ? 'hold waiting for you' : status === 'denied' || status === 'expired' ? 'hold voided' : 'order';
          kinds.set(kind, (kinds.get(kind) ?? 0) + 1);
        }
        const count = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;
        const PLURAL: Record<string, string> = { 'payment captured': 'payments captured', 'hold waiting for you': 'holds waiting for you', 'hold voided': 'holds voided', order: 'orders' };
        const matching = data.checks.filter((check) => check.matches).length;
        const total = data.checks.length;
        const inWords =
          `${count(total, 'PayPal order', 'PayPal orders')} checked: ${[...kinds].map(([kind, n]) => count(n, kind, PLURAL[kind] ?? kind)).join(', ')}. ` +
          (matching === total ? `All ${total} match the ledger.` : `${matching} of ${total} match the ledger.`);
        return ctx.success(JSON.stringify({ in_words: inWords, checks: rows }));
      },
    });
    const transactionsTool = api.defineAiTool({
      name: 'paypal_transactions',
      description:
        "PayPal's own list of transactions for this account over the last seven days (Transaction Search, through PayPal's Agent Toolkit, read-only), each marked with whether it is one of Allowance's purchases. PayPal can take up to three hours to list a new payment.",
      params: (s) => s.object({}),
      execute: async (_args, ctx) => {
        const response = await fetch('/api/paypal/transactions');
        const data = (await response.json().catch(() => ({}))) as { available?: boolean; reason?: string; note?: string; transactions?: unknown[] };
        if (!response.ok || !data.available) return ctx.success(data.reason ?? 'PayPal could not be asked for its transaction list.');
        return ctx.success(JSON.stringify({ note: data.note, transactions: (data.transactions ?? []).slice(0, 30) }));
      },
    });
    const chartTool = api.defineAiTool({
      name: 'add_allowance_chart',
      description:
        'Add a ready-made chart under the summary at the top of the Insights page. money_by_decider: money each agent asked for, split by who decided (rules or AI review). money_by_merchant: money paid and money blocked, by merchant. blocked_by_agent: blocked attempts per agent, and how many the AI review stopped.',
      params: (s) => s.object({ chart: s.enum(Object.keys(CHARTS) as ChartId[], { description: 'Which chart to add.' }) }),
      execute: ({ chart }, ctx) => {
        const preset = CHARTS[chart];
        const state = structuredClone(api.getState()) as unknown as { selectedPageId: string; pages: LoosePage[] };
        const page = state.pages.find((p) => p.id === state.selectedPageId) ?? state.pages[0];
        if (!page) return ctx.success('There is no page to add the chart to.');
        // Make room under the summary row: everything from row 3 down moves down by the chart's height.
        for (const layout of Object.values(page.widgetLayout ?? {})) if (layout && layout.yTrack >= 3) layout.yTrack += 5;
        const id = `${chart}_${Date.now().toString(36)}`;
        page.widgets = { ...page.widgets, [id]: { ...preset.widget, format: { title: { text: preset.title, enabled: true }, ...legend } } };
        page.widgetLayout = { ...page.widgetLayout, [id]: { xTrack: 0, yTrack: 3, xSpan: 12, ySpan: 5 } };
        api.setState(state as unknown as ReturnType<typeof api.getState>);
        return ctx.success(`Added the chart "${preset.title}" under the summary at the top of the page.`);
      },
    });
    return createAiHarness(api, ({ builtIn, tools }) => ({
      agents: [
        ...(['planning', 'data', 'page', 'widget'] as const).map((id) => directLlmRunner({ ...builtIn[id], adapter })),
        directLlmRunner({
          id: 'auditor',
          name: 'Allowance auditor',
          description: "Answers the owner's questions about what the agents tried to buy, and asks Studio's agents for widgets.",
          adapter,
          schema: (s) => s.undefined(),
          instructions: () => AUDITOR_INSTRUCTIONS,
          tools: () => [
            requestsTool,
            paypalTool,
            transactionsTool,
            chartTool,
            tools.studio.viewSchema(),
            tools.studio.viewPage(),
            tools.delegateTo(['planning', 'data', 'page', 'widget']),
            tools.renameThread(),
          ],
        }),
      ],
      primary: 'auditor',
      promptStarters: [
        { label: 'What was blocked?', prompt: 'Which agents tried to pay for things they should not have, and who stopped them?' },
        { label: 'Check with PayPal', prompt: 'Check the ledger against PayPal: does every payment match what PayPal says?' },
        { label: 'Chart by decider', prompt: 'Add a chart of the money each agent asked for, split by who decided.' },
      ],
    }));
  };
}
