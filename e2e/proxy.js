// Forwards /api/* to roll20-audio-sync with the CORS headers Kong adds in
// production (cors-global, any origin): the module calls it from Foundry's
// page, another origin
const http = require('node:http');

const PORT = Number(process.env.PROXY_PORT ?? 8096);
const API = process.env.API_URL ?? 'http://127.0.0.1:8095';
const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': '*',
};

http.createServer((req, res) => {
  if (req.url === '/healthz') { res.writeHead(200); res.end(); return; }
  if (req.method === 'OPTIONS') { res.writeHead(204, CORS); res.end(); return; }
  if (!req.url.startsWith('/api/')) { res.writeHead(404); res.end(); return; }
  const upstream = http.request(API + req.url.slice(4), { method: req.method, headers: req.headers }, (up) => {
    res.writeHead(up.statusCode, { ...up.headers, ...CORS });
    up.pipe(res);
  });
  upstream.on('error', (e) => { res.writeHead(502, CORS); res.end(e.message); });
  req.pipe(upstream);
}).listen(PORT, () => console.log(`proxy on http://localhost:${PORT}`));
