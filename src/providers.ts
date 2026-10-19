import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import { WindowBinding } from './binding';
import type { Worker, WorkerSource } from './delegate';
import type { AgentRunSpec } from './agentTasks';
import { HostState } from './hostState';
import { readIdentity } from './accounts';
import { allWorkingDirs, workingRoot } from './workdir';
import { NOTICE_KEY } from './setupWizard';
import { log } from './log';
import { CatalogModel, Family, FAMILIES, fetchCatalog, modelSettings, newest, OtherModel, toAnthropic } from './modelCatalog';
import { ensureProxy, install, isInstalled, ProxyHandle, proxyConfig, proxyLogFile, proxyPort, stopProxy } from './litellm';

/**
 * Billing providers: WHERE a window's requests go and WHO pays for them, kept
 * apart from the ACCOUNT (identity, history, settings, project trust).
 *
 * "Anthropic" — the default — is the window's own Anthropic login: a claude.ai
 * plan (Pro, Max, Team, Enterprise) or a Console key from /login. A provider is
 * either an Anthropic API key (native, no base URL or model rewriting) or an
 * Anthropic-compatible gateway — Poe, a company proxy — reached with a base URL
 * and a key. Claude Code ranks ANTHROPIC_AUTH_TOKEN / ANTHROPIC_API_KEY above a
 * saved /login, and the login "stays saved and unused while the variable is set"
 * (code.claude.com/docs/en/llm-gateway-connect). So a window flips to a gateway
 * and back without ever touching its login: running out of subscription usage
 * means picking another provider, not signing in as someone else.
 *
 * How it reaches Claude Code
 * ──────────────────────────
 * Through the `env` block of the window's OWN settings.json — the one in its
 * working dir, which is its CLAUDE_CONFIG_DIR and belongs to no other window.
 * Not process.env, the channel used for CLAUDE_CONFIG_DIR: keys live in
 * SecretStorage, which is async, and Claude Code may spawn `claude` before an
 * await returns — the provider would silently not apply. settings.json is read
 * by every `claude` process when it starts, so there is no race; and the
 * window's integrated terminals point at the same dir, so a `claude` run there
 * follows the window's provider with no extra plumbing.
 *
 * Where things are kept
 * ─────────────────────
 * A provider belongs to one ACCOUNT on one HOST: definitions in this host's
 * state file (hostState.ts), under the account's email, so a window sees only
 * the providers of the account it runs, here. Keys are in SecretStorage, which
 * lives on the CLIENT and is shared by every host — so each key's name carries
 * this host's id. (Up to 1.7 both were client-wide, shared by every host and
 * account; migrate() splits them up.) The per-window choice is in
 * workspaceState, and the settings.json carries a copy of the key next to the
 * OAuth token the same dir already holds (0600).
 *
 * Models
 * ──────
 * A gateway serves its own set of models under its own names. The provider keeps
 * the gateway's list (from its `/v1/models`, see modelCatalog.ts) and the window
 * gets the settings that make Claude Code's model picker and effort slider work
 * on exactly that set.
 */

export interface Provider {
  id: string;
  name: string;
  /** 'anthropic': an Anthropic API key, sent straight to Anthropic. Unset: a gateway. */
  kind?: 'anthropic';
  /** A gateway added from a preset (see PRESETS); unset for a custom one. */
  preset?: GatewayPreset;
  baseUrl: string;
  /** How the gateway takes its key: `Authorization: Bearer` or `x-api-key`. */
  auth: 'bearer' | 'x-api-key';
  /** Per-family picks (gateway IDs). A family without one gets the catalog's newest. */
  models?: Partial<Record<Family, string>>;
  /** The Claude models the gateway serves to Claude Code, from its `/v1/models`. */
  catalog?: CatalogModel[];
  /** When the catalog was read (ms). */
  catalogAt?: number;
  /** Non-Claude models the gateway serves in OpenAI's format, from the same list. */
  otherCatalog?: OtherModel[];
  /** The non-Claude models the user enabled. Any at all routes the provider through the local LiteLLM proxy. */
  extraModels?: string[];
  /** For gateways that reject Anthropic's experimental `anthropic-beta` headers. */
  disableBetas?: boolean;
  /** The shared (≤ 1.7) provider this one was adopted from, when its id changed — windows may still name it. */
  legacyId?: string;
  /** Models of this provider the window's AI may consult as workers (see delegate.ts). Off when unset. */
  workers?: string[];
  /** Of those, the ones that may also run agent tasks (agentTasks.ts): tools, in a worktree. */
  agentWorkers?: string[];
}

/** Where versions up to 1.7 kept every provider: globalState, shared by every host and account. */
const LEGACY_PROVIDERS_KEY = 'claudeProfiles.providers';
const ACTIVE_KEY = 'claudeProfiles.activeProvider';
const HIDE_OVERRIDE_WARNING_KEY = 'claudeProfiles.hideProviderOverrideWarning';
/** workspaceState: the window's own values of MANAGED_TOP, saved when a provider took them over. */
const STASH_KEY = 'claudeProfiles.providerStash';
/** How old a catalog may get before a window using the provider re-reads it. */
const CATALOG_TTL_MS = 24 * 60 * 60 * 1000;
const legacySecretKey = (id: string) => `claudeProfiles.provider.${id}`;
const ANTHROPIC_API = 'https://api.anthropic.com';
const isNative = (p: Provider) => p.kind === 'anthropic';

/**
 * Gateways known well enough to set up from a name and a key. Anything else is
 * added as a custom gateway (base URL + key header asked for).
 */
interface PresetDef {
  label: string;
  /** Default provider name (status bar). */
  name: string;
  detail: string;
  baseUrl: string;
  auth: 'bearer' | 'x-api-key';
  keyHint: string;
  /** Models come from the gateway's /v1/models (true) or are fixed by `models`. */
  readsCatalog: boolean;
  models?: Partial<Record<Family, string>>;
  /** Extra env the gateway's documented Claude Code setup asks for (must be in MANAGED_ENV). */
  env?: Record<string, string>;
}

type GatewayPreset = 'poe' | 'zai';

const PRESETS: Record<GatewayPreset, PresetDef> = {
  poe: {
    label: 'Poe',
    name: 'Poe',
    detail: 'Claude models on a Poe subscription; other models (GLM, Qwen…) optionally, through a local proxy',
    baseUrl: 'https://api.poe.com',
    auth: 'bearer',
    keyHint: 'From poe.com/api_key',
    readsCatalog: true,
  },
  zai: {
    label: 'Z.ai GLM Coding Plan',
    name: 'Z.ai',
    detail: "GLM models on Z.ai's Anthropic-compatible endpoint — no proxy needed",
    baseUrl: 'https://api.z.ai/api/anthropic',
    auth: 'bearer',
    keyHint: 'An API key from your Z.ai Coding Plan (z.ai → API keys)',
    // Z.ai's documented Claude Code setup (docs.z.ai/devpack/tool/claude): GLM
    // in every slot, `[1m]` so Claude Code knows the 1M window, compaction and
    // a long timeout to match. Its slots are fixed, so no model list is read —
    // that list would only offer GLM again, through the proxy it doesn't need.
    models: { opus: 'glm-5.3[1m]', sonnet: 'glm-5.3[1m]', haiku: 'glm-5.3-flash[1m]' },
    env: { CLAUDE_CODE_AUTO_COMPACT_WINDOW: '1000000', API_TIMEOUT_MS: '3000000' },
    readsCatalog: false,
  },
};

/** Whether a provider's models come from its /v1/models list (custom gateways and Poe) or are fixed. */
function readsCatalog(p: Provider): boolean {
  if (isNative(p)) return false;
  return p.preset ? PRESETS[p.preset].readsCatalog : true;
}

/** A model Anthropic serves: an alias (opus, sonnet[1m], default…) or a Claude ID. */
function isClaudeModel(model: string): boolean {
  const m = model.trim().replace(/\[1m\]$/i, '');
  return /^(default|best|opusplan|opus|sonnet|haiku|fable)$/i.test(m) || /^claude-/i.test(m) || Boolean(toAnthropic(m));
}

