import { spawn } from 'node:child_process';
import http from 'node:http';
import { Buffer } from 'node:buffer';

const listenPort = Number(process.env.PORT || 8080);
const gitnexusPort = Number(process.env.GITNEXUS_INTERNAL_PORT || 4747);
const username = process.env.BASIC_AUTH_USER || 'gitnexus';
const password = process.env.BASIC_AUTH_PASSWORD || '';
const gitnexusHome = process.env.GITNEXUS_HOME || '/workspace/.gitnexus-runtime';
const backendProbeTimeoutMs = Number(process.env.GITNEXUS_BACKEND_PROBE_TIMEOUT_MS || 2000);
const backendWarmupPollMs = Number(process.env.GITNEXUS_BACKEND_WARMUP_POLL_MS || 1000);
const proxyRequestTimeoutMs = Number(process.env.GITNEXUS_PROXY_TIMEOUT_MS || 120000);

if (!password) {
  console.error('BASIC_AUTH_PASSWORD is required');
  process.exit(1);
}

const expected = `Basic ${Buffer.from(`${username}:${password}`).toString('base64')}`;
let backendReady = false;
let backendWarmupInProgress = false;
let lastBackendError = 'GitNexus backend is still starting';

const child = spawn(
  'node',
  ['gitnexus/dist/cli/index.js', 'serve', '--host', '127.0.0.1', '--port', String(gitnexusPort)],
  {
    cwd: '/app',
    env: {
      ...process.env,
      GITNEXUS_HOME: gitnexusHome,
      PORT: String(gitnexusPort),
    },
    stdio: ['ignore', 'inherit', 'inherit'],
  },
);

child.on('error', (err) => {
  console.error(`failed to start gitnexus serve: ${err.message}`);
  process.exit(1);
});

child.on('exit', (code, signal) => {
  console.error(`gitnexus serve exited with code=${code} signal=${signal}`);
  process.exit(code ?? 1);
});

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function writeJson(res, statusCode, body, headers = {}) {
  res.writeHead(statusCode, { 'Content-Type': 'application/json', ...headers });
  res.end(JSON.stringify(body));
}

function checkBackendHealth() {
  return new Promise((resolve) => {
    const probeReq = http.request(
      {
        hostname: '127.0.0.1',
        port: gitnexusPort,
        method: 'GET',
        path: '/api/health',
      },
      (probeRes) => {
        probeRes.resume();
        const status = probeRes.statusCode ?? 0;
        resolve(status >= 200 && status < 400);
      },
    );

    probeReq.setTimeout(backendProbeTimeoutMs, () => {
      probeReq.destroy(new Error(`health probe timeout after ${backendProbeTimeoutMs}ms`));
    });

    probeReq.on('error', (err) => {
      lastBackendError = err.message;
      resolve(false);
    });

    probeReq.end();
  });
}

async function warmupBackend() {
  if (backendReady || backendWarmupInProgress) return;
  backendWarmupInProgress = true;
  console.log(`Waiting for GitNexus backend on 127.0.0.1:${gitnexusPort}...`);

  try {
    while (!backendReady) {
      const ready = await checkBackendHealth();
      if (ready) {
        backendReady = true;
        lastBackendError = '';
        console.log(`GitNexus backend is ready on 127.0.0.1:${gitnexusPort}`);
        break;
      }
      await sleep(backendWarmupPollMs);
    }
  } finally {
    backendWarmupInProgress = false;
  }
}

void warmupBackend();

function unauthorized(res) {
  res.writeHead(401, {
    'WWW-Authenticate': 'Basic realm="Vurvey GitNexus", charset="UTF-8"',
    'Cache-Control': 'no-store',
  });
  res.end('Authentication required');
}

const server = http.createServer((req, res) => {
  if (req.url === '/_health') {
    if (!backendReady) {
      writeJson(res, 503, {
        status: 'warming',
        detail: lastBackendError || 'GitNexus backend is still starting',
      });
      return;
    }
    writeJson(res, 200, { status: 'ok' });
    return;
  }

  if (req.headers.authorization !== expected) {
    unauthorized(res);
    return;
  }

  if (!backendReady) {
    writeJson(
      res,
      503,
      {
        error: 'GitNexus backend is still starting. Retry in a few seconds.',
        detail: lastBackendError || undefined,
      },
      { 'Retry-After': '5' },
    );
    return;
  }

  const proxyReq = http.request(
    {
      hostname: '127.0.0.1',
      port: gitnexusPort,
      method: req.method,
      path: req.url,
      headers: {
        ...req.headers,
        host: `127.0.0.1:${gitnexusPort}`,
      },
    },
    (proxyRes) => {
      res.writeHead(proxyRes.statusCode || 502, proxyRes.headers);
      proxyRes.pipe(res);
    },
  );

  proxyReq.setTimeout(proxyRequestTimeoutMs, () => {
    proxyReq.destroy(new Error(`upstream timeout after ${proxyRequestTimeoutMs}ms`));
  });

  proxyReq.on('error', (err) => {
    backendReady = false;
    lastBackendError = err.message;
    void warmupBackend();
    writeJson(res, 503, { error: err.message });
  });

  req.pipe(proxyReq);
});

server.listen(listenPort, '0.0.0.0', () => {
  console.log(`GitNexus auth proxy listening on :${listenPort} (home=${gitnexusHome})`);
});

process.on('SIGTERM', () => {
  server.close(() => undefined);
  child.kill('SIGTERM');
});
