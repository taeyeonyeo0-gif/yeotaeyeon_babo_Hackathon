import { copyFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { defineConfig, loadEnv } from 'vite';

let regionalBuildActive = false;

function regionalNetworkApi() {
  const root = process.cwd();
  const python = resolve(root, '.venv/bin/python');
  const builder = resolve(root, 'build_walking_graph.py');
  const pbf = resolve(root, 'south-korea-261025.osm.pbf');
  const install = server => {
    server.middlewares.use('/api/region-network', (request, response, next) => {
      if (request.method !== 'GET') {
        response.statusCode = 405;
        response.end();
        return;
      }
      const url = new URL(request.url || '/', 'http://localhost');
      const bbox = (url.searchParams.get('bbox') || '').split(',').map(Number);
      const region = (url.searchParams.get('region') || '').trim().slice(0, 100);
      if (
        bbox.length !== 4 || bbox.some(value => !Number.isFinite(value)) || !region
        || bbox[0] < 124 || bbox[2] > 132 || bbox[1] < 32 || bbox[3] > 39
        || bbox[0] >= bbox[2] || bbox[1] >= bbox[3]
        || bbox[2] - bbox[0] > 0.06 || bbox[3] - bbox[1] > 0.06
        || (bbox[2] - bbox[0]) * (bbox[3] - bbox[1]) > 0.003
      ) {
        response.statusCode = 400;
        response.setHeader('Content-Type', 'application/json; charset=utf-8');
        response.end(JSON.stringify({ error: '지역 검색 범위를 확인해 주세요. 한 번에 작은 주변 구역만 불러옵니다.' }));
        return;
      }
      if (regionalBuildActive) {
        response.statusCode = 429;
        response.setHeader('Content-Type', 'application/json; charset=utf-8');
        response.end(JSON.stringify({ error: '다른 지역 보행망을 불러오는 중입니다. 잠시 기다려 주세요.' }));
        return;
      }
      if (!existsSync(python) || !existsSync(builder) || !existsSync(pbf)) {
        response.statusCode = 503;
        response.setHeader('Content-Type', 'application/json; charset=utf-8');
        response.end(JSON.stringify({ error: '지역 보행망 생성 환경을 사용할 수 없습니다.' }));
        return;
      }

      regionalBuildActive = true;
      let tempDir;
      let child;
      let timedOut = false;
      let disconnected = false;
      const stdout = [];
      const stderr = [];
      const reply = (status, body) => {
        if (response.writableEnded || disconnected) return;
        response.statusCode = status;
        response.setHeader('Content-Type', 'application/json; charset=utf-8');
        response.end(JSON.stringify(body));
      };
      response.on('close', () => {
        if (!response.writableEnded) {
          disconnected = true;
          child?.kill('SIGTERM');
        }
      });

      void (async () => {
        const timer = setTimeout(() => {
          timedOut = true;
          child?.kill('SIGTERM');
        }, 120_000);
        try {
          tempDir = await mkdtemp(join(tmpdir(), 'safe-walk-region-'));
          const output = join(tempDir, 'graph.json');
          child = spawn(python, [
            builder, '--input', pbf, '--output', output, '--bbox', ...bbox.map(String),
            '--buffer-meters', '500', '--region', region,
          ], { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] });
          child.stdout.on('data', chunk => { if (stdout.join('').length < 8000) stdout.push(chunk.toString()); });
          child.stderr.on('data', chunk => { if (stderr.join('').length < 8000) stderr.push(chunk.toString()); });
          child.on('error', error => reply(503, { error: `지역 보행망 실행 실패: ${error.message}` }));
          const exitCode = await new Promise(resolveExit => child.on('close', resolveExit));
          if (timedOut) {
            reply(504, { error: '지역 보행망 생성 시간이 초과됐습니다. 잠시 후 다시 시도해 주세요.' });
            return;
          }
          if (exitCode !== 0 || !existsSync(output)) {
            const detail = stderr.join('').trim().split('\n').at(-1);
            reply(422, { error: detail || stdout.join('').trim().split('\n').at(-1) || '이 지역에서 보행망을 생성하지 못했습니다.' });
            return;
          }
          const content = await readFile(output);
          if (content.byteLength > 24_000_000) {
            reply(413, { error: '지역 보행망 응답이 너무 큽니다. 더 좁은 장소를 검색해 주세요.' });
            return;
          }
          const graph = JSON.parse(content.toString('utf8'));
          if (!Array.isArray(graph.nodes) || !Array.isArray(graph.edges) || !graph.edges.length) {
            reply(422, { error: '검색한 위치에 경로 계산용 보행망이 없습니다.' });
            return;
          }
          reply(200, graph);
        } catch {
          reply(500, { error: '지역 보행망을 준비하는 중 문제가 생겼습니다.' });
        } finally {
          clearTimeout(timer);
          if (tempDir) await rm(tempDir, { recursive: true, force: true });
          regionalBuildActive = false;
        }
      })();
    });
  };
  return {
    name: 'regional-walking-network',
    configureServer: install,
    configurePreviewServer: install,
  };
}

