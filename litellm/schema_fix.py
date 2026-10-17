"""
Pre-call hook for the extension's local LiteLLM proxy (loaded via
litellm_settings.callbacks in the generated config).

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
