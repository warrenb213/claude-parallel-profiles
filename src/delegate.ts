import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import * as http from 'http';
import * as crypto from 'crypto';
import { spawn } from 'child_process';
import { claudeShellArgs } from './cli';
import { log } from './log';
import type { AgentTasks } from './agentTasks';
import { UsageBook, zaiQuota, fromRateLimitInfo } from './usage';

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
  /** Also enabled for agent tasks (agentTasks.ts): runs in a worktree with tools. */
  agent?: boolean;
  /**
   * 'login': Claude on the window's own Anthropic login — run as headless Claude
   * Code on the account's directory (callLoginWorker), never with its token here.
   */
  kind?: 'login';
  /** The provider's preset, for usage lookups (e.g. 'zai'). */
  preset?: string;
}

export interface WorkerSource {
  workers(): Worker[];
  keyFor(providerId: string): Promise<string | undefined>;
  /** The account's own Claude Code directory (its store — never a window's working dir, which may carry a gateway). */
  loginDir(): string | undefined;
  readonly onDidChange: vscode.EventEmitter<void>;
}

export const LOGIN_PROVIDER = 'Anthropic login';

const SERVER_NAME = 'claude-accounts-workers';
/** Caps per call — a worker is for focused questions, not for shipping the repo. */
const MAX_CONTEXT_CHARS = 120_000;
const MAX_OUTPUT_TOKENS = 8_192;
const DEFAULT_OUTPUT_TOKENS = 4_096;
/** Per window session (extension host lifetime). */
const MAX_CALLS = 100;
/**
 * Claude Code waits 60 s for an MCP call unless the server entry sets
 * `timeout`, and drops an HTTP MCP call that stays silent for 5 minutes
 * (CLAUDE_CODE_MCP_TOOL_IDLE_TIMEOUT). This server answers each call in one
 * piece, so every call must finish inside that: the entry asks for just under
 * 5 minutes, and calls give up before it.
 */
export const MCP_CALL_TIMEOUT_MS = 295_000;
const CALL_TIMEOUT_MS = 270_000;

const WORKER_SYSTEM =
  'You are a worker model consulted by another AI assistant (the lead), which is helping a user with ' +
  'software work. You only see what the lead sent you: answer the task with that, precisely and ' +
  'concisely. If the material is insufficient, say exactly what is missing instead of guessing. ' +
  'Your answer goes back to the lead, which will check it before relying on it.';

type Json = Record<string, unknown>;

/**
 * Room for reasoning on top of the answer cap. Models such as GLM think by
 * default and their thinking counts against max_tokens: with a 400-token cap,
 * GLM-5.3-Flash spent all 400 thinking and wrote no answer.
 */
const THINKING_HEADROOM = 8_192;

/** The worker call itself: an Anthropic Messages request to the worker's provider. */
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
  type Reply = {
    content?: Array<{ type?: string; text?: string }>;
    stop_reason?: string;
    usage?: { input_tokens?: number; output_tokens?: number };
    error?: { message?: string };
  };
  const send = async (extra: Record<string, unknown>): Promise<Reply> => {
    const res = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify({ model: w.model, system: WORKER_SYSTEM, messages: [{ role: 'user', content }], ...extra }),
      signal: AbortSignal.timeout(CALL_TIMEOUT_MS - (Date.now() - started)),
    });
    const body = (await res.json().catch(() => ({}))) as Reply;
    if (!res.ok) throw new Error(`${w.providerName} answered HTTP ${res.status}: ${body.error?.message ?? 'no details'}`);
    return body;
  };
  const textOf = (b: Reply) =>
    (b.content ?? []).filter((c) => c.type === 'text' && typeof c.text === 'string').map((c) => c.text).join('\n').trim();
  let body = await send({ max_tokens: maxTokens + THINKING_HEADROOM });
  let inTok = body.usage?.input_tokens ?? 0;
  let outTok = body.usage?.output_tokens ?? 0;
  if (!textOf(body) && body.stop_reason === 'max_tokens') {
    // It thought through the whole budget: ask again for a direct answer.
    body = await send({ max_tokens: maxTokens, thinking: { type: 'disabled' } });
    inTok += body.usage?.input_tokens ?? 0;
    outTok += body.usage?.output_tokens ?? 0;
  }
  return { text: textOf(body), inputTokens: inTok, outputTokens: outTok, ms: Date.now() - started };
}

/**
 * A worker on the Anthropic login: Claude Code itself, headless, on the
 * account's own directory — no tools, no MCP servers, the worker's system
 * prompt. The subscription is only ever used by Claude Code. Its stream also
 * carries the subscription's rate-limit windows (rate_limit_event), returned
 * for the usage book.
 */
