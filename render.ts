/**
 * Single-line rendering.
 *
 * Hard requirement: the bar is exactly one line, always. When the terminal is
 * too narrow it compacts in tiers rather than wrapping or replacing the chat
 * area with a panel:
 *
 *   tier 0  ⌁ Codex 5h 7% ↺2h 7d 42% ↺4d │ ▸ CMD 5h 25% ↺2h 7d 76% ↺4d
 *   tier 1  ⌁ Codex 5h 7% 7d 42% │ ▸ CMD 5h 25% 7d 76%
 *   tier 2  ⌁ Codex 5h 7% │ ▸ CMD 5h 25%
 *   tier 3  ⌁ Codex 7% │ ▸ CMD 25%
 *
 * Only if every tier still overflows are trailing providers dropped. The active
 * provider is never dropped, so the ▸ highlight cannot vanish.
 *
 * This module is pure: it reads no credentials and performs no I/O, which is
 * what lets the display rules be tested offline.
 */

import type { BarWindow, ProviderRecord, QuotaProviderId } from "./types.ts";
import { PROVIDER_DESCRIPTORS, type ProviderDescriptor } from "./registry.ts";
import { clampPercent, formatReset, hardTruncate, paint, stripAnsi, visibleWidth } from "./util.ts";

type Theme = { fg?: (color: string, text: string) => string; bold?: (text: string) => string } | undefined;

export interface RenderInput {
  theme: Theme;
  records: ReadonlyMap<QuotaProviderId, ProviderRecord>;
  /** Active model's Pi provider id, used for the ▸ highlight. */
  currentPiProvider: string | undefined;
  /** Show providers that have a credential but no readable usage. */
  showNoData: boolean;
  /** Epoch ms, injectable for tests. */
  now?: number;
}

type Windows = BarWindow[];

/** A provider contributes a segment only when it has something honest to say. */
type Visible =
  | { kind: "windows"; descriptor: ProviderDescriptor; windows: Windows; stale: boolean }
  | { kind: "nodata"; descriptor: ProviderDescriptor; marker: string; color: string };

function isCurrent(descriptor: ProviderDescriptor, currentPiProvider: string | undefined): boolean {
  return currentPiProvider !== undefined && descriptor.piProviders.includes(currentPiProvider);
}

/**
 * A window is worth showing when it carries a real percentage *and* describes
 * an actual time window.
 *
 * Providers attach non-window rows to the same payload — Codex ships a
 * `Spend cap` flag — with `windowSeconds: 0`. Those are not subscription
 * allowance and would read as `Spend cap 0%`. They stay out of the compact bar
 * but remain visible in `/subs status`.
 */
function usableWindows(record: ProviderRecord): Windows | undefined {
  if (record.outcome.kind !== "ok") return undefined;
  const withPercent = record.outcome.windows.filter((w) => Number.isFinite(w.usedPercent));
  const timed = withPercent.filter((w) => (w.windowSeconds ?? 0) > 0);
  const windows = timed.length > 0 ? timed : withPercent;
  return windows.length > 0 ? windows : undefined;
}

/**
 * Pick the window that represents the provider when only one fits.
 *
 * The shortest window is the usual convention, but a spent one is the most
 * actionable fact on screen and must not hide behind an idle 5h bar.
 */
function pickPrimary(windows: Windows | undefined): BarWindow | undefined {
  if (!windows || windows.length === 0) return undefined;
  return (
    windows.find((w) => w.limited) ??
    windows.find((w) => w.usedPercent >= 100) ??
    windows[0]
  );
}