/**
 * What a window's own Anthropic login is, read from its files: "Team plan ·
 * Acme", "Max plan", "Console API key". Not from `claude auth status`, which
 * reports the provider's key instead while one is active.
 */
export function describeLogin(dir: string | undefined): string {
  if (!dir) return 'Anthropic login';
  const read = (f: string): Record<string, unknown> => {
    try {
      return JSON.parse(fs.readFileSync(path.join(dir, f), 'utf-8')) as Record<string, unknown>;
    } catch {
      return {};
    }
  };
  const config = read('.claude.json');
  const plan = (read('.credentials.json').claudeAiOauth as { subscriptionType?: unknown } | undefined)
    ?.subscriptionType;
  if (typeof plan === 'string' && plan) {
    const org = (config.oauthAccount as { organizationName?: unknown } | undefined)?.organizationName;
    const name = `${plan[0].toUpperCase()}${plan.slice(1)} plan`;
    return plan !== 'pro' && plan !== 'max' && typeof org === 'string' && org ? `${name} · ${org}` : name;
  }
  if (config.primaryApiKey) return 'Console API key (/login), billed per token';
  return 'Anthropic login';
}

/**
 * Claude Code asks before using an ANTHROPIC_API_KEY it hasn't seen ("Detected a
 * custom API key"), defaulting to No — and a No silently falls back to the
 * login. The user already chose this key here, so it is approved the way Claude
 * Code records it: the key's last 20 characters, in the dir's .claude.json.
 */
function approveApiKey(dir: string, key: string): void {
  const file = path.join(dir, '.claude.json');
  let config: Record<string, unknown> = {};
  try {
    config = JSON.parse(fs.readFileSync(file, 'utf-8')) as Record<string, unknown>;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') return; // never clobber a file we can't read
  }
  const tail = key.trim().slice(-20);
  const prev = (config.customApiKeyResponses ?? {}) as { approved?: string[]; rejected?: string[] };
  const approved = Array.isArray(prev.approved) ? prev.approved : [];
  const rejected = Array.isArray(prev.rejected) ? prev.rejected : [];
  if (approved.includes(tail) && !rejected.includes(tail)) return;
  config.customApiKeyResponses = {
    ...prev,
    approved: approved.includes(tail) ? approved : [...approved, tail],
    rejected: rejected.filter((r) => r !== tail),
  };
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(config, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, file);
}

/**
 * Every env var a provider may set. All of them are removed when the window goes
 * back to its Anthropic login — including the ones the current provider leaves
 * unset, so nothing from a previous provider can linger.
 */
const MANAGED_ENV = [
  'ANTHROPIC_BASE_URL',
  'ANTHROPIC_AUTH_TOKEN',
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_DEFAULT_OPUS_MODEL',
  'ANTHROPIC_DEFAULT_SONNET_MODEL',
  'ANTHROPIC_DEFAULT_HAIKU_MODEL',
  'ANTHROPIC_DEFAULT_FABLE_MODEL',
  'CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS',
  'CLAUDE_CODE_AUTO_MODE_SERVER',
  // Set by presets (Z.ai).
  'CLAUDE_CODE_AUTO_COMPACT_WINDOW',
  'API_TIMEOUT_MS',
] as const;

/**
 * Top-level settings a provider takes over. Unlike the env vars these are things
 * a user might set for themselves, so the window's own values are saved when a
 * provider takes them over and put back when it goes — a leftover override would
 * send a gateway's model name to Anthropic.
 */
const MANAGED_TOP = ['modelOverrides', 'availableModels', 'enforceAvailableModels', 'modelPicker'] as const;

interface ProviderSettings {
  env: Record<string, string>;
  top: Partial<Record<(typeof MANAGED_TOP)[number], unknown>>;
  /** Leave the window's own MANAGED_TOP values in place (native Anthropic serves the usual models). */
  keepTop?: boolean;
}

/**
 * Everything a provider writes. The unused credential is set EMPTY, not left out:
 * settings env overrides shell exports, so an ANTHROPIC_* key in the user's shell
 * can't sneak past it.
 */
export function settingsFor(p: Provider, key: string, proxy?: ProxyHandle): ProviderSettings {
  // Anthropic itself: just the key. The base URL is pinned so a shell export
  // can't redirect it; Claude Code's own model lineup applies unchanged.
  if (isNative(p)) {
    return { env: { ANTHROPIC_BASE_URL: ANTHROPIC_API, ANTHROPIC_API_KEY: key, ANTHROPIC_AUTH_TOKEN: '' }, top: {}, keepTop: true };
  }
  const models = modelSettings(p.catalog, p.models);
  // Through the proxy, the window holds only the proxy's own key; the gateway key
  // stays in the proxy's environment.
  const env: Record<string, string> = proxy
    ? { ANTHROPIC_BASE_URL: `http://127.0.0.1:${proxy.port}`, ANTHROPIC_AUTH_TOKEN: proxy.masterKey, ANTHROPIC_API_KEY: '' }
    : {
        ANTHROPIC_BASE_URL: p.baseUrl,
        ANTHROPIC_AUTH_TOKEN: p.auth === 'bearer' ? key : '',
        ANTHROPIC_API_KEY: p.auth === 'x-api-key' ? key : '',
      };
  Object.assign(env, models.env);
  if (p.disableBetas) env.CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS = '1';
  // Auto mode asks Anthropic's API to run its safety checks inside each request
  // (the `safeguards` field → `safeguard_results`). A gateway can't — Poe isn't
  // Anthropic, and a translated model isn't even the Messages API — so Claude
  // Code falls back to its own classifier requests (every action is still
  // checked), after holding the first one behind an "isn't eligible" notice.
  // Telling it up front gives the same fallback without the notice.
  // (code.claude.com/docs/en/auto-mode-classifier-billing)
  env.CLAUDE_CODE_AUTO_MODE_SERVER = '0';
  if (p.preset) Object.assign(env, PRESETS[p.preset].env ?? {});
  const top: ProviderSettings['top'] = {};
  if (models.modelOverrides) top.modelOverrides = models.modelOverrides;
  if (models.availableModels) top.availableModels = models.availableModels;
  if (models.enforceAvailableModels) top.enforceAvailableModels = true;
  const extras = proxy ? p.extraModels ?? [] : [];
  if (extras.length > 0) {
    // Claude Code's gateway discovery only lists IDs containing "claude", so the
    // other models get picker rows of their own — and must be on the allowlist.
    if (models.availableModels) top.availableModels = [...models.availableModels, ...extras];
    top.modelPicker = {
      options: extras.map((id) => ({ model: id, description: `${p.name} · translated by the local LiteLLM proxy` })),
    };
  }
  return { env, top };
}

/** The gateway names of the Claude models a provider routes: its catalog, plus manual picks. */
function claudeGatewayIds(p: Provider): string[] {
  const ids = new Set((p.catalog ?? []).map((m) => m.gatewayId));
  for (const id of Object.values(p.models ?? {})) if (id && toAnthropic(id)) ids.add(id);
  return [...ids];
}

/** "opus → claude-opus-4.8, …" — what each family resolves to on this provider. */
export function describeModels(p: Provider): string {
  const { env, modelOverrides = {} } = modelSettings(p.catalog, p.models);
  return FAMILIES.filter((f) => env[`ANTHROPIC_DEFAULT_${f.toUpperCase()}_MODEL`])
    .map((f) => {
      const id = env[`ANTHROPIC_DEFAULT_${f.toUpperCase()}_MODEL`];
      return `${f} → ${modelOverrides[id] ?? id}`; // the gateway's name, as the user knows it
    })
    .join(', ');
}

export type TestResult =
  | { ok: true; model: string; ms: number }
  | { ok: false; model: string; status?: number; message: string; hint: string };

/** The model a connection test asks for: the cheapest one Claude Code would use here, as it sends it. */
function testModel(p: Provider): string {
  if (isNative(p)) return 'claude-haiku-4-5';
  const pick =
    p.models?.haiku ??
    (p.catalog ? newest(p.catalog, 'haiku')?.gatewayId : undefined) ??
    p.models?.sonnet ??
    (p.catalog ? newest(p.catalog, 'sonnet')?.gatewayId : undefined) ??
    p.models?.opus ??
    'claude-sonnet-4-6';
  return pick.replace(/(\[1m\])+$/i, ''); // Claude Code's own marker for the 1M window, never sent
}

