import { spawn } from 'node:child_process';
import http from 'node:http';
import { Buffer } from 'node:buffer';

const listenPort = Number(process.env.PORT || 8080);
const gitnexusPort = Number(process.env.GITNEXUS_INTERNAL_PORT || 4747);
const username = process.env.BASIC_AUTH_USER || 'gitnexus';
const password = process.env.BASIC_AUTH_PASSWORD || '';
const gitnexusHome = process.env.GITNEXUS_HOME || '/workspace/.gitnexus-runtime';

if (!password) {
  console.error('BASIC_AUTH_PASSWORD is required');
  process.exit(1);
}

const expected = `Basic ${Buffer.from(`${username}:${password}`).toString('base64')}`;

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

function unauthorized(res) {
  res.writeHead(401, {
    'WWW-Authenticate': 'Basic realm="Vurvey GitNexus", charset="UTF-8"',
    'Cache-Control': 'no-store',
  });
  res.end('Authentication required');
}

const server = http.createServer((req, res) => {
  if (req.url === '/_health') {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('ok');
    return;
  }

  if (req.headers.authorization !== expected) {
    unauthorized(res);
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

  proxyReq.on('error', (err) => {
    res.writeHead(502, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: err.message }));
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
