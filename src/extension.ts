import * as vscode from 'vscode';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { AccountRegistry, readIdentity } from './accounts';
import { WindowBinding } from './binding';
import { StatusBarManager } from './statusBar';
import { SetupWizard, NOTICE_KEY } from './setupWizard';
import { ensureSharedHistory } from './sharedHistory';
import { defaultSourceDir } from './capture';
import { AccountWatcher } from './accountWatcher';
import { HostState } from './hostState';
import { describeLogin, ProviderManager } from './providers';
import { OrchestrationPanel } from './orchestration';
import { DelegateServer } from './delegate';
import { AgentTasks } from './agentTasks';
import { Transcripts } from './transcripts';
import { allWorkingDirs, workingRoot } from './workdir';
import { removeStrayLinks } from './litellm';
import { log, showLog } from './log';

/**
 * Everything this extension does rests on Linux semantics that we verified:
 * Claude Code keeping credentials as FILES (macOS uses the Keychain instead),
 * /proc for finding live sessions, symlinks for shared history, a POSIX shell
 * for the CLI. On any other OS those assumptions silently break — up to
 * destructive misbehaviour (e.g. the registry pruning every account because it
 * sees no credential files). So elsewhere the extension must not guess: it
 * activates into an INERT mode that touches nothing and says why.
 *
 * The package is universal (see release.yml for why), so it installs on every
 * platform and this mode is what non-Linux installs get. The check runs where
 * the extension actually executes — in a WSL/SSH/container window that's the
 * REMOTE side (extensionKind "workspace"), so a Windows desktop driving a
 * Linux remote is fully supported and never lands here.
 */
function activateUnsupported(context: vscode.ExtensionContext): void {
  const label =
    process.platform === 'darwin' ? 'macOS' : process.platform === 'win32' ? 'native Windows' : process.platform;
  const msg =
    `Claude Parallel Accounts supports Linux only for now — desktop Linux, WSL, Remote-SSH to a Linux ` +
    `host, or a dev container. On ${label} it stays inactive: no files are read or written, no accounts ` +
    `are touched.` +
    (process.platform === 'win32' ? ' Tip: open your folder in a WSL window and install it there.' : '');
  log(`platform ${process.platform} is unsupported — inert mode, nothing will be touched`);

  const item = vscode.window.createStatusBarItem(
    'claudeProfiles.status',
    vscode.StatusBarAlignment.Right,
    90
  );
  item.name = 'Claude Account';
  item.text = '$(account) Claude: unsupported OS';
  const tooltip = new vscode.MarkdownString(`$(account) **Claude Parallel Accounts**\n\n${msg}`);
  tooltip.supportThemeIcons = true;
  item.tooltip = tooltip;
  item.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
  item.command = 'claudeProfiles.showStatus';
  item.show();

  // The commands stay registered so palette entries and keybindings don't die
  // with a cryptic "command not found" — they all explain the same thing.
  const explain = () => void vscode.window.showInformationMessage(msg);
  context.subscriptions.push(
    item,
    vscode.commands.registerCommand('claudeProfiles.switchAccount', explain),
    vscode.commands.registerCommand('claudeProfiles.captureAccount', explain),
    vscode.commands.registerCommand('claudeProfiles.removeProfile', explain),
    vscode.commands.registerCommand('claudeProfiles.switchProvider', explain),
    vscode.commands.registerCommand('claudeProfiles.addProvider', explain),
    vscode.commands.registerCommand('claudeProfiles.editProvider', explain),
    vscode.commands.registerCommand('claudeProfiles.showStatus', explain),
    vscode.commands.registerCommand('claudeProfiles.showLog', () => showLog())
  );
}