/**
 * One request to the provider exactly as Claude Code would send it — same
 * endpoint, key header and model — asking for a single output token. Catches a
 * wrong key, an inactive plan or empty balance, a wrong endpoint or an unknown
 * model when the provider is added, instead of as a "hang" in the first chat:
 * Claude Code retries a 429 up to 11 times, quietly.
 */
export async function testProvider(p: Provider, key: string): Promise<TestResult> {
  const model = testModel(p);
  const url = `${(isNative(p) ? ANTHROPIC_API : p.baseUrl).replace(/\/+$/, '')}/v1/messages`;
  const headers: Record<string, string> = { 'content-type': 'application/json', 'anthropic-version': '2023-06-01' };
  if (isNative(p) || p.auth === 'x-api-key') headers['x-api-key'] = key;
  else headers.authorization = `Bearer ${key}`;
  const started = Date.now();
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify({ model, max_tokens: 1, messages: [{ role: 'user', content: 'ping' }] }),
      signal: AbortSignal.timeout(30_000),
    });
    if (res.ok) return { ok: true, model, ms: Date.now() - started };
    const text = await res.text();
    let message = text.trim();
    try {
      const body = JSON.parse(text) as { error?: { message?: unknown } | string; message?: unknown };
      const m = typeof body.error === 'object' ? body.error?.message : (body.error ?? body.message);
      if (typeof m === 'string' && m) message = m;
    } catch {
      /* not JSON: keep the text */
    }
    const hint =
      res.status === 401 || res.status === 403
        ? 'The key was rejected — check it, and that it belongs to this provider.'
        : res.status === 404
          ? `The endpoint or the model "${model}" wasn't found — check the base URL and model aliases.`
          : res.status === 429
            ? "Rate-limited — or the account's plan or balance doesn't cover this. Claude Code would keep retrying this and look hung."
            : res.status === 400
              ? `The request was refused — often a model name ("${model}") this provider doesn't serve.`
              : 'The provider answered with an error.';
    return { ok: false, model, status: res.status, message: message.slice(0, 300), hint };
  } catch (err) {
    return { ok: false, model, message: (err as Error).message, hint: `Couldn't reach ${url}.` };
  }
}

/** The models a provider can offer as workers, with a one-line note for the lead. */
export function workerChoices(p: Provider): Array<{ model: string; note: string }> {
  if (isNative(p)) {
    return [
      { model: 'claude-haiku-5-5', note: 'Claude Haiku — fast: summaries, bulk rewriting, quick checks' },
      { model: 'claude-sonnet-5-5', note: 'Claude Sonnet — balanced: reviews, drafts, second opinions' },
      { model: 'claude-opus-5-5', note: 'Claude Opus — strongest: hard reasoning, careful reviews' },
    ];
  }
  if (p.preset === 'zai') {
    return [
      { model: 'glm-5.3', note: 'GLM-5.3 — second opinions, reviews, harder questions (slower)' },
      { model: 'glm-5.3-flash', note: 'GLM-5.3-Flash — fast: summaries, bulk rewriting, quick checks' },
    ];
  }
  const ids = p.catalog?.length
    ? p.catalog.map((m) => m.gatewayId)
    : Object.values(p.models ?? {}).filter((m): m is string => Boolean(m));
  return [...new Set(ids.map((m) => m.replace(/(\[1m\])+$/i, '')))].map((model) => ({ model, note: `${model} on ${p.name}` }));
}

function formatModels(m: Provider['models']): string {
  return FAMILIES
    .filter((k) => m?.[k])
    .map((k) => `${k}=${m![k]}`)
    .join(', ');
}

function parseModels(input: string): Provider['models'] | string {
  const models: NonNullable<Provider['models']> = {};
  for (const part of input.split(',').map((s) => s.trim()).filter(Boolean)) {
    const m = /^(opus|sonnet|haiku|fable)\s*=\s*(\S+)$/i.exec(part);
    if (!m) return `"${part}" — expected alias=model, e.g. sonnet=claude-sonnet-4-5`;
    models[m[1].toLowerCase() as Family] = m[2];
  }
  return models;
}