export function callLoginWorker(
  w: Worker,
  accountDir: string,
  task: string,
  context: string | undefined
): Promise<{ text: string; inputTokens?: number; outputTokens?: number; ms: number; rateLimit?: Record<string, unknown> }> {
  const content = context ? `${task}\n\n<context>\n${context}\n</context>` : task;
  const args = [
    '-p', content, '--model', w.model, '--system-prompt', WORKER_SYSTEM, '--tools', '',
    '--strict-mcp-config', '--no-session-persistence', '--output-format', 'stream-json', '--verbose',
    // Belt and braces: the official endpoint and no provider key, whatever settings are around.
    '--settings', JSON.stringify({ env: { ANTHROPIC_BASE_URL: 'https://api.anthropic.com', ANTHROPIC_AUTH_TOKEN: '', ANTHROPIC_API_KEY: '' } }),
  ];
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const k of Object.keys(env)) if (k.startsWith('ANTHROPIC_') || k === 'CLAUDE_CONFIG_DIR') delete env[k];
  env.CLAUDE_CONFIG_DIR = accountDir;
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const child = spawn(process.env.SHELL || '/bin/bash', claudeShellArgs(args), {
      cwd: accountDir,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let buf = '';
    let err = '';
    let text = '';
    let usage: { input_tokens?: number; output_tokens?: number } | undefined;
    let rateLimit: Record<string, unknown> | undefined;
    let failed: string | undefined;
    const timer = setTimeout(() => child.kill('SIGKILL'), CALL_TIMEOUT_MS);
    const onLine = (line: string) => {
      try {
        const ev = JSON.parse(line) as { type?: string; result?: string; is_error?: boolean; usage?: typeof usage; rate_limit_info?: Record<string, unknown> };
        if (ev.type === 'rate_limit_event' && ev.rate_limit_info) rateLimit = ev.rate_limit_info;
        if (ev.type === 'result') {
          text = ev.result ?? '';
          usage = ev.usage;
          if (ev.is_error) failed = ev.result || 'the run ended with an error';
        }
      } catch {
        /* not JSON */
      }
    };
    child.stdout!.on('data', (d: Buffer) => {
      buf += d.toString();
      let nl: number;
      while ((nl = buf.indexOf('\n')) >= 0) {
        onLine(buf.slice(0, nl));
        buf = buf.slice(nl + 1);
      }
    });
    child.stderr!.on('data', (d: Buffer) => (err += d.toString()));
    child.on('close', (code) => {
      clearTimeout(timer);
      if (buf) onLine(buf);
      if (failed || (code !== 0 && !text)) {
        reject(new Error(failed ?? (err.trim().split('\n').slice(-2).join(' ') || `claude exited with ${code}`)));
      } else {
        resolve({ text: text.trim(), inputTokens: usage?.input_tokens, outputTokens: usage?.output_tokens, ms: Date.now() - started, rateLimit });
      }
    });
  });
}

/** One `delegate` call, kept for its transcript (the account hover links to them). */
export interface Consult {
  n: number;
  worker: string;
  caller: 'lead' | 'agent';
  at: number;
  task: string;
  context?: string;
  answer?: string;
  error?: string;
  ms?: number;
  inTok?: number;
  outTok?: number;
}

const KEEP_CONSULTS = 50;

export class DelegateServer implements vscode.Disposable {
  private server: http.Server | undefined;
  private port = 0;
  /** The lead's token: every tool. */
  private readonly token = crypto.randomBytes(24).toString('hex');
  /** Agent runs' token: consult and usage only — a worker can't start tasks. */
  private readonly workerToken = crypto.randomBytes(24).toString('hex');
  private calls = 0;
  readonly usage = new UsageBook();
  /** This window's latest consultations, oldest first. */
  readonly consults: Consult[] = [];
  readonly onDidConsult = new vscode.EventEmitter<Consult>();
  /** Open GET event streams (sessions listening for server notifications). */
  private readonly streams = new Set<http.ServerResponse>();
  private heartbeat: NodeJS.Timeout | undefined;
  /** The tool lists last announced, to notify only on a real change. */
  private lastTools = '';
  private readonly subscription: vscode.Disposable;

  /** `configDir`: this window's CLAUDE_CONFIG_DIR (its own working dir), or undefined when unbound. */
  constructor(
    private readonly source: WorkerSource,
    private readonly configDir: () => string | undefined,
    private readonly agents?: AgentTasks
  ) {
    this.subscription = source.onDidChange.event(() => void this.reconcile());
  }

