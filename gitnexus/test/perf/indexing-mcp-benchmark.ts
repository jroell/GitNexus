import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import {
  PERF_SCENARIOS,
  compareToBaseline,
  runIndexingMcpBenchmark,
  toBaselineFile,
  type BenchmarkMetrics,
  type BaselineFile,
} from './harness.js';

const BASELINE_PATH = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  'baseline.synthetic-medium.json',
);

process.env.GITNEXUS_PREFER_DIST_WORKERS = '1';

function parseArgs(argv: string[]) {
  const flags = new Set(argv.filter(arg => arg.startsWith('--')));
  const scenarioFlag = argv.find(arg => arg.startsWith('--scenario='));
  const samplesFlag = argv.find(arg => arg.startsWith('--samples='));
  const scenarioName = scenarioFlag?.split('=')[1] ?? 'medium';
  const parsedSamples = Number(samplesFlag?.split('=')[1] ?? '3');

  return {
    scenarioName,
    sampleCount: Number.isFinite(parsedSamples) && parsedSamples > 0 ? Math.floor(parsedSamples) : 3,
    check: flags.has('--check'),
    writeBaseline: flags.has('--write-baseline'),
  };
}

const median = (values: number[]): number => {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) {
    return sorted[middle];
  }
  return (sorted[middle - 1] + sorted[middle]) / 2;
};

const aggregateRuns = (runs: BenchmarkMetrics[]): BenchmarkMetrics => {
  const representative = runs[Math.floor(runs.length / 2)] ?? runs[0];

  return {
    ...representative,
    timings: {
      pipelineMs: median(runs.map(run => run.timings.pipelineMs)),
      kuzuLoadMs: median(runs.map(run => run.timings.kuzuLoadMs)),
      ftsMs: median(runs.map(run => run.timings.ftsMs)),
      indexTotalMs: median(runs.map(run => run.timings.indexTotalMs)),
      backendInitMs: median(runs.map(run => run.timings.backendInitMs)),
      mcpConnectMs: median(runs.map(run => run.timings.mcpConnectMs)),
      queryColdMs: median(runs.map(run => run.timings.queryColdMs)),
      queryWarmSamplesMs: representative.timings.queryWarmSamplesMs,
      queryWarmAvgMs: median(runs.map(run => run.timings.queryWarmAvgMs)),
      contextMs: median(runs.map(run => run.timings.contextMs)),
      cypherMs: median(runs.map(run => run.timings.cypherMs)),
    },
    throughput: {
      filesPerSecond: median(runs.map(run => run.throughput.filesPerSecond)),
      nodesPerSecond: median(runs.map(run => run.throughput.nodesPerSecond)),
    },
    generatedAt: new Date().toISOString(),
  };
};

function printSummary(label: string, current: number, baseline?: number, budget?: number): void {
  const pieces = [`${label}: ${current.toFixed(2)}ms`];
  if (baseline !== undefined) {
    const delta = current - baseline;
    const pct = baseline > 0 ? (delta / baseline) * 100 : 0;
    pieces.push(`baseline ${baseline.toFixed(2)}ms`);
    pieces.push(`delta ${delta >= 0 ? '+' : ''}${delta.toFixed(2)}ms (${pct >= 0 ? '+' : ''}${pct.toFixed(2)}%)`);
  }
  if (budget !== undefined) {
    pieces.push(`budget ${budget.toFixed(2)}ms`);
  }
  console.log(`  ${pieces.join(' | ')}`);
}

async function readBaseline(): Promise<BaselineFile | null> {
  try {
    const raw = await fs.readFile(BASELINE_PATH, 'utf-8');
    return JSON.parse(raw) as BaselineFile;
  } catch {
    return null;
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const scenario = PERF_SCENARIOS[args.scenarioName];
  if (!scenario) {
    console.error(`Unknown scenario "${args.scenarioName}". Available: ${Object.keys(PERF_SCENARIOS).join(', ')}`);
    process.exit(1);
  }

  const runs: BenchmarkMetrics[] = [];
  for (let sample = 0; sample < args.sampleCount; sample++) {
    runs.push(await runIndexingMcpBenchmark({ scenario }));
  }
  const metrics = aggregateRuns(runs);
  const baseline = await readBaseline();

  console.log(`\nGitNexus perf benchmark: ${metrics.scenario.name}`);
  console.log(`  Samples: ${args.sampleCount} (median)`);
  console.log(`  Fixture files: ${metrics.fixture.generatedFiles}`);
  console.log(`  Indexed stats: ${metrics.stats.files} files | ${metrics.stats.nodes} nodes | ${metrics.stats.edges} edges | ${metrics.stats.processes} processes`);
  console.log(`  Throughput: ${metrics.throughput.filesPerSecond.toFixed(2)} files/s | ${metrics.throughput.nodesPerSecond.toFixed(2)} nodes/s`);
  console.log('');

  if (baseline) {
    const comparison = compareToBaseline(metrics, baseline);
    for (const result of comparison.results) {
      printSummary(result.metric, result.current, result.baseline, result.budget);
    }
    if (args.check && !comparison.ok) {
      console.error('\nOne or more benchmark metrics exceeded the stored regression budget.');
      process.exit(1);
    }
  } else {
    printSummary('indexTotalMs', metrics.timings.indexTotalMs);
    printSummary('queryColdMs', metrics.timings.queryColdMs);
    printSummary('queryWarmAvgMs', metrics.timings.queryWarmAvgMs);
    printSummary('contextMs', metrics.timings.contextMs);
    printSummary('cypherMs', metrics.timings.cypherMs);
  }

  if (args.writeBaseline) {
    const baselineFile = toBaselineFile(metrics, args.sampleCount);
    await fs.writeFile(BASELINE_PATH, JSON.stringify(baselineFile, null, 2) + '\n', 'utf-8');
    console.log(`\nBaseline written to ${BASELINE_PATH}`);
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack || error.message : String(error));
  process.exit(1);
});
