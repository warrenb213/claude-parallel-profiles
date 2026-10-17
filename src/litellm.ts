import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as net from 'net';
import * as crypto from 'crypto';
import { execFile, spawn } from 'child_process';
import { workingRoot } from './workdir';
import { log } from './log';

/**
 * A local LiteLLM proxy, so Claude Code can run models that only speak OpenAI's
 * chat-completions format (Qwen, GLM, DeepSeek… on Poe), next to the Claude
 * models the same gateway serves natively.
 *
 * Claude Code → LiteLLM (127.0.0.1) → the gateway:
 *   • Claude models: passed through to the gateway's /v1/messages UNCHANGED
 *     (`model_info.supported_endpoints` contains "/v1/messages"), so thinking,
 *     effort, tools and context management reach it exactly as without a proxy;
 *   • everything else: translated to /v1/chat/completions and back, tool calls
 *     included. `use_chat_completions_url_for_anthropic_messages` matters: without
 *     it LiteLLM routes OpenAI-style models to the Responses API, which most Poe
 *     models don't serve.
 * Verified end to end with the CLI, a mock gateway and a translated tool call.
 *
 * Supply chain: LiteLLM's PyPI package was hijacked on 2026-03-24 (1.82.7/1.82.8
 * stole credentials at interpreter start-up). This proxy holds the gateway key,
 * so it is never installed by name: every one of its packages is pinned by hash in
 * litellm/requirements.lock, shipped inside the extension, and pip/uv install with
 * --require-hashes — a tampered upload fails to install instead of running.
 *
 * Network: LiteLLM fetches three JSON files from its GitHub `main` branch at
 * start-up (price map, Anthropic beta-header rules, router presets) — remote
 * config that can change its behaviour. The LOCAL_* switches below keep it on the
 * copies inside the pinned package; verified to leave no outbound connection but
 * the gateway itself.
 *
 * One proxy per provider per host, shared by every window on the host that uses
 * it, listening on 127.0.0.1 only and requiring its own random key. The gateway
 * key reaches it through its environment, never a file.
 */

const NO_REMOTE_CONFIG = {
  LITELLM_LOCAL_MODEL_COST_MAP: 'True',
  LITELLM_LOCAL_ANTHROPIC_BETA_HEADERS: 'True',
  LITELLM_LOCAL_AUTOROUTER_PRESETS: 'True',
};

function root(): string {
  return path.join(workingRoot(), 'litellm');
}
function venv(): string {
  return path.join(root(), 'venv');
}
function marker(): string {
  return path.join(venv(), '.installed-lock-sha256');
}
const sha256 = (s: string | Buffer) => crypto.createHash('sha256').update(s).digest('hex');

/** Installed, and from exactly the lockfile this extension version ships. */
export function isInstalled(lockPath: string): boolean {
  try {
    return (
      fs.readFileSync(marker(), 'utf-8') === sha256(fs.readFileSync(lockPath)) &&
      fs.existsSync(path.join(venv(), 'bin', 'litellm'))
    );
  } catch {
    return false;
  }
}

function run(cmd: string, args: string[], env?: NodeJS.ProcessEnv): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      cmd,
      args,
      { env: env ?? process.env, timeout: 15 * 60_000, maxBuffer: 16 * 1024 * 1024 },
      (err, stdout, stderr) => {
        if (err) reject(new Error(`${path.basename(cmd)} ${args[0]}: ${(stderr || err.message).trim().split('\n').slice(-3).join(' ')}`));
        else resolve(stdout.toString());
      }
    );
  });
}

/** An executable on PATH or in the usual user install dirs (VS Code's PATH may lack ~/.local/bin). */
function findExecutable(name: string): string | undefined {
  const dirs = [
    ...(process.env.PATH ?? '').split(path.delimiter),
    path.join(os.homedir(), '.local', 'bin'),
    path.join(os.homedir(), '.cargo', 'bin'),
  ];
  for (const d of dirs) {
    const p = path.join(d, name);
    try {
      fs.accessSync(p, fs.constants.X_OK);
      return p;
    } catch {
      /* not here */
    }
  }
  return undefined;
}

/** A Python LiteLLM supports (3.10–3.14), for when uv isn't available. */
async function findPython(): Promise<string | undefined> {
  for (const name of ['python3.13', 'python3.12', 'python3.11', 'python3.10', 'python3.14', 'python3']) {
    const p = findExecutable(name);
    if (!p) continue;
    try {
      const [major, minor] = (await run(p, ['-c', 'import sys; print(*sys.version_info[:2])'])).trim().split(' ').map(Number);
      if (major === 3 && minor >= 10 && minor <= 14) return p;
    } catch {
      /* broken interpreter — try the next */
    }
  }
  return undefined;
}

/**
 * Serialises work across windows (each its own extension host) with an
 * exclusive-create lock file. A lock older than `staleMs` is from a host that
 * died mid-way and is taken over.
 */
