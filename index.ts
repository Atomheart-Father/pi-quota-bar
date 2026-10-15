/**
 * Unified subscription quota bar for Pi.
 *
 * Renders ONE line covering: Claude, Codex, OpenCode Go, OpenDesign Go,
 * Z.AI / GLM Coding Plan and MiniMax Coding Plan.
 *
 * Scope boundary — Command Code / GOAT is deliberately NOT handled here.
 * `commandcode-go-for-pi` owns that provider end to end (auth, model calls,
 * failover, usage queries and its own `cc-quota` widget). This extension never
 * queries Command Code, never renders it, and never touches the `cc-quota`
 * widget, so the two systems cannot interfere.
 *
 * Design notes:
 *   - Providers without a credential are hidden entirely, so an unconfigured
 *     subscription adds no "N/A" noise.
 *   - Every fetch is independent; one failure leaves the others untouched and
 *     keeps the provider's last good numbers, marked stale.
 *   - Numbers are always server-side subscription usage. Nothing is estimated
 *     from local token counts or hardcoded prices.
 *   - Credentials are read-only, never logged, and only ever sent to the
 *     provider's own origin.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { ADAPTERS, fetchProvider } from "./adapters.ts";
import { cacheAgeLabel, loadCache, saveCache } from "./cache.ts";
import { DEFAULT_CONFIG, PROVIDER_ORDER, loadConfig, saveConfig, type QuotaBarConfig } from "./config.ts";
import { primeParsers } from "./parsers.ts";
import { PROVIDER_DESCRIPTORS } from "./registry.ts";
import { renderBarLine, renderDetail, renderSummary, type RenderInput } from "./render.ts";
import type { ProviderRecord, QuotaProviderId } from "./types.ts";
import { stripAnsi } from "./util.ts";

const WIDGET_KEY = "quota-bar";
const STATUS_KEY = "quota-bar";
/** Floor between two network refreshes, whatever the config says. */
const MIN_REFRESH_MS = 30_000;
const MAX_BACKOFF_STEPS = 4;

/** Short human labels for the provider menu and toggle messages. */
const LABELS: Record<QuotaProviderId, string> = Object.fromEntries(
  PROVIDER_DESCRIPTORS.map((descriptor) => [descriptor.id, descriptor.label]),
) as Record<QuotaProviderId, string>;

