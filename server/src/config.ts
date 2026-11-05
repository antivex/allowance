import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import type { AiFailureMode } from './policy/combine.js';

export interface AiConfig {
  enabled: boolean;
  baseUrl: string;
  apiKey: string;
  model: string;
  /** Sent as `reasoning_effort`; "none" turns off slow thinking on Ollama. Empty to omit. */
  reasoningEffort: string;
  timeoutMs: number;
  onFailure: AiFailureMode;
}

export interface Config {
  port: number;
  host: string;
  publicUrl: string;
  dataDir: string;
  currency: string;
  /** Minutes the owner has to decide before a hold is voided. */
  holdMinutes: number;
  paypal: { clientId: string; clientSecret: string; recordDir: string | null } | null;
  ai: AiConfig;
  /** Port of the demo shop, or 0 to turn it off. */
  shopPort: number;
  /** AG Studio license key for the Insights tab, handed to the dashboard at runtime and never logged. */
  agStudioLicenseKey: string | null;
}

export class ConfigError extends Error {}

/** Loads `.env` from the project root if present, without overriding variables already set. */
export function loadDotEnv(root: string = process.cwd()): void {
  const file = resolve(root, '.env');
  if (existsSync(file)) process.loadEnvFile(file);
}

function int(env: NodeJS.ProcessEnv, key: string, fallback: number, min: number, max: number): number {
  const raw = env[key]?.trim();
  if (!raw) return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new ConfigError(`${key} must be a whole number between ${min} and ${max}, got "${raw}".`);
  }
  return value;
}

function str(env: NodeJS.ProcessEnv, key: string, fallback: string): string {
  const raw = env[key];
  return raw === undefined ? fallback : raw.trim();
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env, root: string = process.cwd()): Config {
  const port = int(env, 'PORT', 4000, 1, 65535);
  const host = str(env, 'HOST', '127.0.0.1') || '127.0.0.1';
  const currency = (str(env, 'CURRENCY', 'USD') || 'USD').toUpperCase();
  if (!/^[A-Z]{3}$/.test(currency)) throw new ConfigError(`CURRENCY must be a 3-letter code, got "${currency}".`);

  const paypalEnv = str(env, 'PAYPAL_ENV', 'sandbox').toLowerCase();
  if (paypalEnv !== 'sandbox') {
    throw new ConfigError('Only PAYPAL_ENV=sandbox is supported: this build never moves real money.');
  }
  const clientId = str(env, 'PAYPAL_CLIENT_ID', '');
  const clientSecret = str(env, 'PAYPAL_CLIENT_SECRET', '');
  if (Boolean(clientId) !== Boolean(clientSecret)) {
    throw new ConfigError('Set both PAYPAL_CLIENT_ID and PAYPAL_CLIENT_SECRET, or neither for the offline simulation.');
  }
  const recordDir = str(env, 'PAYPAL_RECORD_DIR', '');

  const onFailure = str(env, 'AI_ON_FAILURE', 'ask');
  if (onFailure !== 'ask' && onFailure !== 'keep') throw new ConfigError('AI_ON_FAILURE must be "ask" or "keep".');

  return {
    port,
    host,
    publicUrl: (str(env, 'PUBLIC_URL', '') || `http://localhost:${port}`).replace(/\/$/, ''),
    dataDir: resolve(root, str(env, 'DATA_DIR', 'data') || 'data'),
    currency,
    holdMinutes: int(env, 'HOLD_TIMEOUT_MINUTES', 1440, 1, 3 * 24 * 60),
    paypal: clientId ? { clientId, clientSecret, recordDir: recordDir ? resolve(root, recordDir) : null } : null,
    ai: {
      enabled: str(env, 'AI_ENABLED', 'true').toLowerCase() !== 'false',
      baseUrl: (str(env, 'AI_BASE_URL', 'http://localhost:11434/v1') || 'http://localhost:11434/v1').replace(/\/$/, ''),
      apiKey: str(env, 'AI_API_KEY', 'ollama'),
      model: str(env, 'AI_MODEL', 'qwen3.5:4b') || 'qwen3.5:4b',
      reasoningEffort: str(env, 'AI_REASONING_EFFORT', 'none'),
      timeoutMs: int(env, 'AI_TIMEOUT_MS', 30_000, 1_000, 300_000),
      onFailure,
    },
    shopPort: int(env, 'SHOP_PORT', 4100, 0, 65535),
    agStudioLicenseKey: str(env, 'AG_STUDIO_LICENSE_KEY', '') || null,
  };
}
