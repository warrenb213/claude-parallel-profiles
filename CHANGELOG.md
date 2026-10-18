# Changelog

## 1.8.5 — 2026-10-17

### Fixed

- **"API Error: Part of the response never arrived" with non-Claude models on Poe.** Poe's stream marks the reply finished (`finish_reason: "tool_calls"`) right after the first tool call, then streams the next ones. LiteLLM believed the early finish and dropped the later tool calls' block starts — names and ids included — so Claude Code discarded the rest of the reply whenever the model called several tools at once. The proxy's hook now holds such an early finish back until the reply really ends; standard streams pass through unchanged.

## 1.8.4 — 2026-10-17

### Fixed

- **A window reloading mid-start could leave the proxy wrong for three minutes.** The proxy's start lock was only taken over once it was three minutes old. A window reloaded while starting the proxy (as after an update: the old code started one without the schema hook in its last seconds) left the lock behind, and the updated windows waited it out while every request failed — the chat looked hung. The lock now records its owner's process, and a lock whose owner is gone is taken over at once; the three-minute rule remains only as a fallback.

## 1.8.3 — 2026-10-17

### Fixed

- **"claude-sonnet-4-6 is temporarily unavailable (connection failed)" in auto mode, and dropped replies.** Every window on a host shares the provider's local proxy and brings it in line whenever it gains focus. Two windows running different extension versions (one not reloaded since an update) each rebuilt the proxy their own way, taking turns restarting it — five restarts in three minutes were seen — and every request in flight, auto mode's classifier checks included, failed with "connection failed". The proxy now records which version started it, and an older version reuses a newer one's proxy instead of rebuilding it (port and key are unchanged either way). A running proxy that misses one 2-second health check (busy, not dead) also gets three chances before it is restarted. Windows still running ≤ 1.8.2 code need one reload to stop taking part.

## 1.8.2 — 2026-10-17

### Changed

- **No more auto mode "this session isn't eligible" notice on gateways.** Auto mode now asks Anthropic's API to run its safety checks inside each request; a gateway such as Poe can't, so Claude Code fell back to its own classifier requests after holding the first checked action behind that notice. Gateway windows now set `CLAUDE_CODE_AUTO_MODE_SERVER=0`, which gives the same fallback without the notice — every action is still checked, and the classifier requests are billed by the gateway as before. Not set for the Anthropic login or an Anthropic API key, and removed when a window switches back.

## 1.8.1 — 2026-10-17

### Fixed

