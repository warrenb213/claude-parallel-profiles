import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import { execFile, execFileSync, spawn, ChildProcess } from 'child_process';
import { workingRoot } from './workdir';
import { log } from './log';
import { MCP_CALL_TIMEOUT_MS } from './delegate';
import { claudeShellArgs } from './cli';
import { fence, details, clip } from './transcripts';

/**
 * Agent tasks: a worker that does real work, not just answers.
 *
 * Each task is a headless `claude -p` on the worker's provider (e.g. GLM on
 * Z.ai), in auto mode, inside a git worktree made from a snapshot of the
 * user's repo — HEAD plus uncommitted changes (untracked files included,
 * .gitignore respected), built with a temporary index so the user's own index
 * is never touched. The run gets a fresh config: none of the user's login,
 * plugins or MCP servers, and the provider key only in its process
 * environment. When it ends, the worktree's changes are collected as a patch
 * against the snapshot and the worktree is removed; the lead reviews the patch
 * and, if it wants, applies it to the working tree (never the index).
 *
 * Auto mode checks each consequential action (commands, network) with a
 * classifier on the worker's own model — about 35K tokens per check on Z.ai.
 */

export interface AgentRunSpec {
  /** The model id Claude Code should run, as the provider's settings name it (e.g. "glm-5.3[1m]"). */
  runModel: string;
  /** settings.json for the run — no secrets. */
  settings: Record<string, unknown>;
  /** Secret env (the provider key), passed to the process only. */
  secretEnv: Record<string, string>;
  /** Approve an ANTHROPIC_API_KEY for the run's config (Claude Code asks about custom keys). */
  approveKeyTail?: string;
}

type Status = 'queued' | 'running' | 'done' | 'failed' | 'cancelled';

interface Task {
  id: string;
  worker: string;
  task: string;
  context?: string;
  /** Builds on this task's result (chained tasks). */
  after?: string;
  /** Commit of the task's included changes on top of `base` — what a chained task starts from. */
  result?: string;
  status: Status;
  dir: string;
  repo: string;
  base: string;
  worktree: string;
  started: number;
  ended?: number;
  child?: ChildProcess;
  turns: number;
  toolUses: number;
  lastAction?: string;
  report?: string;
  error?: string;
  costUsd?: number;
  inTok?: number;
  outTok?: number;
  patchFile?: string;
  stat?: string;
  files?: string[];
  /** Files the worker wrote with its file tools (worktree-relative). New files only land if listed here. */
  written: Set<string>;
  /** New files that only appeared as side effects of commands (build output, caches) — left out of the patch. */
  sideEffects?: string[];
  /** Dependency folders linked into the worktree (DEP_DIRS). */
  links?: string[];
  /** What the snapshot left out (untracked over budget, LFS files), for the worker and the lead. */
  snapshotNote?: string;
  applied?: boolean;
  waiters: Array<() => void>;
}

const MAX_RUNNING = 2;
const MAX_TURNS = 80;
const WALL_MS = 30 * 60_000;
const KEEP_DAYS = 7;
const MAX_DIFF_IN_RESULT = 60_000;

/**
 * Snapshot budgets. A repo's untracked content can be anything — one project
 * had 162 GB of scratch data in an un-ignored `.temp`, and `git add -A` began
 * hashing all of it into the repo's object store, once per task. So untracked
 * files are taken one by one within these limits; the rest is left out and
 * reported, and LFS-managed files are never added (their content would be
 * copied into LFS storage).
 */
const UNTRACKED_FILE_MAX = 5 * 1024 * 1024;
const UNTRACKED_TOTAL_MAX = 100 * 1024 * 1024;
const UNTRACKED_COUNT_MAX = 2_000;
/** How many untracked paths to look at before giving up counting. */
const UNTRACKED_SCAN_MAX = 200_000;
/** A worktree checks HEAD out in full: refuse repos whose tracked files exceed this. */
const CHECKOUT_MAX_BYTES = 5 * 1024 ** 3;
const SNAPSHOT_GIT_TIMEOUT_MS = 120_000;
/**
 * Paths copied in by name even though the rules above leave them out — a
 * gitignored scratch file the task needs, say. Their own budget, the same
 * size limit a file.
 */
const INCLUDE_TOTAL_MAX = 100 * 1024 * 1024;
const INCLUDE_COUNT_MAX = 2_000;

/**
 * Dependency folders a worktree lacks — they're gitignored, so a snapshot
 * leaves them out — linked in from the user's repo so an agent can build and
 * test (GLM couldn't typecheck this very repo without node_modules). Top-level
 * only; each link is removed again before the changes are collected.
 */
const DEP_DIRS = ['node_modules', '.venv', 'venv', '.virtualenv', 'vendor', '.bundle', 'bower_components', 'Pods', '.gradle'];

/** The workers MCP server, as agent runs see it (restricted token: consult tools only). */
const CONSULT_SERVER = 'claude-accounts-workers';
const CONSULT_TOOLS = ['delegate', 'list_workers', 'provider_usage'];
const CONSULT_INSTRUCTIONS =
  ' You can consult other models with the `delegate` tool (answers only — paste in what they need), ' +
  "e.g. Claude on the user's subscription for a second opinion on a tricky change. `list_workers` shows who " +
  'is available, `provider_usage` how much of each plan is left; consult when it helps, not for every step.';

/**
 * Files under the repo that `text` names by absolute path ("/repo/.temp/Plan v2.md").
 * Names may hold spaces, so each mention is tried from its longest reading down.
 * Files only: a folder named in passing can be anything (one was 162 GB).
 */
