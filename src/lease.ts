import * as vscode from 'vscode';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

/**
 * A usage lease: proof that some CPPO — under ANY extension ID — ran on this host
 * recently. uninstall.js (which VS Code runs at the next server start after an
 * uninstall, possibly days later) leaves everything alone while the lease is fresh,
 * so a stale copy that doesn't know the ID of the one now installed can't delete the
 * data that copy uses. Lives under ~/.config/cppo, outside everything an older
 * uninstall script removes; the path must stay in sync with uninstall.js.
 */
export function leasePath(): string {
  return path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), 'cppo', 'in-use');
}

/** Refreshes the lease (atomic write; best effort — it must never keep the extension from running). */
export function touchLease(context: vscode.ExtensionContext): void {
  try {
    const file = leasePath();
    const tmp = `${file}.${process.pid}.tmp`;
    const pkg = context.extension.packageJSON;
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    fs.writeFileSync(tmp, JSON.stringify({
      at: new Date().toISOString(),
      id: context.extension.id,
      version: pkg.version,
      generation: pkg.cppo?.generation,
    }), { mode: 0o600 });
    fs.renameSync(tmp, file);
  } catch {
    // Best-effort: a lease must never keep the extension from running.
  }
}

/** Takes the lease now and keeps it fresh hourly while this extension host runs. */
export function startLease(context: vscode.ExtensionContext): void {
  touchLease(context);
  const timer = setInterval(() => touchLease(context), 60 * 60 * 1000);
  timer.unref();
  context.subscriptions.push(new vscode.Disposable(() => clearInterval(timer)));
}
