import * as vscode from 'vscode';

/**
 * Other installed copies of this product — the same code and the same data
 * (~/.claude-*) under another extension ID. It has had three:
 * Claude Parallel Accounts (DercasDrol.claude-parallel-accounts), CPPO as
 * warrenb213.cppo, and CPPO as beboutit503.cppo.
 *
 * Each build says which copy it is with a mark in its package.json:
 * `"cppo": { "generation": N }`. With it, a copy knows the others whatever their
 * ID: the newest generation runs, older ones step aside, and an uninstaller
 * leaves the data alone while any other copy is installed (uninstall.js reads
 * the same mark). Copies built before the mark existed are known by ID; they
 * don't step aside for a newer generation and their uninstallers would delete
 * its data, so the newest stays idle beside them until they're updated to their
 * bridge release (which carries the mark).
 */

/** IDs that predate the mark, with the generation they were. */
const UNMARKED: Record<string, number> = {
  'dercasdrol.claude-parallel-accounts': 1,
  'warrenb213.cppo': 2,
};

export interface Copy {
  id: string;
  version: string;
  generation: number;
  /** Carries the mark: steps aside for newer copies, and its uninstaller keeps shared data. */
  marked: boolean;
}

function generationOf(pkg: unknown): number | undefined {
  const g = (pkg as { cppo?: { generation?: unknown } } | undefined)?.cppo?.generation;
  return typeof g === 'number' ? g : undefined;
}

/** This copy's extension ID, once activated (the hover's "Extension" link). */
export let selfId = '';

/** This copy's generation (its package.json mark; 0 if a build lacks it). */
export function ownGeneration(context: vscode.ExtensionContext): number {
  selfId = context.extension.id;
  return generationOf(context.extension.packageJSON) ?? 0;
}

/** Every other installed copy. */
export function otherCopies(context: vscode.ExtensionContext): Copy[] {
  const self = context.extension.id.toLowerCase();
  const out: Copy[] = [];
  for (const e of vscode.extensions.all) {
    const id = e.id.toLowerCase();
    if (id === self) continue;
    const marked = generationOf(e.packageJSON);
    const known = UNMARKED[id];
    if (marked === undefined && known === undefined) continue;
    out.push({
      id: e.id,
      version: String((e.packageJSON as { version?: unknown } | undefined)?.version ?? '?'),
      generation: marked ?? known,
      marked: marked !== undefined,
    });
  }
  return out;
}

const RELEASES = 'https://github.com/warrenb213/cppo/releases';

/** A newer copy is installed: this one does nothing but point at it. */
export function stepAside(context: vscode.ExtensionContext, newer: Copy): void {
  const item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 99);
  item.text = `$(info) ${context.extension.packageJSON.displayName ?? 'This extension'} → ${newer.id}`;
  item.tooltip =
    `${newer.id} ${newer.version} is installed and runs this window. This copy (${context.extension.id}) is doing ` +
    `nothing; uninstall it — it leaves your accounts, providers and history in place.`;
  item.show();
  context.subscriptions.push(item);
  void vscode.window
    .showInformationMessage(
      `${newer.id} has taken over from ${context.extension.id}. Uninstall this older copy — it leaves your accounts, providers and history in place.`,
      'Show it'
    )
    .then((pick) => {
      if (pick) void vscode.commands.executeCommand('workbench.extensions.search', `@installed ${context.extension.id}`);
    });
}

/**
 * An older copy that predates the mark is installed: it runs too, and its
 * uninstaller would delete the data this copy uses. Idle until it's updated to
 * its bridge release and removed.
 */
export function blockedByUnmarked(context: vscode.ExtensionContext, old: Copy[]): void {
  const names = old.map((c) => `${c.id} ${c.version}`).join(', ');
  const item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  item.text = '$(warning) CPPO: update the older copy first';
  item.tooltip = `${names} is still installed. CPPO stays idle until it is updated to its bridge release and uninstalled.`;
  item.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
  item.show();
  context.subscriptions.push(item);
  void vscode.window
    .showWarningMessage(
      `An older copy of CPPO is still installed (${names}), so this one stays idle — both would claim this window's ` +
        `account. Don't just uninstall it: that version's uninstaller deletes the accounts and history CPPO uses. ` +
        `Install its bridge release from the CPPO releases first — it steps aside and leaves your data alone when ` +
        `removed — then uninstall it and reload.`,
      { modal: true },
      'Open releases'
    )
    .then((pick) => {
      if (pick) void vscode.env.openExternal(vscode.Uri.parse(RELEASES));
    });
}

/** Older marked copies: harmless, but should go. */
export function suggestRemoving(old: Copy[]): void {
  const names = old.map((c) => c.id).join(', ');
  void vscode.window
    .showInformationMessage(
      `CPPO has replaced ${names}, which ${old.length === 1 ? 'is' : 'are'} still installed (doing nothing). Uninstall ${old.length === 1 ? 'it' : 'them'} — ${old.length === 1 ? 'it leaves' : 'they leave'} your accounts and history in place.`,
      'Show'
    )
    .then((pick) => {
      if (pick) void vscode.commands.executeCommand('workbench.extensions.search', `@installed ${old[0].id}`);
    });
}
