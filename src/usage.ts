/**
 * What's left on each provider, for the lead (provider_usage) and the user.
 *
 * Sources, best first:
 *  - The Anthropic login: Claude Code's own `rate_limit_event` messages (5-hour
 *    and weekly windows, from Anthropic's response headers), seen whenever a
 *    worker call runs on the login. Never an extra call made with the login's
 *    token — only Claude Code talks to the subscription.
 *  - Z.ai: its quota monitor (`/api/monitor/usage/quota/limit`). Unofficial and
 *    undocumented: read defensively, shown as such.
 *  - Everyone: this window's own worker calls and tokens.
 */

export interface UsageWindow {
  label: string;
  /** 0–100 (may pass 100 when a window runs over). */
  usedPct: number;
  /** ms since epoch. */
  resetsAt?: number;
  detail?: string;
}

export interface UsageEntry {
  plan?: string;
  windows: UsageWindow[];
  source: string;
  at: number;
}

const ZAI_UNITS: Record<number, string> = { 1: 'minute', 2: 'minute', 3: 'hour', 4: 'day', 5: 'day', 6: 'week', 7: 'month' };

/** Z.ai's quota monitor, as its Coding Plan answers it (`data.limits[]`, `data.level`). */
export async function zaiQuota(key: string): Promise<UsageEntry | undefined> {
  try {
    const res = await fetch('https://api.z.ai/api/monitor/usage/quota/limit', {
      headers: { Authorization: key, 'Accept-Language': 'en-US,en', 'Content-Type': 'application/json' },
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) return undefined;
    const body = (await res.json()) as {
      data?: {
        level?: string;
        limits?: Array<{ type?: string; unit?: number; number?: number; usage?: number; currentValue?: number; remaining?: number; percentage?: number; nextResetTime?: number }>;
      };
    };
    const limits = body.data?.limits;
    if (!Array.isArray(limits)) return undefined;
    const windows = limits.map((l) => {
      const unit = ZAI_UNITS[l.unit ?? 0] ?? `unit ${l.unit}`;
      const span = l.number && l.number > 1 ? `${l.number} ${unit}s` : unit;
      const pct = typeof l.percentage === 'number' ? l.percentage : l.usage ? ((l.currentValue ?? 0) / l.usage) * 100 : 0;
      return {
        label: `per ${span}`,
        usedPct: pct,
        resetsAt: typeof l.nextResetTime === 'number' ? l.nextResetTime : undefined,
        detail:
          typeof l.usage === 'number'
            ? `${(l.currentValue ?? 0).toLocaleString('en-US')} of ${l.usage.toLocaleString('en-US')} ${l.type === 'CREDIT_LIMIT' ? 'credits' : 'units'}`
            : undefined,
      };
    });
    return { plan: body.data?.level, windows, source: "Z.ai's quota monitor (unofficial)", at: Date.now() };
  } catch {
    return undefined;
  }
}

/** Claude Code's `rate_limit_event.rate_limit_info` → windows. */
export function fromRateLimitInfo(info: {
  unifiedWindows?: Record<string, { utilization?: number; resetsAt?: number } | undefined>;
  utilization?: number;
  resetsAt?: number;
  rateLimitType?: string;
}): UsageWindow[] {
  const names: Record<string, string> = {
    five_hour: 'per 5 hours',
    seven_day: 'per week',
    seven_day_overage_included: 'per week (incl. extra usage)',
  };
  const out: UsageWindow[] = [];
  for (const [k, w] of Object.entries(info.unifiedWindows ?? {})) {
    if (w && typeof w.utilization === 'number') {
      out.push({ label: names[k] ?? k, usedPct: w.utilization * 100, resetsAt: w.resetsAt ? w.resetsAt * 1000 : undefined });
    }
  }
  if (out.length === 0 && typeof info.utilization === 'number') {
    out.push({
      label: names[info.rateLimitType ?? ''] ?? info.rateLimitType ?? 'current window',
      usedPct: info.utilization * 100,
      resetsAt: info.resetsAt ? info.resetsAt * 1000 : undefined,
    });
  }
  return out;
}

function ago(ms: number): string {
  const s = Math.round((Date.now() - ms) / 1000);
  return s < 90 ? `${s} s ago` : s < 5400 ? `${Math.round(s / 60)} min ago` : `${Math.round(s / 3600)} h ago`;
}

function until(ms: number): string {
  const m = Math.max(0, Math.round((ms - Date.now()) / 60_000));
  return m < 90 ? `${m} min` : m < 2880 ? `${Math.round(m / 60)} h` : `${Math.round(m / 1440)} d`;
}

export class UsageBook {
  private readonly entries = new Map<string, UsageEntry>();
  private readonly counts = new Map<string, { calls: number; tasks: number; inTok: number; outTok: number }>();

  set(provider: string, entry: UsageEntry): void {
    this.entries.set(provider, entry);
  }

  get(provider: string): UsageEntry | undefined {
    return this.entries.get(provider);
  }

  count(workerId: string, kind: 'call' | 'task', inTok = 0, outTok = 0): void {
    const c = this.counts.get(workerId) ?? { calls: 0, tasks: 0, inTok: 0, outTok: 0 };
    if (kind === 'call') c.calls++;
    else c.tasks++;
    c.inTok += inTok;
    c.outTok += outTok;
    this.counts.set(workerId, c);
  }

  /** Plain text for the lead and the user. `providers`: every provider that has workers, in display order. */
  format(providers: string[]): string {
    const lines: string[] = [];
    for (const p of providers) {
      const e = this.entries.get(p);
      if (!e) {
        lines.push(`${p}: no usage data yet${p === 'Anthropic login' ? ' — it appears after the first worker call on the login' : ''}.`);
        continue;
      }
      lines.push(`${p}${e.plan ? ` (${e.plan} plan)` : ''} — ${e.source}, ${ago(e.at)}:`);
      for (const w of e.windows) {
        lines.push(
          `  ${w.label}: ${w.usedPct.toFixed(w.usedPct < 10 ? 1 : 0)}% used${w.detail ? ` (${w.detail})` : ''}${w.resetsAt ? `, resets in ${until(w.resetsAt)}` : ''}`
        );
      }
    }
    if (this.counts.size > 0) {
      lines.push('This window so far:');
      for (const [w, c] of this.counts) {
        lines.push(`  ${w}: ${c.calls} call${c.calls === 1 ? '' : 's'}, ${c.tasks} task${c.tasks === 1 ? '' : 's'}, ${c.inTok.toLocaleString('en-US')} in / ${c.outTok.toLocaleString('en-US')} out tokens`);
      }
    }
    return lines.join('\n') || 'No providers with workers.';
  }
}
