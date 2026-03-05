import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { execFileSync } from 'child_process';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { runPipelineFromRepo } from '../../src/core/ingestion/pipeline.js';
import {
  closeKuzu,
  createFTSIndex,
  getKuzuStats,
  initKuzu,
  loadGraphToKuzu,
} from '../../src/core/kuzu/kuzu-adapter.js';
import { createMCPServer } from '../../src/mcp/server.js';
import { LocalBackend } from '../../src/mcp/local/local-backend.js';
import { getCurrentCommit } from '../../src/storage/git.js';
import { getStoragePaths, registerRepo, saveMeta } from '../../src/storage/repo-manager.js';

export interface PerfScenario {
  name: string;
  moduleCount: number;
  sharedUtilityCount: number;
}

export interface BenchmarkRunOptions {
  scenario: PerfScenario;
  queryText?: string;
  contextSymbol?: string;
}

export interface BenchmarkMetrics {
  scenario: PerfScenario;
  environment: {
    node: string;
    platform: string;
    arch: string;
    cpuModel: string;
    cpuCount: number;
    totalMemoryGb: number;
  };
  fixture: {
    repoName: string;
    repoPath: string;
    generatedFiles: number;
  };
  stats: {
    files: number;
    nodes: number;
    edges: number;
    communities: number;
    processes: number;
  };
  timings: {
    pipelineMs: number;
    kuzuLoadMs: number;
    ftsMs: number;
    indexTotalMs: number;
    backendInitMs: number;
    mcpConnectMs: number;
    queryColdMs: number;
    queryWarmSamplesMs: number[];
    queryWarmAvgMs: number;
    contextMs: number;
    cypherMs: number;
  };
  throughput: {
    filesPerSecond: number;
    nodesPerSecond: number;
  };
  assertions: {
    queryContains: string;
    contextContains: string;
    cypherContains: string;
  };
  generatedAt: string;
}

export interface BaselineFile {
  scenario: PerfScenario;
  generatedAt: string;
  sampleCount?: number;
  environment: BenchmarkMetrics['environment'];
  stats: BenchmarkMetrics['stats'];
  timings: {
    pipelineMs: number;
    kuzuLoadMs: number;
    ftsMs: number;
    indexTotalMs: number;
    queryColdMs: number;
    queryWarmAvgMs: number;
    contextMs: number;
    cypherMs: number;
  };
  budgets: {
    indexTotalMs: number;
    queryColdMs: number;
    queryWarmAvgMs: number;
    contextMs: number;
    cypherMs: number;
  };
}

export const PERF_SCENARIOS: Record<string, PerfScenario> = {
  smoke: {
    name: 'synthetic-smoke',
    moduleCount: 6,
    sharedUtilityCount: 2,
  },
  medium: {
    name: 'synthetic-medium',
    moduleCount: 24,
    sharedUtilityCount: 4,
  },
};

const DOMAIN_NAMES = [
  'billing',
  'accounts',
  'orders',
  'inventory',
  'shipping',
  'support',
  'catalog',
  'analytics',
  'reporting',
  'payments',
  'returns',
  'checkout',
  'pricing',
  'subscriptions',
  'notifications',
  'customers',
  'vendors',
  'partners',
  'compliance',
  'auditing',
  'security',
  'insights',
  'forecasting',
  'approval',
  'reconciliation',
  'fulfillment',
  'scheduling',
  'warehousing',
  'campaigns',
  'targeting',
  'localization',
  'search',
];

const toPascalCase = (value: string): string =>
  value
    .split(/[^a-zA-Z0-9]/)
    .filter(Boolean)
    .map(part => part[0].toUpperCase() + part.slice(1))
    .join('');

const round = (value: number): number => Number(value.toFixed(2));

const symbolToQuery = (symbolName: string): string =>
  symbolName
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/[_-]+/g, ' ')
    .toLowerCase();

const normalizeAssertionText = (value: string): string =>
  value.toLowerCase().replace(/[^a-z0-9]+/g, '');

const measure = async <T>(fn: () => Promise<T>): Promise<{ ms: number; value: T }> => {
  const start = process.hrtime.bigint();
  const value = await fn();
  const end = process.hrtime.bigint();
  return { ms: Number(end - start) / 1_000_000, value };
};