function selectVisible(input: RenderInput): Visible[] {
  const now = input.now ?? Date.now();
  const out: Visible[] = [];
  for (const descriptor of PROVIDER_DESCRIPTORS) {
    const record = input.records.get(descriptor.id);
    if (!record) continue;
    const { outcome } = record;

    // No credential, or the usage surface does not apply to this credential
    // type: contribute nothing rather than a placeholder.
    if (outcome.kind === "unconfigured" || outcome.kind === "not_applicable") continue;

    if (outcome.kind === "unavailable") {
      if (input.showNoData) {
        out.push({ kind: "nodata", descriptor, marker: "—", color: "dim" });
      }
      continue;
    }

    const windows = usableWindows(record);
    if (!windows) {
      if (input.showNoData) {
        out.push({ kind: "nodata", descriptor, marker: "✗", color: "error" });
      }
      continue;
    }

    const stale =
      record.staleReason !== undefined ||
      record.fetchedAt === undefined ||
      now - record.fetchedAt > 30 * 60_000;
    out.push({ kind: "windows", descriptor, windows, stale });
  }
  return out;
}

const SEVERITY_WARNING = 70;
const SEVERITY_ERROR = 90;

/** Restrained by default: only at-risk values draw the eye. */
function percentColor(percent: number, stale: boolean): string {
  if (stale) return "warning";
  if (percent >= SEVERITY_ERROR) return "error";
  if (percent >= SEVERITY_WARNING) return "warning";
  return "text";
}

function paintBold(theme: Theme, text: string): string {
  const bold = theme?.bold;
  if (typeof bold !== "function") return text;
  try {
    const out = bold.call(theme, text);
    return typeof out === "string" && out.length > 0 ? out : text;
  } catch {
    return text;
  }
}

/** The active provider's label: accent color plus bold, nothing more. */
function activeLabel(theme: Theme, text: string): string {
  return paintBold(theme, paint(theme, "accent", text));
}

function renderWindowsSegment(
  item: Extract<Visible, { kind: "windows" }>,
  input: RenderInput,
  tier: number,
): string {
  const { theme } = input;
  const current = isCurrent(item.descriptor, input.currentPiProvider);
  const label = current
    ? activeLabel(theme, `▸ ${item.descriptor.label}`)
    : paint(theme, "muted", item.descriptor.label);

  const shown = tier >= 2 ? [pickPrimary(item.windows)].filter((w): w is BarWindow => w !== undefined) : item.windows;
  const withResets = tier === 0;
  const now = input.now ?? Date.now();

  const parts: string[] = [];
  for (const window of shown) {
    const percent = clampPercent(window.usedPercent);
    const value = paint(theme, percentColor(percent, item.stale), `${Math.round(percent)}%`);
    // Tier 3 drops the window label when even `Name 5h 7%` is too wide.
    const windowLabel = tier >= 3 || !window.label ? "" : `${paint(theme, "dim", window.label)} `;
    const reset = withResets ? formatReset(window.resetsAt, now) : "";
    const resetText = reset ? paint(theme, "dim", ` ↺${reset}`) : "";
    parts.push(`${windowLabel}${value}${resetText}`);
  }

  const exhausted = item.windows.some((w) => w.limited);
  const limitMark = exhausted ? paint(theme, "error", " !") : "";
  const staleMark = item.stale ? paint(theme, "warning", " ⌛") : "";
  return `${label} ${parts.join(" ")}${limitMark}${staleMark}`;
}

function renderSegment(item: Visible, input: RenderInput, tier: number): string {
  if (item.kind === "nodata") {
    const current = isCurrent(item.descriptor, input.currentPiProvider);
    const label = current
      ? activeLabel(input.theme, `▸ ${item.descriptor.label}`)
      : paint(input.theme, "muted", item.descriptor.label);
    return `${label} ${paint(input.theme, item.color, item.marker)}`;
  }
  return renderWindowsSegment(item, input, tier);
}

/**
 * Build the single bar line, compacting until it fits `width`.
 *
 * Tiers trade detail for space in the order the bar is read: resets go first
 * (they remain available in `/subs status`), then secondary windows, then
 * window labels.
 *
 * `width <= 0` means "unknown", which renders the richest tier.
 */
