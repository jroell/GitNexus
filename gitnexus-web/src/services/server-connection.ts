import { GraphNode, GraphRelationship } from '../core/graph/types';

export interface RepoSummary {
  name: string;
  path: string;
  indexedAt: string;
  lastCommit: string;
  stats: {
    files: number;
    nodes: number;
    edges: number;
    communities: number;
    processes: number;
  };
}

export interface ServerRepoInfo {
  name: string;
  repoPath: string;
  indexedAt: string;
  stats: {
    files: number;
    nodes: number;
    edges: number;
    communities: number;
    processes: number;
  };
}

export interface ConnectToServerResult {
  nodes: GraphNode[];
  relationships: GraphRelationship[];
  repoInfo: ServerRepoInfo;
}

export interface ServerGrepMatch {
  file: string;
  line: number;
  content: string;
}

export function normalizeServerUrl(input: string): string {
  let url = input.trim();

  // Strip trailing slashes
  url = url.replace(/\/+$/, '');

  // Add protocol if missing
  if (!url.startsWith('http://') && !url.startsWith('https://')) {
    if (url.startsWith('localhost') || url.startsWith('127.0.0.1')) {
      url = `http://${url}`;
    } else {
      url = `https://${url}`;
    }
  }

  // Add /api if not already present
  if (!url.endsWith('/api')) {
    url = `${url}/api`;
  }

  return url;
}

export async function fetchRepos(baseUrl: string): Promise<RepoSummary[]> {
  const response = await fetch(`${baseUrl}/repos`);
  if (!response.ok) throw new Error(`Server returned ${response.status}`);
  return response.json();
}

export async function fetchRepoInfo(baseUrl: string, repoName?: string): Promise<ServerRepoInfo> {
  const url = repoName ? `${baseUrl}/repo?repo=${encodeURIComponent(repoName)}` : `${baseUrl}/repo`;
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Server returned ${response.status}: ${response.statusText}`);
  }
  const data = await response.json();
  // npm gitnexus@1.3.3 returns "path"; git HEAD returns "repoPath"
  return { ...data, repoPath: data.repoPath ?? data.path };
}

export async function fetchGraph(
  baseUrl: string,
  onProgress?: (downloaded: number, total: number | null) => void,
  signal?: AbortSignal,
  repoName?: string
): Promise<{ nodes: GraphNode[]; relationships: GraphRelationship[] }> {
  const url = repoName ? `${baseUrl}/graph?repo=${encodeURIComponent(repoName)}` : `${baseUrl}/graph`;
  const response = await fetch(url, { signal });
  if (!response.ok) {
    throw new Error(`Server returned ${response.status}: ${response.statusText}`);
  }

  const contentLength = response.headers.get('Content-Length');
  const total = contentLength ? parseInt(contentLength, 10) : null;

  if (!response.body) {
    const data = await response.json();
    return data;
  }

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let downloaded = 0;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    chunks.push(value);
    downloaded += value.length;
    onProgress?.(downloaded, total);
  }

  const combined = new Uint8Array(downloaded);
  let offset = 0;
  for (const chunk of chunks) {
    combined.set(chunk, offset);
    offset += chunk.length;
  }

  const text = new TextDecoder().decode(combined);
  return JSON.parse(text);
}

export async function fetchFileContent(
  baseUrl: string,
  filePath: string,
  repoName?: string,
): Promise<string> {
  const repoQuery = repoName ? `repo=${encodeURIComponent(repoName)}&` : '';
  const response = await fetch(`${baseUrl}/file?${repoQuery}path=${encodeURIComponent(filePath)}`);
  if (!response.ok) {
    throw new Error(`Server returned ${response.status}: ${response.statusText}`);
  }
  const body = await response.json();
  return body.content ?? '';
}

export async function grepFiles(
  baseUrl: string,
  params: {
    pattern: string;
    fileFilter?: string;
    caseSensitive?: boolean;
    maxResults?: number;
  },
  repoName?: string,
): Promise<ServerGrepMatch[]> {
  const response = await fetch(`${baseUrl}/grep`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...params, repo: repoName }),
  });
  if (!response.ok) {
    throw new Error(`Server returned ${response.status}: ${response.statusText}`);
  }
  const body = await response.json();
  return Array.isArray(body.results) ? body.results : [];
}

export async function connectToServer(
  url: string,
  onProgress?: (phase: string, downloaded: number, total: number | null) => void,
  signal?: AbortSignal,
  repoName?: string
): Promise<ConnectToServerResult> {
  const baseUrl = normalizeServerUrl(url);

  // Phase 1: Validate server
  onProgress?.('validating', 0, null);
  const repoInfo = await fetchRepoInfo(baseUrl, repoName);

  // Phase 2: Download graph
  onProgress?.('downloading', 0, null);
  const { nodes, relationships } = await fetchGraph(
    baseUrl,
    (downloaded, total) => onProgress?.('downloading', downloaded, total),
    signal,
    repoName
  );

  onProgress?.('hydrating', 0, null);
  return { nodes, relationships, repoInfo };
}
