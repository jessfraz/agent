import assert from "node:assert/strict";
import { test } from "node:test";
import { comparisons, Scenario, type Sample } from "./fixtures/search-performance.js";

function samples(baseline: number[], candidate: number[]): Sample[] {
  const result: Sample[] = [];
  for (const scenario of Object.values(Scenario)) {
    const times = scenario === Scenario.CachedIndex ? { baseline, candidate }
      : { baseline: [100, 100, 100], candidate: [100, 100, 100] };
    for (const version of ["baseline", "candidate"] satisfies Array<Sample["version"]>) {
      for (const [pair, elapsed_ms] of times[version].entries()) {
        result.push({ type: "sample", scenario, version, pair, elapsed_ms,
          warmup: false, signature: "matching", operations: 4 });
      }
    }
  }
  return result;
}

function cached(input: Sample[]) {
  const result = comparisons(input).find(result => result.scenario === Scenario.CachedIndex);
  assert.ok(result); return result;
}

test("paired gate preserves faster paired work despite uneven runner stalls", () => {
  // Actual CI measurements: five of seven candidate runs were faster. Separate
  // medians nevertheless reported a 39% regression.
  const baseline = [439.37029, 1310.91328, 366.57530, 904.75781, 298.85085, 302.64821, 929.83019];
  const candidate = [284.22749, 1163.28675, 266.54889, 300.55142, 610.78433, 758.52455, 703.86416];
  assert.equal(cached(samples(baseline, candidate)).passed, true);
});

test("paired gate retains relative and absolute budgets and ignores only warmup pairs", () => {
  assert.equal(cached(samples([100, 100, 100], [125, 125, 125])).passed, true);
  assert.equal(cached(samples([100, 100, 100], [126, 126, 126])).passed, false);
  assert.equal(cached(samples([10, 10, 10], [30, 30, 30])).passed, true);
  assert.equal(cached(samples([10, 10, 10], [31, 31, 31])).passed, false);
  const input = samples([100, 100, 100], [126, 126, 126]);
  input.push({ type: "sample", scenario: Scenario.CachedIndex, version: "baseline", pair: -1,
    elapsed_ms: 10000, warmup: true, signature: "matching", operations: 4 });
  assert.equal(cached(input).passed, false);
});

test("paired gate rejects missing, repeated and invalid measurements", () => {
  const missing = samples([100, 100, 100], [100, 100, 100]);
  missing.pop(); assert.throws(() => comparisons(missing), /incomplete/);
  const duplicate = samples([100, 100, 100], [100, 100, 100]);
  const first = duplicate[0]; assert.ok(first); duplicate.push(first);
  assert.throws(() => comparisons(duplicate), /repeat a version/);
  assert.throws(() => comparisons(samples([100, 100, 100], [100, Number.NaN, 100])));
  assert.throws(() => comparisons(samples([Number.MAX_VALUE, Number.MAX_VALUE, Number.MAX_VALUE], [100, 100, 100])), /not finite/);
});