const ensureGit = (): void => {
  execFileSync('git', ['--version'], { stdio: 'ignore' });
};

const buildModuleFiles = (domain: string, index: number): Array<{ relativePath: string; content: string }> => {
  const pascal = toPascalCase(domain);
  const metricKey = `${domain}.workflow.${index}`;
  const baseDir = `src/${domain}`;

  return [
    {
      relativePath: `${baseDir}/types.ts`,
      content: `export interface ${pascal}Request {
  requestId: string;
  actorId: string;
  payload: Record<string, unknown>;
}

export interface ${pascal}Record {
  requestId: string;
  status: 'accepted' | 'rejected';
  summary: string;
}
`,
    },
    {
      relativePath: `${baseDir}/validator.ts`,
      content: `import type { ${pascal}Request } from './types';

export function validate${pascal}Request(input: ${pascal}Request): ${pascal}Request {
  if (!input.requestId || !input.actorId) {
    throw new Error('${pascal} request is missing identity fields');
  }
  return input;
}
`,
    },
    {
      relativePath: `${baseDir}/repository.ts`,
      content: `import type { ${pascal}Record } from './types';

export function persist${pascal}Record(record: ${pascal}Record): ${pascal}Record {
  return {
    ...record,
    summary: record.summary + ' persisted for ${domain}',
  };
}
`,
    },
    {
      relativePath: `${baseDir}/formatter.ts`,
      content: `import type { ${pascal}Record } from './types';

export function format${pascal}Response(record: ${pascal}Record): string {
  return '[${metricKey}] ' + record.requestId + ': ' + record.summary;
}
`,
    },
    {
      relativePath: `${baseDir}/service.ts`,
      content: `import type { ${pascal}Request, ${pascal}Record } from './types';
import { validate${pascal}Request } from './validator';
import { persist${pascal}Record } from './repository';
import { format${pascal}Response } from './formatter';

export function process${pascal}Workflow(input: ${pascal}Request): { record: ${pascal}Record; response: string } {
  const validated = validate${pascal}Request(input);
  const record = persist${pascal}Record({
    requestId: validated.requestId,
    status: 'accepted',
    summary: '${pascal} workflow completed',
  });
  return {
    record,
    response: format${pascal}Response(record),
  };
}
`,
    },
    {
      relativePath: `${baseDir}/handler.ts`,
      content: `import type { ${pascal}Request } from './types';
import { process${pascal}Workflow } from './service';

export function handle${pascal}Request(input: ${pascal}Request): string {
  const result = process${pascal}Workflow(input);
  return result.response;
}
`,
    },
  ];
};

const buildSharedUtilities = (count: number): Array<{ relativePath: string; content: string }> => {
  return Array.from({ length: count }, (_, index) => ({
    relativePath: `src/shared/utility-${index + 1}.ts`,
    content: `export function sharedUtility${index + 1}(label: string): string {
  return 'shared:' + label + ':${index + 1}';
}
`,
  }));
};

const buildIndexFile = (domains: string[]): { relativePath: string; content: string } => {
  const imports = domains.map((domain) => {
    const pascal = toPascalCase(domain);
    return `import { handle${pascal}Request } from './${domain}/handler';`;
  }).join('\n');

  const routes = domains.map((domain) => {
    const pascal = toPascalCase(domain);
    return `  ${domain}: handle${pascal}Request,`;
  }).join('\n');

  return {
    relativePath: 'src/index.ts',
    content: `${imports}

export const handlers = {
${routes}
};
`,
  };
};

