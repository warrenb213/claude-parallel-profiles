import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import { WindowBinding } from './binding';
import { NOTICE_KEY } from './setupWizard';
import { log } from './log';

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
 */

export interface Provider {
  id: string;
  name: string;
  baseUrl: string;
  /** How the gateway takes its key: `Authorization: Bearer` or `x-api-key`. */
  auth: 'bearer' | 'x-api-key';
  /** What Claude Code's opus/sonnet/haiku aliases resolve to on this gateway. */
  models?: { opus?: string; sonnet?: string; haiku?: string };
  /** For gateways that reject Anthropic's experimental `anthropic-beta` headers. */
  disableBetas?: boolean;
}

const PROVIDERS_KEY = 'claudeProfiles.providers';
const ACTIVE_KEY = 'claudeProfiles.activeProvider';
const HIDE_OVERRIDE_WARNING_KEY = 'claudeProfiles.hideProviderOverrideWarning';
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
  'CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS',
] as const;

/** The env block for a provider. The unused credential is set EMPTY, not left out: settings env overrides shell exports, so an ANTHROPIC_* key in the user's shell can't sneak past it. */
function envFor(p: Provider, key: string): Record<string, string> {
  const env: Record<string, string> = {
    ANTHROPIC_BASE_URL: p.baseUrl,
    ANTHROPIC_AUTH_TOKEN: p.auth === 'bearer' ? key : '',
    ANTHROPIC_API_KEY: p.auth === 'x-api-key' ? key : '',
  };
  if (p.models?.opus) env.ANTHROPIC_DEFAULT_OPUS_MODEL = p.models.opus;
  if (p.models?.sonnet) env.ANTHROPIC_DEFAULT_SONNET_MODEL = p.models.sonnet;
  if (p.models?.haiku) env.ANTHROPIC_DEFAULT_HAIKU_MODEL = p.models.haiku;
  if (p.disableBetas) env.CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS = '1';
  return env;
}

function formatModels(m: Provider['models']): string {
  return (['opus', 'sonnet', 'haiku'] as const)
    .filter((k) => m?.[k])
    .map((k) => `${k}=${m![k]}`)
    .join(', ');
}

function parseModels(input: string): Provider['models'] | string {
  const models: NonNullable<Provider['models']> = {};
  for (const part of input.split(',').map((s) => s.trim()).filter(Boolean)) {
    const m = /^(opus|sonnet|haiku)\s*=\s*(\S+)$/i.exec(part);
    if (!m) return `"${part}" — expected alias=model, e.g. sonnet=claude-sonnet-4-5`;
    models[m[1].toLowerCase() as 'opus' | 'sonnet' | 'haiku'] = m[2];
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
   * Writes the provider's env into this window's settings.json, or removes every
   * managed var for the subscription. Leaves the rest of the file alone — Claude
   * Code's /config writes there too. Returns true if the file changed.
   */
  private writeEnv(env: Record<string, string> | undefined): boolean {
    const file = this.settingsFile();
    if (!file) throw new Error('This window has no account of its own yet — sign in or pick an account first.');
    let settings: Record<string, unknown> = {};
    if (fs.existsSync(file)) {
      try {
        settings = JSON.parse(fs.readFileSync(file, 'utf-8')) as Record<string, unknown>;
      } catch (err) {
        // Never overwrite a file we can't read — it may hold the user's own settings.
        throw new Error(`Can't read ${file} (${(err as Error).message}). Fix or remove it, then try again.`);
      }
    } else if (!env) {
      return false; // subscription, and nothing was ever written
    }
    const before = JSON.stringify(settings);
    const current = { ...((settings.env as Record<string, string> | undefined) ?? {}) };
    for (const k of MANAGED_ENV) delete current[k];
    Object.assign(current, env ?? {});
    if (Object.keys(current).length > 0) settings.env = current;
    else delete settings.env;
    if (JSON.stringify(settings) === before) return false;
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(settings, null, 2), { mode: 0o600 });
    fs.chmodSync(tmp, 0o600); // the file now holds a key
    fs.renameSync(tmp, file);
    return true;
  }

  /** Points this window at `provider` (undefined = subscription) and reloads it. */
  private async useInWindow(provider: Provider | undefined): Promise<void> {
    let env: Record<string, string> | undefined;
    if (provider) {
      const key = await this.context.secrets.get(secretKey(provider.id));
      if (!key) throw new Error(`No key is stored for ${provider.name}. Edit the provider and set its key.`);
      env = envFor(provider, key);
    }
    this.writeEnv(env);
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
    const provider = this.get(id);
    const key = provider ? await this.context.secrets.get(secretKey(provider.id)) : undefined;
    let changed: boolean;
    try {
      changed = this.writeEnv(provider && key ? envFor(provider, key) : undefined);
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

    const canUse = Boolean(this.settingsFile());
    const pick = await vscode.window.showInformationMessage(
      `Added ${provider.name}. Model aliases and beta headers can be adjusted under "Edit or Remove a Provider".`,
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
          detail: 'Sets ANTHROPIC_API_KEY — the CLI asks once to approve a custom API key',
          value: 'x-api-key' as const,
        },
      ],
      { title: 'How does the gateway take its key?' }
    );
    return picked?.value;
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

    type Action = 'key' | 'url' | 'auth' | 'models' | 'betas' | 'rename' | 'remove';
    const action = (
      await vscode.window.showQuickPick<vscode.QuickPickItem & { action: Action }>(
        [
          { label: '$(key) Replace key', action: 'key' },
          { label: '$(link) Change base URL', description: target.baseUrl, action: 'url' },
          { label: '$(shield) Key header', description: target.auth === 'bearer' ? 'Bearer' : 'x-api-key', action: 'auth' },
          {
            label: '$(symbol-enum) Model aliases',
            description: formatModels(target.models) || 'Claude Code defaults',
            action: 'models',
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
        const input = await vscode.window.showInputBox({
          title: `Model aliases for ${target.name}`,
          prompt:
            'alias=model pairs, comma-separated; empty for Claude Code\'s defaults. Use Anthropic model ' +
            'IDs (Poe accepts them) — names Claude Code doesn\'t know lose their context-window info.',
          placeHolder: 'opus=claude-opus-4-5, sonnet=claude-sonnet-4-5, haiku=claude-haiku-4-5',
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
    if (this.active()?.id === target.id) await this.sync();
    else vscode.window.showInformationMessage(`Updated ${updated.name}.`);
  }

  dispose(): void {
    this.onDidChange.dispose();
  }
}
