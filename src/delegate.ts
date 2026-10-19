import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import * as http from 'http';
import * as crypto from 'crypto';
import { log } from './log';

/**
 * Workers: other models the window's AI can consult — "Claude leads, others help".
 *
 * A small MCP server inside the extension host, on 127.0.0.1 behind a random
 * token. Claude Code connects to it like any MCP server and gets two tools:
 * `list_workers` and `delegate`. A worker only answers: one request with the
 * task and the context the lead chose to send, nothing else — it can't read
 * files or run anything. Provider keys never leave VS Code's secret storage:
 * the server asks for a key per call.
 *
 * Why here and not in the session: a Claude Code session has one endpoint and
 * one credential. Consulting another provider from a session on the Anthropic
 * login would otherwise mean proxying that login — which this never does.
 *
 * Registered in the window's own CLAUDE_CONFIG_DIR/.claude.json (user-scope
 * mcpServers) only while at least one worker is enabled; removed otherwise and
 * when the window closes. New Claude Code sessions pick it up.
 */

export interface Worker {
  /** Stable handle the lead passes to `delegate`, e.g. "zai/glm-5.3". */
  id: string;
  providerId: string;
  providerName: string;
  model: string;
  baseUrl: string;
  auth: 'bearer' | 'x-api-key';
  /** One line for the lead: what this worker is good for. */
  note: string;
}

export interface WorkerSource {
  workers(): Worker[];
  keyFor(providerId: string): Promise<string | undefined>;
  readonly onDidChange: vscode.EventEmitter<void>;
}

const SERVER_NAME = 'claude-accounts-workers';
/** Caps per call — a worker is for focused questions, not for shipping the repo. */
const MAX_CONTEXT_CHARS = 120_000;
const MAX_OUTPUT_TOKENS = 8_192;
const DEFAULT_OUTPUT_TOKENS = 4_096;
/** Per window session (extension host lifetime). */
const MAX_CALLS = 100;
const CALL_TIMEOUT_MS = 10 * 60_000;

const WORKER_SYSTEM =
  'You are a worker model consulted by another AI assistant (the lead), which is helping a user with ' +
  'software work. You only see what the lead sent you: answer the task with that, precisely and ' +
  'concisely. If the material is insufficient, say exactly what is missing instead of guessing. ' +
  'Your answer goes back to the lead, which will check it before relying on it.';

type Json = Record<string, unknown>;

/** The worker call itself: one Anthropic Messages request to the worker's provider. */
export async function callWorker(
  w: Worker,
  key: string,
  task: string,
  context: string | undefined,
  maxTokens: number
): Promise<{ text: string; inputTokens?: number; outputTokens?: number; ms: number }> {
  const url = `${w.baseUrl.replace(/\/+$/, '')}/v1/messages`;
  const headers: Record<string, string> = { 'content-type': 'application/json', 'anthropic-version': '2023-06-01' };
  if (w.auth === 'x-api-key') headers['x-api-key'] = key;
  else headers.authorization = `Bearer ${key}`;
  const content = context ? `${task}\n\n<context>\n${context}\n</context>` : task;
  const started = Date.now();
  const res = await fetch(url, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      model: w.model,
      max_tokens: maxTokens,
      system: WORKER_SYSTEM,
      messages: [{ role: 'user', content }],
    }),
    signal: AbortSignal.timeout(CALL_TIMEOUT_MS),
  });
  const body = (await res.json().catch(() => ({}))) as {
    content?: Array<{ type?: string; text?: string }>;
    usage?: { input_tokens?: number; output_tokens?: number };
    error?: { message?: string };
  };
  if (!res.ok) throw new Error(`${w.providerName} answered HTTP ${res.status}: ${body.error?.message ?? 'no details'}`);
  const text = (body.content ?? [])
    .filter((b) => b.type === 'text' && typeof b.text === 'string')
    .map((b) => b.text)
    .join('\n')
    .trim();
  return { text, inputTokens: body.usage?.input_tokens, outputTokens: body.usage?.output_tokens, ms: Date.now() - started };
}

