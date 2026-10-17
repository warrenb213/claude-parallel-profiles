import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import { WindowBinding } from './binding';
import { NOTICE_KEY } from './setupWizard';
import { log } from './log';
import { CatalogModel, Family, FAMILIES, fetchCatalog, modelSettings, newest, OtherModel, toAnthropic } from './modelCatalog';
import { ensureProxy, install, isInstalled, ProxyHandle, proxyConfig, proxyLogFile, stopProxy } from './litellm';

/**
 * Billing providers: WHERE a window's requests go and WHO pays for them, kept
 * apart from the ACCOUNT (identity, history, settings, project trust).
 *
 * "Subscription" is the window's own Anthropic login. Any other provider is an
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
 * Definitions in globalState, keys in SecretStorage — both on the CLIENT, so
 * shared by every remote host this editor reaches. That is deliberate, and the
 * opposite of accounts (see hostState.ts): an account is a store on one host's
 * disk, but a gateway key works from anywhere, so it is entered once. The
 * per-window choice is in workspaceState, and the settings.json carries a copy
 * of the key next to the OAuth token the same dir already holds (0600).
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
}

const PROVIDERS_KEY = 'claudeProfiles.providers';
const ACTIVE_KEY = 'claudeProfiles.activeProvider';
const HIDE_OVERRIDE_WARNING_KEY = 'claudeProfiles.hideProviderOverrideWarning';
/** workspaceState: the window's own values of MANAGED_TOP, saved when a provider took them over. */
const STASH_KEY = 'claudeProfiles.providerStash';
/** How old a catalog may get before a window using the provider re-reads it. */
const CATALOG_TTL_MS = 24 * 60 * 60 * 1000;
const secretKey = (id: string) => `claudeProfiles.provider.${id}`;

/**
 * Every env var a provider may set. All of them are removed when the window goes
 * back to its subscription — including the ones the current provider leaves
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
}

/**
 * Everything a provider writes. The unused credential is set EMPTY, not left out:
 * settings env overrides shell exports, so an ANTHROPIC_* key in the user's shell
 * can't sneak past it.
 */
