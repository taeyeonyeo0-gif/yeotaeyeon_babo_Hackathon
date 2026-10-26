import { copyFileSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { defineConfig, loadEnv } from 'vite';

function copyRouteData() {
  return {
    name: 'copy-nightpath-data',
    closeBundle() {
      const output = resolve('dist');
      mkdirSync(resolve(output, 'data'), { recursive: true });
      mkdirSync(resolve(output, 'vendor'), { recursive: true });
      copyFileSync('data.json', resolve(output, 'data.json'));
      copyFileSync('data/graph-exclusions.json', resolve(output, 'data/graph-exclusions.json'));
      copyFileSync('data/cheonho-cctv.csv', resolve(output, 'data/cheonho-cctv.csv'));
      copyFileSync('theme-bootstrap.js', resolve(output, 'theme-bootstrap.js'));
      copyFileSync('vendor/leaflet.js', resolve(output, 'vendor/leaflet.js'));
      copyFileSync('vendor/leaflet.css', resolve(output, 'vendor/leaflet.css'));
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