  /** Server up and registered while any worker is enabled; down and unregistered otherwise. */
  async reconcile(): Promise<void> {
    const dir = this.configDir();
    const want = Boolean(dir) && this.source.workers().length > 0;
    try {
      if (want) {
        const wasUp = Boolean(this.server);
        await this.start();
        if (wasUp) this.notifyToolsChanged();
        register(dir!, {
          type: 'http',
          url: `http://127.0.0.1:${this.port}/mcp`,
          headers: { Authorization: `Bearer ${this.token}` },
          timeout: MCP_CALL_TIMEOUT_MS,
        });
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
        this.lastTools = JSON.stringify([this.tools(true), this.tools(false)]);
        log(`workers: MCP server on 127.0.0.1:${this.port} (${this.source.workers().map((w) => w.id).join(', ')})`);
        resolve();
      });
    });
  }

  private stop(): void {
    for (const s of this.streams) s.end();
    this.streams.clear();
    if (this.heartbeat) clearInterval(this.heartbeat);
    this.heartbeat = undefined;
    this.server?.close();
    this.server = undefined;
  }

  /**
   * Tells listening sessions their tool list changed (workers enabled or
   * removed, agent tasks switched on), so open Claude Code sessions re-read it
   * instead of keeping the list they started with.
   */
  private notifyToolsChanged(): void {
    const now = JSON.stringify([this.tools(true), this.tools(false)]);
    if (now === this.lastTools) return;
    this.lastTools = now;
    const event = `event: message\ndata: ${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/tools/list_changed' })}\n\n`;
    for (const s of this.streams) s.write(event);
    if (this.streams.size) log(`workers: told ${this.streams.size} session(s) the tools changed`);
  }

  private async handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const send = (status: number, body?: Json) => {
      res.writeHead(status, body ? { 'content-type': 'application/json' } : {});
      res.end(body ? JSON.stringify(body) : undefined);
    };
    const lead = req.headers.authorization === `Bearer ${this.token}`;
    if (!lead && req.headers.authorization !== `Bearer ${this.workerToken}`) return send(401, { error: 'unauthorized' });
    if (req.method === 'GET' && String(req.headers.accept ?? '').includes('text/event-stream')) {
      // A session listening for notifications (tools/list_changed).
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
      res.write(': listening\n\n');
      this.streams.add(res);
      req.on('close', () => this.streams.delete(res));
      // Comments keep idle connections from being dropped; clients ignore them.
      this.heartbeat ??= setInterval(() => this.streams.forEach((s) => s.write(': ping\n\n')), 25_000);
      return;
    }
    if (req.method === 'DELETE') return send(200);
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
          capabilities: { tools: { listChanged: true } },
          serverInfo: { name: SERVER_NAME, version: '1' },
          instructions:
            'Other AI models (workers) the user enabled. `delegate` asks one a question (answers only). ' +
            'Where enabled, start_task runs one as an agent on a scratch worktree of the repo and returns a ' +
            'diff via wait_task; review it before apply_task_changes. Check workers\' output before relying on it.',
        });
      case 'ping':
        return reply({});
      case 'tools/list':
        return reply({ tools: this.tools(lead) });
      case 'tools/call': {
        const name = String(msg.params?.name);
        if (!this.tools(lead).some((t) => t.name === name)) return reply({ content: [{ type: 'text', text: `Tool ${name} is not available here.` }], isError: true });
        return reply(await this.call(name, (msg.params?.arguments ?? {}) as Json, lead ? 'lead' : 'agent'));
      }
      default:
        return fail(-32601, `unknown method ${msg.method}`);
    }
  }

  /** Where agent runs reach this server, with the restricted token — while it is running. */
  workerAccess(): { url: string; token: string } | undefined {
    return this.server ? { url: `http://127.0.0.1:${this.port}/mcp`, token: this.workerToken } : undefined;
  }

  private tools(lead = true): Json[] {
    const ids = this.source.workers().map((w) => w.id);
    const all: Json[] = [
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
            // No enum: a session keeps the tool definitions it started with, so a list here
            // would go stale when the user changes workers. list_workers is always current.
            worker: { type: 'string', description: `Which worker — see list_workers (at session start: ${ids.join(', ')}).` },
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
      {
        name: 'provider_usage',
        description:
          "How much of each worker provider's plan is used (e.g. the Anthropic subscription's 5-hour and weekly " +
          "windows, Z.ai's credit windows) and this window's worker calls so far. Check it to spread work across " +
          'subscriptions instead of exhausting one.',
        inputSchema: { type: 'object', properties: {} },
      },
      ...(lead ? this.agentTools() : []),
    ];
    return all;
  }

  private agentTools(): Json[] {
    const ids = this.source.workers().filter((w) => w.agent).map((w) => w.id);
    if (!this.agents || ids.length === 0) return [];
    const id = { type: 'string', description: 'The task_id start_task returned.' };
    return [
      {
        name: 'start_task',
        description:
          'Start an agent task: a worker model (another provider the user enabled) runs Claude Code headless on a ' +
          "scratch git worktree of this repo — HEAD plus the user's uncommitted changes — with auto-mode tool use " +
          '(edits, commands checked by a safety classifier). It can consult other workers itself, answers only ' +
          "(e.g. Claude on the user's subscription). Returns a task_id at once; tasks take minutes. The worker " +
          'sees only its copy and what you put in task/context: gitignored files (scratch folders, build output) ' +
          'are not in it unless listed in `include` — or named in task/context by absolute path, which copies ' +
          'that file in. Get the result with wait_task.',
        inputSchema: {
          type: 'object',
          properties: {
            worker: { type: 'string', description: `An agent-enabled worker — see list_workers (at session start: ${ids.join(', ')}).` },
            task: { type: 'string', description: 'The job, stated completely, with how to verify it.' },
            context: { type: 'string', description: 'Anything it needs beyond the repo itself.' },
            include: {
              type: 'array',
              items: { type: 'string' },
              description:
                'Files or folders (relative to the repo root) to copy into the worker\'s copy even though they are ' +
                'gitignored — only what the task needs (5 MB a file, 100 MB and 2,000 files in all). Not with `after`.',
            },
            after: {
              type: 'string',
              description:
                "Chain: start from this task's result instead of the user's repo (waits for it if it is still running). " +
                'Applying a chained task also applies the unapplied tasks before it.',
            },
          },
          required: ['worker', 'task'],
        },
      },
      {
        name: 'wait_task',
        description: "Wait for an agent task (up to `seconds`), then return its status — or, when done, the worker's report and the diff of its changes.",
        inputSchema: {
          type: 'object',
          properties: { task_id: id, seconds: { type: 'integer', minimum: 1, maximum: 240, description: 'How long to wait, at most 240 s (default 120); call again if it is still running.' } },
          required: ['task_id'],
        },
      },
      {
        name: 'cancel_task',
        description: 'Stop a running agent task (its changes so far are still collected).',
        inputSchema: { type: 'object', properties: { task_id: id }, required: ['task_id'] },
      },
      {
        name: 'apply_task_changes',
        description:
          "Apply a finished task's diff to the user's working tree (unstaged). Only after you reviewed the diff from wait_task.",
        inputSchema: { type: 'object', properties: { task_id: id }, required: ['task_id'] },
      },
    ];
  }

  /** Refreshes what can be read without spending anything (Z.ai's monitor), then formats the book. */
  async usageReport(): Promise<string> {
    const ws = this.source.workers();
    for (const w of ws) {
      if (w.preset !== 'zai') continue;
      const e = this.usage.get(w.providerName);
      if (e && Date.now() - e.at < 60_000) continue;
      const key = await this.source.keyFor(w.providerId);
      const q = key ? await zaiQuota(key) : undefined;
      if (q) this.usage.set(w.providerName, q);
    }
    return this.usage.format([...new Set(ws.map((w) => w.providerName))]);
  }

  private async call(name: string, args: Json, caller: 'lead' | 'agent' = 'lead'): Promise<Json> {
    const text = (t: string, isError = false) => ({ content: [{ type: 'text', text: t }], ...(isError && { isError: true }) });
    if (name === 'list_workers') {
      const ws = this.source.workers();
      return text(ws.map((w) => `- ${w.id}: ${w.note} (${w.providerName}, model ${w.model})`).join('\n') || 'No workers are enabled.');
    }
    if (name === 'provider_usage') return text(await this.usageReport());
    if (this.agents && ['start_task', 'wait_task', 'cancel_task', 'apply_task_changes'].includes(name)) {
      try {
        const id = String(args.task_id ?? '');
        if (name === 'start_task') {
          const w = this.source.workers().find((x) => x.id === args.worker && x.agent);
          if (!w) {
            const agentIds = this.source.workers().filter((x) => x.agent).map((x) => x.id);
            return text(`No worker "${String(args.worker)}" enabled for agent tasks. Enabled now: ${agentIds.join(', ') || 'none'}.`, true);
          }
          const task = typeof args.task === 'string' ? args.task.trim() : '';
          if (!task) return text('`task` is required.', true);
          const context = typeof args.context === 'string' ? args.context : undefined;
          if (task.length + (context?.length ?? 0) > MAX_CONTEXT_CHARS) return text(`Too much to send (limit ${MAX_CONTEXT_CHARS} characters).`, true);
          const after = typeof args.after === 'string' && args.after ? args.after : undefined;
          const include = Array.isArray(args.include) ? args.include.filter((x): x is string => typeof x === 'string' && x.trim() !== '').map((x) => x.trim()) : [];
          const r = await this.agents.start(w.id, task, context, after, include);
          return text(
            `${r.queued ? 'Queued' : 'Started'} task ${r.id} on ${w.id}${after ? `, building on ${after}` : ''}` +
              `${r.queued ? (after ? ` — it starts when ${after} is done` : ' — it starts when a slot frees') : ''}. ` +
              `Call wait_task with task_id "${r.id}" for its result.${r.note ? `\n\nSnapshot: ${r.note}` : ''}`
          );
        }
        if (name === 'wait_task') {
          const r = await this.agents.wait(id, Number(args.seconds) || 120);
          return text(r.text, r.isError);
        }
        if (name === 'cancel_task') return text(this.agents.cancel(id));
        const r = await this.agents.apply(id);
        return text(r.text, r.isError);
      } catch (err) {
        return text((err as Error).message, true);
      }
    }
    if (name !== 'delegate') return text(`Unknown tool ${name}.`, true);
    const w = this.source.workers().find((x) => x.id === args.worker);
    if (!w) {
      return text(`No enabled worker "${String(args.worker)}". Enabled now: ${this.source.workers().map((x) => x.id).join(', ') || 'none'}.`, true);
    }
    const task = typeof args.task === 'string' ? args.task.trim() : '';
    const context = typeof args.context === 'string' ? args.context : undefined;
    if (!task) return text('`task` is required.', true);
    if ((context?.length ?? 0) + task.length > MAX_CONTEXT_CHARS) {
      return text(`Too much to send: ${(context?.length ?? 0) + task.length} characters (limit ${MAX_CONTEXT_CHARS}). Send only what the task needs.`, true);
    }
    if (this.calls >= MAX_CALLS) return text(`This window reached its limit of ${MAX_CALLS} worker calls; reload the window to reset it.`, true);
    const maxTokens = Math.min(Math.max(Number(args.max_tokens) || DEFAULT_OUTPUT_TOKENS, 64), MAX_OUTPUT_TOKENS);
    let run: () => Promise<{ text: string; inputTokens?: number; outputTokens?: number; ms: number; rateLimit?: Record<string, unknown> }>;
    if (w.kind === 'login') {
      const dir = this.source.loginDir();
      if (!dir) return text("This window's account has no directory of its own to run Claude on.", true);
      run = () => callLoginWorker(w, dir, task, context);
    } else {
      const key = await this.source.keyFor(w.providerId);
      if (!key) return text(`No key is stored for ${w.providerName}.`, true);
      run = () => callWorker(w, key, task, context, maxTokens);
    }
    this.calls++;
    const busy = vscode.window.setStatusBarMessage(`$(sync~spin) Worker ${w.id}…`);
    const consult: Consult = { n: this.calls, worker: w.id, caller, at: Date.now(), task, context };
    this.consults.push(consult);
    if (this.consults.length > KEEP_CONSULTS) this.consults.shift();
    this.onDidConsult.fire(consult);
    try {
      const r = await run();
      Object.assign(consult, { answer: r.text, ms: r.ms, inTok: r.inputTokens, outTok: r.outputTokens });
      if (r.rateLimit) {
        const windows = fromRateLimitInfo(r.rateLimit);
        if (windows.length) this.usage.set(w.providerName, { windows, source: "Claude Code's rate-limit report", at: Date.now() });
      }
      this.usage.count(w.id, 'call', r.inputTokens, r.outputTokens);
      log(`workers: ${w.id} answered${caller === 'agent' ? ' an agent task' : ''} in ${r.ms} ms (${r.inputTokens ?? '?'} in / ${r.outputTokens ?? '?'} out tokens)`);
      return text(`${r.text || '(empty answer)'}\n\n— ${w.id} · ${r.ms} ms · ${r.inputTokens ?? '?'} in / ${r.outputTokens ?? '?'} out tokens`);
    } catch (err) {
      consult.error = (err as Error).message;
      log(`workers: ${w.id} failed — ${(err as Error).message}`);
      return text(`Worker ${w.id} failed: ${(err as Error).message}`, true);
    } finally {
      busy.dispose();
      this.onDidConsult.fire(consult);
    }
  }

  dispose(): void {
    this.subscription.dispose();
    this.onDidConsult.dispose();
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
