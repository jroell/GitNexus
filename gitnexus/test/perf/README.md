# Perf Benchmarks

This directory contains a synthetic end-to-end benchmark for GitNexus indexing and MCP query latency.

The benchmark creates a temporary TypeScript repository, runs the full indexing pipeline, loads Kuzu + FTS, starts the MCP server, and measures real MCP tool calls through an in-memory MCP client transport.

Each CLI run executes 3 samples by default and reports the median so the regression check is less sensitive to one noisy run.

Commands:

- `npm run perf` builds `dist/`, runs the medium synthetic scenario, and prints timings
- `npm run perf:write-baseline` builds `dist/` and refreshes `baseline.synthetic-medium.json`
- `npm run perf:check` builds `dist/`, compares the current run against the stored baseline budgets, and exits non-zero on regression
- Add `-- --samples=5` to any command if you want a wider sample window on a noisy machine

The integration smoke test at `test/integration/perf-benchmark.test.ts` uses the smaller `synthetic-smoke` scenario so the benchmark path is covered in automated tests without making the suite too slow.