async function withLock<T>(file: string, staleMs: number, fn: () => Promise<T>): Promise<T> {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  for (;;) {
    try {
      fs.closeSync(fs.openSync(file, 'wx', 0o600));
      break;
    } catch {
      try {
        if (Date.now() - fs.statSync(file).mtimeMs > staleMs) fs.rmSync(file, { force: true });
      } catch {
        /* released meanwhile */
      }
      await new Promise((r) => setTimeout(r, 500));
    }
  }
  try {
    return await fn();
  } finally {
    fs.rmSync(file, { force: true });
  }
}

/** Installs LiteLLM into ~/.claude-windows/litellm/venv from the hash-pinned lockfile. */
export async function install(lockPath: string): Promise<void> {
  await withLock(path.join(root(), 'install.lock'), 20 * 60_000, async () => {
    if (isInstalled(lockPath)) return; // another window finished it while we waited
    // A venv can't be moved (its scripts hold absolute paths), so it's built in
    // place; the marker, written last, is what says it's complete.
    fs.rmSync(venv(), { recursive: true, force: true });
    const uv = findExecutable('uv');
    if (uv) {
      log(`litellm: installing with ${uv}`);
      await run(uv, ['venv', '--quiet', '--python', '>=3.10,<3.15', venv()]);
      await run(uv, ['pip', 'install', '--quiet', '--require-hashes', '-r', lockPath], {
        ...process.env,
        VIRTUAL_ENV: venv(),
      });
    } else {
      const python = await findPython();
      if (!python) throw new Error('LiteLLM needs Python 3.10–3.14 (or uv) on this host, and neither was found.');
      log(`litellm: installing with ${python} -m venv + pip`);
      await run(python, ['-m', 'venv', venv()]);
      await run(path.join(venv(), 'bin', 'pip'), [
        'install', '--quiet', '--no-input', '--disable-pip-version-check', '--require-hashes', '-r', lockPath,
      ]);
    }
    fs.writeFileSync(marker(), sha256(fs.readFileSync(lockPath)), { mode: 0o600 });
    log('litellm: installed');
  });
}

export interface ProxyHandle {
  port: number;
  masterKey: string;
}

interface ProxyState extends ProxyHandle {
  pid: number;
  hash: string;
}

/** Alive AND still our LiteLLM — a recycled PID must not count. */
function isOurProxy(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return fs.readFileSync(`/proc/${pid}/cmdline`, 'utf-8').includes(path.join(venv(), 'bin', 'litellm'));
  } catch {
    return false;
  }
}

async function healthy(port: number): Promise<boolean> {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/health/liveliness`, { signal: AbortSignal.timeout(2000) });
    return res.ok;
  } catch {
    return false;
  }
}

function portFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const s = net.createServer();
    s.once('error', () => resolve(false));
    s.listen(port, '127.0.0.1', () => s.close(() => resolve(true)));
  });
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.once('error', reject);
    s.listen(0, '127.0.0.1', () => {
      const port = (s.address() as net.AddressInfo).port;
      s.close(() => resolve(port));
    });
  });
}

async function stopPid(pid: number): Promise<void> {
  if (!isOurProxy(pid)) return;
  try {
    process.kill(-pid, 'SIGTERM'); // its process group: uvicorn workers too
  } catch {
    try {
      process.kill(pid, 'SIGTERM');
    } catch {
      return;
    }
  }
  for (let i = 0; i < 20 && isOurProxy(pid); i++) await new Promise((r) => setTimeout(r, 250));
  if (isOurProxy(pid)) {
    try {
      process.kill(-pid, 'SIGKILL');
    } catch {
      /* gone */
    }
  }
}

function readState(dir: string): ProxyState | undefined {
  try {
    return JSON.parse(fs.readFileSync(path.join(dir, 'state.json'), 'utf-8')) as ProxyState;
  } catch {
    return undefined;
  }
}

/**
 * The provider's proxy, running with exactly this config and gateway key: the
 * running one if it matches, otherwise (re)started. The port and the proxy key are
 * kept across restarts, so the windows pointed at it stay valid.
 */
export async function ensureProxy(
  providerId: string,
  config: object,
  gatewayKey: string,
  /** The schema_fix.py this extension version ships — copied next to the config, which loads it. */
  hookFile: string
): Promise<ProxyHandle> {
  const dir = path.join(root(), providerId);
  return withLock(path.join(dir, 'start.lock'), 3 * 60_000, async () => {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    // JSON is valid YAML, which is what LiteLLM reads.
    const configText = JSON.stringify(config, null, 2);
    const configFile = path.join(dir, 'config.yaml');
    const hook = fs.readFileSync(hookFile);
    // The hook is part of what runs: a new version of it restarts the proxy too.
    const hash = sha256(`${configText}\0${sha256(gatewayKey)}\0${sha256(hook)}`);
    const state = readState(dir);
    if (state && state.hash === hash && isOurProxy(state.pid) && (await healthy(state.port))) {
      return { port: state.port, masterKey: state.masterKey };
    }
    if (state) await stopPid(state.pid);

    fs.writeFileSync(configFile, configText, { mode: 0o600 });
    fs.writeFileSync(path.join(dir, 'schema_fix.py'), hook, { mode: 0o600 });
    const masterKey = state?.masterKey ?? `sk-local-${crypto.randomBytes(24).toString('hex')}`;
    const port = state?.port && (await portFree(state.port)) ? state.port : await freePort();
    const logFile = path.join(dir, 'litellm.log');
    const out = fs.openSync(logFile, 'a', 0o600);
    const child = spawn(
      path.join(venv(), 'bin', 'litellm'),
      ['--config', configFile, '--host', '127.0.0.1', '--port', String(port)],
      {
        cwd: dir,
        detached: true, // outlives this window; other windows share it
        stdio: ['ignore', out, out],
        env: {
          ...process.env,
          ...NO_REMOTE_CONFIG,
          PROVIDER_KEY: gatewayKey,
          LITELLM_MASTER_KEY: masterKey,
        },
      }
    );
    fs.closeSync(out);
    child.unref();
    if (!child.pid) throw new Error('LiteLLM did not start');
    const next: ProxyState = { pid: child.pid, port, masterKey, hash };
    fs.writeFileSync(path.join(dir, 'state.json'), JSON.stringify(next), { mode: 0o600 });
    log(`litellm[${providerId}]: started pid ${child.pid} on 127.0.0.1:${port}`);

    for (let i = 0; i < 180; i++) {
      if (await healthy(port)) return { port, masterKey };
      if (!isOurProxy(child.pid)) break;
      await new Promise((r) => setTimeout(r, 500));
    }
    const tail = fs.readFileSync(logFile, 'utf-8').trim().split('\n').slice(-5).join(' | ');
    throw new Error(`LiteLLM didn't come up on 127.0.0.1:${port}. Last log lines: ${tail}`);
  });
}

