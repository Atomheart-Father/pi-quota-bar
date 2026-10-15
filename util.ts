/**
 * Small self-contained helpers. No dependency on pi-tui, so the module also
 * loads in environments where the TUI package is not resolvable.
 */

const ANSI_RE = /\u001b\[[0-9;]*m|\u001b\][^\u0007]*\u0007/g;
const SECRET_RE =
  /\b(?:Bearer\s+)?(?:sk-[A-Za-z0-9_-]{8,}|user_[A-Za-z0-9_-]{8,}|oc_sk_[A-Za-z0-9_-]{8,}|rt\.1\.[A-Za-z0-9._-]{8,}|eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,})\b/g;

export function stripAnsi(text: string): string {
  return text.replace(ANSI_RE, "");
}

/** Terminal display width, counting CJK/emoji as 2 columns. */
export function visibleWidth(text: string): number {
  const stripped = stripAnsi(text);
  let width = 0;
  for (const char of stripped) {
    const cp = char.codePointAt(0) ?? 0;
    if (
      (cp >= 0x1100 && cp <= 0x115f) ||
      (cp >= 0x2e80 && cp <= 0xa4cf && cp !== 0x303f) ||
      (cp >= 0xac00 && cp <= 0xd7a3) ||
      (cp >= 0xf900 && cp <= 0xfaff) ||
      (cp >= 0xfe30 && cp <= 0xfe6f) ||
      (cp >= 0xff00 && cp <= 0xff60) ||
      (cp >= 0xffe0 && cp <= 0xffe6) ||
      (cp >= 0x1f300 && cp <= 0x1f64f) ||
      (cp >= 0x1f900 && cp <= 0x1f9ff) ||
      (cp >= 0x20000 && cp <= 0x3fffd)
    ) {
      width += 2;
    } else if (cp >= 0x0300 && cp <= 0x036f) {
      // combining marks are zero-width
    } else {
      width += 1;
    }
  }
  return width;
}

/**
 * Last-resort truncation. Only reached when every compaction tier still does
 * not fit, so losing the provider colors here is acceptable.
 */
export function hardTruncate(text: string, width: number): string {
  if (width <= 0) return "";
  if (visibleWidth(text) <= width) return text;
  const plain = stripAnsi(text);
  let out = "";
  let used = 0;
  for (const char of plain) {
    const w = visibleWidth(char);
    if (used + w > width - 1) break;
    out += char;
    used += w;
  }
  return `${out}…`;
}

type ThemeLike = { fg?: (color: string, text: string) => string } | undefined;

/**
 * Theme-aware coloring that never throws and never blanks the text. An unknown
 * color name or a stale UI context falls back to the uncolored string.
 */
export function paint(theme: ThemeLike, color: string, text: string): string {
  if (!text) return text;
  const fg = theme?.fg;
  if (typeof fg !== "function") return text;
  try {
    const out = fg.call(theme, color, text);
    return typeof out === "string" && out.length > 0 ? out : text;
  } catch {
    return text;
  }
}

/** Strip anything credential-shaped from text that may reach the UI or disk. */
export function redact(text: string, extraSecrets: readonly string[] = []): string {
  let out = String(text ?? "");
  for (const secret of extraSecrets) {
    if (!secret || secret.length < 8) continue;
    out = out.split(secret).join("[redacted]");
  }
  return out.replace(SECRET_RE, "[redacted]").replace(/\s+/g, " ").trim().slice(0, 180);
}

export function num(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

export function clampPercent(value: number): number {
  return Math.min(100, Math.max(0, value));
}

/**
 * Map a window length to the compact cross-provider label used in the bar.
 * Providers name the same window differently ("5h Rolling", "主窗口", "general"),
 * so the label is derived from the duration the provider itself reports.
 */
export function compactWindowLabel(windowSeconds: number | undefined): string {
  if (!windowSeconds || windowSeconds <= 0) return "";
  if (windowSeconds % 86_400 === 0) return `${windowSeconds / 86_400}d`;
  if (windowSeconds % 3_600 === 0) return `${windowSeconds / 3_600}h`;
  if (windowSeconds % 60 === 0) return `${windowSeconds / 60}m`;
  return `${windowSeconds}s`;
}

/** Human reset countdown: `2h`, `3d4h`. */
export function formatReset(resetsAt: number | undefined, now = Date.now()): string {
  if (!resetsAt || !Number.isFinite(resetsAt)) return "";
  const diff = resetsAt - now;
  if (diff <= 0) return "now";
  const minutes = Math.floor(diff / 60_000);
  if (minutes < 60) return `${Math.max(1, minutes)}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) {
    const rest = minutes % 60;
    return rest > 0 ? `${hours}h${rest}m` : `${hours}h`;
  }
  const days = Math.floor(hours / 24);
  const restHours = hours % 24;
  return restHours > 0 ? `${days}d${restHours}h` : `${days}d`;
}
