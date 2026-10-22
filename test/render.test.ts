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

const okZai = record({
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
  const line = stripAnsi(renderBarLine(build({ zai: okZai, codex: okCodex }, "zai-coding-cn"), 400));
  assert.match(line, /Z\.AI 5h 12%/);
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
    outcome: okZai.outcome,
    fetchedAt: Date.now() - 20 * 60_000,
    staleReason: "HTTP 503",
  });
  const line = stripAnsi(renderBarLine(build({ zai: stale }), 400));
  assert.match(line, /Z\.AI 5h 12%/, "real numbers are preserved");
  assert.match(line, /⌛/, "marked stale rather than blanked");
});

test("an error with no last-good data shows a compact marker", () => {
  const broken: ProviderRecord = { outcome: { kind: "error", reason: "timeout" }, failureStreak: 2 };
  const line = stripAnsi(renderBarLine(build({ zai: broken }), 400));
  assert.match(line, /Z\.AI ✗/);
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
        zai: okZai,
        codex: record({ outcome: { kind: "unconfigured", reason: "no credential" } }),
      }),
      400,
    ),
  );
  assert.equal(line.includes("Codex"), false);
});

test("active provider is highlighted only when it has data", () => {
  const line = renderBarLine(build({ zai: okZai, codex: okCodex }, "opencode-go"), 400);
  assert.equal(stripAnsi(line).includes("▸ Z.AI"), false, "no highlight for an unrelated provider");
  const yes = renderBarLine(build({ zai: okZai, codex: okCodex }, "zai-coding-cn"), 400);
  assert.match(stripAnsi(yes), /▸ Z\.AI/);
  assert.match(yes, /\u001b\[1m/, "active label is bold");
});

test("the line never exceeds the available width", () => {
  const records = {
    zai: okZai,
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
  const records = { zai: okZai, codex: okCodex };
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
  assert.match(narrow, /Z\.AI 12%/);
  assert.match(narrow, /Codex 7%/);
  void tier3;
});

test("providers drop cleanly rather than truncating mid-name", () => {
  const line = stripAnsi(renderBarLine(build({ zai: okZai, codex: okCodex }), 12));
  // A single provider survives intact; no half-written provider name.
  assert.match(line, /Codex|Z\.AI/);
  assert.equal(/Cod$|Z\.A$/.test(line), false, "never emits a partial provider label");
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
  const line = stripAnsi(renderBarLine(build({ zai: exhausted }), 40));
  assert.match(line, /100%/, "the spent window is what fits");
  assert.match(line, /!/, "exhaustion is flagged");
});

test("detail view reports reasons and counts", () => {
  const lines = renderDetail(build({ zai: okZai, codex: okCodex }, "zai-coding-cn")).map(stripAnsi);
  const text = lines.join("\n");
  assert.match(text, /Z\.AI \/ GLM Coding Plan/);
  assert.match(text, /▸ Z\.AI \/ GLM Coding Plan/, "active provider highlighted in detail");
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

const okCommandCode = record({
  outcome: {
    kind: "ok",
    windows: [
      {
        label: "5h",
        nativeLabel: "5h Rolling",
        usedPercent: 1.6,
        windowSeconds: H5,
        resetsAt: Date.now() + 2 * 3600_000,
        hasCounts: true,
        usedValue: 0.22,
        limitValue: 14,
        isCurrency: true,
      },
      {
        label: "7d",
        nativeLabel: "Weekly",
        usedPercent: 14.5,
        windowSeconds: D7,
        resetsAt: Date.now() + 6 * 86_400_000,
        hasCounts: true,
        usedValue: 5.09,
        limitValue: 35,
        isCurrency: true,
      },
    ],
  },
  fetchedAt: Date.now(),
});

test("command code renders between codex and opencode", () => {
  const line = stripAnsi(renderBarLine(build({ zai: okZai, codex: okCodex, commandcode: okCommandCode }), 0));
  const order = ["Codex", "CMD"].map((label) => line.indexOf(label));
  assert.ok(order.every((index) => index >= 0), `all labels present in ${line}`);
  assert.deepEqual([...order].sort((a, b) => a - b), order, "display order is stable");
});

test("command code uses the CMD label, never CC", () => {
  const line = stripAnsi(renderBarLine(build({ commandcode: okCommandCode }), 0));
  assert.match(line, /CMD/);
  assert.doesNotMatch(line, /\bCC\b/, "CC is never used as the Command Code label");
});

test("command code highlights when the active model is command-code", () => {
  const active = stripAnsi(renderBarLine(build({ commandcode: okCommandCode }, "command-code"), 0));
  assert.match(active, /▸ CMD/);
  const inactive = stripAnsi(renderBarLine(build({ commandcode: okCommandCode }, "zai-coding-cn"), 0));
  assert.doesNotMatch(inactive, /▸ CMD/);
});

test("command code credit windows keep their counts in the detail view", () => {
  const text = renderDetail(build({ commandcode: okCommandCode })).map(stripAnsi).join("\n");
  assert.match(text, /Command Code/, "full label, not the CMD abbreviation");
  assert.match(text, /0\/14|0\/35/, "credit counts are surfaced");
});