export async function stopProxy(providerId: string): Promise<void> {
  const state = readState(path.join(root(), providerId));
  if (state) {
    await stopPid(state.pid);
    log(`litellm[${providerId}]: stopped`);
  }
}

/**
 * Up to 1.7.1 this dir was mistaken for a window's working dir, and shared
 * history was linked into it. Removes those links — symlinks only, into the
 * shared store; the history itself is untouched.
 */
export function removeStrayLinks(): void {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(root(), { withFileTypes: true });
  } catch {
    return; // never installed
  }
  for (const e of entries) {
    if (!e.isSymbolicLink()) continue;
    try {
      fs.unlinkSync(path.join(root(), e.name));
    } catch {
      /* best effort */
    }
  }
}

/** The port the provider's proxy was last started on, on this host. */
export function proxyPort(providerId: string): number | undefined {
  return readState(path.join(root(), providerId))?.port;
}

export function proxyLogFile(providerId: string): string {
  return path.join(root(), providerId, 'litellm.log');
}

/** The OpenAI-style base the gateway serves, from its Anthropic-style base URL. */
function openAiBase(baseUrl: string): string {
  return `${baseUrl.replace(/\/+$/, '').replace(/\/v1$/, '')}/v1`;
}

/**
 * LiteLLM's config: Claude models passed through, the others translated. Model
 * names are the gateway's own — what Claude Code sends once modelOverrides mapped
 * the Anthropic IDs.
 *
 * Auth: `api_key` makes LiteLLM send a Bearer token. For an x-api-key gateway the
 * key also goes in `extra_headers` (not `headers`: the /v1/messages passthrough
 * reads only `extra_headers`); the passthrough then sends x-api-key alone, and
 * translated calls send both, since the OpenAI client always adds Bearer.
 */
export function proxyConfig(
  baseUrl: string,
  auth: 'bearer' | 'x-api-key',
  claudeIds: string[],
  otherIds: string[]
): object {
  const api = {
    api_base: openAiBase(baseUrl),
    api_key: 'os.environ/PROVIDER_KEY',
    ...(auth === 'x-api-key' && { extra_headers: { 'x-api-key': 'os.environ/PROVIDER_KEY' } }),
  };
  return {
    model_list: [
      ...claudeIds.map((id) => ({
        model_name: id,
        litellm_params: { model: `openai/${id}`, ...api },
        model_info: { supported_endpoints: ['/v1/messages', '/v1/chat/completions'] },
      })),
      ...otherIds.map((id) => ({ model_name: id, litellm_params: { model: `openai/${id}`, ...api } })),
    ],
    general_settings: { master_key: 'os.environ/LITELLM_MASTER_KEY' },
    litellm_settings: {
      drop_params: true,
      use_chat_completions_url_for_anthropic_messages: true,
      // schema_fix.py, next to this file: rewrites tool-schema keywords that
      // OpenAI-format backends reject (Poe: "Failed to parse tool definition").
      callbacks: ['schema_fix.proxy_handler_instance'],
    },
  };
}
