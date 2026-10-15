/**
 * Shared types for the unified subscription quota bar.
 *
 * Scope: Claude, Codex, OpenCode Go, OpenDesign Go, Z.AI, MiniMax.
 * Command Code / GOAT is deliberately absent — `commandcode-go-for-pi` owns
 * that provider and renders its own `cc-quota` widget. Nothing here reads,
 * queries or renders Command Code.
 */

export type QuotaProviderId =
  | "claude"
  | "codex"
  | "opencode"
  | "opendesign"
  | "zai"
  | "minimax";

/** One usage window, normalized across providers. */
export interface BarWindow {
  /** Compact cross-provider label: `5h`, `7d`, `30d`. */
  label: string;
  /** Percent *used* (0-100), matching the pi-usage/pi-subs convention. */
  usedPercent: number;
  /** Epoch ms. Absent when the provider does not report a reset. */
  resetsAt?: number;
  /** Window length in seconds, when known. */
  windowSeconds?: number;
  /** Provider reports this window as exhausted. */
  limited?: boolean;
  /** Provider-native label, shown by the detail command. */
  nativeLabel: string;
  /** True when the provider reports real used/limit counts. */
  hasCounts?: boolean;
  usedValue?: number;
  limitValue?: number;
  /** Currency window (credits/balance) rather than a percentage. */
  isCurrency?: boolean;
}

export type AdapterOutcome =
  /** Real numbers in hand. */
  | { kind: "ok"; windows: BarWindow[]; notes?: string[] }
  /** No credential for this provider — the bar hides it entirely. */
  | { kind: "unconfigured"; reason: string }
  /** Credential exists but this usage surface does not apply to it. */
  | { kind: "not_applicable"; reason: string }
  /** Credential exists, but no control-plane usage API exists. */
  | { kind: "unavailable"; reason: string }
  /** Fetch/parse failed. Last good numbers may still be shown as stale. */
  | { kind: "error"; reason: string };

export interface ProviderRecord {
  outcome: AdapterOutcome;
  /** Epoch ms of the last successful fetch. */
  fetchedAt?: number;
  /** Epoch ms before which no retry should be attempted (backoff). */
  retryAt?: number;
  failureStreak: number;
  /**
   * Set when the most recent fetch failed but last-good windows are still
   * being displayed. `outcome` then still holds those windows, so the bar keeps
   * showing real numbers marked stale rather than blanking the provider.
   */
  staleReason?: string;
}
