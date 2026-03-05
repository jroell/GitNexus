import { describe, expect, it } from 'vitest';
import { PERF_SCENARIOS, runIndexingMcpBenchmark } from '../perf/harness.js';

describe('performance benchmark harness', () => {
  it('indexes a synthetic repo and serves MCP queries end to end', async () => {
    const metrics = await runIndexingMcpBenchmark({
      scenario: PERF_SCENARIOS.smoke,
    });

    expect(metrics.fixture.generatedFiles).toBeGreaterThan(0);
    expect(metrics.stats.files).toBeGreaterThan(0);
    expect(metrics.stats.nodes).toBeGreaterThan(0);
    expect(metrics.stats.edges).toBeGreaterThan(0);
    expect(metrics.timings.indexTotalMs).toBeGreaterThan(0);
    expect(metrics.timings.queryColdMs).toBeGreaterThan(0);
    expect(metrics.timings.queryWarmAvgMs).toBeGreaterThan(0);
    expect(metrics.timings.contextMs).toBeGreaterThan(0);
    expect(metrics.timings.cypherMs).toBeGreaterThan(0);
    expect(metrics.throughput.filesPerSecond).toBeGreaterThan(0);
    expect(metrics.assertions.queryContains).toContain('validateBillingRequest');
    expect(metrics.assertions.contextContains).toContain('validateBillingRequest');
    expect(metrics.assertions.cypherContains).toContain('validateBillingRequest');
  }, 120_000);
});
