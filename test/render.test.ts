/**
 * Deterministic display tests for the quota bar.
 *
 * These run offline against hand-built records, so they cover the states that
 * are awkward to trigger against live APIs: stale last-good data, a provider
 * with no readable usage, an exhausted window, and narrow terminals.
 *
 * Run: node --experimental-strip-types test/render.test.ts
 */

import assert from "node:assert/strict";
import test from "node:test";
import type { ProviderRecord, QuotaProviderId } from "../types.ts";
import { renderBarLine, renderDetail } from "../render.ts";
import { stripAnsi, visibleWidth, redact, compactWindowLabel } from "../util.ts";

const H5 = 5 * 3600;
const D7 = 7 * 86_400;

// Emits real SGR codes, so the assertions exercise stripAnsi (the way the
// real TUI theme behaves) instead of comparing markup.
const theme = {
  fg: (_color: string, text: string) => `\u001b[36m${text}\u001b[0m`,
  bold: (text: string) => `\u001b[1m${text}\u001b[0m`,
};

function record(partial: Partial<ProviderRecord> & Pick<ProviderRecord, "outcome">): ProviderRecord {
  return { failureStreak: 0, ...partial };
}

const okClaude = record({
  outcome: {
    kind: "ok",
    windows: [
      { label: "5h", nativeLabel: "5h", usedPercent: 12, windowSeconds: H5, resetsAt: Date.now() + 3 * 3600_000 },
      { label: "7d", nativeLabel: "7d", usedPercent: 42, windowSeconds: D7, resetsAt: Date.now() + 4 * 86_400_000 },
    ],
  },
  fetchedAt: Date.now(),
});

const okCodex = record({
  outcome: {
    kind: "ok",
    windows: [
      { label: "5h", nativeLabel: "5h", usedPercent: 7, windowSeconds: H5 },
      { label: "7d", nativeLabel: "7d", usedPercent: 23, windowSeconds: D7 },
      // Untimed row that must stay out of the compact bar.
      { label: "", nativeLabel: "Spend cap", usedPercent: 0, windowSeconds: 0 },
    ],
  },
  fetchedAt: Date.now(),
});

function build(records: Partial<Record<QuotaProviderId, ProviderRecord>>, current?: string) {
  return {
    theme,
    records: new Map(Object.entries(records) as Array<[QuotaProviderId, ProviderRecord]>),
    currentPiProvider: current,
    showNoData: true,
  };
}

test("renders all configured providers on one line", () => {
  const line = stripAnsi(renderBarLine(build({ claude: okClaude, codex: okCodex }, "anthropic"), 400));
  assert.match(line, /Claude 5h 12%/);
  assert.match(line, /7d 42%/);
  assert.match(line, /Codex 5h 7% 7d 23%/);
  assert.equal(line.includes("\n"), false, "must be a single line");
});

test("untimed rows never leak into the compact bar", () => {
  const line = stripAnsi(renderBarLine(build({ codex: okCodex }), 400));
  assert.equal(/Spend cap/.test(line), false);
});

test("stale last-good data keeps its numbers and is marked", () => {
  const stale = record({
    outcome: okClaude.outcome,
    fetchedAt: Date.now() - 20 * 60_000,
    staleReason: "HTTP 503",
  });
  const line = stripAnsi(renderBarLine(build({ claude: stale }), 400));
  assert.match(line, /Claude 5h 12%/, "real numbers are preserved");
  assert.match(line, /⌛/, "marked stale rather than blanked");
});

test("an error with no last-good data shows a compact marker", () => {
  const broken: ProviderRecord = { outcome: { kind: "error", reason: "timeout" }, failureStreak: 2 };
  const line = stripAnsi(renderBarLine(build({ claude: broken }), 400));
  assert.match(line, /Claude ✗/);
});

test("unavailable provider is marked but never invents numbers", () => {
  const od = record({ outcome: { kind: "unavailable", reason: "no control-plane usage API" } });
  const line = stripAnsi(renderBarLine(build({ opendesign: od }, "opendesign"), 400));
  assert.match(line, /▸ OD —/);
  assert.equal(/\d+%/.test(line), false);
});

test("unconfigured providers are hidden entirely", () => {
  const line = stripAnsi(
    renderBarLine(
      build({
        claude: okClaude,
        codex: record({ outcome: { kind: "unconfigured", reason: "no credential" } }),
      }),
      400,
    ),
  );
  assert.equal(line.includes("Codex"), false);
});