function mentionedFiles(repo: string, text: string): string[] {
  const found = new Set<string>();
  const prefix = repo + '/';
  for (let i = text.indexOf(prefix); i >= 0; i = text.indexOf(prefix, i + 1)) {
    let candidate = text.slice(i + prefix.length, i + prefix.length + 400).split(/[\n`'"<>|*]/)[0];
    for (let tries = 0; candidate && tries < 40; tries++) {
      const rel = path.normalize(candidate.replace(/[\s).,;:\]]+$/, ''));
      try {
        if (rel && !rel.startsWith('..') && fs.statSync(path.join(repo, rel)).isFile()) {
          found.add(rel.split(path.sep).join('/'));
          break;
        }
      } catch {
        /* not this reading */
      }
      const cut = candidate.search(/\s\S*$/);
      if (cut <= 0) break;
      candidate = candidate.slice(0, cut);
    }
  }
  return [...found];
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function git(cwd: string, args: string[], env?: NodeJS.ProcessEnv, opts: { timeoutMs?: number; input?: string } = {}): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = execFile(
      'git',
      args,
      { cwd, env: { ...process.env, ...env }, maxBuffer: 256 * 1024 * 1024, timeout: opts.timeoutMs ?? 0, killSignal: 'SIGKILL' },
      (err, stdout, stderr) => {
        if (err) {
          const killed = (err as { killed?: boolean }).killed;
          reject(new Error(killed ? `git ${args[0]} took longer than ${Math.round((opts.timeoutMs ?? 0) / 1000)} s and was stopped` : `git ${args[0]}: ${(stderr || err.message).toString().trim().split('\n').slice(-2).join(' ')}`));
        } else resolve(stdout.toString());
      }
    );
    if (opts.input !== undefined) child.stdin?.end(opts.input);
  });
}

/** Lists NUL-separated paths from a git command, streaming (an untracked tree can be huge), up to `max`. */
function gitPaths(cwd: string, args: string[], max: number): Promise<{ paths: string[]; truncated: boolean }> {
  return new Promise((resolve, reject) => {
    const child = spawn('git', args, { cwd, stdio: ['ignore', 'pipe', 'ignore'] });
    const paths: string[] = [];
    let buf = '';
    let truncated = false;
    child.stdout!.on('data', (d: Buffer) => {
      buf += d.toString();
      let i: number;
      while ((i = buf.indexOf('\0')) >= 0) {
        if (paths.length >= max) {
          truncated = true;
          child.kill('SIGKILL');
          return;
        }
        paths.push(buf.slice(0, i));
        buf = buf.slice(i + 1);
      }
    });
    child.on('error', reject);
    child.on('close', () => resolve({ paths, truncated }));
  });
}

const IDENTITY = {
  GIT_AUTHOR_NAME: 'Claude Accounts',
  GIT_AUTHOR_EMAIL: 'agent-task@localhost',
  GIT_COMMITTER_NAME: 'Claude Accounts',
  GIT_COMMITTER_EMAIL: 'agent-task@localhost',
};

/** A tool call's one-line heading in a transcript: what it acts on. */
function toolHead(input: Record<string, unknown>): string {
  const target = input.file_path ?? input.notebook_path ?? input.path ?? input.pattern ?? input.url ?? input.description;
  return typeof target === 'string' ? ` · \`${target.replace(/`/g, "'").slice(0, 160)}\`` : '';
}

/** A tool call's input in a transcript: the command, the edit, or the arguments. */
function toolBody(name: string, input: Record<string, unknown>): string {
  if (typeof input.command === 'string') return fence(clip(input.command, 3000), 'sh');
  if (name === 'Edit' && typeof input.old_string === 'string') {
    const diff = [
      ...String(input.old_string).split('\n').map((l) => `- ${l}`),
      ...String(input.new_string ?? '').split('\n').map((l) => `+ ${l}`),
    ].join('\n');
    return fence(clip(diff, 3000), 'diff');
  }
  if (name === 'Write' && typeof input.content === 'string') return details(`Content · ${input.content.split('\n').length} lines`, fence(clip(input.content, 3000)));
  const rest = { ...input };
  for (const k of ['file_path', 'notebook_path', 'path', 'pattern', 'url', 'description']) delete rest[k];
  return Object.keys(rest).length ? fence(clip(JSON.stringify(rest, null, 2), 2000), 'json') : '';
}

const RUN_INSTRUCTIONS =
  "You are a worker agent. You are in a scratch git worktree: a copy of the user's repository, made for this " +
  'task alone. Make the changes the task needs here, and verify them (build, tests) where it makes sense. ' +
  'Do not commit, push, or touch anything outside this directory; paths to the user\'s repository in the task ' +
  "already point at this copy, and nothing outside it is available — if the task needs a file you don't have, " +
  'say so in your report instead of working around it. Dependency folders such as node_modules ' +
  "or .venv may be links to the user's own copies: use them to build and test, but don't install into or " +
  'modify them. Another AI (the lead) will review your ' +
  'changes as a diff before anything reaches the user. Finish with a short report: what you changed and why, ' +
  'what you ran to verify it and the results, and anything left open.';

export class AgentTasks implements vscode.Disposable {
  private readonly tasks = new Map<string, Task>();
  /** Fires when any task changes — the account's status bar item shows them (statusBar.ts). */
  readonly onDidChange = new vscode.EventEmitter<void>();

  constructor(
    private readonly spec: (workerId: string) => Promise<AgentRunSpec | undefined>,
    /** The workers server for runs (restricted token), when it is up. */
    private readonly access?: () => { url: string; token: string } | undefined,
    /** Called when a task ends: worker, input and output tokens (for the usage book). */
    private readonly onTaskDone?: (worker: string, inTok: number, outTok: number) => void
  ) {
    this.prune();
  }

  private root(): string {
    return path.join(workingRoot(), 'agent-tasks');
  }

  /** Task folders (patch + log) older than KEEP_DAYS go. */
  private prune(): void {
    try {
      for (const name of fs.readdirSync(this.root())) {
        const dir = path.join(this.root(), name);
        if (Date.now() - fs.statSync(dir).mtimeMs > KEEP_DAYS * 86_400_000) fs.rmSync(dir, { recursive: true, force: true });
      }
    } catch {
      /* nothing yet */
    }
  }

  private render(): void {
    this.onDidChange.fire();
  }

  /**
   * For the account's hover card: how many tasks are active, and a line per
   * recent task (newest first) — worker, state, progress, and what it changed.
   */
  summary(max = 5): { active: number; lines: string[] } {
    const md = (s: string) => s.replace(/[\\`*_[\]<>|]/g, (c) => `\\${c}`);
    const all = [...this.tasks.values()].sort((a, b) => b.started - a.started);
    const active = all.filter((t) => t.status === 'running' || t.status === 'queued').length;
    const lines = all.slice(0, max).map((t) => {
      const name = `[${md(t.worker.split('/').pop() ?? t.worker)}](command:claudeProfiles.showAgentTaskTranscript?${encodeURIComponent(JSON.stringify([t.id]))} "Open its transcript")`;
      const what = md(t.task.length > 70 ? `${t.task.slice(0, 70)}…` : t.task);
      const secs = Math.round(((t.ended ?? Date.now()) - t.started) / 1000);
      const time = secs < 120 ? `${secs} s` : `${Math.round(secs / 60)} min`;
      switch (t.status) {
        case 'queued':
          return `$(clock) **${name}** · queued${t.after ? ` after ${t.after}` : ''} — ${what}`;
        case 'running':
          return `$(sync~spin) **${name}** · ${t.turns} turns · ${time}${t.lastAction ? ` · \`${t.lastAction.slice(0, 60).replace(/`/g, "'")}\`` : ''} — ${what}`;
        case 'done':
          return `$(check) **${name}** · done in ${time} · ${t.files?.length ?? 0} file${t.files?.length === 1 ? '' : 's'} changed${t.applied ? ' · **applied**' : t.files?.length ? ' · not applied' : ''} — ${what}`;
        default:
          return `$(error) **${name}** · ${t.status}${t.error ? `: ${md(t.error.slice(0, 80))}` : ''} — ${what}`;
      }
    });
    if (all.length > max) lines.push(`_…and ${all.length - max} earlier_`);
    return { active, lines };
  }

  /** This window's tasks, newest first (the transcript pickers). */
  list(): Array<{ id: string; worker: string; status: Status; task: string; started: number; files: number; applied: boolean }> {
    return [...this.tasks.values()]
      .sort((a, b) => b.started - a.started)
      .map((t) => ({ id: t.id, worker: t.worker, status: t.status, task: t.task, started: t.started, files: t.files?.length ?? 0, applied: Boolean(t.applied) }));
  }

  /** A task's run as a readable Markdown transcript, from its log; undefined for an unknown task. */
  transcript(id: string): string | undefined {
    const t = this.tasks.get(id);
    if (!t) return undefined;
    const secs = Math.round(((t.ended ?? Date.now()) - t.started) / 1000);
    const out: string[] = [
      `# Agent task ${t.id} · ${t.worker}`,
      [
        `**Status:** ${t.status}${t.applied ? ' (applied)' : ''}`,
        `**Started:** ${new Date(t.started).toLocaleString()} · ${secs < 120 ? `${secs} s` : `${Math.round(secs / 60)} min`}`,
        `**Turns:** ${t.turns} · **tool uses:** ${t.toolUses}${t.inTok !== undefined ? ` · **tokens:** ${t.inTok.toLocaleString('en-US')} in / ${(t.outTok ?? 0).toLocaleString('en-US')} out` : ''}`,
        t.after ? `**Built on:** ${t.after}` : '',
        t.error ? `**Error:** ${t.error}` : '',
      ].filter(Boolean).join('  \n'),
      '## Task',
      fence(t.task),
      t.context ? details('Context', fence(t.context)) : '',
      t.snapshotNote ? `_${t.snapshotNote}_` : '',
      '## Run',
    ];
    let log = '';
    try {
      log = fs.readFileSync(path.join(t.dir, 'log.jsonl'), 'utf-8');
    } catch {
      out.push(t.status === 'queued' ? '_Not started yet._' : '_No log._');
    }
    type Block = { type?: string; text?: string; thinking?: string; name?: string; input?: Record<string, unknown>; content?: unknown; is_error?: boolean };
    const other: string[] = [];
    for (const line of log.split('\n')) {
      if (!line.trim()) continue;
      let ev: { type?: string; subtype?: string; model?: string; permissionMode?: string; claude_code_version?: string; message?: { content?: Block[] | string }; result?: string; num_turns?: number };
      try {
        ev = JSON.parse(line);
      } catch {
        other.push(line);
        continue;
      }
      if (ev.type === 'system' && ev.subtype === 'init') {
        out.push(`_Claude Code ${ev.claude_code_version ?? '?'} · ${ev.model ?? '?'} · ${ev.permissionMode ?? '?'} mode_`);
      } else if (ev.type === 'assistant' && Array.isArray(ev.message?.content)) {
        for (const c of ev.message!.content as Block[]) {
          if (c.type === 'text' && c.text?.trim()) out.push(c.text.trim());
          else if (c.type === 'thinking' && c.thinking?.trim()) out.push(details('Thinking', fence(clip(c.thinking.trim(), 4000))));
          else if (c.type === 'tool_use') out.push(`**${c.name}**${toolHead(c.input ?? {})}`, toolBody(c.name ?? '', c.input ?? {}));
        }
      } else if (ev.type === 'user' && Array.isArray(ev.message?.content)) {
        for (const c of ev.message!.content as Block[]) {
          if (c.type !== 'tool_result') continue;
          const text = typeof c.content === 'string'
            ? c.content
            : Array.isArray(c.content)
              ? (c.content as Block[]).map((x) => (x.type === 'text' ? x.text ?? '' : `[${x.type}]`)).join('\n')
              : '';
          const lines = text.split('\n').length;
          out.push(details(`${c.is_error ? 'Error' : 'Result'} · ${lines} line${lines === 1 ? '' : 's'}`, fence(clip(text, 3000))));
        }
      } else if (ev.type === 'result') {
        out.push(`_Run ended: ${ev.subtype ?? '?'} after ${ev.num_turns ?? '?'} turns._`);
      }
    }
    if (other.length) out.push(details('Other output', fence(clip(other.join('\n'), 3000))));
    if (t.report) out.push('## Report', t.report.trim());
    if (t.stat) out.push('## Changes', fence(t.stat), t.patchFile ? `Patch: \`${t.patchFile}\`` : '');
    if (t.sideEffects?.length) out.push(`_Left out as side effects of commands: ${t.sideEffects.slice(0, 20).join(', ')}${t.sideEffects.length > 20 ? ', …' : ''}_`);
    if (t.status === 'running') out.push('---', '_Still running — this view updates as it goes._');
    return out.filter(Boolean).join('\n\n') + '\n';
  }

  /** The repository a task works on: the window's first folder's git top level. */
  private async repoRoot(): Promise<string> {
    const folder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (!folder) throw new Error('This window has no folder open.');
    try {
      return (await git(folder, ['rev-parse', '--show-toplevel'])).trim();
    } catch {
      throw new Error(`${folder} is not in a git repository — agent tasks work on a worktree of one.`);
    }
  }

  /** One snapshot at a time per repository: three tasks at once must not triple the work. */
  private readonly snapshotLocks = new Map<string, Promise<unknown>>();

  /**
   * HEAD + uncommitted changes, without touching the user's index: tracked
   * changes (except LFS-managed files) and untracked files within the budgets
   * above (.gitignore respected). Returns the commit and a note of what was left
   * out.
   */
  private async snapshot(repo: string, dir: string, include: string[]): Promise<{ commit: string; note?: string; copied?: string }> {
    const prev = this.snapshotLocks.get(repo) ?? Promise.resolve();
    const run = prev.catch(() => undefined).then(() => this.snapshotNow(repo, dir, include));
    this.snapshotLocks.set(repo, run);
    try {
      return await run;
    } finally {
      if (this.snapshotLocks.get(repo) === run) this.snapshotLocks.delete(repo);
    }
  }

  private async snapshotNow(repo: string, dir: string, include: string[]): Promise<{ commit: string; note?: string; copied?: string }> {
    const T = { timeoutMs: SNAPSHOT_GIT_TIMEOUT_MS };
    const head = (await git(repo, ['rev-parse', '--verify', 'HEAD']).catch(() => '')).trim();
    if (!head) throw new Error('The repository has no commits yet — agent tasks start from one.');
    // Every worktree is a full checkout of HEAD (LFS files stay pointers): refuse a huge one.
    const sizes = await git(repo, ['ls-tree', '-r', '-l', '-z', 'HEAD'], undefined, T);
    let checkout = 0;
    for (const entry of sizes.split('\0')) {
      const n = Number(entry.split(/\s+/)[3]);
      if (Number.isFinite(n)) checkout += n;
    }
    if (checkout > CHECKOUT_MAX_BYTES) {
      throw new Error(`A checkout of this repository's tracked files is ${(checkout / 1024 ** 3).toFixed(1)} GB — too big to copy for an agent task (limit ${CHECKOUT_MAX_BYTES / 1024 ** 3} GB).`);
    }
    const index = path.join(dir, 'index');
    const real = path.resolve(repo, (await git(repo, ['rev-parse', '--git-path', 'index'])).trim());
    if (fs.existsSync(real)) fs.copyFileSync(real, index);
    const env = { GIT_INDEX_FILE: index, GIT_LITERAL_PATHSPECS: '1', ...IDENTITY };
    const lfs = async (paths: string[]): Promise<Set<string>> => {
      if (paths.length === 0) return new Set();
      const out = await git(repo, ['check-attr', '-z', '--stdin', 'filter'], undefined, { ...T, input: paths.join('\0') + '\0' });
      const parts = out.split('\0');
      const hit = new Set<string>();
      for (let i = 0; i + 2 < parts.length; i += 3) if (parts[i + 2] === 'lfs') hit.add(parts[i]);
      return hit;
    };
    const addPaths = async (paths: string[], force = false) => {
      for (let i = 0; i < paths.length; i += 500) {
        await git(repo, ['add', '-A', ...(force ? ['-f'] : []), '--pathspec-from-file=-', '--pathspec-file-nul'], env, { ...T, input: paths.slice(i, i + 500).join('\0') });
      }
    };
    const notes: string[] = [];

    // Tracked changes (modified, deleted), minus LFS-managed files.
    const changed = (await gitPaths(repo, ['diff', '--name-only', '-z', 'HEAD'], 100_000)).paths;
    const lfsChanged = await lfs(changed);
    await addPaths(changed.filter((p) => !lfsChanged.has(p)));
    if (lfsChanged.size) notes.push(`${lfsChanged.size} modified Git LFS file(s) (e.g. ${[...lfsChanged][0]}) — the copy has their committed version`);

    // Untracked files, by top-level group (a folder, or a file at the root), smallest
    // groups first, each taken whole or not at all — a scratch folder full of files
    // must not crowd out the few that matter, nor be half-copied.
    const scan = await gitPaths(repo, ['ls-files', '-z', '--others', '--exclude-standard'], UNTRACKED_SCAN_MAX);
    const lfsUntracked = await lfs(scan.paths.slice(0, 20_000));
    const groups = new Map<string, { files: string[]; bytes: number }>();
    let dropped = 0;
    let droppedBytes = 0;
    for (const p of scan.paths) {
      let size = 0;
      try {
        size = fs.lstatSync(path.join(repo, p)).size;
      } catch {
        continue;
      }
      if (lfsUntracked.has(p) || size > UNTRACKED_FILE_MAX) {
        dropped++;
        droppedBytes += size;
        continue;
      }
      const key = p.includes('/') ? `${p.split('/')[0]}/` : p;
      const g = groups.get(key) ?? { files: [], bytes: 0 };
      g.files.push(p);
      g.bytes += size;
      groups.set(key, g);
    }
    const take: string[] = [];
    let total = 0;
    const left: Array<[string, number, number]> = [];
    for (const [key, g] of [...groups.entries()].sort((a, b) => a[1].bytes - b[1].bytes || a[1].files.length - b[1].files.length)) {
      if (total + g.bytes <= UNTRACKED_TOTAL_MAX && take.length + g.files.length <= UNTRACKED_COUNT_MAX) {
        take.push(...g.files);
        total += g.bytes;
      } else {
        left.push([key, g.files.length, g.bytes]);
      }
    }
    await addPaths(take);
    if (dropped || left.length || scan.truncated) {
      const parts: string[] = [];
      if (left.length) {
        parts.push(
          left
            .sort((a, b) => b[2] - a[2])
            .slice(0, 4)
            .map(([k, n, b]) => `${k} (${n.toLocaleString('en-US')} file${n === 1 ? '' : 's'}, ${(b / 1024 ** 2).toFixed(1)} MB)`)
            .join(', ') + (left.length > 4 ? ` and ${left.length - 4} more` : '')
        );
      }
      if (dropped) parts.push(`${dropped} large or LFS file(s), ${(droppedBytes / 1024 ** 3).toFixed(droppedBytes > 1024 ** 3 ? 1 : 3)} GB`);
      if (scan.truncated) parts.push(`and more — over ${UNTRACKED_SCAN_MAX.toLocaleString('en-US')} untracked paths, the rest not looked at`);
      notes.push(
        `untracked ${parts.join('; ')} — over the snapshot budget (${UNTRACKED_FILE_MAX / 1024 ** 2} MB a file, ` +
          `${UNTRACKED_TOTAL_MAX / 1024 ** 2} MB and ${UNTRACKED_COUNT_MAX.toLocaleString('en-US')} files in all); gitignore scratch data to keep it out`
      );
    }
    // Paths asked for by name, gitignored or not: each taken whole within its own budget, or not at all.
    let copied: string | undefined;
    if (include.length) {
      const files: string[] = [];
      let bytes = 0;
      const refused: string[] = [];
      for (const rel of include) {
        const found: string[] = [];
        let size = 0;
        let over = false;
        const walk = (r: string): void => {
          if (over) return;
          const st = fs.lstatSync(path.join(repo, r));
          if (st.isDirectory()) {
            if (path.basename(r) !== '.git') for (const name of fs.readdirSync(path.join(repo, r))) walk(path.join(r, name));
          } else if (st.size > UNTRACKED_FILE_MAX) {
            over = true;
          } else {
            found.push(r.split(path.sep).join('/'));
            size += st.size;
            over = files.length + found.length > INCLUDE_COUNT_MAX || bytes + size > INCLUDE_TOTAL_MAX;
          }
        };
        try {
          walk(rel);
        } catch {
          refused.push(`${rel} (not readable)`);
          continue;
        }
        if (over) refused.push(`${rel} (over the budget)`);
        else {
          files.push(...found);
          bytes += size;
        }
      }
      const lfsIncluded = await lfs(files);
      const take = files.filter((f) => !lfsIncluded.has(f));
      await addPaths(take, true);
      const size = bytes < 1024 ** 2 ? `${Math.ceil(bytes / 1024)} KB` : `${(bytes / 1024 ** 2).toFixed(1)} MB`;
      if (take.length) copied = `Copied in by name: ${take.length} file${take.length === 1 ? '' : 's'}, ${size}`;
      if (lfsIncluded.size) refused.push(`${lfsIncluded.size} Git LFS file(s)`);
      if (refused.length) {
        notes.push(
          `asked-for paths ${refused.join(', ')} — ${UNTRACKED_FILE_MAX / 1024 ** 2} MB a file, ` +
            `${INCLUDE_TOTAL_MAX / 1024 ** 2} MB and ${INCLUDE_COUNT_MAX.toLocaleString('en-US')} files in all; name the files that matter`
        );
      }
    }
    const tree = (await git(repo, ['write-tree'], env, T)).trim();
    const commit = (await git(repo, ['commit-tree', tree, '-p', head, '-m', 'agent task base (HEAD + uncommitted changes)'], env, T)).trim();
    return { commit, note: notes.length ? `Left out of the worker's copy: ${notes.join('; ')}.` : undefined, copied };
  }

  /**
   * Creates a task. With `after`, it builds on that task's result (its tree,
   * not the user's) and waits for it if it is still running; otherwise it starts
   * from a snapshot of the user's repo. Starts at once when a slot is free.
   */
  async start(
    worker: string,
    task: string,
    context?: string,
    after?: string,
    include: string[] = []
  ): Promise<{ id: string; queued: boolean; note?: string }> {
    if (!(await this.spec(worker))) throw new Error(`"${worker}" is not enabled for agent tasks.`);
    if (after && include.length) throw new Error('`include` is for tasks that start from the repo; a chained task has what the task before it had.');
    let pred: Task | undefined;
    if (after) {
      pred = this.tasks.get(after);
      if (!pred) throw new Error(`No task ${after} in this window.`);
      if (pred.status === 'failed' || pred.status === 'cancelled') throw new Error(`Task ${after} ${pred.status} — nothing to build on.`);
    }
    const id = `t${Date.now().toString(36)}${crypto.randomBytes(2).toString('hex')}`;
    const dir = path.join(this.root(), id);
    fs.mkdirSync(path.join(dir, 'config'), { recursive: true, mode: 0o700 });
    const repo = pred ? pred.repo : await this.repoRoot();
    const t: Task = {
      id, worker, task, context, after, status: 'queued', dir, repo, base: '', worktree: path.join(dir, 'worktree'),
      started: Date.now(), turns: 0, toolUses: 0, written: new Set(), waiters: [],
    };
    const notes: string[] = [];
    const refused: string[] = [];
    if (!pred) {
      // Asked for by name, plus files the task names by absolute path (often gitignored scratch).
      const wanted = new Set<string>();
      for (const entry of include) {
        const rel = path.relative(repo, path.resolve(repo, entry));
        if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) refused.push(`${entry} (outside the repository)`);
        else if (!fs.existsSync(path.join(repo, rel))) refused.push(`${entry} (not found)`);
        else wanted.add(rel);
      }
      for (const rel of mentionedFiles(repo, `${task}\n${context ?? ''}`)) wanted.add(rel);
      const snap = await this.snapshot(repo, dir, [...wanted]);
      t.base = snap.commit;
      t.snapshotNote = snap.note;
      if (refused.length) notes.push(`Not copied: ${refused.join(', ')}.`);
      if (snap.copied) notes.push(`${snap.copied}.`);
      if (snap.note) {
        notes.push(snap.note);
        log(`agent task ${id}: ${snap.note}`);
      }
    } else {
      t.snapshotNote = pred.snapshotNote;
    }
    this.tasks.set(id, t);
    log(`agent task ${id}: queued on ${worker}${after ? ` after ${after}` : ''}`);
    await this.promote();
    return { id, queued: t.status === 'queued', note: notes.length ? notes.join(' ') : undefined };
  }

  /** Starts queued tasks whose predecessor is done, while slots are free; fails those whose predecessor didn't finish. */
  private async promote(): Promise<void> {
    for (const t of [...this.tasks.values()].filter((x) => x.status === 'queued').sort((a, b) => a.started - b.started)) {
      const pred = t.after ? this.tasks.get(t.after) : undefined;
      if (pred && (pred.status === 'failed' || pred.status === 'cancelled')) {
        t.status = 'failed';
        t.error = `its predecessor ${pred.id} ${pred.status}`;
        t.ended = Date.now();
        for (const w of t.waiters.splice(0)) w();
        continue;
      }
      if (pred && pred.status !== 'done') continue;
      if ([...this.tasks.values()].filter((x) => x.status === 'running').length >= MAX_RUNNING) return;
      if (pred) t.base = pred.result ?? pred.base;
      try {
        await this.launch(t);
      } catch (err) {
        t.status = 'failed';
        t.error = (err as Error).message;
        t.ended = Date.now();
        log(`agent task ${t.id}: could not start — ${t.error}`);
        for (const w of t.waiters.splice(0)) w();
      }
    }
    this.render();
  }

  private async launch(t: Task): Promise<void> {
    const spec = await this.spec(t.worker);
    if (!spec) throw new Error(`"${t.worker}" is no longer enabled for agent tasks.`);
    const config = path.join(t.dir, 'config');
    // LFS files stay pointers: a checkout must not copy their content (10,861 of them in one repo).
    await git(t.repo, ['worktree', 'add', '--detach', t.worktree, t.base], { GIT_LFS_SKIP_SMUDGE: '1' }, { timeoutMs: SNAPSHOT_GIT_TIMEOUT_MS });
    t.links = [];
    for (const name of DEP_DIRS) {
      const from = path.join(t.repo, name);
      const to = path.join(t.worktree, name);
      try {
        if (!fs.statSync(from).isDirectory() || fs.existsSync(to)) continue;
        await git(t.repo, ['check-ignore', '-q', name]); // throws unless ignored
        fs.symlinkSync(from, to, 'dir');
        t.links.push(name);
      } catch {
        /* not there, not ignored, or not linkable */
      }
    }
    if (t.links.length) log(`agent task ${t.id}: linked ${t.links.join(', ')} from the repo`);
    fs.writeFileSync(path.join(config, 'settings.json'), JSON.stringify(spec.settings, null, 2), { mode: 0o600 });
    // Workers can consult: the workers server with the restricted token (delegate, list_workers, provider_usage).
    const access = this.access?.();
    fs.writeFileSync(
      path.join(config, '.claude.json'),
      JSON.stringify({
        hasCompletedOnboarding: true,
        projects: { [t.worktree]: { hasTrustDialogAccepted: true } },
        ...(spec.approveKeyTail && { customApiKeyResponses: { approved: [spec.approveKeyTail], rejected: [] } }),
        ...(access && {
          mcpServers: {
            [CONSULT_SERVER]: { type: 'http', url: access.url, headers: { Authorization: `Bearer ${access.token}` }, timeout: MCP_CALL_TIMEOUT_MS },
          },
        }),
      }),
      { mode: 0o600 }
    );
    t.status = 'running';
    t.started = Date.now();
    // The lead names files by their real paths; the worker must read and edit its copy.
    const repoPath = new RegExp(`${escapeRegExp(t.repo)}(?=[/\\s\`'")\\]]|$)`, 'g');
    const local = (s: string) => s.replace(repoPath, t.worktree);
    const prompt =
      `${RUN_INSTRUCTIONS}${access ? CONSULT_INSTRUCTIONS : ''}` +
      ' Git LFS files in this copy are pointer files, not their content.' +
      (t.snapshotNote ? ` ${t.snapshotNote}` : '') +
      `\n\n<task>\n${local(t.task)}\n</task>` +
      (t.context ? `\n\n<context>\n${local(t.context)}\n</context>` : '');
    const args = [
      '-p', prompt, '--model', spec.runModel, '--permission-mode', 'auto',
      '--output-format', 'stream-json', '--verbose', '--no-session-persistence', '--max-turns', String(MAX_TURNS),
      // Consulting is answers-only and already consented to: no classifier check per call.
      ...(access ? ['--allowedTools', ...CONSULT_TOOLS.map((n) => `mcp__${CONSULT_SERVER}__${n}`)] : []),
    ];
    // Only the run's own config and provider: none of this window's account or provider leaks in.
    const env: NodeJS.ProcessEnv = { ...process.env };
    for (const k of Object.keys(env)) if (k.startsWith('ANTHROPIC_') || k === 'CLAUDE_CONFIG_DIR') delete env[k];
    Object.assign(env, spec.secretEnv, { CLAUDE_CONFIG_DIR: config, PYTHONDONTWRITEBYTECODE: '1' });
    // The Claude Code extension's binary, through a login shell (see cli.ts).
    const child = spawn(process.env.SHELL || '/bin/bash', claudeShellArgs(args), {
      cwd: t.worktree,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    t.child = child;
    const out = fs.openSync(path.join(t.dir, 'log.jsonl'), 'a', 0o600);
    let buf = '';
    child.stdout!.on('data', (d: Buffer) => {
      fs.writeSync(out, d);
      buf += d.toString();
      let nl: number;
      while ((nl = buf.indexOf('\n')) >= 0) {
        this.onEvent(t, buf.slice(0, nl));
        buf = buf.slice(nl + 1);
      }
    });
    child.stderr!.on('data', (d: Buffer) => fs.writeSync(out, d));
    const wall = setTimeout(() => {
      t.error = `timed out after ${WALL_MS / 60_000} min`;
      this.kill(t);
    }, WALL_MS);
    child.on('close', (code) => {
      clearTimeout(wall);
      fs.closeSync(out);
      void this.finish(t, code);
    });
    log(`agent task ${t.id}: started on ${t.worker} (${spec.runModel}) in ${t.worktree}`);
    this.render();
  }

  private onEvent(t: Task, line: string): void {
    let ev: { type?: string; subtype?: string; permissionMode?: string; claude_code_version?: string; message?: { content?: Array<{ type?: string; text?: string; name?: string; input?: Record<string, unknown> }> }; result?: string; is_error?: boolean; num_turns?: number; total_cost_usd?: number; usage?: { input_tokens?: number; output_tokens?: number } };
    try {
      ev = JSON.parse(line);
    } catch {
      return;
    }
    if (ev.type === 'system' && ev.subtype === 'init' && ev.permissionMode !== 'auto') {
      // Headless, nobody can approve anything: outside auto mode every edit is denied
      // and the run only burns turns. Some versions fall back to "default" quietly.
      t.error =
        `Claude Code ${ev.claude_code_version ?? '(unknown version)'} started the run in "${ev.permissionMode ?? '?'}" ` +
        'permission mode, not auto, so it could not edit anything. Update Claude Code (the Claude Code extension, ' +
        "or the `claude` on PATH where that extension isn't installed).";
      log(`agent task ${t.id}: ${t.error}`);
      this.kill(t);
      return;
    }
    if (ev.type === 'assistant') {
      t.turns++;
      for (const c of ev.message?.content ?? []) {
        if (c.type === 'tool_use') {
          t.toolUses++;
          const arg = c.input?.command ?? c.input?.file_path ?? c.input?.pattern ?? '';
          t.lastAction = `${c.name} ${String(arg).slice(0, 80)}`.trim();
          const file = c.input?.file_path ?? c.input?.notebook_path;
          if (typeof file === 'string' && /^(Write|Edit|MultiEdit|NotebookEdit)$/.test(c.name ?? '')) {
            const rel = path.relative(t.worktree, path.resolve(t.worktree, file));
            if (!rel.startsWith('..')) t.written.add(rel.split(path.sep).join('/'));
          }
        }
      }
      this.render();
    } else if (ev.type === 'result') {
      t.report = ev.result;
      t.costUsd = ev.total_cost_usd;
      t.inTok = ev.usage?.input_tokens;
      t.outTok = ev.usage?.output_tokens;
      if (ev.is_error && !t.error) t.error = 'the run ended with an error';
    }
  }

  private async finish(t: Task, code: number | null): Promise<void> {
    // The dependency links go first: they're the user's folders, never the task's changes.
    for (const name of t.links ?? []) {
      try {
        const link = path.join(t.worktree, name);
        if (fs.lstatSync(link).isSymbolicLink()) fs.unlinkSync(link);
      } catch {
        /* already gone */
      }
    }
    try {
      await git(t.worktree, ['add', '-A']);
      // Changes to files that existed land; new files only if the worker wrote
      // them with its file tools — a cache or build output from its own checks
      // (e.g. __pycache__) is reported, not applied.
      const status = (await git(t.worktree, ['diff', '--cached', '--name-status', '--no-renames', t.base])).trim().split('\n').filter(Boolean);
      const included: string[] = [];
      t.sideEffects = [];
      for (const line of status) {
        const [code, file] = line.split('\t');
        if (code === 'A' && !t.written.has(file)) t.sideEffects.push(file);
        else included.push(file);
      }
      t.files = included;
      const spec = included.length > 0 ? ['--', ...included] : null;
      const patch = spec ? await git(t.worktree, ['diff', '--cached', '--binary', '--no-renames', t.base, ...spec]) : '';
      t.stat = spec ? (await git(t.worktree, ['diff', '--cached', '--stat', '--no-renames', t.base, ...spec])).trim() : '';
      if (patch.trim()) {
        t.patchFile = path.join(t.dir, 'changes.patch');
        fs.writeFileSync(t.patchFile, patch, { mode: 0o600 });
        // The result as a commit (base + included changes only), for tasks chained after this one.
        const index = path.join(t.dir, 'result-index');
        const env = { GIT_INDEX_FILE: index, ...IDENTITY };
        await git(t.repo, ['read-tree', t.base], env);
        await git(t.repo, ['apply', '--cached', '--binary', t.patchFile], env);
        const tree = (await git(t.repo, ['write-tree'], env)).trim();
        t.result = (await git(t.repo, ['commit-tree', tree, '-p', t.base, '-m', `agent task ${t.id} result`], env)).trim();
        fs.rmSync(index, { force: true });
      } else {
        t.result = t.base;
      }
    } catch (err) {
      t.error = t.error ?? `collecting changes failed: ${(err as Error).message}`;
    }
    try {
      await git(t.repo, ['worktree', 'remove', '--force', t.worktree]);
    } catch (err) {
      log(`agent task ${t.id}: worktree removal failed — ${(err as Error).message}`);
    }
    fs.rmSync(path.join(t.dir, 'config'), { recursive: true, force: true }); // the run's settings
    fs.rmSync(path.join(t.dir, 'index'), { force: true });
    if (t.status === 'running') t.status = t.error || (code !== 0 && !t.report) ? 'failed' : 'done';
    t.ended = Date.now();
    t.child = undefined;
    log(`agent task ${t.id}: ${t.status} in ${Math.round((t.ended - t.started) / 1000)} s, ${t.turns} turns, ${t.files?.length ?? 0} files changed`);
    this.onTaskDone?.(t.worker, t.inTok ?? 0, t.outTok ?? 0);
    this.render();
    for (const w of t.waiters.splice(0)) w();
    await this.promote(); // a slot is free, and tasks chained on this one may start
  }

  private kill(t: Task): void {
    const c = t.child;
    if (!c?.pid) return;
    c.kill('SIGTERM');
    setTimeout(() => c.exitCode === null && c.kill('SIGKILL'), 5000);
  }

  cancel(id: string): string {
    const t = this.tasks.get(id);
    if (!t) return `No task ${id}.`;
    if (t.status === 'queued') {
      t.status = 'cancelled';
      t.ended = Date.now();
      for (const w of t.waiters.splice(0)) w();
      void this.promote(); // tasks chained on it fail now
      return `Cancelled ${id} before it started.`;
    }
    if (t.status !== 'running') return `Task ${id} already ${t.status}.`;
    t.status = 'cancelled';
    this.kill(t);
    return `Cancelling ${id}; its changes so far are still collected.`;
  }

  /** Waits up to `seconds` for the task to end; then reports where it is. */
  async wait(id: string, seconds: number): Promise<{ text: string; isError?: boolean }> {
    const t = this.tasks.get(id);
    if (!t) return { text: `No task ${id} in this window.`, isError: true };
    if (t.status === 'running' || t.status === 'queued') {
      await new Promise<void>((resolve) => {
        // At most 240 s: the whole MCP call must end inside Claude Code's 5-minute idle limit.
        const timer = setTimeout(resolve, Math.min(Math.max(seconds, 1), 240) * 1000);
        t.waiters.push(() => {
          clearTimeout(timer);
          resolve();
        });
      });
    }
    const secs = Math.round(((t.ended ?? Date.now()) - t.started) / 1000);
    if (t.status === 'queued') {
      return { text: `Task ${id} is queued${t.after ? ` — it starts when ${t.after} is done` : ' — waiting for a free slot'}. Call wait_task again.` };
    }
    if (t.status === 'running') {
      return { text: `Task ${id} is still running (${secs} s, ${t.turns} turns, ${t.toolUses} tool calls; last: ${t.lastAction ?? '—'}). Call wait_task again.` };
    }
    let diff = '';
    if (t.patchFile) {
      const full = fs.readFileSync(t.patchFile, 'utf-8');
      diff = full.length > MAX_DIFF_IN_RESULT ? `${full.slice(0, MAX_DIFF_IN_RESULT)}\n… (truncated — full patch: ${t.patchFile})` : full;
    }
    return {
      text: [
        `Task ${id}: ${t.status}${t.error ? ` (${t.error})` : ''} — ${t.worker}, ${secs} s, ${t.turns} turns${t.costUsd !== undefined ? `, ~$${t.costUsd.toFixed(3)} by Claude Code's estimate` : ''}.` +
          (t.after ? ` Built on ${t.after}.` : '') +
          (t.snapshotNote ? `\n${t.snapshotNote}` : ''),
        `\nWorker's report:\n${t.report ?? '(none)'}`,
        t.patchFile
          ? `\nChanges (against ${t.after ? `the result of ${t.after}` : "HEAD + the user's uncommitted changes at start"}):\n${t.stat}\n\n${diff}`
          : '\nNo file changes.',
        t.sideEffects?.length
          ? `\nCreated by commands, NOT included (build output, caches…): ${t.sideEffects.slice(0, 20).join(', ')}${t.sideEffects.length > 20 ? ` and ${t.sideEffects.length - 20} more` : ''}.`
          : '',
        t.patchFile ? `\nReview the diff; if it should land, call apply_task_changes with task_id "${id}".` : '',
      ].join('\n'),
      isError: t.status === 'failed',
    };
  }

  /** The chain ending at `t`, oldest first. */
  private chain(t: Task): Task[] {
    const out: Task[] = [t];
    let cur = t;
    while (cur.after) {
      const prev = this.tasks.get(cur.after);
      if (!prev) break;
      out.unshift(prev);
      cur = prev;
    }
    return out;
  }

  /**
   * Applies a finished task's changes to the user's working tree (not the
   * index), after a dry run. For a chained task, everything in its chain that
   * isn't applied yet comes along — its own diff alone builds on changes the
   * tree doesn't have.
   */
  async apply(id: string): Promise<{ text: string; isError?: boolean }> {
    const t = this.tasks.get(id);
    if (!t) return { text: `No task ${id} in this window.`, isError: true };
    if (t.status !== 'done') return { text: `Task ${id} is ${t.status}; only a finished task can be applied.`, isError: true };
    if (t.applied) return { text: `Task ${id} was already applied.`, isError: true };
    const chain = this.chain(t);
    const lastApplied = chain.map((x) => Boolean(x.applied)).lastIndexOf(true);
    const pending = chain.slice(lastApplied + 1);
    const notDone = pending.find((x) => x.status !== 'done' || !x.result);
    if (notDone) return { text: `Task ${notDone.id} in this chain is ${notDone.status}; it can't be applied.`, isError: true };
    const from = lastApplied >= 0 ? chain[lastApplied].result! : chain[0].base;
    const patch = await git(t.repo, ['diff', '--binary', from, t.result!]);
    if (!patch.trim()) {
      pending.forEach((x) => (x.applied = true));
      return { text: `Nothing to apply: ${pending.map((x) => x.id).join(', ')} changed no files.` };
    }
    const file = path.join(t.dir, pending.length > 1 ? 'chain.patch' : 'apply.patch');
    fs.writeFileSync(file, patch, { mode: 0o600 });
    try {
      await git(t.repo, ['apply', '--check', '--whitespace=nowarn', file]);
    } catch (err) {
      return {
        text: `The changes no longer apply cleanly (the files changed since the task started): ${(err as Error).message}\nThe patch is at ${file}.`,
        isError: true,
      };
    }
    await git(t.repo, ['apply', '--whitespace=nowarn', file]);
    pending.forEach((x) => (x.applied = true));
    const files = (await git(t.repo, ['diff', '--name-only', from, t.result!])).trim().split('\n').filter(Boolean);
    log(`agent task ${id}: applied to ${t.repo} (${pending.map((x) => x.id).join(' → ')}, ${files.length} files)`);
    return {
      text: `Applied ${pending.length > 1 ? `the chain ${pending.map((x) => x.id).join(' → ')}` : `task ${id}`} to the working tree (not staged): ${files.join(', ')}.`,
    };
  }

  /** For the status bar's menu. */
  async showInteractive(): Promise<void> {
    const all = [...this.tasks.values()].sort((a, b) => b.started - a.started);
    if (all.length === 0) {
      vscode.window.showInformationMessage('No agent tasks in this window.');
      return;
    }
    const pick = await vscode.window.showQuickPick(
      all.map((t) => ({
        label: `${t.status === 'running' ? '$(sync~spin)' : t.status === 'queued' ? '$(clock)' : t.status === 'done' ? '$(check)' : '$(error)'} ${t.id} · ${t.worker}`,
        description: `${t.status}${t.applied ? ', applied' : ''} · ${t.turns} turns · ${t.files?.length ?? 0} files`,
        detail: t.task.slice(0, 140),
        t,
      })),
      { title: 'Agent tasks in this window' }
    );
    if (!pick) return;
    const action = await vscode.window.showQuickPick(
      [
        { label: '$(book) Open transcript', a: 'transcript' },
        { label: '$(output) Open raw log', a: 'log' },
        ...(pick.t.patchFile ? [{ label: '$(diff) Open patch', a: 'patch' }] : []),
        ...(pick.t.status === 'running' || pick.t.status === 'queued' ? [{ label: '$(stop) Cancel', a: 'cancel' }] : []),
      ],
      { title: pick.t.id }
    );
    if (action?.a === 'cancel') vscode.window.showInformationMessage(this.cancel(pick.t.id));
    else if (action?.a === 'transcript') await vscode.commands.executeCommand('claudeProfiles.showAgentTaskTranscript', pick.t.id);
    else if (action) {
      const file = action.a === 'log' ? path.join(pick.t.dir, 'log.jsonl') : pick.t.patchFile!;
      await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(file), { preview: true });
    }
  }

  dispose(): void {
    // The window is going away mid-task: stop the run and take its worktree out
    // of the user's repo now — nothing will be left to collect it later.
    for (const t of this.tasks.values()) {
      if (t.status !== 'running') continue;
      t.child?.kill('SIGKILL');
      for (const name of t.links ?? []) {
        try {
          fs.unlinkSync(path.join(t.worktree, name)); // the user's own folders: unlink, never recurse
        } catch {
          /* gone */
        }
      }
      try {
        execFileSync('git', ['worktree', 'remove', '--force', t.worktree], { cwd: t.repo, stdio: 'ignore' });
      } catch {
        /* best effort */
      }
    }
    this.onDidChange.dispose();
  }
}
