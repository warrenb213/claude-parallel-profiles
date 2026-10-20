import * as vscode from 'vscode';
import type { AgentTasks } from './agentTasks';
import type { Consult, DelegateServer } from './delegate';

/**
 * Transcripts of what workers did in this window — agent task runs and
 * `delegate` consultations — as read-only Markdown documents, opened in the
 * preview from the account hover. Rendered on demand from the task logs and the
 * consultation records; a running task's transcript follows along.
 */

const SCHEME = 'cppo-transcript';

/** A fenced code block that the text itself can't close early. */
export function fence(text: string, lang = ''): string {
  const longest = Math.max(2, ...(text.match(/`+/g) ?? []).map((r) => r.length));
  const f = '`'.repeat(longest + 1);
  return `${f}${lang}\n${text}\n${f}`;
}

/** A collapsed section (the Markdown preview renders <details>). */
export function details(summary: string, body: string): string {
  return `<details><summary>${summary.replace(/</g, '&lt;')}</summary>\n\n${body}\n\n</details>`;
}

export function clip(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}\n… (${(text.length - max).toLocaleString('en-US')} more characters)` : text;
}

function renderConsult(c: Consult): string {
  return [
    `# Consultation #${c.n} · ${c.worker}`,
    [
      `**Asked by:** ${c.caller === 'lead' ? 'the lead (this window\'s chat)' : 'an agent task'}`,
      `**When:** ${new Date(c.at).toLocaleString()}${c.ms !== undefined ? ` · ${(c.ms / 1000).toFixed(1)} s` : ''}`,
      c.inTok !== undefined ? `**Tokens:** ${c.inTok.toLocaleString('en-US')} in / ${(c.outTok ?? 0).toLocaleString('en-US')} out` : '',
    ].filter(Boolean).join('  \n'),
    '## Question',
    fence(c.task),
    c.context ? details(`Context · ${c.context.length.toLocaleString('en-US')} characters`, fence(c.context)) : '',
    '## Answer',
    c.error ? `**Failed:** ${c.error}` : c.answer !== undefined ? c.answer.trim() || '_(empty answer)_' : '_Waiting for the answer…_',
  ].filter(Boolean).join('\n\n') + '\n';
}

export class Transcripts implements vscode.TextDocumentContentProvider, vscode.Disposable {
  private readonly changed = new vscode.EventEmitter<vscode.Uri>();
  readonly onDidChange = this.changed.event;
  private readonly disposables: vscode.Disposable[] = [];
  private pending: NodeJS.Timeout | undefined;

  constructor(
    private readonly tasks: AgentTasks,
    private readonly workers: DelegateServer
  ) {
    this.disposables.push(
      vscode.workspace.registerTextDocumentContentProvider(SCHEME, this),
      // Open transcripts follow along — at most once a second.
      tasks.onDidChange.event(() => this.refreshSoon()),
      workers.onDidConsult.event(() => this.refreshSoon())
    );
  }

  provideTextDocumentContent(uri: vscode.Uri): string {
    const [, kind, id] = uri.path.split('/');
    if (kind === 'task') return this.tasks.transcript(id) ?? `# Task ${id}\n\nNot in this window any more.\n`;
    const c = this.workers.consults.find((x) => String(x.n) === id);
    return c ? renderConsult(c) : `# Consultation #${id}\n\nNo longer kept (this window keeps the latest 50).\n`;
  }

  /** How many tasks and consultations a worker has in this window (the hover's counts). */
  count(workerId: string): number {
    return this.tasks.list().filter((t) => t.worker === workerId).length + this.workers.consults.filter((c) => c.worker === workerId).length;
  }

  async openTask(id: string): Promise<void> {
    await this.open(vscode.Uri.from({ scheme: SCHEME, path: `/task/${id}/transcript.md` }));
  }

  /** A worker's tasks and consultations (all workers' without an id), newest first, to open one. */
  async pick(workerId?: string): Promise<void> {
    type Item = vscode.QuickPickItem & { uri: vscode.Uri; at: number };
    const items: Item[] = [
      ...this.tasks.list().filter((t) => !workerId || t.worker === workerId).map((t) => ({
        label: `$(${t.status === 'running' ? 'sync~spin' : t.status === 'queued' ? 'clock' : t.status === 'done' ? 'check' : 'error'}) Agent task ${t.id}`,
        description: `${workerId ? '' : `${t.worker} · `}${t.status}${t.applied ? ', applied' : ''} · ${t.files} file${t.files === 1 ? '' : 's'} · ${new Date(t.started).toLocaleTimeString()}`,
        detail: t.task.slice(0, 160),
        uri: vscode.Uri.from({ scheme: SCHEME, path: `/task/${t.id}/transcript.md` }),
        at: t.started,
      })),
      ...this.workers.consults.filter((c) => !workerId || c.worker === workerId).map((c) => ({
        label: `$(${c.error ? 'error' : c.answer === undefined ? 'sync~spin' : 'comment-discussion'}) Consultation #${c.n}`,
        description: `${workerId ? '' : `${c.worker} · `}asked by ${c.caller === 'lead' ? 'the lead' : 'an agent task'} · ${new Date(c.at).toLocaleTimeString()}`,
        detail: c.task.slice(0, 160),
        uri: vscode.Uri.from({ scheme: SCHEME, path: `/consult/${c.n}/transcript.md` }),
        at: c.at,
      })),
    ].sort((a, b) => b.at - a.at);
    if (items.length === 0) {
      vscode.window.showInformationMessage(`${workerId ?? 'No worker'} has done nothing in this window yet.`);
      return;
    }
    const choice = await vscode.window.showQuickPick(items, { title: `${workerId ?? 'Workers'}: tasks and consultations in this window`, matchOnDetail: true });
    if (choice) await this.open(choice.uri);
  }

  private async open(uri: vscode.Uri): Promise<void> {
    try {
      await vscode.commands.executeCommand('markdown.showPreview', uri);
    } catch {
      // The built-in Markdown extension is off: the source reads fine too.
      const doc = await vscode.workspace.openTextDocument(uri);
      await vscode.languages.setTextDocumentLanguage(doc, 'markdown');
      await vscode.window.showTextDocument(doc, { preview: true });
    }
  }

  private refreshSoon(): void {
    if (this.pending) return;
    this.pending = setTimeout(() => {
      this.pending = undefined;
      for (const doc of vscode.workspace.textDocuments) if (doc.uri.scheme === SCHEME) this.changed.fire(doc.uri);
    }, 1000);
  }

  dispose(): void {
    if (this.pending) clearTimeout(this.pending);
    this.changed.dispose();
    for (const d of this.disposables) d.dispose();
  }
}