export function settingsFor(p: Provider, key: string, proxy?: ProxyHandle): ProviderSettings {
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
    private readonly binding: WindowBinding
  ) {}

  list(): Provider[] {
    return this.context.globalState.get<Provider[]>(PROVIDERS_KEY, []);
  }

  private get(id: string): Provider | undefined {
    return this.list().find((p) => p.id === id);
  }

  private async save(list: Provider[]): Promise<void> {
    list.sort((a, b) => a.name.localeCompare(b.name));
    await this.context.globalState.update(PROVIDERS_KEY, list);
  }

  /** The provider this window bills to; undefined = its subscription. */
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
   * them for the subscription. Leaves the rest of the file alone — Claude Code's
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
      return false; // subscription, and nothing was ever written
    }
    const before = JSON.stringify(settings);

    const env = { ...((settings.env as Record<string, string> | undefined) ?? {}) };
    for (const k of MANAGED_ENV) delete env[k];
    Object.assign(env, desired?.env ?? {});
    if (Object.keys(env).length > 0) settings.env = env;
    else delete settings.env;

    if (desired) {
      // Coming from the subscription: keep the window's own values to put back.
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
    if (!force && provider.catalogAt && Date.now() - provider.catalogAt < CATALOG_TTL_MS) return provider;
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
          () => ensureProxy(p.id, config, key)
        )
      : ensureProxy(p.id, config, key);
  }

  /** Points this window at `provider` (undefined = subscription) and reloads it. */
  private async useInWindow(provider: Provider | undefined): Promise<void> {
    let desired: ProviderSettings | undefined;
    if (provider) {
      const key = await this.context.secrets.get(secretKey(provider.id));
      if (!key) throw new Error(`No key is stored for ${provider.name}. Edit the provider and set its key.`);
      provider = await this.refreshCatalog(provider, key);
      desired = settingsFor(provider, key, await this.proxyFor(provider, key, true));
    }
    await this.writeSettings(desired);
    await this.context.workspaceState.update(ACTIVE_KEY, provider?.id);
    log(`provider: this window now bills to ${provider ? `${provider.name} (${provider.baseUrl})` : 'its subscription'}`);
    this.onDidChange.fire();
    // Claude Code keeps a long-lived process that read its env when it started;
    // only a reload makes the panel itself pick the change up.
    await this.context.workspaceState.update(
      NOTICE_KEY,
      provider
        ? `This window now bills to ${provider.name}. Your Anthropic login stays saved — switch back any time from the status bar.`
        : `This window is back on its Anthropic subscription.`
    );
    await vscode.commands.executeCommand('workbench.action.reloadWindow');
  }

  /**
   * Brings settings.json in line with the provider's CURRENT definition and key.
   * Definitions are shared, so another window — or another host — may have
   * edited or removed the one this window uses. Never reloads by itself: it
   * offers the reload, so this can't become a loop.
   */
  async sync(): Promise<void> {
    const id = this.context.workspaceState.get<string>(ACTIVE_KEY);
    if (!id || !this.settingsFile()) return;
    let provider = this.get(id);
    const key = provider ? await this.context.secrets.get(secretKey(provider.id)) : undefined;
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
      ? 'The provider this window used was removed, so it is back on its Anthropic subscription.'
      : !key
        ? `${provider.name} has no stored key any more, so this window is back on its Anthropic subscription.`
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
   * over the process env), but it DOES silently replace the subscription in every
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
          `window, so windows on "Subscription" won't use their Anthropic login. Add it as a provider ` +
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
        label: `${mark(!current)}Subscription`,
        description: 'the Anthropic login of this window\'s account',
      },
      ...this.list().map((p) => ({
        label: `${mark(current?.id === p.id)}${p.name}`,
        description: p.baseUrl,
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
      vscode.window.showInformationMessage(`This window already bills to ${current?.name ?? 'its subscription'}.`);
      return;
    }
    await this.useInWindow(picked.provider);
  }

  async addInteractive(): Promise<void> {
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
    await this.context.secrets.store(secretKey(provider.id), key.trim());
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
          detail: 'Sets ANTHROPIC_API_KEY — the CLI asks once to approve a custom API key',
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
        providers.map((p) => ({ label: p.name, description: p.baseUrl, provider: p })),
        { title: 'Edit or remove a provider' }
      )
    )?.provider;
    if (!target) return;

    type Action = 'key' | 'url' | 'auth' | 'models' | 'others' | 'refresh' | 'proxylog' | 'betas' | 'rename' | 'remove';
    const action = (
      await vscode.window.showQuickPick<vscode.QuickPickItem & { action: Action }>(
        [
          { label: '$(key) Replace key', action: 'key' },
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
          { label: '$(edit) Rename', action: 'rename' },
          { label: '$(trash) Remove', action: 'remove' },
        ],
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
          validateInput: (v) => (v.trim() ? undefined : 'Enter the key'),
        });
        if (!key) return;
        await this.context.secrets.store(secretKey(target.id), key.trim());
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
            description: [m.ownedBy, m.contextLength ? `${Math.round(m.contextLength / 1000)}K context` : '']
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
        const doc = await vscode.workspace.openTextDocument(proxyLogFile(target.id));
        await vscode.window.showTextDocument(doc, { preview: true });
        return;
      }
      case 'refresh': {
        const key = await this.context.secrets.get(secretKey(target.id));
        if (!key) throw new Error(`No key is stored for ${target.name}. Replace its key first.`);
        const fresh = await vscode.window.withProgress(
          { location: vscode.ProgressLocation.Notification, title: `Reading ${target.name}'s model list…` },
          () => this.refreshCatalog(target, key, true)
        );
        Object.assign(updated, { catalog: fresh.catalog, catalogAt: fresh.catalogAt });
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
            `back to its Anthropic subscription.`,
          { modal: true },
          'Remove'
        );
        if (ok !== 'Remove') return;
        await this.save(this.list().filter((p) => p.id !== target.id));
        await this.context.secrets.delete(secretKey(target.id));
        await stopProxy(target.id);
        log(`provider removed: ${target.name}`);
        // This window used it: back to the subscription now. Other windows find
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
      const key = await this.context.secrets.get(secretKey(updated.id));
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
