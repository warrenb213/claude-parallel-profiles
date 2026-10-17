/**
 * Which Claude models a gateway serves, and how to make Claude Code treat them
 * as the models they are.
 *
 * Claude Code enables thinking, effort levels and the right context window by
 * recognising a model's ANTHROPIC ID. Gateways name models their own way —
 * Poe says `claude-opus-4.8` for Anthropic's `claude-opus-4-8` — and an ID
 * Claude Code doesn't recognise runs at 200K with thinking and effort off.
 * The cure is the `modelOverrides` setting, `{ <Anthropic ID>: <gateway ID> }`:
 * Claude Code then treats the gateway ID as that model and sends it on the wire.
 * Verified against the CLI:
 *   • the key must be the Anthropic ID exactly, DATE INCLUDED for models that
 *     have one (`claude-haiku-4-5-20251001`) — an undated key is silently
 *     ignored and the model goes out unmapped;
 *   • the alias env var must hold the ANTHROPIC ID too. Pinned to the gateway ID,
 *     `--model opus` still worked, but the default model and every fallback went
 *     out with the legacy thinking budget and no effort — half-recognised;
 *   • `availableModels` with versions makes anything the gateway doesn't serve
 *     (Opus 5.5, Fable) fall back to an allowed model instead of a 400 — listing
 *     families (`opus`) would allow every version. Entries are PREFIXES, so they
 *     are the undated IDs: a dated entry would not match an undated request.
 *
 * And the list itself comes from the gateway (`GET /v1/models`), so it never
 * lags behind what the gateway actually serves.
 */

export type Family = 'opus' | 'sonnet' | 'haiku' | 'fable';
export const FAMILIES: Family[] = ['opus', 'sonnet', 'haiku', 'fable'];

export interface CatalogModel {
  /** The name the gateway expects. */
  gatewayId: string;
  /** Anthropic's ID for the same model — what Claude Code recognises. */
  anthropicId: string;
  /** The same without a date — what `availableModels` matches as a prefix. */
  prefix: string;
  family: Family;
  /** [major, minor] for ordering. */
  version: [number, number];
  /** Context window as the gateway reports it, when it does. */
  contextLength?: number;
}

/**
 * Models whose Anthropic ID carries a release date. Every model since Opus 4.6
 * has an undated ID, so this table only ever covers older releases.
 */
const DATED: Record<string, string> = {
  'claude-opus-4-5': 'claude-opus-4-5-20251101',
  'claude-sonnet-4-5': 'claude-sonnet-4-5-20250929',
  'claude-haiku-4-5': 'claude-haiku-4-5-20251001',
  'claude-opus-4-1': 'claude-opus-4-1-20250805',
};

/**
 * The Anthropic model a gateway ID stands for, or undefined if it isn't a Claude
 * model. Tolerates the usual gateway spellings: dots for hyphens (Poe), case,
 * a vendor prefix (`anthropic/claude-…`), a `[1m]` suffix.
 */
export function toAnthropic(
  gatewayId: string
): { anthropicId: string; prefix: string; family: Family; version: [number, number] } | undefined {
  const bare = gatewayId.split('/').pop()!.toLowerCase().replace(/\[1m\]$/, '');
  const m = /^claude-(opus|sonnet|haiku|fable)-(\d+)(?:[.-](\d{1,2}))?(?:-(\d{8}))?$/.exec(bare);
  if (!m) return undefined;
  const [, family, major, minor, date] = m;
  const undated = `claude-${family}-${major}${minor !== undefined ? `-${minor}` : ''}`;
  return {
    anthropicId: date ? `${undated}-${date}` : DATED[undated] ?? undated,
    prefix: undated,
    family: family as Family,
    version: [Number(major), minor !== undefined ? Number(minor) : 0],
  };
}

/**
 * Turns a `/v1/models` response into the Claude models usable from Claude Code.
 * Accepts both the OpenAI-style list (Poe, LiteLLM, OpenRouter) and Anthropic's.
 * A model that declares its endpoints must declare `/v1/messages` — Poe lists
 * some Claude models only on its OpenAI endpoint, and Claude Code can't use those.
 */
