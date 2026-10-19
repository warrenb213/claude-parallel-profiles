# Claude Parallel Accounts

[![CI](https://img.shields.io/github/actions/workflow/status/DercasDrol/claude-parallel-profiles/ci.yml?label=CI)](https://github.com/DercasDrol/claude-parallel-profiles/actions)
[![Platform: Linux](https://img.shields.io/badge/platform-Linux%20%7C%20WSL%20%7C%20SSH-orange.svg)](#requirements)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

**A companion for the [Claude Code extension for VS Code](https://marketplace.visualstudio.com/items?itemName=anthropic.claude-code): run a different Claude account in each VSCode window, at the same time — with one shared conversation history.**

**[⬇️ Install from the Marketplace](https://marketplace.visualstudio.com/items?itemName=DercasDrol.claude-parallel-accounts)** · **[🐙 Source](https://github.com/DercasDrol/claude-parallel-profiles)** · **[🐛 Report an issue](https://github.com/DercasDrol/claude-parallel-profiles/issues)**

Claude Code signs you into **one** account, shared by every VSCode window. If you juggle several — personal, work, a second Pro for when the first hits its limits — this extension gives **each window its own account**: pick it once per window, and your conversations follow you across accounts instead of disappearing.

ℹ️ It's a **companion**, not a replacement: the official Claude Code extension must be installed; this one only controls which account each window uses.

> 🐧 **Linux only (for now).** Built and tested on Linux: desktop VSCode on Linux, **WSL**, **Remote-SSH** to a Linux host, and dev containers. The check happens where the extension actually runs — in a WSL/SSH window that's the *remote* side — so a Windows desktop driving a Linux remote is fully supported. On macOS and native Windows the Marketplace doesn't offer the extension at all, and a side-loaded VSIX stays completely **inert**: no files read or written, no accounts touched — the status bar says why. (Reason: Claude Code stores credentials differently there, e.g. the macOS Keychain, and guessing would be worse than declining.)

---

## The idea in 30 seconds

- **Sign in as usual** — through Claude Code's own UI (its account menu; `/login` in the chat works too). The extension notices and saves the account by itself — nothing extra to click, no names to invent: the account *is* its email.
- **Each window picks its account** from the status bar. Two windows run two accounts simultaneously — no logout/login dance, no cross-contamination. The window's integrated terminals get the same account.
- **Switching reloads the window** — required, not cosmetic: Claude Code reads its account once at start-up, so only a reload makes it both *show* and *bill* the account you picked.
- **History stays one whole.** Giving each window its own data directory would scatter your chats across them, so the extension keeps them in one store instead — your history is exactly the single history Claude Code always had. Hit a usage limit, switch account, *continue the same conversation*.
- **Forget really signs out.** Forgetting an account deletes its OAuth token from every copy on this machine and stops sessions running on it. The data directories stay — signing in again restores everything.
- **Uninstalling really cleans up.** Your history is consolidated back into the default `~/.claude`, your last account is handed back to Claude Code (still signed in), and every folder the extension made is deleted — no tokens left lying around.

> ⭐ **Enjoying it?** [Rate it on the Marketplace](https://marketplace.visualstudio.com/items?itemName=DercasDrol.claude-parallel-accounts&ssr=false#review-details) — it helps other developers discover it.

---

## Requirements

| Requirement | Notes |
| --- | --- |
| Linux environment | desktop Linux, WSL, Remote-SSH (Linux host), or a dev container |
| VSCode ≥ 1.85 | the extension installs into the (remote) Linux side |
| [Claude Code extension](https://marketplace.visualstudio.com/items?itemName=anthropic.claude-code) | the thing being multiplied |
| `claude` CLI on `$PATH` | asked read-only whether a directory is signed in |

---

## Quick start

1. **Install** from the [Marketplace](https://marketplace.visualstudio.com/items?itemName=DercasDrol.claude-parallel-accounts) (search "Claude Parallel Accounts").
2. **You're probably already signed in** — the status bar shows your email, and the account is saved automatically.
3. **Add the second account**: in Claude Code, sign in as the other account (its account menu — or `/login` in the chat). The extension saves it and reloads the window onto it — the previous account stays in the list.
4. **Assign accounts to windows**: status bar → **Switch account**. Open another window for another project, give it the other account — both run in parallel.

---

## Daily use

**The status bar item** — `👤 you@example.com` is the account **this window** runs as, confirmed against the real token (`claude auth status`), not just a label. **Click** it and the one action that makes sense right now happens directly: switch when there are other accounts, pick a saved account when the window is signed out, save when the account is new. **Hover** it for the full card — account details, switch/forget actions, and quick links to the extension page, its settings and its log.

**Switching** reloads the window; after the reload both the identity Claude Code shows and the token it bills are the ones you picked.

**Signing in as another account inside a window** (Claude Code's account menu, or `/login`) replaces only *that window's* account. The extension saves the new account, keeps the old one in the list, and reloads the window so Claude Code actually switches to it — other windows are untouched.

**Reopening a project** — the extension remembers which account each repository used last and restores it automatically (the tooltip says so).

**One account, one entry** — saving the same email twice reuses the existing entry; lists are collapsed by email, so you always see one row per account.

**Forgetting** (status bar hover → *Forget…*) asks for confirmation, then removes the account from the list, **deletes its OAuth token from every copy on this machine**, interrupts Claude sessions running on it, and reloads any window that was using it (that window then offers to switch to another saved account). History, settings and the data folders stay on disk; signing in again brings the account back.

**Signing out** (Claude Code's account menu, or `/logout`) revokes the token on Anthropic's side — for every copy of it. The extension notices and removes the account from the list everywhere, since switching to it could only fail.

**Switching provider** (status bar hover → *Switch provider*, or *Claude Accounts: Switch Provider for This Window*) changes where this window's requests go and who pays for them, without changing the account: same history, settings and project trust. There are three kinds:

- **Anthropic** — the default for every window: the account's own login, whatever kind it is. A claude.ai plan (Pro, Max, Team, Enterprise) or a Console API key from `/login`; the menu shows which (e.g. *Team plan · Acme*, *Max plan*, *Console API key*). **To go back to Anthropic from anything else, pick this.**
- **Anthropic API key** — a key from [console.anthropic.com](https://console.anthropic.com), billed per token, without signing the account in with it. Requests go straight to Anthropic with Claude Code's usual models; nothing is rewritten or proxied. The extension approves the key for Claude Code, so its "Detected a custom API key" prompt — whose default, *No*, would silently fall back to the login — never appears.
- **Gateway** — an Anthropic-compatible endpoint with a key. Two come prebaked, so only a name and a key are asked:
  - **Poe** — Claude models on a Poe subscription (`https://api.poe.com`); its other models (GLM, Qwen…) can be added through a local proxy (see *Non-Claude models* below).
  - **Z.ai GLM Coding Plan** — GLM on Z.ai's own Anthropic-compatible endpoint (`https://api.z.ai/api/anthropic`), set up as [Z.ai documents for Claude Code](https://docs.z.ai/devpack/tool/claude): GLM in the opus/sonnet/haiku slots with its 1M context window. No proxy is involved; change the slots under *Edit or Remove a Provider → Model aliases*.
  - **Custom** — any other endpoint (a company proxy…): a base URL, and whether it takes its key as `Authorization: Bearer` or `x-api-key`.

Add an API key or a gateway with *Claude Accounts: Add a Provider*, which lists the presets first. The window reloads, the status bar shows `you@example.com · Poe`, and the Anthropic login stays saved but unused until you switch back. Each window remembers its own provider, and terminals in the window follow it. *Edit or Remove a Provider* replaces a key, renames or removes a provider, and for gateways also changes the URL or default models and turns off experimental beta headers for gateways that reject them.

**Models on a gateway** come from the gateway itself (an Anthropic API key needs none of this — Claude Code already knows Anthropic's models): its model list (`/v1/models`) is read when you add it, daily while a window uses it, and on *Refresh model list*. Only Claude models the provider serves on Claude Code's endpoint are kept, and the window is set up so that Claude Code's own model picker lists exactly those, each recognised as the model it is — thinking, effort levels and context window included — and sent under the provider's name for it (Poe's `claude-opus-4.8` is Anthropic's `claude-opus-4-8`). Each family defaults to the newest model the provider has; pick another under *Default models*. A model the provider doesn't serve, such as one chosen earlier on Anthropic, falls back to an allowed one instead of failing. Whether the provider honours thinking and effort levels is up to it: on Poe, as of this writing, thinking works, but effort levels appear to have little or no effect (Poe accepts even invalid values without error).

**Non-Claude models** (opt-in, per provider): many gateways also serve models such as Qwen, GLM or DeepSeek, but only in OpenAI's chat-completions format, which Claude Code doesn't speak. *Edit or Remove a Provider → Non-Claude models* lists the ones usable from Claude Code (text output, tool calling, and a context window of at least 200K — the window Claude Code assumes for models it doesn't know, and compacts against) and adds the ones you pick to Claude Code's model picker. Turning the first one on asks to install a local [LiteLLM](https://github.com/BerriAI/litellm) proxy (about 600 MB, into `~/.claude-windows/litellm`, with `uv` or Python 3.10–3.14), which then sits between the window and the gateway: Claude models pass through to the gateway untouched, the others are translated both ways, tool calls included. Claude Code is built for Claude; other models can use its tools, but less reliably.

- **Pinned by hash.** LiteLLM's PyPI package was hijacked in March 2026, and this proxy holds your gateway key, so it is never installed by name: every package is pinned by SHA-256 in the extension's own lockfile and installed with `--require-hashes` — a tampered download fails instead of running.
- **Local only.** One proxy per provider per host, on `127.0.0.1`, behind a random key of its own; windows hold only that key, and the gateway key lives in the proxy's memory, never in a file. LiteLLM's start-up downloads of remote configuration are switched off, so the gateway is the only thing it talks to.
- **Stops cleanly.** Turning the models off, removing the provider, or uninstalling the extension stops the proxy. *Show proxy log* opens its log.

**Workers** (opt-in, per provider): the window's AI can consult other models you've set up — Claude on your Anthropic login leads, and asks, say, GLM on Z.ai for a second opinion, a review or bulk text work. *Edit or Remove a Provider → Workers* picks which of that provider's models may be consulted (off by default; a one-time confirmation says what leaves the machine). New Claude Code sessions in that account's windows then get two tools, `list_workers` and `delegate`:

- **Answers only.** A worker gets the task and the material the lead pastes into the call — nothing else. It can't read files, run commands or change anything, and the lead is told to check its answers.
- **Keys stay put.** The tools are served by a small MCP server inside the extension, on `127.0.0.1` behind a random token; each call reads the provider's key from VS Code's secret storage. The window's own provider is untouched — a window on the Anthropic login stays on it.
- **Limits.** At most 120,000 characters sent and 8,192 tokens back per call, 100 calls per window session. The log records each call (worker, time, tokens), never its content; the status bar shows a worker at work.
- Registered in the window's own Claude Code config only while some worker is enabled, and removed when none is or the window closes. Open sessions are told when workers change and pick up the new tools without restarting.

**Agent tasks** (a second opt-in, per worker model): a worker that does real work. When you enable a worker under *Workers*, a second step asks which of those models may also run agent tasks, with a confirmation of what that means. The lead then gets `start_task`, `wait_task`, `cancel_task` and `apply_task_changes`:

- **Where it runs.** Claude Code — the Claude Code extension's own binary, the version your chats use; `claude` on PATH only where that extension isn't installed — headless, on the worker's model (e.g. GLM-5.3 on Z.ai), in **auto mode**, inside a scratch **git worktree** made from your repo — HEAD plus your uncommitted changes, built with a temporary index so yours is never touched. Untracked files come along within a budget (5 MB a file, 100 MB and 2,000 files in all, `.gitignore` respected), taken by top-level folder, smallest first; a folder that doesn't fit is left out whole, and so are Git LFS files (they stay pointers — their content is never copied). What was left out is told to the worker and the lead. Gitignored files the task needs (a plan in a scratch folder, say) come along when the lead lists them in `start_task`'s `include` (5 MB a file, 100 MB and 2,000 files in all) or names them in the task by absolute path; such paths are rewritten to point at the worker's copy. A repository whose tracked files exceed 5 GB is refused. It gets a fresh config: none of your login, plugins or MCP servers; the provider key only in its process environment.
- **Builds and tests.** Gitignored dependency folders at the top of your repo (`node_modules`, `.venv`, `venv`, `vendor`, …) are linked into the worktree so the worker can build and test; they're your copies, so the worker is told not to install into them, and the links are removed before its changes are collected.
- **What it can do.** Read and edit files in the worktree and run commands (tests, builds). Auto mode checks each consequential action with a safety classifier on the worker's own model — about 35K tokens per check on Z.ai.
- **What comes back.** The worker's report and a diff against the snapshot. Changes to existing files and new files it wrote with its file tools are included; files that only appeared as side effects of its commands (build output, caches, logs) are listed but left out. The worktree is then removed; the patch and run log stay under `~/.claude-windows/agent-tasks` for 7 days.
- **Applying.** Nothing reaches your working tree unless the lead calls `apply_task_changes` after reviewing the diff (with your usual Claude Code permission for that tool). It's checked first and applied to the working tree only — never staged.
- **Limits.** 2 tasks at a time; each gets 2 hours and 300 turns unless the lead sets `minutes` (5–480) or `max_turns` (10–1000), and a run with no output for 20 minutes is taken as stuck. The worker is told its limits. A run stopped at a limit (or cancelled) keeps the changes it made: the lead can review and apply them, or continue with `start_task` and `after` — the follow-up starts from those changes and is told where the run stopped, with its last message. While tasks are active the account's status bar item shows a count (`you@example.com · ⟳ 2`), and its hover card lists the recent tasks — worker, progress, what each changed and whether it was applied — next to the account, provider and workers; *Agent tasks* there (or *Claude Accounts: Show Agent Tasks*) opens a task's transcript, log or patch, or cancels it. A run that doesn't start in auto mode (an old Claude Code falls back to "default", where every edit is denied) is stopped at once with that reason.

**Transcripts.** In the hover, each agent task's worker name opens that task's transcript, and each worker under *Workers* (with a count) lists its agent tasks and `delegate` consultations in this window. Transcripts open in the Markdown preview: an agent task's run — the worker's messages, each tool call with its command or edit, results and thinking collapsed, its report and changes — following along while it runs; a consultation's question, context and answer. Also *Claude Accounts: Show Worker Transcripts*. The window keeps its latest 50 consultations, in memory only.
- **Chains.** `start_task(..., after: <task_id>)` starts from that task's result instead of your repo — waiting for it if it's still running — so a pipeline (fix → test → docs) can be queued at once. Applying the last task of a chain also applies the earlier, not yet applied ones; nothing lands half-done.
- **Workers can consult.** An agent run can call `delegate` itself (answers only) — e.g. GLM asking Claude for a second opinion mid-task — plus `list_workers` and `provider_usage`. It can't start tasks: runs reach the workers server with a token limited to those three tools.

**Claude on your own login as a worker.** *Edit or Remove a Provider → Anthropic login (this account)* enables Claude models (haiku, sonnet, opus) on the account's own subscription as workers — for the lead and for agents such as GLM to consult. Each call runs Claude Code itself, headless, on the account's own directory (never a window's working directory, which may be set to a gateway), with no tools, no MCP servers and the session not saved; the extension never handles the subscription's token. It counts toward the plan's usage.

**Usage awareness.** `provider_usage` (for the lead and agents) and *Claude Accounts: Show Provider Usage* report how much of each plan is used, to spread work across subscriptions instead of exhausting one:

- **Anthropic login** — 5-hour and weekly windows, from Claude Code's own rate-limit reports on each login worker call.
- **Z.ai** — the Coding Plan's credit windows, from Z.ai's quota monitor (unofficial: it may change or disappear; the report says so).
- **This window** — calls, tasks and tokens per worker.

---

## One conversation history

Claude Code has **one** history: it is stored per *data directory*, and vanilla Claude Code only ever has one directory. This extension gives each window a directory of its own — so it has to put the history back together, or installing it would make every conversation you ever had disappear from the panel.

It does that with one store, `~/.claude-shared`, symlinked from every directory:

```text
~/.claude/projects                ──┐
~/.claude-work/projects           ──┼──▶  ~/.claude-shared/projects/<per-repo>/…
~/.claude-windows/a1b2…/projects  ──┘
```

- Conversations, session state, plans and todos live there. **Credentials and identity never do** — those stay strictly per-account, which is the whole point of the extension.
- Transcripts stay keyed by workspace folder, exactly as Claude Code writes them, so nothing leaks between repositories.
- Hit a usage limit, switch account, carry on in the same conversation.

There is **nothing to configure** — this isn't a feature bolted onto Claude Code, it's what keeps Claude Code's own behaviour intact. (Up to v1.2.7 a `sharedHistory` toggle existed. Turning it off isolated nothing meaningful — it copied the entire history into every directory. It's gone.)

**Uninstalling** moves the store back into the default `~/.claude` — see [Uninstalling](#uninstalling).

---

## How it works

Claude Code resolves its data directory from the `CLAUDE_CONFIG_DIR` environment variable. Every VSCode window runs its own extension-host process, so `process.env` is per-window — that's the isolation mechanism. Each **account** is a store (`~/.claude-<name>`); each **window** runs on a private working copy of the account it picked:

```text
account stores                    per-window working copies
~/.claude-work      ──copy──▶    ~/.claude-windows/a1b2… ◀── window A (CLAUDE_CONFIG_DIR)
~/.claude-personal  ──copy──▶    ~/.claude-windows/c3d4… ◀── window B (CLAUDE_CONFIG_DIR)
```

The details that make it reliable — each one a bug found and fixed:

- **Activation order.** Claude Code reads `CLAUDE_CONFIG_DIR` the moment it activates and caches it — so this extension must get there *first*. It uses the `*` activation event, which VSCode's docs discourage because it loads the extension at every start-up: a deliberate, load-bearing trade-off — with any lazier activation the variable would be set after Claude Code has already read it, and per-window accounts simply wouldn't work. The cost is kept negligible: a ~25 KB bundle with zero dependencies, and the activation path itself only sets the variable and does a handful of file checks — everything heavier is deferred. (The same start-up read is why switching needs a window reload.)
- **A working copy per window.** A `/login` writes into the window's own directory, so it can only ever affect that window — "which window signed in?" is answered by construction, and no other window's account can be overwritten. Copies of an OAuth token authenticate independently, so the duplicates are safe.
- **No competing source of truth.** A machine-wide `CLAUDE_CONFIG_DIR` in `claudeCode.environmentVariables` or `terminal.integrated.env` would force all windows onto one account — the extension strips it and keeps isolation in `process.env` only.
- **Terminals follow the window.** Integrated terminals get the window's account via VSCode's environment-variable API. External terminals (outside VSCode) keep using the default `~/.claude`.
- **Reload safety.** Automatic reloads (after a forget or an in-window sign-in) go through a circuit breaker: state is corrected *before* reloading, and at most one automatic reload per minute — a misbehaving edge case degrades to a message with a button, never a reload loop.
- **Survives its own absence.** The account you last used is mirrored into Claude Code's own default `~/.claude` on every sync, so if the extension is ever gone — uninstalled, disabled, or not yet activated — Claude Code is already signed in there and just works. Nothing important waits on the uninstall script, which VSCode defers to its next restart and may never run.
- **Found where it runs.** The extension is published as a single universal package, not per-platform. In WSL and Remote-SSH it executes on the Linux *remote*, but the VSCode *client* that resolves the Marketplace is often Windows or macOS — a Linux-only build would be invisible to that client, which then reports the extension as missing and never updates it. The Linux requirement is enforced at runtime instead (the inert mode above).

---

## Settings

**None.** The extension has no settings — it does one thing and there is nothing to tune. Accounts are managed entirely from the status bar.

---

## Privacy & your data

This extension is built to manage credentials, so it holds itself to a strict policy — each point verifiable in the [source](https://github.com/DercasDrol/claude-parallel-profiles):

- **No telemetry, no analytics, and one kind of network request.** The extension has **zero runtime dependencies** — it is your files, the `vscode` API, and Node's standard library. Its only network request reads the model list of a provider *you* added (`GET <provider>/v1/models`, with that provider's key); nothing else is ever sent anywhere, and with no providers added it makes no requests at all. The one exception is opt-in: enabling [non-Claude models](#daily-use) installs the hash-pinned LiteLLM proxy from PyPI, and that proxy then talks to your gateway.
- **Everything stays in your home directory.** Accounts, working copies and the history store live under `~/.claude*`, created with owner-only permissions (`600`/`700`). Credentials are only ever *copied between* Claude Code's own data directories on this machine — never parsed beyond checking they exist, never displayed, never transmitted.
- **Providers belong to one account on one host.** A provider you add is seen only by windows running that same Claude account on that same host; another account, or the same account on another host, adds its own. Its key is stored in VS Code's secret storage on the computer running VS Code, under a name tied to that host. A window using a provider also gets a copy in its own `settings.json` (`600`), next to the OAuth token its directory already holds, because that file is how Claude Code receives it. Switching back to *Anthropic*, removing the provider, or uninstalling removes that copy. With non-Claude models on, the window gets the local proxy's key instead, and the gateway key is passed to the proxy through its environment only.
- **Workers send what the lead chooses, to the provider you enabled.** With workers on, the content of each `delegate` call (task and pasted material) goes to that provider — and, for a gateway such as Z.ai, to the model's maker — billed to its key. Nothing is sent unless the AI calls the tool, and only for models you switched on.
- **Usage lookups.** `provider_usage` reads Z.ai's quota monitor with the Z.ai key (a plain GET; nothing is sent). The Anthropic login's usage comes only from Claude Code's own output.
- **Agent tasks read your repo.** A worker enabled for agent tasks reads files of a scratch copy of the repository (HEAD + uncommitted changes) as it works, so that content goes to its provider. Its run has no access to your login, plugins or MCP servers, and its changes stay in the copy unless the lead applies them.
- **Conversations are moved, not read.** Shared history relinks the files; the extension does not inspect their contents.
- **Minimal footprint elsewhere:** the workspace folder path is hashed to tell windows apart; `claude auth status` is asked (locally, read-only) to confirm a directory is signed in; on Linux/WSL the process list is scanned only during *Forget*, to stop `claude` processes running on the token being deleted.
- **Self-restricted in the VSCode manifest:** disabled in virtual workspaces, and in Restricted Mode (untrusted folders) it never reads workspace content — only the folder's path, to tell windows apart ([`capabilities`](package.json)).
- **Inert off Linux.** On unsupported platforms it performs no operations at all — no file reads, no writes, no account changes; the uninstall hook is guarded the same way.
- **Uninstalling cleans up after itself:** the directories the extension created are deleted and stray OAuth tokens wiped; the one token it leaves is in `~/.claude`, exactly where Claude Code keeps its own login with no extension installed — see [Uninstalling](#uninstalling).

---

## Uninstalling

Removing the extension leaves the machine as if it had never been installed — **and leaves Claude Code signed in and working**.

**You stay signed in the whole time, not just at the end.** While the extension runs it continuously keeps Claude Code's own default account (`~/.claude`) pointed at whichever account you last used — the normal place Claude Code keeps its login. So the instant the extension is gone — uninstalled, disabled, or simply not activated yet — plain Claude Code is already signed in and working. This does **not** depend on the uninstall step running: VSCode defers uninstall scripts to its next restart (and may skip them), so nothing that matters is trusted to one.

When the uninstall script *does* run, it tidies up:

- **Your history is consolidated** into `~/.claude` — the shared store is *moved* there (instant, whatever its size; a few hundred milliseconds even for gigabytes), and any history an account kept to itself is folded in. Plain Claude Code has one history, not one per account.
- **Every directory the extension created is deleted** — the account stores, the per-window working copies, the shared store. No duplicated history, and no OAuth token left in a folder only this extension ever used.
- **If anything can't be moved in time**, the script stops rather than risk your data: it still wipes stray tokens, but keeps any directory whose history hasn't safely reached `~/.claude`. (It runs on a strict deadline — VSCode kills uninstall scripts after five seconds — so it never reads a file it can only move.)

Your other accounts stay signed out afterwards — sign into them the normal way. Directories the extension didn't create are never touched: it deletes only what a manifest of its own says it made, and if a newer copy of the extension is already installed the script does nothing at all.

---

## Limitations

- **Linux only for now.** On macOS Claude Code keeps credentials in the Keychain (not files) and native Windows is untested — on both, the extension refuses to run rather than guess (see the note at the top). Support may come later.
- **Loads at every VSCode start-up** (`*` activation). Required to win the activation race against Claude Code — see [How it works](#how-it-works). The extension is deliberately tiny, so the impact is milliseconds.
- **API-key users**: this is for OAuth (claude.ai) logins. With `ANTHROPIC_API_KEY` you don't need it — set the key per window yourself.
- **Switching reloads the window** — a consequence of Claude Code reading its account once at start-up; surfaced honestly rather than pretended around.
- **Uninstalling leaves you signed into one account** (the last one you used). Vanilla Claude Code holds one account at a time — the others have to be signed into the normal way.
- **The same project in two windows shares one conversation list.** VSCode won't open the same folder twice, but a folder and a `.code-workspace` containing it are two windows on one project — and since history is one store (as it is in plain Claude Code), both see the same chats and could resume the same one under *different accounts*. The transcript is a tree of parent-linked entries, so this forks the conversation rather than corrupting it, but the two branches will bill two accounts. Don't drive one chat from two windows at once.

---

## Development & releases

```bash
npm ci            # install
npm run watch     # dev build with watch
npm run compile   # typecheck + build
npm run package   # build .vsix
```

- **CI** ([ci.yml](.github/workflows/ci.yml)): every push/PR to `main` builds and uploads the `.vsix` artifact.
- **Release** ([release.yml](.github/workflows/release.yml)): pushing a `v*` tag builds, creates a GitHub Release with the `.vsix`, and publishes to the VS Code Marketplace (`VSCE_PAT` secret) and Open VSX (`OVSX_PAT` secret).

```bash
# release flow: make sure package.json version matches the tag, then
git tag v<version>
git push origin main --tags     # CI does the rest
```

---

## License

MIT License — see [LICENSE](LICENSE) for details.