export class DelegateServer implements vscode.Disposable {
  private server: http.Server | undefined;
  private port = 0;
  private readonly token = crypto.randomBytes(24).toString('hex');
  private calls = 0;
  private readonly subscription: vscode.Disposable;

  /** `configDir`: this window's CLAUDE_CONFIG_DIR (its own working dir), or undefined when unbound. */
  constructor(
    private readonly source: WorkerSource,
    private readonly configDir: () => string | undefined
  ) {
    this.subscription = source.onDidChange.event(() => void this.reconcile());
  }

  /** Server up and registered while any worker is enabled; down and unregistered otherwise. */
  async reconcile(): Promise<void> {
    const dir = this.configDir();
    const want = Boolean(dir) && this.source.workers().length > 0;
    try {
      if (want) {
        await this.start();
        register(dir!, { type: 'http', url: `http://127.0.0.1:${this.port}/mcp`, headers: { Authorization: `Bearer ${this.token}` } });
      } else {
        if (dir) register(dir, undefined);
        this.stop();
      }
    } catch (err) {
      log(`workers: ${(err as Error).message}`);
    }
  }

  private start(): Promise<void> {
    if (this.server) return Promise.resolve();
    const server = http.createServer((req, res) => void this.handle(req, res));
    this.server = server;
    return new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => {
        this.port = (server.address() as { port: number }).port;
        log(`workers: MCP server on 127.0.0.1:${this.port} (${this.source.workers().map((w) => w.id).join(', ')})`);
        resolve();
      });
    });
  }

  private stop(): void {
    this.server?.close();
    this.server = undefined;
  }

  private async handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const send = (status: number, body?: Json) => {
      res.writeHead(status, body ? { 'content-type': 'application/json' } : {});
      res.end(body ? JSON.stringify(body) : undefined);
    };
    if (req.headers.authorization !== `Bearer ${this.token}`) return send(401, { error: 'unauthorized' });
    if (req.method !== 'POST') return send(405);
    let raw = '';
    for await (const chunk of req) {
      raw += chunk;
      if (raw.length > MAX_CONTEXT_CHARS * 4) return send(413, { error: 'request too large' });
    }
    let msg: { jsonrpc?: string; id?: unknown; method?: string; params?: Json };
    try {
      msg = JSON.parse(raw);
    } catch {
      return send(400, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'parse error' } });
    }
    if (msg.id === undefined) return send(202); // a notification (initialized, cancelled…)
    const reply = (result: Json) => send(200, { jsonrpc: '2.0', id: msg.id, result });
    const fail = (code: number, message: string) => send(200, { jsonrpc: '2.0', id: msg.id, error: { code, message } });
    switch (msg.method) {
      case 'initialize':
        return reply({
          protocolVersion: typeof msg.params?.protocolVersion === 'string' ? msg.params.protocolVersion : '2025-06-18',
          capabilities: { tools: {} },
          serverInfo: { name: SERVER_NAME, version: '1' },
          instructions:
            'Other AI models (workers) the user enabled for consultation. Use them for second opinions, ' +
            'reviews, drafts and bulk text work; check their answers before relying on them.',
        });
      case 'ping':
        return reply({});
      case 'tools/list':
        return reply({ tools: this.tools() });
      case 'tools/call':
        return reply(await this.call(String(msg.params?.name), (msg.params?.arguments ?? {}) as Json));
      default:
        return fail(-32601, `unknown method ${msg.method}`);
    }
  }

  private tools(): Json[] {
    const ids = this.source.workers().map((w) => w.id);
    return [
      {
        name: 'list_workers',
        description: 'List the worker models the user enabled, with what each is good for.',
        inputSchema: { type: 'object', properties: {} },
      },
      {
        name: 'delegate',
        description:
          'Ask a worker model (another provider the user enabled) to do a focused task and return its answer. ' +
          'The worker sees ONLY `task` and `context` — paste in everything it needs (code, text, constraints). ' +
          'It cannot read files or run commands. What you send goes to that third-party provider: send only ' +
          "what the task needs, never secrets. Check the answer before relying on it. Up to " +
          `${MAX_CONTEXT_CHARS.toLocaleString('en-US')} characters of context.`,
        inputSchema: {
          type: 'object',
          properties: {
            worker: { type: 'string', enum: ids, description: 'Which worker (see list_workers).' },
            task: { type: 'string', description: 'What to do, stated completely.' },
            context: { type: 'string', description: 'The material to work on: code, text, notes.' },
            max_tokens: {
              type: 'integer',
              minimum: 64,
              maximum: MAX_OUTPUT_TOKENS,
              description: `Answer length cap (default ${DEFAULT_OUTPUT_TOKENS}).`,
            },
          },
          required: ['worker', 'task'],
        },
      },
    ];
  }

  private async call(name: string, args: Json): Promise<Json> {
    const text = (t: string, isError = false) => ({ content: [{ type: 'text', text: t }], ...(isError && { isError: true }) });
    if (name === 'list_workers') {
      const ws = this.source.workers();
      return text(ws.map((w) => `- ${w.id}: ${w.note} (${w.providerName}, model ${w.model})`).join('\n') || 'No workers are enabled.');
    }
    if (name !== 'delegate') return text(`Unknown tool ${name}.`, true);
    const w = this.source.workers().find((x) => x.id === args.worker);
    if (!w) return text(`No enabled worker "${String(args.worker)}". Call list_workers.`, true);
    const task = typeof args.task === 'string' ? args.task.trim() : '';
    const context = typeof args.context === 'string' ? args.context : undefined;
    if (!task) return text('`task` is required.', true);
    if ((context?.length ?? 0) + task.length > MAX_CONTEXT_CHARS) {
      return text(`Too much to send: ${(context?.length ?? 0) + task.length} characters (limit ${MAX_CONTEXT_CHARS}). Send only what the task needs.`, true);
    }
    if (this.calls >= MAX_CALLS) return text(`This window reached its limit of ${MAX_CALLS} worker calls; reload the window to reset it.`, true);
    const maxTokens = Math.min(Math.max(Number(args.max_tokens) || DEFAULT_OUTPUT_TOKENS, 64), MAX_OUTPUT_TOKENS);
    const key = await this.source.keyFor(w.providerId);
    if (!key) return text(`No key is stored for ${w.providerName}.`, true);
    this.calls++;
    const busy = vscode.window.setStatusBarMessage(`$(sync~spin) Worker ${w.id}…`);
    try {
      const r = await callWorker(w, key, task, context, maxTokens);
      log(`workers: ${w.id} answered in ${r.ms} ms (${r.inputTokens ?? '?'} in / ${r.outputTokens ?? '?'} out tokens)`);
      return text(`${r.text || '(empty answer)'}\n\n— ${w.id} · ${r.ms} ms · ${r.inputTokens ?? '?'} in / ${r.outputTokens ?? '?'} out tokens`);
    } catch (err) {
      log(`workers: ${w.id} failed — ${(err as Error).message}`);
      return text(`Worker ${w.id} failed: ${(err as Error).message}`, true);
    } finally {
      busy.dispose();
    }
  }

  dispose(): void {
    this.subscription.dispose();
    const dir = this.configDir();
    if (dir) {
      try {
        register(dir, undefined);
      } catch {
        /* best effort on shutdown */
      }
    }
    this.stop();
  }
}

/**
 * Adds (or, with undefined, removes) the server in the dir's .claude.json
 * `mcpServers`. Read-modify-write with an atomic rename; leaves everything else
 * — Claude Code's own state — as it was, and never writes a file it can't parse.
 */
function register(dir: string, entry: Json | undefined): void {
  const file = path.join(dir, '.claude.json');
  let config: Json = {};
  try {
    config = JSON.parse(fs.readFileSync(file, 'utf-8')) as Json;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') return;
  }
  const servers = { ...((config.mcpServers as Json | undefined) ?? {}) };
  if (entry) {
    if (JSON.stringify(servers[SERVER_NAME]) === JSON.stringify(entry)) return;
    servers[SERVER_NAME] = entry;
  } else {
    if (!(SERVER_NAME in servers)) return;
    delete servers[SERVER_NAME];
  }
  config.mcpServers = servers;
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(config, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, file);
}