export class ProviderManager implements vscode.Disposable, WorkerSource {
  /** Fires when this window's provider, or its definition, changes. */
  readonly onDidChange = new vscode.EventEmitter<void>();

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly binding: WindowBinding,
    private readonly state: HostState
  ) {}

  private version(): string {
    return String((this.context.extension?.packageJSON as { version?: unknown } | undefined)?.version ?? '0');
  }

  /** The account this window runs — providers belong to it, on this host. */
  private email(): string | undefined {
    const dir = this.binding.getEnvDir();
    return dir ? readIdentity(dir)?.email : undefined;
  }

  /** This account's providers on this host. */
  list(): Provider[] {
    const email = this.email();
    if (!email) return [];
    return this.state.get<Record<string, Provider[]>>('claudeProfiles.providers', {})[email] ?? [];
  }

  /** By id — or by the shared provider's id it was adopted from, which a window may still hold. */
  private get(id: string): Provider | undefined {
    const list = this.list();
    return list.find((p) => p.id === id) ?? list.find((p) => p.legacyId === id);
  }

  private async save(list: Provider[]): Promise<void> {
    const email = this.email();
    if (!email) throw new Error('This window has no signed-in account — providers belong to an account.');
    list.sort((a, b) => a.name.localeCompare(b.name));
    const all = this.state.get<Record<string, Provider[]>>('claudeProfiles.providers', {});
    if (list.length > 0) all[email] = list;
    else delete all[email];
    await this.state.update('claudeProfiles.providers', all);
  }

  /**
   * Where a provider's key lives in the client's secret storage. SecretStorage is
   * on the CLIENT, shared by every host, so the name carries this host's id: the
   * same provider id on two hosts never shares — or deletes — the other's key.
   */
  private secretKey(id: string): string {
    let host = this.state.get<string>('claudeProfiles.hostId');
    if (!host) {
      host = crypto.randomBytes(6).toString('hex');
      void this.state.update('claudeProfiles.hostId', host);
    }
    return `claudeProfiles.provider.${host}.${id}`;
  }

  /**
   * One-time, per host: adopt the providers versions up to 1.7 kept in
   * globalState, which every host and every account shared.
   *
   * A provider goes to each account that has a window on THIS host using it right
   * now — its key in the window's settings.json, or its local proxy's port —
   * and to no one else. The first account keeps its id (the running proxy and
   * the windows' settings stay valid); another account on the same host gets a
   * new id, so their proxies can't collide. Each copy gets its own key entry.
   *
   * globalState and the old key entries are left alone: hosts still on an older
   * version read them, and other hosts adopt from them when they update.
   */
  async migrate(): Promise<void> {
    if (this.state.get<boolean>('claudeProfiles.providersMigrated')) return;
    const legacy = this.context.globalState.get<Provider[]>(LEGACY_PROVIDERS_KEY, []);
    // Several windows may activate at once: one adopts, the others wait for it.
    const lock = path.join(workingRoot(), '.providers-migration.lock');
    try {
      fs.mkdirSync(workingRoot(), { recursive: true, mode: 0o700 });
      fs.closeSync(fs.openSync(lock, 'wx', 0o600));
    } catch {
      // Another window is adopting. A lock older than a minute was left by one
      // that died: clear it so the next activation retries.
      try {
        if (Date.now() - fs.statSync(lock).mtimeMs > 60_000) fs.rmSync(lock, { force: true });
      } catch {
        /* released meanwhile */
      }
      return;
    }
    try {
      const all = this.state.get<Record<string, Provider[]>>('claudeProfiles.providers', {});
      const used = new Set<string>(); // legacy ids already adopted on this host
      for (const p of legacy) {
        const key = await this.context.secrets.get(legacySecretKey(p.id));
        if (!key) continue;
        const port = proxyPort(p.id);
        const owners = new Map<string, boolean>(); // email → uses the running proxy
        for (const dir of allWorkingDirs()) {
          let env: Record<string, string> = {};
          try {
            env = (JSON.parse(fs.readFileSync(path.join(dir, 'settings.json'), 'utf-8')).env ?? {}) as Record<string, string>;
          } catch {
            continue;
          }
          const direct = env.ANTHROPIC_AUTH_TOKEN === key || env.ANTHROPIC_API_KEY === key;
          const proxied = port !== undefined && env.ANTHROPIC_BASE_URL === `http://127.0.0.1:${port}`;
          const email = readIdentity(dir)?.email;
          if ((direct || proxied) && email) owners.set(email, (owners.get(email) ?? false) || proxied);
        }
        // The account on the running proxy keeps the id, so its windows stay as they are.
        for (const email of [...owners.keys()].sort((a, b) => Number(owners.get(b)) - Number(owners.get(a)))) {
          const copy: Provider = used.has(p.id)
            ? { ...p, id: crypto.randomBytes(6).toString('hex'), legacyId: p.id }
            : { ...p };
          used.add(p.id);
          await this.context.secrets.store(this.secretKey(copy.id), key);
          all[email] = [...(all[email] ?? []).filter((q) => q.id !== copy.id), copy];
          log(`provider ${p.name}: adopted on this host for ${email}${copy.legacyId ? ` as ${copy.id}` : ''}`);
        }
        if (owners.size === 0) log(`provider ${p.name}: not in use on this host — not adopted here`);
      }
      await this.state.update('claudeProfiles.providers', all);
      await this.state.update('claudeProfiles.providersMigrated', true);
    } finally {
      fs.rmSync(lock, { force: true });
    }
  }

  /** The provider this window bills to; undefined = its Anthropic login. */
  active(): Provider | undefined {
    const id = this.context.workspaceState.get<string>(ACTIVE_KEY);
    return id ? this.get(id) : undefined;
  }

  /**
   * This window's settings.json — only while the window runs in its own working
   * dir. An unbound window runs on the DEFAULT dir, shared with every other
   * unbound window and with plain `claude` in any shell; a provider written there
   * would leak far beyond this window.
   */
  private settingsFile(): string | undefined {
    const dir = this.binding.getEnvDir();
    if (!dir || path.normalize(dir) !== path.normalize(this.binding.workingDir())) return undefined;
    return path.join(dir, 'settings.json');
  }

  /** This window's own CLAUDE_CONFIG_DIR, when it runs in one (see settingsFile). */
  ownConfigDir(): string | undefined {
    const file = this.settingsFile();
    return file ? path.dirname(file) : undefined;
  }

  /** WorkerSource: every model of this account's providers enabled as a worker. */
  workers(): Worker[] {
    const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'provider';
    return this.list().flatMap((p) => {
      const notes = new Map(workerChoices(p).map((c) => [c.model, c.note]));
      return (p.workers ?? []).map((model) => ({
        id: `${slug(p.name)}/${model}`,
        providerId: p.id,
        providerName: p.name,
        model,
        baseUrl: isNative(p) ? ANTHROPIC_API : p.baseUrl,
        auth: isNative(p) ? ('x-api-key' as const) : p.auth,
        note: notes.get(model) ?? `${model} on ${p.name}`,
        agent: (p.agentWorkers ?? []).includes(model),
      }));
    });
  }

  /**
   * How to run a worker as an agent task: the provider's settings as a window on
   * it would get them, minus the key — which goes to the run's process only.
   */
  async agentSpec(workerId: string): Promise<AgentRunSpec | undefined> {
    const w = this.workers().find((x) => x.id === workerId && x.agent);
    const p = w && this.list().find((x) => x.id === w.providerId);
    if (!w || !p) return undefined;
    if (p.extraModels?.includes(w.model)) return undefined; // translated models need the proxy; not for agent tasks
    const key = await this.keyFor(p.id);
    if (!key) return undefined;
    const s = settingsFor(p, key);
    const { ANTHROPIC_AUTH_TOKEN = '', ANTHROPIC_API_KEY = '', ...env } = s.env;
    // The provider's own name for the model (it may carry Claude Code's [1m] marker).
    const runModel =
      Object.values(p.models ?? {}).find((m) => m && m.replace(/(\[1m\])+$/i, '') === w.model) ?? w.model;
    return {
      runModel,
      settings: { ...s.top, env },
      secretEnv: { ANTHROPIC_AUTH_TOKEN, ANTHROPIC_API_KEY },
      ...(ANTHROPIC_API_KEY && { approveKeyTail: ANTHROPIC_API_KEY.trim().slice(-20) }),
    };
  }

  /** WorkerSource: the provider's key, read from secret storage per call. */
  keyFor(providerId: string): Promise<string | undefined> {
    return Promise.resolve(this.context.secrets.get(this.secretKey(providerId)));
  }

  /**
   * Writes the provider's settings into this window's settings.json, or removes
   * them for the Anthropic login. Leaves the rest of the file alone — Claude Code's
   * /config writes there too. Returns true if the file changed.
   */
  private async writeSettings(desired: ProviderSettings | undefined): Promise<boolean> {
    const file = this.settingsFile();
    if (!file) throw new Error('This window has no account of its own yet — sign in or pick an account first.');
    const stash = this.context.workspaceState.get<Record<string, unknown>>(STASH_KEY);
    let settings: Record<string, unknown> = {};
    if (fs.existsSync(file)) {
      try {
        settings = JSON.parse(fs.readFileSync(file, 'utf-8')) as Record<string, unknown>;
      } catch (err) {
        // Never overwrite a file we can't read — it may hold the user's own settings.
        throw new Error(`Can't read ${file} (${(err as Error).message}). Fix or remove it, then try again.`);
      }
    } else if (!desired) {
      if (stash) await this.context.workspaceState.update(STASH_KEY, undefined);
      return false; // Anthropic login, and nothing was ever written
    }
    const before = JSON.stringify(settings);

    const env = { ...((settings.env as Record<string, string> | undefined) ?? {}) };
    for (const k of MANAGED_ENV) delete env[k];
    Object.assign(env, desired?.env ?? {});
    if (Object.keys(env).length > 0) settings.env = env;
    else delete settings.env;

    if (desired && !desired.keepTop) {
      // Coming from the Anthropic login: keep the window's own values to put back.
      if (!stash) {
        const own = Object.fromEntries(MANAGED_TOP.filter((k) => k in settings).map((k) => [k, settings[k]]));
        await this.context.workspaceState.update(STASH_KEY, own);
      }
      for (const k of MANAGED_TOP) delete settings[k];
      Object.assign(settings, desired.top);
    } else if (stash) {
      for (const k of MANAGED_TOP) delete settings[k];
      Object.assign(settings, stash);
      await this.context.workspaceState.update(STASH_KEY, undefined);
    }

    // Going to Anthropic (the login or an API key): a default model only a gateway
    // serves — `/model` → glm-5.3, saved by Claude Code — would be sent to
    // Anthropic and fail. Claude aliases and IDs stay.
    if ((!desired || desired.keepTop) && typeof settings.model === 'string' && !isClaudeModel(settings.model)) {
      log(`provider: dropped default model "${settings.model}", which Anthropic doesn't serve`);
      delete settings.model;
    }
    if (desired?.env.ANTHROPIC_API_KEY) approveApiKey(path.dirname(file), desired.env.ANTHROPIC_API_KEY);
    if (JSON.stringify(settings) === before) return false;
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(settings, null, 2), { mode: 0o600 });
    fs.chmodSync(tmp, 0o600); // the file now holds a key
    fs.renameSync(tmp, file);
    return true;
  }

  /**
   * Re-reads the provider's model list when it's missing or older than a day.
   * Best effort: a gateway that's down, or has no /v1/models, keeps the list it
   * had (or none — the manual aliases still apply).
   */
  private async refreshCatalog(provider: Provider, key: string, force = false): Promise<Provider> {
    if (!readsCatalog(provider)) return provider; // Anthropic itself, or a preset with fixed models
    // A list read before non-Claude models existed (≤ 1.5) has no otherCatalog: re-read it now.
    const fresh = provider.catalogAt && Date.now() - provider.catalogAt < CATALOG_TTL_MS && provider.otherCatalog;
    if (!force && fresh) return provider;
    try {
      const { claude: catalog, others } = await fetchCatalog(provider.baseUrl, provider.auth, key);
      const updated: Provider = { ...provider, catalog, otherCatalog: others, catalogAt: Date.now() };
      await this.save(this.list().map((p) => (p.id === provider.id ? updated : p)));
      log(
        `provider ${provider.name}: ${catalog.length} Claude models on /v1/messages (${describeModels(updated)}), ` +
          `${others.length} others usable through the proxy`
      );
      return updated;
    } catch (err) {
      log(`provider ${provider.name}: could not read the model list — ${(err as Error).message}`);
      if (force) throw err;
      return provider;
    }
  }

  private lockFile(): string {
    return path.join(this.context.extensionPath, 'litellm', 'requirements.lock');
  }

  /**
   * The provider's proxy, when it routes through one. Installing LiteLLM is a big,
   * one-time step (~600 MB), so it only happens on an explicit yes: `interactive`
   * asks; otherwise a missing install means no proxy and the caller falls back to
   * the gateway's Claude models only.
   */
  private async proxyFor(p: Provider, key: string, interactive: boolean): Promise<ProxyHandle | undefined> {
    if (!p.extraModels?.length) return undefined;
    if (!isInstalled(this.lockFile())) {
      if (!interactive) return undefined;
      const ok = await vscode.window.showWarningMessage(
        `Running non-Claude models needs a local LiteLLM proxy. Install it on this host now?\n\n` +
          `• Into ~/.claude-windows/litellm (about 600 MB), with uv or Python 3.10+.\n` +
          `• Every package pinned by hash — a tampered download fails instead of installing.\n` +
          `• Listens on 127.0.0.1 only; your ${p.name} key stays in its memory, never in a file.\n` +
          `• Uninstalling this extension removes it.`,
        { modal: true },
        'Install'
      );
      if (ok !== 'Install') return undefined;
      await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: 'Installing LiteLLM (hash-verified)…' },
        () => install(this.lockFile())
      );
    }
    const config = proxyConfig(p.baseUrl, p.auth, claudeGatewayIds(p), p.extraModels);
    return interactive
      ? vscode.window.withProgress(
          { location: vscode.ProgressLocation.Notification, title: `Starting the local proxy for ${p.name}…` },
          () => ensureProxy(p.id, config, key, path.join(this.context.extensionPath, 'litellm', 'schema_fix.py'), this.version())
        )
      : ensureProxy(p.id, config, key, path.join(this.context.extensionPath, 'litellm', 'schema_fix.py'), this.version());
  }

  /** Points this window at `provider` (undefined = its Anthropic login) and reloads it. */
  private async useInWindow(provider: Provider | undefined): Promise<void> {
    let desired: ProviderSettings | undefined;
    if (provider) {
      const key = await this.context.secrets.get(this.secretKey(provider.id));
      if (!key) throw new Error(`No key is stored for ${provider.name}. Edit the provider and set its key.`);
      provider = await this.refreshCatalog(provider, key);
      desired = settingsFor(provider, key, await this.proxyFor(provider, key, true));
    }
    await this.writeSettings(desired);
    await this.context.workspaceState.update(ACTIVE_KEY, provider?.id);
    log(`provider: this window now bills to ${provider ? `${provider.name} (${provider.baseUrl})` : 'its Anthropic login'}`);
    this.onDidChange.fire();
    // Claude Code keeps a long-lived process that read its env when it started;
    // only a reload makes the panel itself pick the change up.
    await this.context.workspaceState.update(
      NOTICE_KEY,
      provider
        ? `This window now bills to ${provider.name}. Your Anthropic login stays saved — switch back any time from the status bar.`
        : `This window is back on its Anthropic login (${describeLogin(this.binding.getEnvDir())}).`
    );
    try {
      await vscode.commands.executeCommand('workbench.action.reloadWindow');
    } catch {
      /* the reload tears this command down mid-call ("Canceled") — that IS the success */
    }
  }

  /**
   * Brings settings.json in line with the provider's CURRENT definition and key.
   * Definitions are shared, so another window — or another host — may have
   * edited or removed the one this window uses. Never reloads by itself: it
   * offers the reload, so this can't become a loop.
   */
  async sync(): Promise<void> {
    // Until this host has adopted the shared providers, a window's provider can't
    // be found yet — acting now would reset it to the Anthropic login.
    if (!this.state.get<boolean>('claudeProfiles.providersMigrated')) return;
    const id = this.context.workspaceState.get<string>(ACTIVE_KEY);
    if (!id || !this.settingsFile()) return;
    let provider = this.get(id);
    if (provider && provider.id !== id) await this.context.workspaceState.update(ACTIVE_KEY, provider.id);
    const key = provider ? await this.context.secrets.get(this.secretKey(provider.id)) : undefined;
    if (provider && key) provider = await this.refreshCatalog(provider, key);
    let changed: boolean;
    try {
      // The proxy may be down — after a reboot, or another window changed its
      // models — and this is what brings it back before the window needs it.
      let proxy: ProxyHandle | undefined;
      if (provider && key) {
        try {
          proxy = await this.proxyFor(provider, key, false);
        } catch (err) {
          log(`provider sync: proxy for ${provider.name} failed — ${(err as Error).message}`);
        }
      }
      changed = await this.writeSettings(provider && key ? settingsFor(provider, key, proxy) : undefined);
    } catch (err) {
      log(`provider sync failed: ${(err as Error).message}`);
      return;
    }
    if (!provider || !key) {
      await this.context.workspaceState.update(ACTIVE_KEY, undefined);
      this.onDidChange.fire();
    }
    if (!changed) return;
    const what = !provider
      ? 'The provider this window used was removed, so it is back on its Anthropic login.'
      : !key
        ? `${provider.name} has no stored key any more, so this window is back on its Anthropic login.`
        : `${provider.name}'s settings changed.`;
    log(`provider sync: ${what}`);
    const pick = await vscode.window.showInformationMessage(
      `Claude Accounts: ${what} Reload the window to apply it to the Claude Code panel.`,
      'Reload window'
    );
    if (pick === 'Reload window') void vscode.commands.executeCommand('workbench.action.reloadWindow');
  }

  /**
   * `claudeCode.environmentVariables` is one setting for every window. A gateway
   * credential there doesn't beat a provider picked here (settings.json env wins
   * over the process env), but it DOES silently replace the Anthropic login in every
   * window set to use it. Warn rather than strip: unlike CLAUDE_CONFIG_DIR, it may
   * well be deliberate.
   */
  warnAboutSharedOverride(): void {
    if (this.context.globalState.get<boolean>(HIDE_OVERRIDE_WARNING_KEY)) return;
    const vars = vscode.workspace
      .getConfiguration('claudeCode')
      .get<Array<{ name: string; value: string }>>('environmentVariables', []);
    const found = vars
      .map((v) => v.name)
      .filter((n) => n === 'ANTHROPIC_AUTH_TOKEN' || n === 'ANTHROPIC_API_KEY' || n === 'ANTHROPIC_BASE_URL');
    if (found.length === 0) return;
    log(`claudeCode.environmentVariables sets ${found.join(', ')} for every window`);
    void vscode.window
      .showWarningMessage(
        `Claude Accounts: the claudeCode.environmentVariables setting sets ${found.join(', ')} for EVERY ` +
          `window, so windows on "Anthropic" won't use their Anthropic login. Add it as a provider ` +
          `instead to choose it per window.`,
        'Open setting',
        "Don't show again"
      )
      .then((pick) => {
        if (pick === 'Open setting') {
          void vscode.commands.executeCommand('workbench.action.openSettings', 'claudeCode.environmentVariables');
        } else if (pick === "Don't show again") {
          void this.context.globalState.update(HIDE_OVERRIDE_WARNING_KEY, true);
        }
      });
  }

  // ─── Commands ───────────────────────────────────────────────────────────────

  async switchInteractive(): Promise<void> {
    if (!this.settingsFile()) {
      vscode.window.showInformationMessage(
        'Claude Accounts: this window has no account of its own yet. Sign in with Claude Code (or pick a ' +
          'saved account), then choose a provider.'
      );
      return;
    }
    const current = this.active();
    type Item = vscode.QuickPickItem & { provider?: Provider; add?: boolean };
    const mark = (on: boolean) => (on ? '$(check) ' : '');
    const items: Item[] = [
      {
        label: `${mark(!current)}Anthropic`,
        description: describeLogin(this.binding.getEnvDir()),
        detail: 'Default — this account\'s own login, straight to Anthropic',
      },
      ...this.list().map((p) => ({
        label: `${mark(current?.id === p.id)}${p.name}`,
        description: isNative(p) ? 'Anthropic API key, billed per token' : p.preset ? PRESETS[p.preset].label : p.baseUrl,
        provider: p,
      })),
      { label: '$(add) Add a provider…', add: true },
    ];
    const picked = await vscode.window.showQuickPick(items, {
      title: 'Bill this window to… (reloads the window)',
      placeHolder: 'Your account, history and settings stay the same — only where requests go changes',
    });
    if (!picked) return;
    if (picked.add) {
      await this.addInteractive();
      return;
    }
    if (picked.provider?.id === current?.id) {
      vscode.window.showInformationMessage(`This window already bills to ${current?.name ?? 'its Anthropic login'}.`);
      return;
    }
    await this.useInWindow(picked.provider);
  }

  /** Runs testProvider with progress; a failure is reported here, a success left to the caller. */
  private async testInteractive(p: Provider, key: string): Promise<TestResult> {
    const r = await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: `Testing ${p.name}…` },
      () => testProvider(p, key)
    );
    if (r.ok) {
      log(`provider ${p.name}: test OK (${r.model}, ${r.ms} ms)`);
      return r;
    }
    log(`provider ${p.name}: test FAILED (${r.model}) ${r.status ?? ''} ${r.message}`);
    vscode.window.showWarningMessage(
      `${p.name} didn't answer a test request${r.status ? ` (HTTP ${r.status})` : ''}: ${r.message}\n\n${r.hint}`,
      { modal: true }
    );
    return r;
  }

  /** After adding: test it, then offer it for this window (a failed test still allows it, with a warning). */
  private async offerNewProvider(p: Provider, key: string, what: string): Promise<void> {
    const { ok } = await this.testInteractive(p, key);
    const canUse = Boolean(this.settingsFile());
    const msg = ok
      ? `Added ${p.name}: ${what}`
      : `Added ${p.name}, but its test failed — fix it under "Edit or Remove a Provider" (Replace key, Test connection).`;
    const pick = await (ok ? vscode.window.showInformationMessage : vscode.window.showWarningMessage)(
      msg,
      ...(canUse ? [ok ? 'Use in this window' : 'Use in this window anyway'] : [])
    );
    if (pick) await this.useInWindow(p);
  }

  async addInteractive(): Promise<void> {
    type Choice = 'anthropic' | GatewayPreset | 'custom';
    const choice = (
      await vscode.window.showQuickPick<vscode.QuickPickItem & { choice: Choice }>(
        [
          {
            label: '$(key) Anthropic API key',
            detail: 'A key from console.anthropic.com — straight to Anthropic, billed per token',
            choice: 'anthropic',
          },
          ...(Object.keys(PRESETS) as GatewayPreset[]).map((id) => ({
            label: `$(server) ${PRESETS[id].label}`,
            description: PRESETS[id].baseUrl,
            detail: PRESETS[id].detail,
            choice: id,
          })),
          {
            label: '$(gear) Custom Anthropic-compatible gateway',
            detail: 'A company proxy or any other endpoint — a base URL and a key',
            choice: 'custom',
          },
        ],
        { title: 'Add a provider' }
      )
    )?.choice;
    if (!choice) return;
    if (choice === 'anthropic') return this.addAnthropicKey();
    return this.addGateway(choice === 'custom' ? undefined : choice);
  }

  /** A gateway: a preset fills in the URL, key header and models, so only a name and key are asked. */
  private async addGateway(presetId?: GatewayPreset): Promise<void> {
    const preset = presetId ? PRESETS[presetId] : undefined;
    const steps = preset ? 2 : 4;
    const taken = (v: string) => this.list().some((p) => p.name === v.trim());
    const name = await vscode.window.showInputBox({
      title: `Add ${preset?.label ?? 'a provider'} (1/${steps}): name`,
      prompt: 'Shown in the status bar',
      value: preset && !taken(preset.name) ? preset.name : '',
      validateInput: (v) => (!v.trim() ? 'Enter a name' : taken(v) ? 'That name is taken' : undefined),
    });
    if (!name) return;
    let baseUrl = preset?.baseUrl;
    let auth = preset?.auth;
    if (!preset) {
      baseUrl = await vscode.window.showInputBox({
        title: 'Add a provider (2/4): base URL',
        prompt: 'The Anthropic-compatible endpoint',
        value: 'https://',
        validateInput: (v) => (/^https?:\/\/[^\s/]+/.test(v.trim()) ? undefined : 'Enter an http(s) URL'),
      });
      if (!baseUrl) return;
      auth = await this.pickAuth();
      if (!auth) return;
    }
    const key = await vscode.window.showInputBox({
      title: `Add ${preset?.label ?? 'a provider'} (${steps}/${steps}): key`,
      prompt: `${preset?.keyHint ? `${preset.keyHint}. ` : ''}Stored in VS Code's secret storage on this computer`,
      password: true,
      ignoreFocusOut: true,
      validateInput: (v) => (v.trim() ? undefined : 'Enter the key'),
    });
    if (!key) return;

    const provider: Provider = {
      id: crypto.randomBytes(6).toString('hex'),
      name: name.trim(),
      baseUrl: baseUrl!.trim().replace(/\/+$/, ''),
      auth: auth!,
      ...(presetId && { preset: presetId }),
      ...(preset?.models && { models: { ...preset.models } }),
    };
    await this.context.secrets.store(this.secretKey(provider.id), key.trim());
    await this.save([...this.list(), provider]);
    log(`provider added: ${provider.name} (${provider.baseUrl}, ${provider.auth}${presetId ? `, preset ${presetId}` : ''})`);

    let added = provider;
    let found: string;
    if (!readsCatalog(provider)) {
      found = `models: ${describeModels(provider)}.`;
    } else {
      // Read what the gateway serves, so the picker shows exactly that.
      try {
        added = await vscode.window.withProgress(
          { location: vscode.ProgressLocation.Notification, title: `Reading ${provider.name}'s model list…` },
          () => this.refreshCatalog(provider, key.trim(), true)
        );
        found = added.catalog?.length
          ? `${added.catalog.length} Claude models usable from Claude Code — ${describeModels(added)}.`
          : `no Claude models it serves to Claude Code were found. Set model aliases under "Edit or Remove a Provider".`;
      } catch (err) {
        found =
          `its model list couldn't be read (${(err as Error).message}). Set model aliases under ` +
          `"Edit or Remove a Provider".`;
      }
    }

    await this.offerNewProvider(added, key.trim(), found);
  }

  private static validateAnthropicKey(v: string): string | undefined {
    return /^sk-ant-\S+$/.test(v.trim()) ? undefined : 'An Anthropic API key starts with sk-ant-';
  }

  /** An Anthropic API key: no URL, no header choice, no model list — Claude Code knows Anthropic. */
  private async addAnthropicKey(): Promise<void> {
    const taken = (v: string) => this.list().some((p) => p.name === v.trim());
    const name = await vscode.window.showInputBox({
      title: 'Add an Anthropic API key (1/2): name',
      prompt: 'Shown in the status bar',
      value: taken('Anthropic API') ? '' : 'Anthropic API',
      validateInput: (v) => (!v.trim() ? 'Enter a name' : taken(v) ? 'That name is taken' : undefined),
    });
    if (!name) return;
    const key = await vscode.window.showInputBox({
      title: 'Add an Anthropic API key (2/2): key',
      prompt: 'From console.anthropic.com → API keys. Stored in VS Code\'s secret storage on this computer',
      password: true,
      ignoreFocusOut: true,
      validateInput: ProviderManager.validateAnthropicKey,
    });
    if (!key) return;
    const provider: Provider = {
      id: crypto.randomBytes(6).toString('hex'),
      name: name.trim(),
      kind: 'anthropic',
      baseUrl: ANTHROPIC_API,
      auth: 'x-api-key',
    };
    await this.context.secrets.store(this.secretKey(provider.id), key.trim());
    await this.save([...this.list(), provider]);
    log(`provider added: ${provider.name} (Anthropic API key)`);
    await this.offerNewProvider(
      provider,
      key.trim(),
      "windows using it bill your Anthropic API key per token; the account's login stays saved."
    );
  }

  private async pickAuth(current?: Provider['auth']): Promise<Provider['auth'] | undefined> {
    const picked = await vscode.window.showQuickPick(
      [
        {
          label: 'Authorization: Bearer',
          description: current === 'bearer' ? 'current' : 'recommended — Poe uses this',
          detail: 'Sets ANTHROPIC_AUTH_TOKEN',
          value: 'bearer' as const,
        },
        {
          label: 'x-api-key',
          description: current === 'x-api-key' ? 'current' : '',
          detail: 'Sets ANTHROPIC_API_KEY',
          value: 'x-api-key' as const,
        },
      ],
      { title: 'How does the gateway take its key?' }
    );
    return picked?.value;
  }

  /**
   * Per-family default model, picked from the gateway's list. "Newest" keeps
   * following the list as the gateway adds models; a specific pick stays put.
   */
  private async pickDefaultModels(p: Provider): Promise<Provider['models'] | undefined> {
    const models = { ...(p.models ?? {}) };
    for (;;) {
      const family = (
        await vscode.window.showQuickPick(
          FAMILIES.filter((f) => p.catalog!.some((m) => m.family === f)).map((f) => ({
            label: f,
            description: models[f] ? models[f] : `newest — ${newest(p.catalog!, f)?.gatewayId}`,
            family: f,
          })),
          { title: `${p.name}: default model per family`, placeHolder: 'Pick a family to change; Esc when done' }
        )
      )?.family;
      if (!family) return models;
      const choice = await vscode.window.showQuickPick(
        [
          { label: 'Newest', description: 'follows the gateway as it adds models', id: undefined as string | undefined },
          ...p.catalog!
            .filter((m) => m.family === family)
            .map((m) => ({
              label: m.gatewayId,
              description: m.contextLength ? `${Math.round(m.contextLength / 1000)}K context` : '',
              id: m.gatewayId as string | undefined,
            })),
        ],
        { title: `${p.name}: ${family} model` }
      );
      if (!choice) continue;
      if (choice.id) models[family] = choice.id;
      else delete models[family];
    }
  }

  async editInteractive(): Promise<void> {
    const providers = this.list();
    if (providers.length === 0) {
      const pick = await vscode.window.showInformationMessage('No providers yet.', 'Add a provider');
      if (pick) await this.addInteractive();
      return;
    }
    const target = (
      await vscode.window.showQuickPick(
        providers.map((p) => ({
          label: p.name,
          description: isNative(p) ? 'Anthropic API key' : p.preset ? PRESETS[p.preset].label : p.baseUrl,
          provider: p,
        })),
        { title: 'Edit or remove a provider' }
      )
    )?.provider;
    if (!target) return;

    type Action = 'test' | 'workers' | 'key' | 'url' | 'auth' | 'models' | 'others' | 'refresh' | 'proxylog' | 'betas' | 'rename' | 'remove';
    type ActionItem = vscode.QuickPickItem & { action: Action };
    const common = (items: ActionItem[]): ActionItem[] => [
      { label: '$(pulse) Test connection', description: 'one tiny request, as Claude Code sends it', action: 'test' },
      {
        label: '$(organization) Workers',
        description: target.workers?.length
          ? target.workers.map((m) => (target.agentWorkers?.includes(m) ? `${m} (+agent)` : m)).join(', ')
          : 'off',
        detail: "Let this window's AI consult this provider's models for focused tasks (answers only)",
        action: 'workers',
      },
      { label: '$(key) Replace key', action: 'key' },
      ...items,
      { label: '$(edit) Rename', action: 'rename' },
      { label: '$(trash) Remove', action: 'remove' },
    ];
    const action = (
      await vscode.window.showQuickPick<ActionItem>(
        isNative(target)
          ? common([])
          : common([
          // A preset's endpoint and key header are what the preset is; only a custom gateway changes them.
          ...(target.preset
            ? []
            : [
                { label: '$(link) Change base URL', description: target.baseUrl, action: 'url' as Action },
                {
                  label: '$(shield) Key header',
                  description: target.auth === 'bearer' ? 'Bearer' : 'x-api-key',
                  action: 'auth' as Action,
                },
              ]),
          {
            label: target.catalog?.length ? '$(symbol-enum) Default models' : '$(symbol-enum) Model aliases',
            description: describeModels(target) || 'Claude Code defaults',
            action: 'models',
          },
          // Non-Claude models through the proxy, and the model list itself, only
          // where the models come from the gateway's list (not Z.ai's fixed GLM).
          ...(readsCatalog(target)
            ? [
                {
                  label: '$(extensions) Non-Claude models',
                  description: target.extraModels?.length
                    ? `${target.extraModels.length} enabled, through the local proxy`
                    : `${target.otherCatalog?.length ?? 0} available`,
                  detail: 'Qwen, GLM, DeepSeek… translated for Claude Code by a local LiteLLM proxy',
                  action: 'others' as Action,
                },
                ...(target.extraModels?.length
                  ? [{ label: '$(output) Show proxy log', action: 'proxylog' as Action }]
                  : []),
                {
                  label: '$(refresh) Refresh model list',
                  description: target.catalogAt
                    ? `${target.catalog?.length ?? 0} Claude models, read ${new Date(target.catalogAt).toLocaleString()}`
                    : 'not read yet',
                  action: 'refresh' as Action,
                },
              ]
            : []),
          {
            label: `$(beaker) ${target.disableBetas ? 'Send' : 'Stop sending'} experimental beta headers`,
            description: target.disableBetas ? 'currently off' : 'currently on',
            detail: 'Turn off if the gateway answers "Unexpected value(s)" or "Extra inputs are not permitted"',
            action: 'betas',
          },
        ]),
        { title: target.name }
      )
    )?.action;
    if (!action) return;

    const updated: Provider = { ...target };
    switch (action) {
      case 'workers': {
        const choices = workerChoices(target);
        if (choices.length === 0) {
          vscode.window.showInformationMessage(`${target.name} has no models to offer as workers yet — set its model aliases first.`);
          return;
        }
        const on = new Set(target.workers ?? []);
        const picked = await vscode.window.showQuickPick(
          choices.map((c) => ({ label: c.model, description: c.note, picked: on.has(c.model) })),
          {
            title: `${target.name}: models this window's AI may consult as workers`,
            placeHolder: 'Workers only answer — they cannot read files or run commands. None selected = off.',
            canPickMany: true,
          }
        );
        if (!picked) return;
        const models = picked.map((i) => i.label);
        const adding = models.filter((m) => !on.has(m));
        if (adding.length > 0) {
          const ok = await vscode.window.showWarningMessage(
            `Let Claude Code in this account's windows send work to ${target.name} (${adding.join(', ')})?\n\n` +
              `• The AI decides what to send: the task and the code or text it pastes in — that content goes to ` +
              `${target.name}${isNative(target) ? '' : ' and the model\'s maker'}, billed to this key.\n` +
              `• Workers only answer. They cannot read your files or run commands.\n` +
              `• Off again any time here; the window log records each call (not its content).`,
            { modal: true },
            'Allow'
          );
          if (ok !== 'Allow') return;
        }
        updated.workers = models.length > 0 ? models : undefined;
        // Agent tasks: a separate, stronger opt-in among the enabled workers.
        const agentOn = new Set((target.agentWorkers ?? []).filter((m) => models.includes(m)));
        if (models.length > 0) {
          const agentPick = await vscode.window.showQuickPick(
            models.map((m) => ({ label: m, picked: agentOn.has(m) })),
            {
              title: `${target.name}: which of these may also run AGENT TASKS?`,
              placeHolder:
                'Agent tasks run Claude Code on this model in a scratch git worktree, with edits and commands (auto mode). None = answers only.',
              canPickMany: true,
            }
          );
          const agents = (agentPick ?? []).map((i) => i.label);
          const newAgents = agents.filter((m) => !agentOn.has(m));
          if (newAgents.length > 0) {
            const ok = await vscode.window.showWarningMessage(
              `Let ${target.name} (${newAgents.join(', ')}) run agent tasks?\n\n` +
                `• Claude Code runs on that model, headless, in a git worktree made from your repo (HEAD + ` +
                `uncommitted changes). It reads and edits files there and runs commands — on this machine.\n` +
                `• Auto mode checks each consequential action with a safety classifier on that same model ` +
                `(about 35K tokens per check). Nothing reaches your working tree unless the lead applies the diff.\n` +
                `• The repo content it reads goes to ${target.name}. Limits: 2 at a time, 80 turns, 30 minutes.`,
              { modal: true },
              'Allow agent tasks'
            );
            if (ok !== 'Allow agent tasks') agents.splice(0, agents.length, ...[...agentOn]);
          }
          updated.agentWorkers = agentPick === undefined ? [...agentOn] : agents.length > 0 ? agents : undefined;
        } else {
          updated.agentWorkers = undefined;
        }
        break;
      }
      case 'test': {
        const key = await this.context.secrets.get(this.secretKey(target.id));
        if (!key) throw new Error(`No key is stored for ${target.name}. Replace its key first.`);
        const r = await this.testInteractive(target, key);
        if (r.ok) vscode.window.showInformationMessage(`${target.name} answered with ${r.model} in ${r.ms} ms.`);
        return;
      }
      case 'key': {
        const key = await vscode.window.showInputBox({
          title: `New key for ${target.name}`,
          password: true,
          ignoreFocusOut: true,
          validateInput: isNative(target)
            ? ProviderManager.validateAnthropicKey
            : (v) => (v.trim() ? undefined : 'Enter the key'),
        });
        if (!key) return;
        await this.context.secrets.store(this.secretKey(target.id), key.trim());
        break;
      }
      case 'url': {
        const url = await vscode.window.showInputBox({
          title: `Base URL for ${target.name}`,
          value: target.baseUrl,
          validateInput: (v) => (/^https?:\/\/[^\s/]+/.test(v.trim()) ? undefined : 'Enter an http(s) URL'),
        });
        if (!url) return;
        updated.baseUrl = url.trim().replace(/\/+$/, '');
        break;
      }
      case 'auth': {
        const auth = await this.pickAuth(target.auth);
        if (!auth) return;
        updated.auth = auth;
        break;
      }
      case 'models': {
        if (target.catalog?.length) {
          const models = await this.pickDefaultModels(target);
          if (!models) return;
          updated.models = Object.keys(models).length > 0 ? models : undefined;
          break;
        }
        // No list from the gateway: name the models by hand.
        const input = await vscode.window.showInputBox({
          title: `Model aliases for ${target.name}`,
          prompt:
            'alias=model pairs as the gateway names them, comma-separated; empty for Claude Code\'s ' +
            'defaults. Claude models are mapped so Claude Code still recognises them.',
          placeHolder: 'opus=claude-opus-4-8, sonnet=claude-sonnet-4-6, haiku=claude-haiku-4-5',
          value: formatModels(target.models),
          validateInput: (v) => {
            const r = parseModels(v);
            return typeof r === 'string' ? r : undefined;
          },
        });
        if (input === undefined) return;
        const models = parseModels(input) as Provider['models'];
        updated.models = models && Object.keys(models).length > 0 ? models : undefined;
        break;
      }
      case 'others': {
        const others = target.otherCatalog ?? [];
        if (others.length === 0) {
          vscode.window.showInformationMessage(
            `${target.name}'s model list has no other models usable from Claude Code (text, tool calling, ` +
              `chat completions). Try "Refresh model list".`
          );
          return;
        }
        const enabled = new Set(target.extraModels ?? []);
        const picked = await vscode.window.showQuickPick(
          others.map((m) => ({
            label: m.id,
            description: [m.ownedBy, m.contextLength ? `${Math.round(m.contextLength / 1000)}K context` : 'context unknown']
              .filter(Boolean)
              .join(' · '),
            picked: enabled.has(m.id),
          })),
          {
            title: `${target.name}: non-Claude models for Claude Code`,
            placeHolder:
              'Each appears in Claude Code\'s model picker. Claude Code is built for Claude — tool use on ' +
              'other models works, but less reliably.',
            canPickMany: true,
            matchOnDescription: true,
          }
        );
        if (!picked) return;
        updated.extraModels = picked.length > 0 ? picked.map((i) => i.label) : undefined;
        if (!updated.extraModels) await stopProxy(target.id);
        break;
      }
      case 'proxylog': {
        if (!fs.existsSync(proxyLogFile(target.id))) {
          vscode.window.showInformationMessage(
            `${target.name}'s proxy hasn't run on this host yet — it starts when a window here switches to ` +
              `${target.name}.`
          );
          return;
        }
        const doc = await vscode.workspace.openTextDocument(proxyLogFile(target.id));
        await vscode.window.showTextDocument(doc, { preview: true });
        return;
      }
      case 'refresh': {
        const key = await this.context.secrets.get(this.secretKey(target.id));
        if (!key) throw new Error(`No key is stored for ${target.name}. Replace its key first.`);
        const fresh = await vscode.window.withProgress(
          { location: vscode.ProgressLocation.Notification, title: `Reading ${target.name}'s model list…` },
          () => this.refreshCatalog(target, key, true)
        );
        Object.assign(updated, { catalog: fresh.catalog, otherCatalog: fresh.otherCatalog, catalogAt: fresh.catalogAt });
        break;
      }
      case 'betas':
        updated.disableBetas = !target.disableBetas || undefined;
        break;
      case 'rename': {
        const name = await vscode.window.showInputBox({
          title: `Rename ${target.name}`,
          value: target.name,
          validateInput: (v) =>
            !v.trim()
              ? 'Enter a name'
              : this.list().some((p) => p.id !== target.id && p.name === v.trim())
                ? 'That name is taken'
                : undefined,
        });
        if (!name) return;
        updated.name = name.trim();
        break;
      }
      case 'remove': {
        const ok = await vscode.window.showWarningMessage(
          `Remove ${target.name}? Its key is deleted from secret storage, and every window using it goes ` +
            `back to its Anthropic login.`,
          { modal: true },
          'Remove'
        );
        if (ok !== 'Remove') return;
        await this.save(this.list().filter((p) => p.id !== target.id));
        await this.context.secrets.delete(this.secretKey(target.id));
        await stopProxy(target.id);
        log(`provider removed: ${target.name}`);
        // This window used it: back to the Anthropic login now. Other windows find
        // it gone on their next sync (focus) and offer the reload themselves.
        if (this.context.workspaceState.get<string>(ACTIVE_KEY) === target.id) {
          await this.useInWindow(undefined);
        } else {
          vscode.window.showInformationMessage(`Removed ${target.name}.`);
        }
        return;
      }
    }
    await this.save(this.list().map((p) => (p.id === target.id ? updated : p)));
    log(`provider edited: ${updated.name} (${action})`);
    this.onDidChange.fire();
    // Turning other models on is the moment to install and start the proxy — the
    // background sync below never installs anything on its own.
    if (action === 'others' && updated.extraModels?.length) {
      const key = await this.context.secrets.get(this.secretKey(updated.id));
      if (key && !(await this.proxyFor(updated, key, true))) {
        vscode.window.showInformationMessage(
          `${updated.name}'s non-Claude models stay off until LiteLLM is installed — its Claude models keep working.`
        );
      }
    }
    if (this.active()?.id === target.id) await this.sync();
    else vscode.window.showInformationMessage(`Updated ${updated.name}.`);
  }

  dispose(): void {
    this.onDidChange.dispose();
  }
}
