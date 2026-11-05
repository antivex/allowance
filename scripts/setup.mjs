// First-run helper: checks Node, creates .env from .env.example (never overwrites), checks the AI endpoint.
import { copyFileSync, existsSync, readFileSync } from 'node:fs';

const [major, minor] = process.versions.node.split('.').map(Number);
if (major < 22 || (major === 22 && minor < 13)) {
  console.error(`Allowance needs Node 22.13 or newer (built-in SQLite). You have ${process.versions.node}.`);
  process.exit(1);
}
console.log(`ok  Node ${process.versions.node}`);

if (existsSync('.env')) {
  console.log('ok  .env already exists (left untouched)');
} else {
  copyFileSync('.env.example', '.env');
  console.log('ok  created .env from .env.example');
}

const env = Object.fromEntries(
  readFileSync('.env', 'utf8')
    .split(/\r?\n/)
    .filter((line) => /^[A-Z_]+=/.test(line))
    .map((line) => [line.slice(0, line.indexOf('=')), line.slice(line.indexOf('=') + 1).trim()]),
);
const pick = (key, fallback) => process.env[key] ?? (env[key] || fallback);

console.log(
  pick('PAYPAL_CLIENT_ID', '')
    ? 'ok  PayPal sandbox credentials found'
    : '--  no PayPal credentials: Allowance will run the offline simulation (see README to use the sandbox)',
);

const baseUrl = pick('AI_BASE_URL', 'http://localhost:11434/v1').replace(/\/$/, '');
const model = pick('AI_MODEL', 'qwen3.5:4b');
try {
  const response = await fetch(`${baseUrl}/models`, {
    headers: { Authorization: `Bearer ${pick('AI_API_KEY', 'ollama')}` },
    signal: AbortSignal.timeout(3000),
  });
  const ids = ((await response.json()).data ?? []).map((m) => m.id);
  if (ids.includes(model)) console.log(`ok  AI model ${model} is available at ${baseUrl}`);
  else console.log(`--  ${model} not found at ${baseUrl}. With Ollama run: ollama pull ${model}`);
} catch {
  console.log(`--  no AI endpoint at ${baseUrl}. Install Ollama (https://ollama.com), then: ollama pull ${model}`);
  console.log('    Allowance still works without it: purchases the rules would approve wait for you instead.');
}

console.log('\nNext: npm start, then open the one-time link it prints to choose the owner password.');
