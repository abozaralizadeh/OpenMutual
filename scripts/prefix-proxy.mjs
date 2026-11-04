// A strict stand-in for the nginx snippet that setup_service.sh writes in shared mode, for testing.
// BASE_PATH=/openmutual/ PROXY_PORT=3518 WEB_PORT=3517 node scripts/prefix-proxy.mjs
// /openmutual gets a 301 to /openmutual/, /openmutual/... goes to the app with the path kept,
// and anything else gets a 404 and a line in the log, so a URL that forgets the base shows up at once.
import { appendFileSync } from 'node:fs';
import http from 'node:http';

const base = `/${(process.env.BASE_PATH ?? '').replace(/^\/+|\/+$/g, '')}/`;
if (base === '//') throw new Error('Set BASE_PATH, like /openmutual/');
const listen = Number(process.env.PROXY_PORT ?? 3518);
const upstream = Number(process.env.WEB_PORT ?? 3517);
const escapedLog = process.env.ESCAPED_LOG;

const server = http.createServer((req, res) => {
  const url = req.url ?? '/';
  const path = url.split('?')[0];
  if (path === base.slice(0, -1)) {
    res.writeHead(301, { location: base }).end();
    return;
  }
  if (!path.startsWith(base)) {
    const line = `${new Date().toISOString()} ${req.method} ${url} (outside ${base})\n`;
    process.stderr.write(`prefix-proxy: ${line}`);
    if (escapedLog) appendFileSync(escapedLog, line);
    res.writeHead(404, { 'content-type': 'text/plain' }).end(`Not under ${base}\n`);
    return;
  }
  const headers = {
    ...req.headers,
    'x-forwarded-for': req.socket.remoteAddress ?? '',
    'x-forwarded-proto': 'http',
    'x-forwarded-host': req.headers.host ?? '',
  };
  const out = http.request({ host: '127.0.0.1', port: upstream, method: req.method, path: url, headers }, (reply) => {
    res.writeHead(reply.statusCode ?? 502, reply.headers);
    reply.pipe(res);
  });
  out.on('error', () => {
    if (!res.headersSent) res.writeHead(502, { 'content-type': 'text/plain' });
    res.end('The app is not answering\n');
  });
  req.pipe(out);
});

server.listen(listen, '127.0.0.1', () => process.stdout.write(`prefix-proxy: ${base} on 127.0.0.1:${listen} -> 127.0.0.1:${upstream}\n`));