export function renderBarLine(input: RenderInput, width: number): string {
  const visible = selectVisible(input);
  if (visible.length === 0) return "";

  const prefix = paint(input.theme, "dim", "⌁ ");
  const separator = paint(input.theme, "dim", " │ ");
  const build = (items: Visible[], tier: number): string =>
    prefix + items.map((item) => renderSegment(item, input, tier)).join(separator);

  for (let tier = 0; tier <= 3; tier += 1) {
    const line = build(visible, tier);
    if (width <= 0 || visibleWidth(line) <= width) return line;
  }

  // Last resort: drop trailing providers at the most compact tier.
  const current = visible.find(
    (item) => item.kind === "windows" && isCurrent(item.descriptor, input.currentPiProvider),
  );
  for (let keep = visible.length - 1; keep >= 1; keep -= 1) {
    let items = visible.slice(0, keep);
    if (current && !items.includes(current)) items = [...items, current];
    const line = build(items, 3);
    if (visibleWidth(line) <= width) return line;
  }

  const only = current ? [current] : [visible[0]!];
  return hardTruncate(build(only, 3), width);
}

/** Detail view for `/subs status`: full labels, counts, resets and reasons. */
export function renderDetail(input: RenderInput): string[] {
  const now = input.now ?? Date.now();
  const lines: string[] = [];
  for (const descriptor of PROVIDER_DESCRIPTORS) {
    const record = input.records.get(descriptor.id);
    const current = isCurrent(descriptor, input.currentPiProvider);
    const name = current ? `▸ ${descriptor.longLabel}` : `  ${descriptor.longLabel}`;

    if (!record) {
      lines.push(`${name}: not queried yet`);
      continue;
    }
    const { outcome } = record;

    if (outcome.kind === "unconfigured") {
      lines.push(`${name}: not configured — ${outcome.reason}`);
      continue;
    }
    if (outcome.kind === "not_applicable") {
      lines.push(`${name}: n/a — ${outcome.reason}`);
      continue;
    }
    if (outcome.kind === "unavailable") {
      lines.push(`${name}: no usage API — ${outcome.reason}`);
      continue;
    }
    if (outcome.kind === "error") {
      // A provider showing last-good numbers marks itself stale in the bar;
      // the underlying reason is only surfaced here.
      if (record.staleReason !== undefined && record.fetchedAt !== undefined) {
        const age = Math.round((now - record.fetchedAt) / 60_000);
        lines.push(`${name}: stale (last good ${age}m ago) — ${record.staleReason}`);
        continue;
      }
      const age = record.fetchedAt !== undefined
        ? ` (last good ${Math.round((now - record.fetchedAt) / 60_000)}m ago)`
        : "";
      lines.push(`${name}: error — ${outcome.reason}${age}`);
      continue;
    }

    // The detail view keeps every reported window, including untimed rows the
    // compact bar filters out.
    if (outcome.windows.length === 0) {
      lines.push(`${name}: no windows reported`);
      continue;
    }
    const detail = outcome.windows
      .map((w) => {
        const value = `${Math.round(clampPercent(w.usedPercent))}%`;
        const counts = w.hasCounts
          ? ` (${Math.round(w.usedValue ?? 0)}/${Math.round(w.limitValue ?? 0)})`
          : "";
        const reset = w.resetsAt ? ` ↺${formatReset(w.resetsAt, now)}` : "";
        const windowLabel = w.label || w.nativeLabel;
        return `${windowLabel} ${value}${counts}${reset}`;
      })
      .join(" · ");
    const age = record.fetchedAt !== undefined
      ? ` · ${Math.round((now - record.fetchedAt) / 60_000)}m ago`
      : "";
    const staleTag = record.staleReason !== undefined ? " [stale]" : "";
    lines.push(`${name}: ${detail}${age}${staleTag}`);
  }
  return lines;
}

/** Plain summary used by notify() and by the read-only probe. */
export function renderSummary(input: RenderInput): string {
  const visible = selectVisible(input);
  const live = visible.filter((item) => item.kind === "windows").length;
  const line = stripAnsi(renderBarLine(input, 0));
  return line ? `${line}  [${live} live]` : `no providers configured [${live} live]`;
}