function createController(pi: ExtensionAPI) {
  let config: QuotaBarConfig = { ...DEFAULT_CONFIG, providers: { ...DEFAULT_CONFIG.providers } };
  const records = new Map<QuotaProviderId, ProviderRecord>(loadCache());

  let ctx: ExtensionContext | undefined;
  let currentPiProvider: string | undefined;
  let timer: ReturnType<typeof setInterval> | undefined;
  let debounce: ReturnType<typeof setTimeout> | undefined;
  let inFlight = false;
  let generation = 0;
  let lastRenderAt = 0;

  function theme(): RenderInput["theme"] {
    try {
      return ctx?.ui?.theme as RenderInput["theme"];
    } catch {
      // A stale context throws on access; render uncolored instead of failing.
      return undefined;
    }
  }

  function renderInput(): RenderInput {
    return {
      theme: theme(),
      records,
      currentPiProvider,
      showNoData: config.showNoData,
    };
  }

  /**
   * Render the bar. All failures are swallowed: a rendering problem must never
   * surface as a chat error or interrupt a turn.
   */
  function render(): void {
    if (!ctx || !config.enabled) return;
    try {
      if (!ctx.hasUI) return;
      if (config.placement === "statusBar") {
        ctx.ui.setWidget(WIDGET_KEY, undefined);
        const line = renderBarLine(renderInput(), 0);
        ctx.ui.setStatus(STATUS_KEY, line || undefined);
        return;
      }
      ctx.ui.setStatus(STATUS_KEY, undefined);
      const line = renderBarLine(renderInput(), 0);
      if (!line) {
        ctx.ui.setWidget(WIDGET_KEY, undefined, { placement: config.placement });
        return;
      }
      // A component (rather than a string array) lets each render call measure
      // the real terminal width, so the bar compacts instead of wrapping.
      ctx.ui.setWidget(
        WIDGET_KEY,
        (tui: { terminal?: { columns?: number } }) => {
          const fallbackWidth = (() => {
            try {
              const columns = tui?.terminal?.columns;
              return typeof columns === "number" ? columns : 0;
            } catch {
              return 0;
            }
          })();
          return {
            render: (renderWidth: number) => {
              const effective = renderWidth > 0 ? renderWidth : fallbackWidth;
              const text = renderBarLine(renderInput(), effective);
              // Always exactly one line: an empty string would still occupy a
              // row, so an empty bar renders nothing at all.
              return text ? [text] : [];
            },
            invalidate: () => {},
          };
        },
        { placement: config.placement },
      );
    } catch {
      // Never let the widget break the session.
    }
  }

  function clear(): void {
    try {
      ctx?.ui?.setStatus(STATUS_KEY, undefined);
      ctx?.ui?.setWidget(WIDGET_KEY, undefined);
    } catch {
      // ignore
    }
  }

  /**
   * How long a successful result is considered fresh.
   *
   * This is the cache TTL: it is what stops `model_select` and `agent_settled`
   * from turning into provider API calls. It deliberately matches the auto
   * refresh interval, so the timer is the thing that re-fetches and event
   * handlers only ever re-render.
   */
  function freshnessMs(): number {
    return Math.max(MIN_REFRESH_MS, config.refreshMinutes * 60_000);
  }

  function shouldFetch(id: QuotaProviderId, force: boolean): boolean {
    if (force) return true;
    const record = records.get(id);
    if (!record) return true;
    const now = Date.now();
    // Backing off after a failure.
    if (record.retryAt !== undefined && now < record.retryAt) return false;
    // Still inside the cache window.
    if (record.fetchedAt !== undefined && now - record.fetchedAt < freshnessMs()) return false;
    return true;
  }

  async function refresh(options: { force?: boolean } = {}): Promise<void> {
    if (!config.enabled) return;
    if (inFlight) return;
    const requestGeneration = generation;
    inFlight = true;
    try {
      const controller = new AbortController();
      const jobs = ADAPTERS.filter((adapter) => config.providers[adapter.id]).map((adapter) =>
        (async () => {
          if (!shouldFetch(adapter.id, options.force === true)) return;
          const outcome = await fetchProvider(adapter, controller.signal);
          if (requestGeneration !== generation) return;
          const previous = records.get(adapter.id);
          const now = Date.now();

          if (outcome.kind === "ok") {
            records.set(adapter.id, {
              outcome,
              fetchedAt: now,
              failureStreak: 0,
            });
            return;
          }

          const streak = (previous?.failureStreak ?? 0) + 1;
          const retryAt = now + freshnessMs() * 2 ** Math.min(streak, MAX_BACKOFF_STEPS);

          // A provider with a credential but no readable usage is a stable
          // fact, not a failure to retry with backoff.
          if (outcome.kind === "unavailable" || outcome.kind === "not_applicable" || outcome.kind === "unconfigured") {
            records.set(adapter.id, { outcome, failureStreak: 0 });
            return;
          }

          // Keep the last good numbers, marked stale, instead of blanking a
          // provider that was working a moment ago. Without a previous success
          // there is nothing to preserve, so the error stands on its own.
          const keptWindows = previous?.outcome.kind === "ok" ? previous.outcome : undefined;
          const staleReason = outcome.kind === "error" ? outcome.reason : "no usage data";
          records.set(adapter.id, {
            ...(keptWindows
              ? { outcome: keptWindows, staleReason, fetchedAt: previous?.fetchedAt }
              : { outcome }),
            retryAt,
            failureStreak: streak,
          });
        })(),
      );
      await Promise.allSettled(jobs);
      if (requestGeneration === generation) {
        saveCache(records);
        render();
        lastRenderAt = Date.now();
      }
    } finally {
      inFlight = false;
    }
  }

  function scheduleRefresh(delayMs = 0): void {
    if (debounce) clearTimeout(debounce);
    debounce = setTimeout(() => {
      debounce = undefined;
      void refresh().catch(() => undefined);
    }, delayMs);
    debounce.unref?.();
  }

  function startTimer(): void {
    stopTimer();
    if (!config.enabled) return;
    const intervalMs = Math.max(MIN_REFRESH_MS, config.refreshMinutes * 60_000);
    timer = setInterval(() => {
      void refresh().catch(() => undefined);
    }, intervalMs);
    timer.unref?.();
  }

  function stopTimer(): void {
    if (timer) clearInterval(timer);
    timer = undefined;
  }

  return {
    get config(): QuotaBarConfig {
      return config;
    },
    get records(): ReadonlyMap<QuotaProviderId, ProviderRecord> {
      return records;
    },
    load(): void {
      config = loadConfig();
    },
    /**
     * Enable/disable the whole bar. Persisted, so it survives a restart.
     */
    setEnabled(enabled: boolean): void {
      config = { ...config, enabled };
      saveConfig(config);
      if (enabled) {
        render();
        scheduleRefresh(0);
        startTimer();
      } else {
        clear();
        stopTimer();
      }
    },
    /**
     * Enable/disable a single provider. Persisted.
     *
     * Disabling forgets the cached numbers so a later re-enable cannot briefly
     * show stale data from before the switch, and so a disabled provider makes
     * no network requests at all.
     */
    setProvider(id: QuotaProviderId, enabled: boolean): void {
      config = { ...config, providers: { ...config.providers, [id]: enabled } };
      saveConfig(config);
      if (!enabled) records.delete(id);
      render();
      if (enabled) scheduleRefresh(0);
    },
    providerState(id: QuotaProviderId): string {
      const record = records.get(id);
      if (!record) return "not queried";
      if (record.outcome.kind === "ok") {
        const age = record.fetchedAt !== undefined ? cacheAgeLabel(record.fetchedAt) : "?";
        return record.staleReason !== undefined ? `stale (${age})` : `ok (${age})`;
      }
      if (record.outcome.kind === "error") return `error: ${record.outcome.reason}`;
      if (record.outcome.kind === "unavailable") return `no usage API: ${record.outcome.reason}`;
      if (record.outcome.kind === "not_applicable") return `n/a: ${record.outcome.reason}`;
      return `not configured: ${record.outcome.reason}`;
    },
    async refresh(options: { force?: boolean } = {}): Promise<void> {
      await refresh(options);
    },
    renderDetailLines(): string[] {
      return renderDetail(renderInput());
    },
    renderSummaryLine(): string {
      return renderSummary(renderInput());
    },
    lastRenderAt(): number {
      return lastRenderAt;
    },
    onSessionStart(sessionCtx: ExtensionContext): void {
      generation += 1;
      ctx = sessionCtx;
      currentPiProvider = sessionCtx.model?.provider;
      render();
      scheduleRefresh(1_200);
      startTimer();
    },
    onModelSelect(nextCtx: ExtensionContext, provider: string | undefined): void {
      ctx = nextCtx;
      currentPiProvider = provider;
      // The highlight moves immediately. A fetch only happens when the cached
      // data has aged past the TTL, so switching models is free in the common
      // case; this also picks up a provider that was just configured.
      render();
      scheduleRefresh(300);
    },
    onSettled(nextCtx: ExtensionContext): void {
      ctx = nextCtx;
      // Cheap due to the cache window; keeps the bar honest after long runs.
      scheduleRefresh(500);
    },
    shutdown(): void {
      generation += 1;
      stopTimer();
      if (debounce) clearTimeout(debounce);
      debounce = undefined;
      clear();
      ctx = undefined;
    },
  };
}

