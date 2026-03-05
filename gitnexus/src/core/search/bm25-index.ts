/**
 * Full-Text Search via KuzuDB FTS
 * 
 * Uses KuzuDB's built-in full-text search indexes for keyword-based search.
 * Always reads from the database (no cached state to drift).
 */

import { queryFTS } from '../kuzu/kuzu-adapter.js';

export interface BM25SearchResult {
  filePath: string;
  score: number;
  rank: number;
}

export interface BM25NodeSearchResult {
  nodeId: string;
  filePath: string;
  score: number;
  rank: number;
  label: string;
  name?: string;
  startLine?: number;
  endLine?: number;
}

interface RawFTSResult {
  nodeId: string;
  filePath: string;
  score: number;
  label: string;
  name?: string;
  startLine?: number;
  endLine?: number;
}

/**
 * Execute a single FTS query via a custom executor (for MCP connection pool).
 * Returns the same shape as core queryFTS.
 */
async function queryFTSViaExecutor(
  executor: (cypher: string) => Promise<any[]>,
  tableName: string,
  indexName: string,
  query: string,
  limit: number,
): Promise<Array<{ filePath: string; score: number }>> {
  const escapedQuery = query.replace(/'/g, "''");
  const cypher = `
    CALL QUERY_FTS_INDEX('${tableName}', '${indexName}', '${escapedQuery}', conjunctive := false)
    RETURN node, score
    ORDER BY score DESC
    LIMIT ${limit}
  `;
  try {
    const rows = await executor(cypher);
    return rows.map((row: any) => {
      const node = row.node || row[0] || {};
      const score = row.score ?? row[1] ?? 0;
      return {
        filePath: node.filePath || '',
        score: typeof score === 'number' ? score : parseFloat(score) || 0,
      };
    });
  } catch {
    return [];
  }
}

async function queryFTSNodesViaExecutor(
  executor: (cypher: string) => Promise<any[]>,
  tableName: string,
  indexName: string,
  query: string,
  limit: number,
): Promise<RawFTSResult[]> {
  const escapedQuery = query.replace(/'/g, "''");
  const cypher = `
    CALL QUERY_FTS_INDEX('${tableName}', '${indexName}', '${escapedQuery}', conjunctive := false)
    RETURN node, score
    ORDER BY score DESC
    LIMIT ${limit}
  `;
  try {
    const rows = await executor(cypher);
    return rows.map((row: any) => {
      const node = row.node || row[0] || {};
      const score = row.score ?? row[1] ?? 0;
      return {
        nodeId: node.id || node.nodeId || '',
        filePath: node.filePath || '',
        score: typeof score === 'number' ? score : parseFloat(score) || 0,
        label: tableName,
        name: node.name || undefined,
        startLine: typeof node.startLine === 'number' ? node.startLine : undefined,
        endLine: typeof node.endLine === 'number' ? node.endLine : undefined,
      };
    }).filter(result => result.nodeId && result.filePath);
  } catch {
    return [];
  }
}

/**
 * Search using KuzuDB FTS and keep node-level hits.
 *
 * This preserves the matching node metadata so callers do not need to
 * rehydrate each hit with follow-up queries.
 */
export const searchFTSNodesFromKuzu = async (
  query: string,
  limit: number = 20,
  repoId?: string,
): Promise<BM25NodeSearchResult[]> => {
  const tables = [
    { tableName: 'File', indexName: 'file_fts' },
    { tableName: 'Function', indexName: 'function_fts' },
    { tableName: 'Class', indexName: 'class_fts' },
    { tableName: 'Method', indexName: 'method_fts' },
    { tableName: 'Interface', indexName: 'interface_fts' },
  ] as const;

  let rawResults: RawFTSResult[] = [];

  if (repoId) {
    // MCP / HTTP path uses the pooled Kuzu adapter, so these read-only queries
    // can fan out safely across multiple checked-out connections.
    const { executeQuery } = await import('../../mcp/core/kuzu-adapter.js');
    const executor = (cypher: string) => executeQuery(repoId, cypher);
    const tableResults = await Promise.all(
      tables.map(table =>
        queryFTSNodesViaExecutor(executor, table.tableName, table.indexName, query, limit),
      ),
    );
    rawResults = tableResults.flat();
  } else {
    // Core CLI/server path still uses a single active connection.
    for (const table of tables) {
      const rows = await queryFTS(table.tableName, table.indexName, query, limit, false).catch(() => []);
      rawResults.push(
        ...rows
          .map((row: any) => ({
            nodeId: row.nodeId || row.id || '',
            filePath: row.filePath || '',
            score: row.score || 0,
            label: table.tableName,
            name: row.name || undefined,
            startLine: typeof row.startLine === 'number' ? row.startLine : undefined,
            endLine: typeof row.endLine === 'number' ? row.endLine : undefined,
          }))
          .filter(result => result.nodeId && result.filePath),
      );
    }
  }

  return rawResults
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map((result, index) => ({
      ...result,
      rank: index + 1,
    }));
};

/**
 * Search using KuzuDB's built-in FTS (always fresh, reads from disk)
 * 
 * Queries multiple node tables (File, Function, Class, Method) in parallel
 * and merges results by filePath, summing scores for the same file.
 * 
 * @param query - Search query string
 * @param limit - Maximum results
 * @param repoId - If provided, queries will be routed via the MCP connection pool
 * @returns Ranked search results from FTS indexes
 */
export const searchFTSFromKuzu = async (query: string, limit: number = 20, repoId?: string): Promise<BM25SearchResult[]> => {
  const nodeResults = await searchFTSNodesFromKuzu(query, limit * 3, repoId);

  // Merge results by filePath, summing scores for same file
  const merged = new Map<string, { filePath: string; score: number }>();
  
  const addResults = (results: any[]) => {
    for (const r of results) {
      const existing = merged.get(r.filePath);
      if (existing) {
        existing.score += r.score;
      } else {
        merged.set(r.filePath, { filePath: r.filePath, score: r.score });
      }
    }
  };
  
  addResults(nodeResults);
  
  // Sort by score descending and add rank
  const sorted = Array.from(merged.values())
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
  
  return sorted.map((r, index) => ({
    filePath: r.filePath,
    score: r.score,
    rank: index + 1,
  }));
};
