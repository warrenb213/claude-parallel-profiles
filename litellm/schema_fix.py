"""
Compatibility fixes for the extension's local LiteLLM proxy (loaded via
litellm_settings.callbacks in the generated config): a pre-call hook for tool
schemas, and — at the bottom — a stream fix for providers that send
finish_reason early.

Claude Code's tool schemas use JSON Schema 2020-12. Some OpenAI-format backends
reject keywords their parsers don't know — Poe's GLM and Qwen answer
"Failed to parse tool definition" to `prefixItems` (a tuple array, used by
Claude Code's ArtifactData tool), and Claude Code then retries the 500 for
minutes, which looks like a hang. For translated (non-Claude) models this
rewrites those schemas into older, equivalent-enough forms before LiteLLM
translates the request. Claude models are passed through untouched: Anthropic
accepts the originals.

Standard library only; it runs inside the proxy, which holds the gateway key.
"""

import copy

from litellm.integrations.custom_logger import CustomLogger


def _rewrite(schema):
    if isinstance(schema, list):
        return [_rewrite(s) for s in schema]
    if not isinstance(schema, dict):
        return schema
    out = {k: _rewrite(v) for k, v in schema.items() if k != "prefixItems"}
    if "prefixItems" in schema:
        # A tuple becomes "an array of any of these"; any schema for the items
        # after the tuple (2020-12 `items`) joins the alternatives.
        alternatives = _rewrite(schema["prefixItems"])
        rest = out.pop("items", None)
        if isinstance(rest, dict):
            alternatives = alternatives + [rest]
        out["items"] = {"anyOf": alternatives}
    return out


class SchemaFix(CustomLogger):
    async def async_pre_call_hook(self, user_api_key_dict, cache, data, call_type):
        model = str(data.get("model", ""))
        tools = data.get("tools")
        if "claude" in model.lower() or not isinstance(tools, list):
            return data
        for tool in tools:
            if not isinstance(tool, dict):
                continue
            if isinstance(tool.get("input_schema"), dict):  # Anthropic format (/v1/messages)
                tool["input_schema"] = _rewrite(tool["input_schema"])
            fn = tool.get("function")
            if isinstance(fn, dict) and isinstance(fn.get("parameters"), dict):  # OpenAI format
                fn["parameters"] = _rewrite(fn["parameters"])
        return data


proxy_handler_instance = SchemaFix()


# ─── Early finish_reason (Poe) ───────────────────────────────────────────────
#
# Poe's OpenAI-format stream sends `finish_reason: "tool_calls"` right after the
# FIRST tool call and then streams the next ones. LiteLLM's Anthropic adapter
# takes the early finish at its word — closes the block and marks the message
# finished — so the next tool call gets deltas but no content_block_start, and
# Claude Code drops the reply: "Part of the response never arrived". It happens
# whenever the model calls several tools at once.
#
# Fix: before the adapter reads the stream, hold a payload-free finish chunk
# back while content keeps coming, and release it at the first payload-free
# chunk after that (normally usage) or at the end of the stream — where a
# standard stream puts it. A normal stream (finish, then usage) passes through
# in the same order. Only the translated (non-Claude) path uses this adapter.


def _choice(chunk):
    choices = getattr(chunk, "choices", None)
    return choices[0] if choices else None


def _has_payload(chunk):
    c = _choice(chunk)
    d = getattr(c, "delta", None) if c is not None else None
    if d is None:
        return False
    return any(getattr(d, k, None) for k in ("content", "tool_calls", "reasoning_content", "thinking_blocks"))


def _finish(chunk):
    c = _choice(chunk)
    return getattr(c, "finish_reason", None) if c is not None else None


class _DeferEarlyFinish:
    def __init__(self, stream):
        self._stream = stream
        self._held = None
        self._out = []
        self._sync = None
        self._async = None
        self._done = False

    def __getattr__(self, name):  # .chunks, .messages… of the wrapped stream
        return getattr(self._stream, name)

    def _feed(self, chunk):
        if _finish(chunk) and _has_payload(chunk):
            # Content and finish together: pass the content on now, decide on
            # the finish like any other.
            content, finish = copy.deepcopy(chunk), copy.deepcopy(chunk)
            _choice(content).finish_reason = None
            d = _choice(finish).delta
            for k in ("content", "tool_calls", "reasoning_content", "thinking_blocks"):
                if hasattr(d, k):
                    setattr(d, k, None)
            self._feed(content)
            self._feed(finish)
            return
        if self._held is None:
            if _finish(chunk) and not _has_payload(chunk):
                self._held = chunk  # maybe early: wait and see
            else:
                self._out.append(chunk)
            return
        if _has_payload(chunk):
            self._out.append(chunk)  # more content after the finish: keep holding it
        elif _finish(chunk):
            self._held = chunk  # a later finish supersedes the early one
        else:
            self._out.extend([self._held, chunk])  # usage / empty: the real end
            self._held = None

    def _flush(self):
        if self._held is not None:
            self._out.append(self._held)
            self._held = None

    def __iter__(self):
        return self

    def __next__(self):
        while not self._out:
            if self._done:
                raise StopIteration
            if self._sync is None:
                self._sync = iter(self._stream)
            try:
                self._feed(next(self._sync))
            except StopIteration:
                self._done = True
                self._flush()
        return self._out.pop(0)

    def __aiter__(self):
        return self

    async def __anext__(self):
        while not self._out:
            if self._done:
                raise StopAsyncIteration
            if self._async is None:
                self._async = self._stream.__aiter__()
            try:
                self._feed(await self._async.__anext__())
            except StopAsyncIteration:
                self._done = True
                self._flush()
        return self._out.pop(0)


def _patch_adapter():
    try:
        from litellm.llms.anthropic.pass_through.adapters import streaming_iterator as si

        splitter = si._CombinedChunkSplitter
        if getattr(splitter, "_claude_accounts_patched", False):
            return
        original = splitter.__init__

        def __init__(self, completion_stream, *args, **kwargs):
            original(self, _DeferEarlyFinish(completion_stream), *args, **kwargs)

        splitter.__init__ = __init__
        splitter._claude_accounts_patched = True
    except Exception:  # a LiteLLM without this class: leave it as it is
        pass


_patch_adapter()