const writeSyntheticRepo = async (repoPath: string, scenario: PerfScenario): Promise<number> => {
  const domains = DOMAIN_NAMES.slice(0, scenario.moduleCount);
  const files = [
    {
      relativePath: 'package.json',
      content: JSON.stringify({
        name: path.basename(repoPath),
        private: true,
        version: '1.0.0',
        type: 'module',
      }, null, 2) + '\n',
    },
    {
      relativePath: 'tsconfig.json',
      content: JSON.stringify({
        compilerOptions: {
          target: 'ES2020',
          module: 'ESNext',
          moduleResolution: 'Bundler',
          strict: true,
        },
        include: ['src/**/*.ts'],
      }, null, 2) + '\n',
    },
    {
      relativePath: 'README.md',
      content: `# ${path.basename(repoPath)}\n\nSynthetic performance fixture for GitNexus.\n`,
    },
    ...buildSharedUtilities(scenario.sharedUtilityCount),
    ...domains.flatMap((domain, index) => buildModuleFiles(domain, index)),
    buildIndexFile(domains),
  ];

  for (const file of files) {
    const fullPath = path.join(repoPath, file.relativePath);
    await fs.mkdir(path.dirname(fullPath), { recursive: true });
    await fs.writeFile(fullPath, file.content, 'utf-8');
  }

  execFileSync('git', ['init', '-b', 'main'], { cwd: repoPath, stdio: 'ignore' });
  execFileSync('git', ['config', 'user.name', 'GitNexus Perf'], { cwd: repoPath, stdio: 'ignore' });
  execFileSync('git', ['config', 'user.email', 'perf@gitnexus.local'], { cwd: repoPath, stdio: 'ignore' });
  execFileSync('git', ['add', '.'], { cwd: repoPath, stdio: 'ignore' });
  execFileSync('git', ['commit', '-m', 'Initial synthetic fixture'], { cwd: repoPath, stdio: 'ignore' });

  return files.length;
};

const createIsolatedWorkspace = async (): Promise<{
  workspaceRoot: string;
  repoPath: string;
  tempHome: string;
  cleanup: () => Promise<void>;
}> => {
  const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'gitnexus-perf-'));
  const tempHome = path.join(workspaceRoot, 'home');
  const repoPath = path.join(workspaceRoot, 'synthetic-perf-repo');
  await fs.mkdir(tempHome, { recursive: true });
  await fs.mkdir(repoPath, { recursive: true });

  return {
    workspaceRoot,
    repoPath,
    tempHome,
    cleanup: async () => {
      await fs.rm(workspaceRoot, { recursive: true, force: true });
    },
  };
};

