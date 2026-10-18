import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import { WindowBinding } from './binding';
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

export class ProviderManager implements vscode.Disposable {
  /** Fires when this window's provider, or its definition, changes. */
  readonly onDidChange = new vscode.EventEmitter<void>();

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly binding: WindowBinding,
    private readonly state: HostState
  ) {}

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
    if (isNative(provider)) return provider; // Claude Code knows Anthropic's own models
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
          () => ensureProxy(p.id, config, key, path.join(this.context.extensionPath, 'litellm', 'schema_fix.py'))
        )
      : ensureProxy(p.id, config, key, path.join(this.context.extensionPath, 'litellm', 'schema_fix.py'));
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
        description: isNative(p) ? 'Anthropic API key, billed per token' : p.baseUrl,
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

  async addInteractive(): Promise<void> {
    const kind = (
      await vscode.window.showQuickPick(
        [
          {
            label: '$(key) Anthropic API key',
            detail: 'A key from console.anthropic.com — straight to Anthropic, billed per token',
            choice: 'anthropic' as const,
          },
          {
            label: '$(server) Anthropic-compatible gateway',
            detail: 'Poe, a company proxy… — a base URL and a key',
            choice: 'gateway' as const,
          },
        ],
        { title: 'Add a provider' }
      )
    )?.choice;
    if (kind === 'anthropic') return this.addAnthropicKey();
    if (!kind) return;

    const name = await vscode.window.showInputBox({
      title: 'Add a provider (1/4): name',
      prompt: 'Shown in the status bar, e.g. "Poe"',
      validateInput: (v) =>
        !v.trim() ? 'Enter a name' : this.list().some((p) => p.name === v.trim()) ? 'That name is taken' : undefined,
    });
    if (!name) return;
    const baseUrl = await vscode.window.showInputBox({
      title: 'Add a provider (2/4): base URL',
      prompt: 'The Anthropic-compatible endpoint — e.g. https://api.poe.com for Poe',
      value: 'https://',
      validateInput: (v) => (/^https?:\/\/[^\s/]+/.test(v.trim()) ? undefined : 'Enter an http(s) URL'),
    });
    if (!baseUrl) return;
    const auth = await this.pickAuth();
    if (!auth) return;
    const key = await vscode.window.showInputBox({
      title: 'Add a provider (4/4): key',
      prompt: 'Stored in VS Code\'s secret storage on this computer',
      password: true,
      ignoreFocusOut: true,
      validateInput: (v) => (v.trim() ? undefined : 'Enter the key'),
    });
    if (!key) return;

    const provider: Provider = {
      id: crypto.randomBytes(6).toString('hex'),
      name: name.trim(),
      baseUrl: baseUrl.trim().replace(/\/+$/, ''),
      auth,
    };
    await this.context.secrets.store(this.secretKey(provider.id), key.trim());
    await this.save([...this.list(), provider]);
    log(`provider added: ${provider.name} (${provider.baseUrl}, ${provider.auth})`);

    // Read what the gateway serves, so the picker shows exactly that.
    let added = provider;
    let found: string;
    try {
      added = await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: `Reading ${provider.name}'s model list…` },
        () => this.refreshCatalog(provider, key.trim(), true)
      );
      found = added.catalog!.length
        ? `${added.catalog!.length} Claude models usable from Claude Code — ${describeModels(added)}.`
        : `no Claude models it serves to Claude Code were found. Set model aliases under "Edit or Remove a Provider".`;
    } catch (err) {
      found =
        `its model list couldn't be read (${(err as Error).message}). Set model aliases under ` +
        `"Edit or Remove a Provider".`;
    }

    const canUse = Boolean(this.settingsFile());
    const pick = await vscode.window.showInformationMessage(
      `Added ${provider.name}: ${found}`,
      ...(canUse ? [`Use in this window`] : [])
    );
    if (pick) await this.useInWindow(added);
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
    const canUse = Boolean(this.settingsFile());
    const pick = await vscode.window.showInformationMessage(
      `Added ${provider.name}. Windows using it bill your Anthropic API key per token; the account's login stays saved.`,
      ...(canUse ? [`Use in this window`] : [])
    );
    if (pick) await this.useInWindow(provider);
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
          description: isNative(p) ? 'Anthropic API key' : p.baseUrl,
          provider: p,
        })),
        { title: 'Edit or remove a provider' }
      )
    )?.provider;
    if (!target) return;

    type Action = 'key' | 'url' | 'auth' | 'models' | 'others' | 'refresh' | 'proxylog' | 'betas' | 'rename' | 'remove';
    type ActionItem = vscode.QuickPickItem & { action: Action };
    const common = (items: ActionItem[]): ActionItem[] => [
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
          { label: '$(link) Change base URL', description: target.baseUrl, action: 'url' },
          { label: '$(shield) Key header', description: target.auth === 'bearer' ? 'Bearer' : 'x-api-key', action: 'auth' },
          {
            label: target.catalog?.length ? '$(symbol-enum) Default models' : '$(symbol-enum) Model aliases',
            description: describeModels(target) || 'Claude Code defaults',
            action: 'models',
          },
          {
            label: '$(extensions) Non-Claude models',
            description: target.extraModels?.length
              ? `${target.extraModels.length} enabled, through the local proxy`
              : `${target.otherCatalog?.length ?? 0} available`,
            detail: 'Qwen, GLM, DeepSeek… translated for Claude Code by a local LiteLLM proxy',
            action: 'others',
          },
          ...(target.extraModels?.length
            ? [{ label: '$(output) Show proxy log', action: 'proxylog' as Action }]
            : []),
          {
            label: '$(refresh) Refresh model list',
            description: target.catalogAt
              ? `${target.catalog?.length ?? 0} Claude models, read ${new Date(target.catalogAt).toLocaleString()}`
              : 'not read yet',
            action: 'refresh',
          },
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
