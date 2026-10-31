import { copyFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { defineConfig, loadEnv } from 'vite';

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
    plugins: [copyRouteData()],
  };
});