export default async function (pi: ExtensionAPI) {
  const controller = createController(pi);
  controller.load();

  // Load pi-usage's parsers once, so a provider's payload is normalized by the
  // same maintained code the rest of the ecosystem uses.
  await primeParsers().catch(() => undefined);

  /**
   * Interactive per-provider menu.
   *
   * Each row toggles on selection and the menu redraws, so several providers
   * can be changed in one visit. Mirrors the ergonomics of Pi's own settings
   * dialogs while keeping the config file as the single source of truth.
   */
  async function providerMenu(cmdCtx: ExtensionContext): Promise<void> {
    for (;;) {
      const choices = PROVIDER_ORDER.map((id) => {
        const on = controller.config.providers[id];
        return `${on ? "✓" : "✗"}  ${LABELS[id]}  —  ${controller.providerState(id)}`;
      });
      choices.push("Done");

      const picked = await cmdCtx.ui.select("Subscription providers", choices);
      if (!picked || picked === "Done") return;

      const id = PROVIDER_ORDER.find((candidate) =>
        picked.startsWith(`${controller.config.providers[candidate] ? "✓" : "✗"}  ${LABELS[candidate]}`),
      );
      if (!id) continue;
      controller.setProvider(id, !controller.config.providers[id]);
    }
  }

  pi.registerCommand("subs", {
    description: "Subscription quota bar: /subs [status|providers|on|off|refresh]",
    handler: async (args, cmdCtx) => {
      const arg = (args ?? "").trim().toLowerCase();
      const report = (text: string) => {
        try {
          cmdCtx.ui.notify(text, "info");
        } catch {
          // A mode without a notify surface: the command is a no-op, not a crash.
        }
      };

      if (arg === "off" || arg === "on") {
        controller.setEnabled(arg === "on");
        report(arg === "on" ? "Quota bar enabled." : "Quota bar disabled.");
        return;
      }

      if (arg === "status" || arg === "detail") {
        report(controller.renderDetailLines().join("\n"));
        return;
      }

      if (arg === "providers") {
        // Interactive when a selector is available (TUI and RPC); the plain
        // listing is the fallback for print/json modes.
        if (cmdCtx.hasUI && typeof cmdCtx.ui?.select === "function") {
          await providerMenu(cmdCtx);
          return;
        }
        const lines = PROVIDER_ORDER.map(
          (id) =>
            `${controller.config.providers[id] ? "[x]" : "[ ]"} ${id}: ${controller.providerState(id)}`,
        );
        report(lines.join("\n"));
        return;
      }

      // `on <provider>` / `off <provider>`: scriptable, no dialog needed.
      const toggle = /^(on|off)\s+(.+)$/.exec(arg);
      if (toggle) {
        const [, verb, name] = toggle;
        const id = PROVIDER_ORDER.find(
          (candidate) => candidate === name || LABELS[candidate].toLowerCase() === name || LABELS[candidate].toLowerCase().startsWith(name ?? ""),
        );
        if (!id) {
          report(`Unknown provider "${name}". Try: ${PROVIDER_ORDER.join(", ")}`);
          return;
        }
        controller.setProvider(id, verb === "on");
        report(`${LABELS[id]} ${verb === "on" ? "enabled" : "disabled"}.`);
        return;
      }

      await controller.refresh({ force: true });
      report(stripAnsi(controller.renderSummaryLine()));
    },
  });

  pi.on("session_start", async (_event, sessionCtx) => {
    controller.load();
    controller.onSessionStart(sessionCtx);
  });

  pi.on("model_select", async (event, sessionCtx) => {
    controller.onModelSelect(sessionCtx, event?.model?.provider);
  });

  pi.on("agent_settled", async (_event, sessionCtx) => {
    controller.onSettled(sessionCtx);
  });

  pi.on("session_shutdown", async () => {
    controller.shutdown();
  });
}