export function parseCatalog(body: unknown): CatalogModel[] {
  const data = (body as { data?: unknown })?.data;
  if (!Array.isArray(data)) throw new Error('the response has no model list');
  const byAnthropic = new Map<string, CatalogModel>();
  for (const raw of data) {
    const m = raw as { id?: unknown; supported_endpoints?: unknown; context_length?: unknown };
    if (typeof m.id !== 'string') continue;
    if (Array.isArray(m.supported_endpoints) && !m.supported_endpoints.includes('/v1/messages')) continue;
    const a = toAnthropic(m.id);
    if (!a || byAnthropic.has(a.anthropicId)) continue;
    byAnthropic.set(a.anthropicId, {
      gatewayId: m.id,
      ...a,
      contextLength: typeof m.context_length === 'number' ? m.context_length : undefined,
    });
  }
  return [...byAnthropic.values()].sort(
    (x, y) => x.family.localeCompare(y.family) || y.version[0] - x.version[0] || y.version[1] - x.version[1]
  );
}

/** Reads the gateway's model list. The only network request this extension makes. */
export async function fetchCatalog(
  baseUrl: string,
  auth: 'bearer' | 'x-api-key',
  key: string
): Promise<CatalogModel[]> {
  const url = `${baseUrl.replace(/\/+$/, '')}/v1/models`;
  const res = await fetch(url, {
    headers: {
      ...(auth === 'bearer' ? { Authorization: `Bearer ${key}` } : { 'x-api-key': key }),
      'anthropic-version': '2023-06-01',
    },
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw new Error(`${url} answered HTTP ${res.status}`);
  return parseCatalog(await res.json());
}

/** The newest model of a family. */
export function newest(catalog: CatalogModel[], family: Family): CatalogModel | undefined {
  return catalog.find((m) => m.family === family); // parseCatalog sorts newest first
}

export interface ModelSettings {
  /** ANTHROPIC_DEFAULT_<FAMILY>_MODEL values: Anthropic IDs, mapped by the overrides. */
  env: Record<string, string>;
  modelOverrides?: Record<string, string>;
  availableModels?: string[];
  enforceAvailableModels?: boolean;
}

/**
 * The model part of a provider's settings.
 *
 * `chosen` are the user's per-family picks (gateway IDs); a family without one
 * gets the catalog's newest. With a catalog, only its models are allowed — the
 * picker then shows exactly what the gateway serves. Without one (a gateway with
 * no `/v1/models`), the picks are still mapped so they're recognised, but nothing
 * is restricted: we don't know what else the gateway has.
 */
export function modelSettings(
  catalog: CatalogModel[] | undefined,
  chosen: Partial<Record<Family, string>> = {}
): ModelSettings {
  const env: Record<string, string> = {};
  const overrides: Record<string, string> = {};
  const allowed = new Set<string>();
  for (const m of catalog ?? []) {
    if (m.anthropicId !== m.gatewayId) overrides[m.anthropicId] = m.gatewayId;
    allowed.add(m.prefix);
  }
  for (const family of FAMILIES) {
    const id = chosen[family] ?? (catalog ? newest(catalog, family)?.gatewayId : undefined);
    if (!id) continue;
    const a = toAnthropic(id);
    // A non-Claude name (a custom deployment) can't be recognised — pin it as is.
    env[`ANTHROPIC_DEFAULT_${family.toUpperCase()}_MODEL`] = a ? a.anthropicId : id;
    if (a && a.anthropicId !== id) overrides[a.anthropicId] = id;
    if (a && catalog) allowed.add(a.prefix);
  }
  // Haiku also runs Claude Code's background work (titles, summaries). A gateway
  // without one would leave that on the built-in Haiku, which it may not serve.
  if (catalog && !env.ANTHROPIC_DEFAULT_HAIKU_MODEL) {
    const fallback = env.ANTHROPIC_DEFAULT_SONNET_MODEL ?? env.ANTHROPIC_DEFAULT_OPUS_MODEL;
    if (fallback) env.ANTHROPIC_DEFAULT_HAIKU_MODEL = fallback;
  }
  const out: ModelSettings = { env };
  if (Object.keys(overrides).length > 0) out.modelOverrides = overrides;
  if (catalog && allowed.size > 0) {
    out.availableModels = [...allowed];
    out.enforceAvailableModels = true;
  }
  return out;
}