test("active provider is highlighted only when it has data", () => {
  const line = renderBarLine(build({ claude: okClaude, codex: okCodex }, "opencode-go"), 400);
  assert.equal(stripAnsi(line).includes("▸ Claude"), false, "no highlight for an unrelated provider");
  const yes = renderBarLine(build({ claude: okClaude, codex: okCodex }, "anthropic"), 400);
  assert.match(stripAnsi(yes), /▸ Claude/);
  assert.match(yes, /\u001b\[1m/, "active label is bold");
});

test("the line never exceeds the available width", () => {
  const records = {
    claude: okClaude,
    codex: okCodex,
    opendesign: record({ outcome: { kind: "unavailable", reason: "none" } }),
  };
  for (const width of [0, 200, 160, 120, 100, 80, 60, 45, 30]) {
    const line = renderBarLine(build(records, "opendesign"), width);
    if (width > 0) {
      assert.ok(
        visibleWidth(line) <= width,
        `width ${width} exceeded by ${visibleWidth(line)}: ${stripAnsi(line)}`,
      );
    }
    assert.equal(line.includes("\n"), false);
  }
});

test("narrow terminals drop detail before dropping providers", () => {
  const records = { claude: okClaude, codex: okCodex };
  const wide = stripAnsi(renderBarLine(build(records), 200));
  const mid = stripAnsi(renderBarLine(build(records), 46));
  // Wide: resets present. Mid: resets dropped, window labels kept.
  assert.match(wide, /↺/, "wide view keeps resets");
  assert.equal(mid.includes("↺"), false, "mid view drops resets");
  assert.match(mid, /5h 12%/);

  // At tier 3 the labels are gone but both providers still fit side by side.
  const tier3 = stripAnsi(renderBarLine(build(records), 200));
  const bothWidth = visibleWidth(stripAnsi(renderBarLine(build(records), 24)));
  const narrow = stripAnsi(renderBarLine(build(records), bothWidth));
  assert.equal(narrow.includes("5h"), false, "labels drop before providers");
  assert.match(narrow, /Claude 12%/);
  assert.match(narrow, /Codex 7%/);
  void tier3;
});

test("providers drop cleanly rather than truncating mid-name", () => {
  const line = stripAnsi(renderBarLine(build({ claude: okClaude, codex: okCodex }), 12));
  // A single provider survives intact; no half-written provider name.
  assert.match(line, /Claude/);
  assert.equal(line.includes("Cod"), false, "never emits a partial provider label");
  assert.equal(line.includes("\u2026"), false, "no ellipsis inside a provider label");
});

test("an exhausted window is surfaced over an idle short window", () => {
  const exhausted = record({
    outcome: {
      kind: "ok",
      windows: [
        { label: "5h", nativeLabel: "5h", usedPercent: 0, windowSeconds: H5 },
        { label: "7d", nativeLabel: "7d", usedPercent: 100, windowSeconds: D7, limited: true },
      ],
    },
    fetchedAt: Date.now(),
  });
  const line = stripAnsi(renderBarLine(build({ claude: exhausted }), 40));
  assert.match(line, /100%/, "the spent window is what fits");
  assert.match(line, /!/, "exhaustion is flagged");
});

test("detail view reports reasons and counts", () => {
  const lines = renderDetail(build({ claude: okClaude, codex: okCodex }, "anthropic")).map(stripAnsi);
  const text = lines.join("\n");
  assert.match(text, /Claude Pro\/Max/);
  assert.match(text, /▸ Claude Pro\/Max/, "active provider highlighted in detail");
  assert.match(text, /Spend cap/, "detail keeps untimed rows");
});

test("redact removes credential-shaped strings", () => {
  // Obviously-synthetic values: they match the shape redaction targets, but
  // read as placeholders so no secret scanner mistakes them for a real key.
  const body = "NOTAREALKEY-placeholder";
  assert.equal(redact(`token sk-ant-oat01-${body} failed`).includes(body), false);
  assert.equal(redact(`key user_${body}`).includes(body), false);
  assert.equal(redact(`oc_sk_${body} leaked`).includes(body), false);
  assert.equal(redact(`Bearer rt.1.${body}`).includes(body), false);
});

test("window labels derive from the reported duration", () => {
  assert.equal(compactWindowLabel(H5), "5h");
  assert.equal(compactWindowLabel(D7), "7d");
  assert.equal(compactWindowLabel(30 * 86_400), "30d");
  assert.equal(compactWindowLabel(0), "");
  assert.equal(compactWindowLabel(undefined), "");
});