const setIsolatedHome = (tempHome: string): (() => void) => {
  const previous = {
    HOME: process.env.HOME,
    USERPROFILE: process.env.USERPROFILE,
    XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME,
  };

  process.env.HOME = tempHome;
  process.env.USERPROFILE = tempHome;
  process.env.XDG_CONFIG_HOME = path.join(tempHome, '.config');

  return () => {
    if (previous.HOME === undefined) delete process.env.HOME;
    else process.env.HOME = previous.HOME;
    if (previous.USERPROFILE === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = previous.USERPROFILE;
    if (previous.XDG_CONFIG_HOME === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = previous.XDG_CONFIG_HOME;
  };
};

const createBaselineBudgets = (metrics: BenchmarkMetrics): BaselineFile['budgets'] => ({
  indexTotalMs: Math.ceil(metrics.timings.indexTotalMs * 1.35),
  queryColdMs: Math.ceil(metrics.timings.queryColdMs * 1.35),
  queryWarmAvgMs: Math.ceil(metrics.timings.queryWarmAvgMs * 1.35),
  contextMs: Math.ceil(metrics.timings.contextMs * 1.35),
  cypherMs: Math.ceil(metrics.timings.cypherMs * 1.35),
});

export const toBaselineFile = (metrics: BenchmarkMetrics, sampleCount = 1): BaselineFile => ({
  scenario: metrics.scenario,
  generatedAt: metrics.generatedAt,
  sampleCount,
  environment: metrics.environment,
  stats: metrics.stats,
  timings: {
    pipelineMs: round(metrics.timings.pipelineMs),
    kuzuLoadMs: round(metrics.timings.kuzuLoadMs),
    ftsMs: round(metrics.timings.ftsMs),
    indexTotalMs: round(metrics.timings.indexTotalMs),
    queryColdMs: round(metrics.timings.queryColdMs),
    queryWarmAvgMs: round(metrics.timings.queryWarmAvgMs),
    contextMs: round(metrics.timings.contextMs),
    cypherMs: round(metrics.timings.cypherMs),
  },
  budgets: createBaselineBudgets(metrics),
});

export const compareToBaseline = (metrics: BenchmarkMetrics, baseline: BaselineFile) => {
  const comparisons = [
    { key: 'indexTotalMs', current: metrics.timings.indexTotalMs },
    { key: 'queryColdMs', current: metrics.timings.queryColdMs },
    { key: 'queryWarmAvgMs', current: metrics.timings.queryWarmAvgMs },
    { key: 'contextMs', current: metrics.timings.contextMs },
    { key: 'cypherMs', current: metrics.timings.cypherMs },
  ] as const;

  const results = comparisons.map(({ key, current }) => {
    const baselineValue = baseline.timings[key];
    const budget = baseline.budgets[key];
    const deltaMs = round(current - baselineValue);
    const deltaPct = baselineValue > 0 ? round((deltaMs / baselineValue) * 100) : 0;
    return {
      metric: key,
      current: round(current),
      baseline: baselineValue,
      budget,
      deltaMs,
      deltaPct,
      ok: current <= budget,
    };
  });

  return {
    ok: results.every(result => result.ok),
    results,
  };
};

const extractTextContent = (result: { content?: Array<{ type: string; text?: string }> }): string =>
  (result.content ?? [])
    .filter(item => item.type === 'text' && typeof item.text === 'string')
    .map(item => item.text)
    .join('\n');

export async function runIndexingMcpBenchmark(options: BenchmarkRunOptions): Promise<BenchmarkMetrics> {
  ensureGit();

  const scenario = options.scenario;
  const workspace = await createIsolatedWorkspace();
  const restoreEnv = setIsolatedHome(workspace.tempHome);

  let backend: LocalBackend | null = null;
  let server: { close: () => Promise<void> } | null = null;
  let client: { close?: () => Promise<void> } | null = null;
  let clientTransport: InMemoryTransport | null = null;
  let serverTransport: InMemoryTransport | null = null;

  try {
    const generatedFiles = await writeSyntheticRepo(workspace.repoPath, scenario);
    const repoName = path.basename(workspace.repoPath);

    const pipelineMeasured = await measure(() => runPipelineFromRepo(workspace.repoPath, () => {}));
    const { storagePath, kuzuPath } = getStoragePaths(workspace.repoPath);

    await fs.rm(storagePath, { recursive: true, force: true });
    await fs.mkdir(storagePath, { recursive: true });

    await initKuzu(kuzuPath);
    const kuzuMeasured = await measure(() => loadGraphToKuzu(
      pipelineMeasured.value.graph,
      pipelineMeasured.value.repoPath,
      storagePath,
    ));
    const ftsMeasured = await measure(async () => {
      await createFTSIndex('File', 'file_fts', ['name', 'content']);
      await createFTSIndex('Function', 'function_fts', ['name', 'content']);
      await createFTSIndex('Class', 'class_fts', ['name', 'content']);
      await createFTSIndex('Method', 'method_fts', ['name', 'content']);
      await createFTSIndex('Interface', 'interface_fts', ['name', 'content']);
    });

    const kuzuStats = await getKuzuStats();
    const indexedAt = new Date().toISOString();
    const meta = {
      repoPath: workspace.repoPath,
      lastCommit: getCurrentCommit(workspace.repoPath),
      indexedAt,
      stats: {
        files: pipelineMeasured.value.totalFileCount,
        nodes: kuzuStats.nodes,
        edges: kuzuStats.edges,
        communities: pipelineMeasured.value.communityResult?.stats.totalCommunities ?? 0,
        processes: pipelineMeasured.value.processResult?.stats.totalProcesses ?? 0,
      },
    };
    await saveMeta(storagePath, meta);
    await registerRepo(workspace.repoPath, meta);
    await closeKuzu();

    backend = new LocalBackend();
    const backendInitMeasured = await measure(async () => {
      const ok = await backend!.init();
      if (!ok) {
        throw new Error('LocalBackend failed to initialize in isolated perf workspace');
      }
    });

    server = createMCPServer(backend) as unknown as { close: () => Promise<void>; connect: (transport: InMemoryTransport) => Promise<void> };
    client = new Client({ name: 'gitnexus-perf-client', version: '1.0.0' });
    [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

    await (server as any).connect(serverTransport);
    const mcpConnectMeasured = await measure(() => (client as any).connect(clientTransport!));

    const contextSymbol = options.contextSymbol ?? 'validateBillingRequest';
    const queryText = options.queryText ?? symbolToQuery(contextSymbol);

    const coldQueryMeasured = await measure(() => (client as any).callTool({
      name: 'query',
      arguments: {
        query: queryText,
        repo: repoName,
      },
    }));
    const coldQueryText = extractTextContent(coldQueryMeasured.value);

    const warmSamples: number[] = [];
    for (let i = 0; i < 3; i++) {
      const warm = await measure(() => (client as any).callTool({
        name: 'query',
        arguments: {
          query: queryText,
          repo: repoName,
        },
      }));
      warmSamples.push(round(warm.ms));
    }

    const contextMeasured = await measure(() => (client as any).callTool({
      name: 'context',
      arguments: {
        name: contextSymbol,
        repo: repoName,
      },
    }));
    const contextText = extractTextContent(contextMeasured.value);

    const cypherMeasured = await measure(() => (client as any).callTool({
      name: 'cypher',
      arguments: {
        query: `MATCH (n:Function) WHERE n.name = '${contextSymbol.replace(/'/g, "''")}' RETURN n.name AS name, n.filePath AS filePath`,
        repo: repoName,
      },
    }));
    const cypherText = extractTextContent(cypherMeasured.value);

    if (!normalizeAssertionText(coldQueryText).includes(normalizeAssertionText(contextSymbol))) {
      throw new Error(
        `Benchmark query response did not include expected symbol "${contextSymbol}". Query="${queryText}". Response:\n${coldQueryText.slice(0, 1200)}`
      );
    }
    if (!normalizeAssertionText(contextText).includes(normalizeAssertionText(contextSymbol))) {
      throw new Error(
        `Benchmark context response did not include expected symbol "${contextSymbol}". Response:\n${contextText.slice(0, 1200)}`
      );
    }
    if (!normalizeAssertionText(cypherText).includes(normalizeAssertionText(contextSymbol))) {
      throw new Error(
        `Benchmark cypher response did not include expected symbol "${contextSymbol}". Response:\n${cypherText.slice(0, 1200)}`
      );
    }

    const queryWarmAvgMs = warmSamples.reduce((sum, sample) => sum + sample, 0) / warmSamples.length;
    const indexTotalMs = pipelineMeasured.ms + kuzuMeasured.ms + ftsMeasured.ms;

    return {
      scenario,
      environment: {
        node: process.version,
        platform: process.platform,
        arch: process.arch,
        cpuModel: os.cpus()[0]?.model ?? 'unknown',
        cpuCount: os.cpus().length,
        totalMemoryGb: round(os.totalmem() / (1024 ** 3)),
      },
      fixture: {
        repoName,
        repoPath: workspace.repoPath,
        generatedFiles,
      },
      stats: {
        files: pipelineMeasured.value.totalFileCount,
        nodes: kuzuStats.nodes,
        edges: kuzuStats.edges,
        communities: pipelineMeasured.value.communityResult?.stats.totalCommunities ?? 0,
        processes: pipelineMeasured.value.processResult?.stats.totalProcesses ?? 0,
      },
      timings: {
        pipelineMs: round(pipelineMeasured.ms),
        kuzuLoadMs: round(kuzuMeasured.ms),
        ftsMs: round(ftsMeasured.ms),
        indexTotalMs: round(indexTotalMs),
        backendInitMs: round(backendInitMeasured.ms),
        mcpConnectMs: round(mcpConnectMeasured.ms),
        queryColdMs: round(coldQueryMeasured.ms),
        queryWarmSamplesMs: warmSamples,
        queryWarmAvgMs: round(queryWarmAvgMs),
        contextMs: round(contextMeasured.ms),
        cypherMs: round(cypherMeasured.ms),
      },
      throughput: {
        filesPerSecond: round((pipelineMeasured.value.totalFileCount / indexTotalMs) * 1000),
        nodesPerSecond: round((kuzuStats.nodes / indexTotalMs) * 1000),
      },
      assertions: {
        queryContains: contextSymbol,
        contextContains: contextSymbol,
        cypherContains: contextSymbol,
      },
      generatedAt: indexedAt,
    };
  } finally {
    try { await client?.close?.(); } catch {}
    try { await clientTransport?.close(); } catch {}
    try { await serverTransport?.close(); } catch {}
    try { await server?.close(); } catch {}
    try { await backend?.disconnect(); } catch {}
    try { await closeKuzu(); } catch {}
    restoreEnv();
    await workspace.cleanup();
  }
}
