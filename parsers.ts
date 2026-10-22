/**
 * Provider response parsing.
 *
 * Every provider is parsed here from the official payload shape. Nothing is
 * delegated to another extension: one file owns the mapping, so a rename or an
 * uninstall elsewhere cannot silently blank the bar.
 *
 * Nothing here estimates usage. A provider that does not report an allowance
 * yields no window, and the caller reports that as missing data.
 */

import type { BarWindow, QuotaProviderId } from "./types.ts";
import { clampPercent, compactWindowLabel, num } from "./util.ts";

// ---------------------------------------------------------------------------
// Native parsers
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
  codex: nativeCodex,
  commandcode: nativeCommandCode,
  opencode: nativeOpenCode,
  // OpenDesign has no usage route; a payload can never reach this.
  opendesign: () => [],
  zai: nativeZai,
  minimax: nativeMiniMax,
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