function copyRouteData() {
  return {
    name: 'copy-nightpath-data',
    closeBundle() {
      const output = resolve('dist');
      mkdirSync(resolve(output, 'data'), { recursive: true });
      mkdirSync(resolve(output, 'data/generated'), { recursive: true });
      mkdirSync(resolve(output, 'vendor'), { recursive: true });
      copyFileSync('data.json', resolve(output, 'data.json'));
      copyFileSync('data/generated/changwon-walking.json', resolve(output, 'data/generated/changwon-walking.json'));
      const citySource = resolve('data/generated/changwon-city');
      const cityManifest = resolve(citySource, 'manifest.json');
      if (existsSync(cityManifest)) {
        const manifest = JSON.parse(readFileSync(cityManifest, 'utf8'));
        const cityOutput = resolve(output, 'data/generated/changwon-city');
        mkdirSync(resolve(cityOutput, 'tiles'), { recursive: true });
        copyFileSync(cityManifest, resolve(cityOutput, 'manifest.json'));
        for (const tile of manifest.tiles || []) {
          if (typeof tile.file !== 'string' || !tile.file.startsWith('tiles/') || tile.file.includes('..')) {
            throw new Error(`Invalid Changwon tile path in manifest: ${tile.file}`);
          }
          const source = resolve(citySource, tile.file);
          if (!existsSync(source)) throw new Error(`Completed Changwon tile is missing: ${source}`);
          const markerPath = resolve(citySource, 'tiles', `${tile.id}.complete.json`);
          if (!existsSync(markerPath)) throw new Error(`Completed Changwon tile marker is missing: ${markerPath}`);
          const marker = JSON.parse(readFileSync(markerPath, 'utf8'));
          const bytes = readFileSync(source);
          const digest = createHash('sha256').update(bytes).digest('hex');
          if (!marker.complete || marker.sha256 !== tile.sha256 || marker.sha256 !== digest || marker.sizeBytes !== bytes.length) {
            throw new Error(`Changwon tile integrity check failed: ${tile.id}`);
          }
          copyFileSync(source, resolve(cityOutput, tile.file));
        }
      }
      copyFileSync('data/graph-exclusions.json', resolve(output, 'data/graph-exclusions.json'));
      copyFileSync('data/cheonho-cctv.csv', resolve(output, 'data/cheonho-cctv.csv'));
      copyFileSync('theme-bootstrap.js', resolve(output, 'theme-bootstrap.js'));
      copyFileSync('vendor/leaflet.js', resolve(output, 'vendor/leaflet.js'));
      copyFileSync('vendor/leaflet.css', resolve(output, 'vendor/leaflet.css'));
      copyFileSync('robots.txt', resolve(output, 'robots.txt'));
      copyFileSync('sitemap.xml', resolve(output, 'sitemap.xml'));
      copyFileSync('safety-location-light.png', resolve(output, 'safety-location-light.png'));
    },
  };
}

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '');

  return {
    publicDir: false,
    define: {
      __SUPABASE_URL__: JSON.stringify(env.SUPABASE_URL || ''),
      __SUPABASE_PUBLISHABLE_KEY__: JSON.stringify(env.SUPABASE_PUBLISHABLE_KEY || ''),
    },
    server: { host: '0.0.0.0', port: 3000 },
    plugins: [regionalNetworkApi(), copyRouteData()],
  };
});