/** CPPO is installed: no accounts, no commands, no files — only a pointer to it. */
function activateSuperseded(context: vscode.ExtensionContext): void {
  const item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 99);
  item.text = '$(info) Claude Parallel Accounts → CPPO';
  item.tooltip =
    'CPPO is installed and runs this window. This extension (its old name) is doing nothing; uninstall it — ' +
    'this version leaves your accounts, providers and history in place when it is removed.';
  item.show();
  context.subscriptions.push(item);
  void vscode.window
    .showInformationMessage(
      'CPPO has taken over from Claude Parallel Accounts. Uninstall the old extension — this version of it leaves your accounts, providers and history in place.',
      'Show it'
    )
    .then((pick) => {
      if (pick) void vscode.commands.executeCommand('workbench.extensions.search', '@installed claude parallel accounts');
    });
}

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  if (process.platform !== 'linux') {
    activateUnsupported(context);
    return;
  }
  // CPPO (warrenb213.cppo) is this extension under its new name. With it installed,
  // this copy steps aside entirely: two copies would both claim the window's
  // CLAUDE_CONFIG_DIR, its commands and its workers server.
  if (vscode.extensions.getExtension('warrenb213.cppo')) {
    activateSuperseded(context);
    return;
  }

  // Accounts, the repo map and the last-used account describe THIS host's disk,
  // so they live on it — not in globalState, which VSCode shares across every
  // remote host this editor connects to (see hostState.ts). Adopting the old
  // globalState copy is synchronous: applyStored() below needs it in place.
  const state = new HostState();
  state.migrateFrom(context.globalState);
  const registry = new AccountRegistry(state);
  const binding = new WindowBinding(context, state);
  const wizard = new SetupWizard(registry, binding, context);
  const providers = new ProviderManager(context, binding, state);
  const statusBar = new StatusBarManager(registry, binding, providers);

  // A forgotten account no longer resolves, so a window that remembered one
  // falls back to the default dir and — via auto-save — onto whichever saved
  // account is signed in there. That's intended: the user then either picks
  // another account from the list, or signs in to a new one in Claude Code and
  // we capture it.
  const resolveAccount = (name: string) => registry.get(name);

  // Bind this window to its remembered account FIRST and synchronously, so
  // process.env.CLAUDE_CONFIG_DIR is set before Claude Code spawns `claude`
  // (both extensions activate on startup — minimise the race window).
  let bound = binding.applyStored(resolveAccount);

  // ── The critical fix ───────────────────────────────────────────────────────
  // The machine-scoped `claudeCode.environmentVariables` setting is shared by
  // every window on this host; if it defines CLAUDE_CONFIG_DIR it overrides our
  // per-window process.env and forces all windows onto one account. Clear it so
  // isolation flows through process.env instead.
  const cleared = await binding.clearMachineOverride();

  // A short-lived earlier design kept a "shadow vault" of credential copies. The
  // per-window working dirs made it unnecessary — an account's store IS the spare
  // copy now — but it held real tokens, so leave none behind.
  try {
    const vault = path.join(os.homedir(), '.claude-vault');
    if (fs.existsSync(vault)) {
      fs.rmSync(vault, { recursive: true, force: true });
      log('removed the obsolete credential vault');
    }
  } catch (err) {
    log(`could not remove the obsolete vault: ${(err as Error).message}`);
  }

  // Pick up any accounts already logged in on disk, then retry binding in case
  // the remembered account was only discovered just now.
  await registry.discoverAndMerge();
  if (!bound) bound = binding.applyStored(resolveAccount);

  // One history, in one store, symlinked from every dir — the same single history
  // vanilla Claude Code has. Do this BEFORE Claude Code reads the dir, otherwise
  // the first paint of the panel would show empty history.
  //
  // This is not a "share between accounts" feature, it is what keeps history from
  // being LOST: a window runs on its own working dir, which starts out empty, so
  // without the links every conversation the user ever had (they live in the
  // default ~/.claude) would simply disappear from the panel the moment this
  // extension was installed. Hence no setting to turn it off — an off switch only
  // ever meant "fragment my history across N directories", which is why it also
  // used to copy the entire store into each of them.
  //
  // Forgotten accounts' dirs are included: they stay on disk and their history is
  // the user's. Working dirs MUST be in here — a window's conversations live in
  // the dir it actually runs on.
  const allDirs = (): string[] => [
    defaultSourceDir(),
    ...registry.list().map((a) => a.dir),
    ...registry.listForgotten().map((a) => a.dir),
    ...allWorkingDirs(),
  ];
  removeStrayLinks();
  const warnings = ensureSharedHistory(allDirs());
  if (warnings.length > 0) {
    vscode.window.showWarningMessage(
      `Claude Accounts: shared history migration hit ${warnings.length} issue(s); ` +
        `will retry on next reload. First: ${warnings[0]}`
    );
  }

  log(
    `activated: env=${process.env.CLAUDE_CONFIG_DIR ?? '(default)'} ` +
      `active=${binding.getActiveName() ?? '(none)'} ` +
      `accounts=${registry.list().length} forgotten=${registry.listForgotten().length} ` +
      `clearedSettingsOverride=${cleared}`
  );

  // A command that dies silently reads as "the button does nothing" — every
  // handler logs and SHOWS its errors instead. Registration itself is also
  // guarded: a duplicate copy of this extension (e.g. the same code published
  // under another publisher) registering the same command IDs used to crash
  // activation halfway and leave a dead status bar button.
  const conflicts: string[] = [];
  const cmd = (id: string, fn: () => Promise<unknown> | unknown): vscode.Disposable => {
    try {
      return vscode.commands.registerCommand(id, async () => {
        log(`command: ${id}`);
        try {
          await fn();
        } catch (err) {
          log(`ERROR in ${id}: ${(err as Error).stack ?? String(err)}`);
          const pick = await vscode.window.showErrorMessage(
            `Claude Accounts: ${(err as Error).message}`,
            'Show log'
          );
          if (pick === 'Show log') showLog();
        }
      });
    } catch (err) {
      conflicts.push(id);
      log(`FAILED to register ${id}: ${(err as Error).message}`);
      return new vscode.Disposable(() => undefined);
    }
  };

  context.subscriptions.push(
    cmd('claudeProfiles.switchAccount', () => wizard.switchAccountInteractive()),
    cmd('claudeProfiles.captureAccount', () => wizard.captureCurrentAccount()),
    cmd('claudeProfiles.removeProfile', () => wizard.removeAccountInteractive()),
    cmd('claudeProfiles.showStatus', () => statusBar.onClick()),
    cmd('claudeProfiles.showLog', () => showLog()),
    cmd('claudeProfiles.switchProvider', () => providers.switchInteractive()),
    cmd('claudeProfiles.addProvider', () => providers.addInteractive()),
    cmd('claudeProfiles.editProvider', () => providers.editInteractive()),
    cmd('claudeProfiles.showAgentTasks', () => agentTasks.showInteractive()),
    // The account hover links each task and worker to its transcripts.
    cmd('claudeProfiles.showAgentTaskTranscript', (id?: string) => (id ? transcripts.openTask(id) : transcripts.pick())),
    cmd('claudeProfiles.showWorkerTranscripts', (worker?: string) => transcripts.pick(worker)),
    cmd('claudeProfiles.showOrchestration', () =>
      OrchestrationPanel.show({
        providers,
        workers,
        account: () => {
          const dir = binding.getEnvDir();
          return { email: dir ? readIdentity(dir)?.email : undefined, login: providers.active()?.name ?? describeLogin(dir) };
        },
      })
    ),
    cmd('claudeProfiles.showUsage', async () => {
      const report = await workers.usageReport();
      const doc = await vscode.workspace.openTextDocument({ content: `Provider usage\n\n${report}\n`, language: 'plaintext' });
      await vscode.window.showTextDocument(doc, { preview: true });
    }),
    // Only the focused window repairs a dir whose account was replaced by a
    // sign-in (it's the window the user signed in from). So a window that was
    // unfocused while that happened must reconcile when focus comes back —
    // otherwise a handoff nobody was around to finish would sit unrepaired.
    vscode.window.onDidChangeWindowState((s) => {
      if (s.focused) void wizard.reconcile().finally(() => statusBar.reconfirm());
      // Provider definitions are shared: another window or host may have edited
      // or removed the one this window bills to.
      if (s.focused) void providers.sync();
    }),
    statusBar,
    providers
  );

  statusBar.initialize();

  // When this window's account state changes on disk (a /login or /logout inside
  // this window, or a forget from another one), reconcile: mirror the token into
  // its shadow copy, save a newly-seen account, and — if a sign-in landed on top
  // of the account this dir held — move the new account into a dir of its own and
  // restore the displaced one. Then repaint the bar so it never lags behind.
  const watcher = new AccountWatcher(binding, () => {
    void wizard.reconcile().finally(() => statusBar.reconfirm());
  });
  watcher.start();
  context.subscriptions.push(watcher);

  if (conflicts.length > 0) {
    void vscode.window
      .showErrorMessage(
        `Claude Accounts: another extension already owns ${conflicts.length} of this extension's ` +
          `commands — most likely a duplicate copy under a different publisher ` +
          `(e.g. "tundak.claude-parallel-accounts"). Uninstall the duplicate and reload the window.`,
        'Show extensions'
      )
      .then((pick) => {
        if (pick === 'Show extensions') {
          void vscode.commands.executeCommand('workbench.extensions.search', 'claude parallel accounts');
        }
      });
  }

  if (cleared) {
    vscode.window.showInformationMessage(
      'Claude Accounts: removed CLAUDE_CONFIG_DIR from the shared machine setting. ' +
        'Isolation now works per-window. Pick this window\'s account from the status bar.'
    );
  }

  // Bring this window in step with what's on disk: save the account it's signed
  // in as (no "Save" click), and follow a sign-in that changed which account its
  // dir holds. Runs after the synchronous env binding above, so it never delays
  // the critical activation race with Claude Code.
  await wizard.reconcile({ atActivation: true });
  // reconcile() may have just bound this window to a freshly-saved account.
  if (!bound) bound = binding.applyStored(resolveAccount);

  // Not part of the activation race: settings.json is read by each `claude` when
  // it starts, and it already carries the provider written at the last switch.
  // Workers (delegate.ts): registered in this window's own config while any are enabled.
  // Login workers run on the account's own store dir — never on a window's working dir, which may carry a gateway.
  providers.setLoginDir(() => {
    const name = binding.getActiveName();
    return name ? registry.get(name)?.dir : undefined;
  });
  const agentTasks: AgentTasks = new AgentTasks(
    (id) => providers.agentSpec(id),
    (): { url: string; token: string } | undefined => workers.workerAccess(),
    (worker: string, inTok: number, outTok: number): void => workers.usage.count(worker, 'task', inTok, outTok)
  );
  const workers: DelegateServer = new DelegateServer(providers, () => providers.ownConfigDir(), agentTasks);
  const transcripts: Transcripts = new Transcripts(agentTasks, workers);
  statusBar.setAgentTasks(agentTasks, transcripts, workers.onDidConsult.event);
  context.subscriptions.push(workers, agentTasks, transcripts);
  void providers.migrate().then(async () => {
    await providers.sync();
    await workers.reconcile();
  });
  providers.warnAboutSharedOverride();

  // An account handoff finishes with a reload, which kills any toast raised
  // before it — so the news of what happened is delivered here instead.
  const notice = context.workspaceState.get<string>(NOTICE_KEY);
  if (notice) {
    await context.workspaceState.update(NOTICE_KEY, undefined);
    // A notice typically reports an account handoff. If this window came out of
    // it with NO account while saved ones exist (forget reloaded it into limbo),
    // the news must come with the way out attached, not read as a dead end.
    const canSwitch = !binding.getActiveName() && registry.listUniqueByEmail().length > 0;
    void vscode.window
      .showInformationMessage(`Claude Accounts: ${notice}`, ...(canSwitch ? ['Switch account'] : []))
      .then((pick) => {
        if (pick === 'Switch account') {
          void vscode.commands.executeCommand('claudeProfiles.switchAccount');
        }
      });
  }

  // First-run guidance only when there's genuinely nothing to work with: no
  // saved accounts and this window isn't signed in anywhere (so auto-save had
  // nothing to capture). Otherwise the status bar already shows the account.
  if (!bound && registry.list().length === 0) {
    const key = 'claudeProfiles.introShown';
    if (!context.globalState.get<boolean>(key, false)) {
      await context.globalState.update(key, true);
      vscode.window.showInformationMessage(
        'Claude Accounts: no accounts detected yet. Sign in with Claude Code (Account menu → Login, ' +
          'or /login in a chat) and this window will remember the account automatically.'
      );
    }
  }
}

export function deactivate(): void {
  /* nothing to clean up */
}