- **Non-Claude models hung on every request.** Poe's GLM and Qwen reject one of Claude Code's own tool schemas (`ArtifactData` uses JSON Schema's `prefixItems`) with "Failed to parse tool definition"; LiteLLM answered 500 and Claude Code kept retrying, which looked like a hang. The proxy now loads a small pre-call hook (`litellm/schema_fix.py`, shipped with the extension) that rewrites such keywords for translated models only; Claude models pass through untouched. A new version of the hook restarts the proxy.
- **Switching back to Anthropic left a gateway-only default model behind.** Picking e.g. `glm-5.3` as the default in `/model` saves it in the window's settings; going back to the Anthropic login or an API key now removes it (Claude aliases and IDs stay), instead of sending `glm-5.3` to Anthropic.
- The window reload after switching provider no longer logs a "Canceled" error.

## 1.8.0 — 2026-10-17

### Changed

- **Providers belong to one account on one host.** Up to 1.7 a provider — its definition, key and enabled non-Claude models — was kept on the VS Code client and shared by every remote host and every Claude account. Now a window sees only the providers of the account it runs, on its own host. On first start each host adopts the old shared providers for the accounts that have a window using them there right now (by key, or by the local proxy's port), and for no one else; other accounts add their own. The account on a running proxy keeps the provider's id, so its windows don't change.

### Fixed

- The LiteLLM proxy's folder (`~/.claude-windows/litellm`) was taken for a window's working folder, and shared-history links were created inside it. Only real window folders are considered now, and the stray links are removed on start (links only — no history is touched).
- *Show proxy log* on a host where the proxy never ran explains that, instead of an error.

## 1.7.1 — 2026-10-17

### Fixed

- **"Non-Claude models: 0 available" after *Refresh model list*.** The refresh read the gateway's non-Claude models, then the edit menu saved its own copy of the provider over them, keeping only the Claude list.
- A provider whose model list was read by 1.5 or earlier (no non-Claude list at all) is now re-read on next use, instead of waiting up to a day.

## 1.7.0 — 2026-10-17

### Added

- **Anthropic API key as a provider.** *Add a Provider → Anthropic API key* takes a key from console.anthropic.com and sends the window's requests straight to Anthropic, billed per token — no base URL, model rewriting or proxy, and Claude Code's usual model lineup. The account's own login stays saved for switching back.
- **API keys are pre-approved for Claude Code.** Any provider that sets `ANTHROPIC_API_KEY` (an Anthropic key, or an `x-api-key` gateway) is recorded as approved in the window's `.claude.json`, so Claude Code's "Detected a custom API key" prompt — whose default answer, *No*, silently fell back to the login — no longer appears. An earlier *No* for the same key is undone.

### Changed

- **"Subscription" is now "Anthropic"** — the default for every window, labelled with what the account's login actually is: *Team plan · Acme*, *Max plan*, *Console API key*. It is read from the account's files, so it stays right while a provider overrides the login.

## 1.6.0 — 2026-10-17

### Added

- **Billing providers per window.** *Switch provider* points a window at the Anthropic subscription or at an Anthropic-compatible gateway (e.g. Poe) with its own base URL and key, without changing the account, its history or its settings. Keys live in VS Code's secret storage.
- **Provider model catalog.** The gateway's `/v1/models` list decides what Claude Code's model picker shows: exactly the Claude models it serves, each recognised as the model it is and sent under the gateway's name for it.
- **Non-Claude models through a local LiteLLM proxy** (opt-in, per provider). Qwen, GLM, DeepSeek… served in OpenAI's format are translated for Claude Code by a proxy on `127.0.0.1`; Claude models pass through untouched; models with a stated context window under 200K are not offered. LiteLLM is installed only on an explicit yes, every package pinned by SHA-256 (`--require-hashes`), and its remote-config downloads are disabled. The gateway key stays in the proxy's memory. Uninstalling stops the proxy.

### Fixed

- **Account state is kept per host**, not in client-shared global state — fixes a reload loop when one VS Code client connects to several remote hosts.
- The packaged extension no longer includes a stray `.claude/` directory.

## 1.2.5 — 2026-07-12

### Fixed

- **Shared-history links are created the moment a window's working directory is stocked**, not only at activation. Previously a `claude` process started right after a mid-session bind could write history into unlinked real directories — invisible to other accounts — and could not see conversations recorded before the bind, failing with "Session … not found" when forking/resuming (the root cause of that error on v1.2.0/1.2.1; the stray history was merged back into the shared store automatically, nothing was lost).

### Changed

- Sign-in/out wording in the README and in messages now leads with Claude Code's account-menu UI; slash commands are mentioned as the alternative.
- README documents the deliberate `*` activation trade-off: why winning the activation race against Claude Code requires it, and why the cost stays negligible (~25 KB bundle, zero dependencies, trivial activation path).
- README: the single-setting table replaced with plain text.

## 1.2.4 — 2026-07-12

### Changed

- **Linux-only platform gate.** The extension is built for the file-based credential layout Claude Code uses on Linux; elsewhere those assumptions break (macOS keeps credentials in the Keychain, native Windows is untested). Two layers now enforce this honestly:
  - the Marketplace release ships **Linux packages only** (x64/arm64/armhf + Alpine), so macOS / native Windows aren't offered the extension at all — WSL, Remote-SSH and dev containers install into the remote Linux side and keep working;
  - if a VSIX is side-loaded anywhere else, the extension activates into an **inert mode**: no files read or written, no accounts or settings touched (the uninstall hook is guarded the same way); the status bar and all commands explain the situation instead of failing cryptically.
- README: prominent platform-support note; deduplicated the header links (one Marketplace link instead of six) and replaced the retired shields.io marketplace badges with live CI/platform/license ones.

## 1.2.3 — 2026-07-12

The per-window architecture release: account isolation is now structural, not heuristic.

### Added

- **Per-window working directories.** Each window runs a private copy (`~/.claude-windows/<id>`) of its account's store, so a `/login` can only ever affect the window it happened in — no shared state, no focus guessing, no races.
- **Auto-save.** A signed-in account is saved the moment it's noticed; the separate "save" step is no longer required (the command remains for manual use).
- **Forceful forget.** Forgetting an account now deletes its OAuth token from every copy on the machine, interrupts live `claude` sessions running on it, and reloads any window that used it — with a confirmation up front and a "Switch account" offer after.
- **Logout handling.** `/logout` revokes the token server-side, so the account is removed from the list everywhere instead of lingering as a dead entry.
- **Terminals follow the window.** Integrated terminals get the window's account via VSCode's environment-variable collection.
- **Status bar hover card** with the extension's name, account details, actions, and quick links to Settings, the extension page, and the log (new *Show Log* command).
- **Reload circuit breaker.** All automatic window reloads correct their trigger state first and are capped at one per minute — a misbehaving edge degrades to a message with a manual button, never a reload loop.
- **Manifest self-restrictions:** disabled in virtual workspaces; limited (content never read, settings not overridable) in Restricted Mode.
- Signed-out windows offer one-click switching to a saved account (status bar click, notices, hover).

### Fixed

- Infinite reload loop after forgetting the account a window was running.
- Switching appearing to do nothing after an in-window `/login` (the window now fully reloads onto the new account; the old one stays in the list).
- Newly added accounts not appearing in other windows until restart (the registry now converges on the on-disk stores).
- A fresh login taking ~30 s to be saved (identity is read from disk instead of spawning the CLI).
- A failed working-copy stocking is no longer mistaken for a logout (which used to drop a perfectly good account).
- Uninstall now also reverts the nested per-window directories and removes their token copies.

## 1.1.5 — 2026-07-12

- Reliable per-window switching: activation-order fix (the extension now sets `CLAUDE_CONFIG_DIR` before Claude Code reads it), machine-wide setting overrides stripped, identity confirmed against the real token.

## 1.0.5 — 2026-07-12

- Rework into per-window parallel accounts with a shared conversation history store (`~/.claude-shared`) and clean uninstall.

## 1.0.0 — 2026-07-12

- Initial release: capture, switch and isolate Claude Code accounts per VSCode window.
