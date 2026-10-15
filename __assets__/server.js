const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const root = __dirname;
const mime = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.ipynb': 'application/json; charset=utf-8' };
function kakaoKey() { if (process.env.KAKAO_MAP_APP_KEY) return process.env.KAKAO_MAP_APP_KEY; try { const line = fs.readFileSync(path.join(root, '.env'), 'utf8').split(/\r?\n/).find((item) => item.startsWith('KAKAO_MAP_APP_KEY=')); return line ? line.slice(18).trim().replace(/^['"]|['"]$/g, '') : ''; } catch { return ''; } }
const server = http.createServer((request, response) => {
  const pathname = new URL(request.url, `http://${request.headers.host}`).pathname;
  if (pathname === '/kakao-sdk.js') { const url = `https://dapi.kakao.com/v2/maps/sdk.js?appkey=${encodeURIComponent(kakaoKey())}&autoload=false&libraries=services,clusterer`; https.get(url, (sdk) => { response.writeHead(sdk.statusCode || 502, { 'Content-Type': sdk.headers['content-type'] || 'text/javascript; charset=utf-8' }); sdk.pipe(response); }).on('error', () => { response.writeHead(502); response.end('Kakao SDK unavailable'); }); return; }
  const relative = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, ''); const file = path.resolve(root, relative);
  if (!file.startsWith(root) || relative === '.env' || relative.startsWith('.env.') || !fs.existsSync(file) || fs.statSync(file).isDirectory()) { response.writeHead(404); response.end('Not found'); return; }
  response.writeHead(200, { 'Content-Type': mime[path.extname(file).toLowerCase()] || 'application/octet-stream' }); fs.createReadStream(file).pipe(response);
});
server.listen(Number(process.env.PORT || 3000), '0.0.0.0');
