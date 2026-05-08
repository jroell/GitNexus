import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  connectToServer,
  fetchGraph,
  normalizeServerUrl,
  setBackendUrl,
} from '../../src/services/backend-client';
import type { GraphCacheProvider } from '../../src/services/graph-cache';

describe('normalizeServerUrl', () => {
  it('adds http:// to localhost', () => {
    expect(normalizeServerUrl('localhost:4747')).toBe('http://localhost:4747');
  });

  it('adds http:// to 127.0.0.1', () => {
    expect(normalizeServerUrl('127.0.0.1:4747')).toBe('http://127.0.0.1:4747');
  });

  it('adds https:// to non-local hosts', () => {
    expect(normalizeServerUrl('example.com')).toBe('https://example.com');
  });

  it('strips trailing slashes', () => {
    expect(normalizeServerUrl('http://localhost:4747/')).toBe('http://localhost:4747');
    expect(normalizeServerUrl('http://localhost:4747///')).toBe('http://localhost:4747');
  });

  it('strips /api suffix (base URL only)', () => {
    expect(normalizeServerUrl('http://localhost:4747/api')).toBe('http://localhost:4747');
  });

  it('trims whitespace', () => {
    expect(normalizeServerUrl('  localhost:4747  ')).toBe('http://localhost:4747');
  });

  it('preserves existing https://', () => {
    expect(normalizeServerUrl('https://gitnexus.example.com')).toBe('https://gitnexus.example.com');
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('fetchGraph', () => {
  it('requests streamed graph responses from the backend', async () => {
    setBackendUrl('http://localhost:4747');

    const fetchMock = vi.fn().mockResolvedValue(
      new Response('{"nodes":[],"relationships":[]}', {
        status: 200,
        headers: {
          'Content-Type': 'application/json',
        },
      }),
    );
    vi.stubGlobal('fetch', fetchMock);

    await fetchGraph('big-repo');

    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining('/api/graph?repo=big-repo&stream=true'),
      expect.any(Object),
    );
  });

  it('parses NDJSON graph streams incrementally', async () => {
    setBackendUrl('http://localhost:4747');

    const encoder = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(
          encoder.encode(
            [
              '{"type":"node","data":{"id":"File:src/app.ts","label":"File","properties":{"name":"app.ts","filePath":"src/app.ts"}}}\n',
              '{"type":"relationship","data":{"id":"File:src/app.ts_CONTAINS_Function:src/app.ts:main","type":"CONTAINS","sourceId":"File:src/app.ts","targetId":"Function:src/app.ts:main"}}\n',
            ].join(''),
          ),
        );
        controller.close();
      },
    });

    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(stream, {
          status: 200,
          headers: {
            'Content-Type': 'application/x-ndjson',
          },
        }),
      ),
    );

    const progress = vi.fn();
    const result = await fetchGraph('big-repo', { onProgress: progress });

    expect(result.nodes).toHaveLength(1);
    expect(result.relationships).toHaveLength(1);
    expect(result.nodes[0].id).toBe('File:src/app.ts');
    expect(result.relationships[0].type).toBe('CONTAINS');
    expect(progress).toHaveBeenCalled();
  });

  it('parses NDJSON graph lines split across chunks', async () => {
    setBackendUrl('http://localhost:4747');

    const encoder = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(
          encoder.encode(
            '{"type":"node","data":{"id":"File:src/app.ts","label":"File","properties":{"name":"app.ts"',
          ),
        );
        controller.enqueue(
          encoder.encode(
            ',"filePath":"src/app.ts"}}}\n{"type":"relationship","data":{"id":"File:src/app.ts_CONTAINS_Function:src/app.ts:main","type":"CONTAINS","sourceId":"File:src/app.ts","targetId":"Function:src/app.ts:main"}}\n',
          ),
        );
        controller.close();
      },
    });

    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(stream, {
          status: 200,
          headers: {
            'Content-Type': 'application/x-ndjson',
          },
        }),
      ),
    );

    const result = await fetchGraph('big-repo');

    expect(result.nodes).toHaveLength(1);
    expect(result.relationships).toHaveLength(1);
    expect(result.nodes[0].properties.filePath).toBe('src/app.ts');
  });

  it('throws backend errors emitted in the NDJSON stream', async () => {
    setBackendUrl('http://localhost:4747');

    const encoder = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode('{"type":"error","error":"stream failed"}\n'));
        controller.close();
      },
    });

    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(stream, {
          status: 200,
          headers: {
            'Content-Type': 'application/x-ndjson',
          },
        }),
      ),
    );

    await expect(fetchGraph('big-repo')).rejects.toMatchObject({
      message: 'stream failed',
    });
  });
});

describe('connectToServer graph cache', () => {
  it('uses a cached graph when repo metadata matches', async () => {
    const cachedGraph = {
      nodes: [
        {
          id: 'File:src/app.ts',
          label: 'File' as const,
          properties: { name: 'app.ts', filePath: 'src/app.ts' },
        },
      ],
      relationships: [],
    };
    const cache: GraphCacheProvider = {
      read: vi.fn().mockResolvedValue(cachedGraph),
      write: vi.fn(),
    };
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          name: 'big-repo',
          path: '/repo',
          indexedAt: '2026-05-07T12:00:00.000Z',
          lastCommit: 'abc123',
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      ),
    );
    vi.stubGlobal('fetch', fetchMock);

    const progress = vi.fn();
    const result = await connectToServer('localhost:4747', progress, undefined, 'big-repo', {
      cache,
    });

    expect(result.fromCache).toBe(true);
    expect(result.nodes).toEqual(cachedGraph.nodes);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith(
      'http://localhost:4747/api/repo?repo=big-repo',
      expect.any(Object),
    );
    expect(cache.read).toHaveBeenCalledWith({
      baseUrl: 'http://localhost:4747',
      repoName: 'big-repo',
      indexedAt: '2026-05-07T12:00:00.000Z',
      lastCommit: 'abc123',
    });
    expect(cache.write).not.toHaveBeenCalled();
    expect(progress).toHaveBeenCalledWith('cache-hit', 0, null);
  });

  it('downloads and stores the graph on a cache miss', async () => {
    const cache: GraphCacheProvider = {
      read: vi.fn().mockResolvedValue(null),
      write: vi.fn().mockResolvedValue(undefined),
    };
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            name: 'big-repo',
            path: '/repo',
            indexedAt: '2026-05-07T12:00:00.000Z',
            lastCommit: 'abc123',
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            nodes: [
              {
                id: 'File:src/app.ts',
                label: 'File',
                properties: { name: 'app.ts', filePath: 'src/app.ts' },
              },
            ],
            relationships: [],
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        ),
      );
    vi.stubGlobal('fetch', fetchMock);

    const progress = vi.fn();
    const result = await connectToServer('localhost:4747', progress, undefined, 'big-repo', {
      cache,
    });

    expect(result.fromCache).toBe(false);
    expect(result.nodes).toHaveLength(1);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock).toHaveBeenLastCalledWith(
      'http://localhost:4747/api/graph?repo=big-repo&stream=true',
      expect.any(Object),
    );
    expect(cache.write).toHaveBeenCalledWith(
      {
        baseUrl: 'http://localhost:4747',
        repoName: 'big-repo',
        indexedAt: '2026-05-07T12:00:00.000Z',
        lastCommit: 'abc123',
      },
      {
        nodes: [
          {
            id: 'File:src/app.ts',
            label: 'File',
            properties: { name: 'app.ts', filePath: 'src/app.ts' },
          },
        ],
        relationships: [],
      },
    );
    expect(progress).toHaveBeenCalledWith('caching', 0, null);
  });
});
