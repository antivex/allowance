import { z } from 'zod';
import type { AiConfig } from '../config.js';

export type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

export class AiError extends Error {
  override name = 'AiError';
}

export interface JsonResult<T> {
  value: T;
  latencyMs: number;
}

interface ChatResponse {
  choices?: Array<{ message?: { content?: string | null } }>;
  error?: { message?: string } | string;
}

/** Pulls the first JSON object out of a model reply, tolerating code fences and chatter around it. */
export function extractJson(text: string): unknown {
  const cleaned = text.replace(/```(?:json)?/gi, '').trim();
  const start = cleaned.indexOf('{');
  const end = cleaned.lastIndexOf('}');
  if (start === -1 || end <= start) throw new AiError('The model did not return JSON.');
  try {
    return JSON.parse(cleaned.slice(start, end + 1)) as unknown;
  } catch {
    throw new AiError('The model returned broken JSON.');
  }
}

/**
 * A minimal client for any OpenAI-compatible /chat/completions endpoint: Ollama (default),
 * LM Studio, vLLM, OpenAI, Groq, OpenRouter...
 */
export class ChatClient {
  private readonly fetch: FetchLike;
  /** Some providers reject json_schema or reasoning_effort; after one 400 we fall back to plain JSON mode. */
  private simpleMode = false;

  constructor(
    private readonly config: Pick<AiConfig, 'baseUrl' | 'apiKey' | 'model' | 'reasoningEffort' | 'timeoutMs'>,
    fetchImpl?: FetchLike,
  ) {
    this.fetch = fetchImpl ?? ((url, init) => fetch(url, init));
  }

  get model(): string {
    return this.config.model;
  }

  async json<T>(params: { system: string; user: string; schema: z.ZodType<T>; name: string }): Promise<JsonResult<T>> {
    const started = Date.now();
    let content: string;
    try {
      content = await this.complete(params, this.simpleMode);
    } catch (error) {
      if (!(error instanceof BadRequest) || this.simpleMode) throw unwrap(error);
      this.simpleMode = true;
      content = await this.complete(params, true).catch((retryError: unknown) => {
        throw unwrap(retryError);
      });
    }
    const parsed = params.schema.safeParse(extractJson(content));
    if (!parsed.success) {
      throw new AiError(`The model reply did not match the expected shape: ${parsed.error.issues[0]?.message ?? 'invalid'}.`);
    }
    return { value: parsed.data, latencyMs: Date.now() - started };
  }

  private async complete(
    params: { system: string; user: string; schema: z.ZodType<unknown>; name: string },
    simple: boolean,
  ): Promise<string> {
    const body: Record<string, unknown> = {
      model: this.config.model,
      temperature: 0,
      messages: [
        { role: 'system', content: params.system },
        { role: 'user', content: params.user },
      ],
      response_format: simple
        ? { type: 'json_object' }
        : { type: 'json_schema', json_schema: { name: params.name, schema: z.toJSONSchema(params.schema), strict: true } },
    };
    if (!simple && this.config.reasoningEffort) body.reasoning_effort = this.config.reasoningEffort;

    let response: Response;
    try {
      response = await this.fetch(`${this.config.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(this.config.apiKey ? { Authorization: `Bearer ${this.config.apiKey}` } : {}),
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(this.config.timeoutMs),
      });
    } catch (error) {
      const timedOut = error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError');
      throw new AiError(
        timedOut
          ? `No answer from ${this.config.model} within ${Math.round(this.config.timeoutMs / 1000)} s.`
          : `Cannot reach the AI endpoint at ${this.config.baseUrl}.`,
      );
    }
    const text = await response.text();
    let data: ChatResponse = {};
    try {
      data = JSON.parse(text) as ChatResponse;
    } catch {
      // handled below
    }
    if (!response.ok) {
      const message = typeof data.error === 'string' ? data.error : (data.error?.message ?? text.slice(0, 200));
      if (response.status === 400) throw new BadRequest(message);
      throw new AiError(`The AI endpoint answered HTTP ${response.status}: ${message}`);
    }
    const content = data.choices?.[0]?.message?.content;
    if (!content) throw new AiError('The model returned an empty answer.');
    return content;
  }

  /** Checks that the endpoint answers and the model exists. Used by the dashboard status badge. */
  async health(): Promise<{ ok: boolean; detail: string }> {
    try {
      const response = await this.fetch(`${this.config.baseUrl}/models`, {
        method: 'GET',
        headers: this.config.apiKey ? { Authorization: `Bearer ${this.config.apiKey}` } : {},
        signal: AbortSignal.timeout(3000),
      });
      if (!response.ok) return { ok: false, detail: `HTTP ${response.status} from ${this.config.baseUrl}` };
      const data = (await response.json()) as { data?: Array<{ id?: string }> };
      const ids = (data.data ?? []).map((model) => model.id);
      if (ids.length > 0 && !ids.includes(this.config.model)) {
        return { ok: false, detail: `Model ${this.config.model} not found. With Ollama: ollama pull ${this.config.model}` };
      }
      return { ok: true, detail: `${this.config.model} ready` };
    } catch {
      return { ok: false, detail: `Cannot reach ${this.config.baseUrl}` };
    }
  }
}

class BadRequest extends Error {}

function unwrap(error: unknown): Error {
  if (error instanceof BadRequest) return new AiError(`The AI endpoint rejected the request: ${error.message}`);
  return error instanceof Error ? error : new AiError(String(error));
}
