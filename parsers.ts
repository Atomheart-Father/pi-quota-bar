/**
 * Provider response parsing.
 *
 * Preference order:
 *   1. The parser already shipped by `@kaishin/pi-usage`, imported by absolute
 *      path at extension startup, so every provider keeps exactly one
 *      maintained implementation and this extension cannot silently drift
 *      from it.
 *   2. A compact native fallback used only when that import is unavailable
 *      (pi-usage removed, renamed, or upgraded past its current layout).
 *
 * The fallbacks cover the same fields, so losing pi-usage degrades the bar
 * instead of blanking it.
 *
 * Nothing here estimates usage. A provider that does not report an allowance
 * yields no window, and the caller reports that as missing data.
 */

import { join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import type { BarWindow, QuotaProviderId } from "./types.ts";
import { clampPercent, compactWindowLabel, num } from "./util.ts";

/** Structural mirror of pi-usage's `QuotaWindow`, so a rename cannot break typing. */
interface PiUsageWindow {
  label?: unknown;
  usedPercent?: unknown;
  resetsAt?: unknown;
  windowSeconds?: unknown;
  usedValue?: unknown;
  limitValue?: unknown;
  isCurrency?: unknown;
}

type PiUsageParsers = {
  parseAnthropicUsage(data: unknown): PiUsageWindow[];
  parseCodexUsage(data: unknown): PiUsageWindow[];
  parseOpenCodeGoUsage(data: unknown): PiUsageWindow[];
  parseZaiUsage(data: unknown): PiUsageWindow[];
  parseMiniMaxUsage(data: unknown): PiUsageWindow[];
};

let piUsageParsers: PiUsageParsers | null = null;

function parsersPath(): string {
  return join(
    getAgentDir(),
    "npm",
    "node_modules",
    "@kaishin",
    "pi-usage",
    "src",
    "providers",
    "providers.ts",
  );
}

/**
 * Load pi-usage's parsers once. Called (and awaited) during extension startup
 * so the network path never depends on a dynamic import resolving later.
 */
export async function primeParsers(): Promise<boolean> {
  if (piUsageParsers) return true;
  try {
    // A runtime path import on purpose: pi-usage is a sibling Pi extension, not
    // a declared dependency, and a failure here must not disable the bar.
    const mod = (await import(parsersPath())) as Partial<PiUsageParsers>;
    if (typeof mod?.parseAnthropicUsage === "function") {
      piUsageParsers = mod as PiUsageParsers;
      return true;
    }
  } catch {
    // Fall back to the native parsers below.
  }
  piUsageParsers = null;
  return false;
}

export function parsersAvailable(): boolean {
  return piUsageParsers !== null;
}

/** Normalize one pi-usage window onto the bar model. */
function fromPiUsageWindow(raw: PiUsageWindow): BarWindow | undefined {
  const usedPercent = num(raw.usedPercent);
  if (usedPercent === undefined) return undefined;

  const rawSeconds = num(raw.windowSeconds);
  const seconds = rawSeconds !== undefined && rawSeconds > 0 ? rawSeconds : undefined;
  const resetsAt = raw.resetsAt instanceof Date ? raw.resetsAt.getTime() : num(raw.resetsAt);
  const limitValue = num(raw.limitValue);
  const usedValue = num(raw.usedValue);
  // pi-usage encodes percentage-only windows as used/100, so a limit of exactly
  // 100 is not a real count pair.
  const hasCounts =
    limitValue !== undefined && usedValue !== undefined && limitValue > 0 && limitValue !== 100;
  const nativeLabel = String(raw.label ?? "");

  return {
    label: seconds !== undefined ? compactWindowLabel(seconds) : nativeLabel,
    nativeLabel: nativeLabel || (seconds !== undefined ? compactWindowLabel(seconds) : "usage"),
    usedPercent: clampPercent(usedPercent),
    ...(resetsAt !== undefined && resetsAt > 0 ? { resetsAt } : {}),
    ...(seconds !== undefined ? { windowSeconds: seconds } : {}),
    ...(hasCounts ? { hasCounts: true, usedValue, limitValue } : {}),
    ...(raw.isCurrency === true ? { isCurrency: true } : {}),
  };
}

/** Try pi-usage first; `undefined` means "not available", not "no data". */
function viaPiUsage(pick: (parsers: PiUsageParsers) => PiUsageWindow[]): BarWindow[] | undefined {
  if (!piUsageParsers) return undefined;
  try {
    const windows = pick(piUsageParsers);
    if (!Array.isArray(windows)) return undefined;
    const mapped = windows
      .map(fromPiUsageWindow)
      .filter((w): w is BarWindow => w !== undefined);
    return mapped.length > 0 ? mapped : undefined;
  } catch {
    return undefined;
  }
}

// ---------------------------------------------------------------------------
// Native fallbacks
// ---------------------------------------------------------------------------

function record(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  return value as Record<string, unknown>;
}

/** Providers mix epoch seconds, epoch milliseconds and ISO strings. */
function epochMs(value: unknown): number | undefined {
  const direct = num(value);
  if (direct !== undefined && direct > 0) {
    return direct > 1e11 ? direct : direct * 1000;
  }
  if (typeof value === "string" && value.trim()) {
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

function percentWindow(
  windowSeconds: number,
  nativeLabel: string,
  usedPercent: number,
  resetsAt?: number,
): BarWindow {
  return {
    label: compactWindowLabel(windowSeconds),
    nativeLabel,
    usedPercent: clampPercent(usedPercent),
    windowSeconds,
    ...(resetsAt !== undefined && resetsAt > 0 ? { resetsAt } : {}),
  };
}

const H5 = 5 * 60 * 60;
const D7 = 7 * 86_400;
const D30 = 30 * 86_400;

/** Claude: `{ five_hour: { utilization, resets_at }, seven_day: { … } }` */
function nativeClaude(data: unknown): BarWindow[] {
  const root = record(data);
  if (!root) return [];
  const out: BarWindow[] = [];
  const push = (key: string, nativeLabel: string, seconds: number) => {
    const entry = record(root[key]);
    if (!entry) return;
    const utilization = num(entry.utilization);
    if (utilization === undefined) return;
    out.push(percentWindow(seconds, nativeLabel, utilization, epochMs(entry.resets_at)));
  };
  push("five_hour", "5h", H5);
  push("seven_day", "7d", D7);
  push("seven_day_opus", "7d Opus", D7);
  push("seven_day_sonnet", "7d Sonnet", D7);
  return out;
}

/** Codex: `{ rate_limit: { primary_window: { used_percent, reset_at } } }` */
function nativeCodex(data: unknown): BarWindow[] {
  const rateLimit = record(record(data)?.rate_limit);
  if (!rateLimit) return [];
  const out: BarWindow[] = [];
  for (const key of ["primary_window", "secondary_window"] as const) {
    const entry = record(rateLimit[key]);
    if (!entry) continue;
    const used = num(entry.used_percent);
    if (used === undefined) continue;
    const seconds = num(entry.limit_window_seconds) ?? (key === "primary_window" ? H5 : D7);
    out.push(percentWindow(seconds, compactWindowLabel(seconds), used, epochMs(entry.reset_at)));
  }
  return out;
}

/** OpenCode Go: `{ usage: { rolling|weekly|monthly: { percent, resetsAt } } }` */
function nativeOpenCode(data: unknown): BarWindow[] {
  const usage = record(record(data)?.usage);
  if (!usage) return [];
  const plan: Array<[string, string, number]> = [
    ["rolling", "rolling 5h", H5],
    ["weekly", "weekly", D7],
    ["monthly", "monthly", D30],
  ];
  const out: BarWindow[] = [];
  for (const [key, nativeLabel, seconds] of plan) {
    const entry = record(usage[key]);
    if (!entry) continue;
    const status = entry.status;
    if (typeof status === "string" && status !== "ok" && status !== "rate-limited") continue;
    const used = num(entry.percent);
    if (used === undefined) continue;
    out.push(percentWindow(seconds, nativeLabel, used, epochMs(entry.resetsAt)));
  }
  return out;
}

/**
 * Z.AI / GLM Coding Plan: `{ data: { limits: [{ type, unit, number,
 * percentage, usage, currentValue, nextResetTime }] } }`
 *
 * `unit` encodes the window: 3 = hour bucket, 4 = day, 6 = week. A credit
 * window also carries real counts (`usage` = allowance, `currentValue` =
 * spent), which are surfaced instead of a bare percentage.
 */
function nativeZai(data: unknown): BarWindow[] {
  const list = record(record(data)?.data)?.limits;
  if (!Array.isArray(list)) return [];
  const out: BarWindow[] = [];
  for (const raw of list) {
    const entry = record(raw);
    if (!entry) continue;
    const type = entry.type;
    if (type !== "TOKENS_LIMIT" && type !== "CREDIT_LIMIT") continue;

    const unit = num(entry.unit);
    const count = num(entry.number) ?? 1;
    let seconds: number;
    if (unit === 3) seconds = count * 3_600;
    else if (unit === 4) seconds = count * 86_400;
    else if (unit === 6) seconds = count * 7 * 86_400;
    else continue;

    const percentage = num(entry.percentage);
    if (percentage === undefined) continue;

    const allowance = num(entry.usage);
    const spent = num(entry.currentValue);
    const hasCounts = allowance !== undefined && spent !== undefined && allowance > 0;
    const resetsAt = epochMs(entry.nextResetTime);

    out.push({
      label: compactWindowLabel(seconds),
      nativeLabel: `${count}${unit === 6 ? "w" : "h"} window`,
      usedPercent: clampPercent(percentage),
      windowSeconds: seconds,
      ...(resetsAt !== undefined && resetsAt > 0 ? { resetsAt } : {}),
      ...(hasCounts ? { hasCounts: true, usedValue: spent, limitValue: allowance } : {}),
    });
  }
  return out;
}

/**
 * MiniMax Token Plan: `{ model_remains: [{ current_interval_remaining_percent,
 * current_weekly_remaining_percent, end_time, weekly_end_time }] }`
 *
 * Both percent fields are *remaining*, so they are inverted. Window length is
 * derived from the provider's own timestamps rather than assumed.
 */
function nativeMiniMax(data: unknown): BarWindow[] {
  const list = record(data)?.model_remains;
  if (!Array.isArray(list)) return [];
  const first = record(list[0]);
  if (!first) return [];
  const out: BarWindow[] = [];

  const intervalRemaining = num(first.current_interval_remaining_percent);
  if (intervalRemaining !== undefined) {
    const seconds = durationSeconds(first.start_time, first.end_time) ?? H5;
    out.push(
      percentWindow(seconds, "5h interval", 100 - intervalRemaining, epochMs(first.end_time)),
    );
  }

  const weeklyRemaining = num(first.current_weekly_remaining_percent);
  if (weeklyRemaining !== undefined) {
    const seconds = durationSeconds(first.weekly_start_time, first.weekly_end_time) ?? D7;
    out.push(
      percentWindow(seconds, "weekly", 100 - weeklyRemaining, epochMs(first.weekly_end_time)),
    );
  }
  return out;
}

/**
 * Command Code: `{ credits, subscription, summary }` assembled by the adapter.
 *
 * Shapes (from `/alpha/billing/credits`):
 *   credits: { monthlyCredits, purchasedCredits, freeCredits }
 *   windowLimits: { fiveHour: { used, cap, resetAt }, weekly: {…} }
 *
 * The window caps are credit amounts, not percentages, so the bar derives a
 * percentage from used/cap and keeps the counts for `/subs status`.
 *
 * The monthly row is deliberately omitted: `monthlyCredits` is the credit
 * grant, not a spend ceiling, so a "monthly %" would be an invented number.
 */
function nativeCommandCode(data: unknown): BarWindow[] {
  const root = record(data);
  const limits = record(root?.credits)?.windowLimits;
  const windowLimits = record(limits) ?? record(record(root?.credits)?.windowLimits);
  if (!windowLimits) return [];

  const out: BarWindow[] = [];
  const plan: Array<[string, string, number]> = [
    ["fiveHour", "5h Rolling", H5],
    ["weekly", "Weekly", D7],
  ];
  for (const [key, nativeLabel, seconds] of plan) {
    const entry = record(windowLimits[key]);
    if (!entry) continue;
    const used = num(entry.used);
    const cap = num(entry.cap);
    if (used === undefined || cap === undefined) continue;
    // A zero cap with zero use is an unconfigured window, not a 0% bar.
    if (used === 0 && cap === 0) continue;
    const resetsAt = epochMs(entry.resetAt);
    const limited = entry.exceeded === true || (cap > 0 && used >= cap);
    out.push({
      label: compactWindowLabel(seconds),
      nativeLabel,
      usedPercent: clampPercent(cap > 0 ? (used / cap) * 100 : used > 0 ? 100 : 0),
      windowSeconds: seconds,
      ...(resetsAt !== undefined && resetsAt > 0 ? { resetsAt } : {}),
      ...(cap > 0 ? { hasCounts: true, usedValue: used, limitValue: cap } : {}),
      ...(limited ? { limited: true } : {}),
      isCurrency: true,
    });
  }
  return out;
}

function durationSeconds(start: unknown, end: unknown): number | undefined {
  const from = num(start);
  const to = num(end);
  if (from === undefined || to === undefined || to <= from) return undefined;
  return Math.round((to - from) / 1000);
}

// ---------------------------------------------------------------------------
// Dispatch
// ---------------------------------------------------------------------------

const NATIVE: Record<QuotaProviderId, (data: unknown) => BarWindow[]> = {
  claude: nativeClaude,
  codex: nativeCodex,
  commandcode: nativeCommandCode,
  opencode: nativeOpenCode,
  // OpenDesign has no usage route; a payload can never reach this.
  opendesign: () => [],
  zai: nativeZai,
  minimax: nativeMiniMax,
};

const PI_USAGE_PICKERS: Partial<
  Record<QuotaProviderId, (parsers: PiUsageParsers, data: unknown) => PiUsageWindow[]>
> = {
  claude: (p, data) => p.parseAnthropicUsage(data),
  codex: (p, data) => p.parseCodexUsage(data),
  // Command Code is intentionally absent: pi-usage's `parseCommandCodeUsage`
  // takes the *normalized* object its own client builds (windowLimits as an
  // array, plus a derived "Monthly Budget" row), not the raw `/alpha/billing`
  // payload this adapter fetches. Passing raw JSON would throw and silently
  // fall back, so the native parser below is the single implementation.
  opencode: (p, data) => p.parseOpenCodeGoUsage(data),
  zai: (p, data) => p.parseZaiUsage(data),
  minimax: (p, data) => p.parseMiniMaxUsage(data),
};

/**
 * Parse a provider payload into bar windows.
 *
 * `undefined` means nothing usable was found, which the caller reports as a
 * failure rather than rendering a provider with no numbers.
 */
export function parseProviderPayload(
  provider: QuotaProviderId,
  data: unknown,
): BarWindow[] | undefined {
  const picker = PI_USAGE_PICKERS[provider];
  if (picker) {
    const reused = viaPiUsage((parsers) => picker(parsers, data));
    if (reused) return reused;
  }
  const native = NATIVE[provider](data);
  return native.length > 0 ? native : undefined;
}

/** Stable display order: shortest window first, so 5h precedes 7d. */
export function sortWindows(windows: BarWindow[]): BarWindow[] {
  return [...windows].sort((a, b) => {
    const aw = a.windowSeconds ?? Number.MAX_SAFE_INTEGER;
    const bw = b.windowSeconds ?? Number.MAX_SAFE_INTEGER;
    if (aw !== bw) return aw - bw;
    return a.nativeLabel.localeCompare(b.nativeLabel);
  });
}
