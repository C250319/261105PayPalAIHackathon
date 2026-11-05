// Copies the AG Grid Community + AG Charts Community browser bundles (MIT) into public/vendor
// so the deployed app never depends on a third-party CDN.
import { copyFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const out = join(root, 'public', 'vendor');
mkdirSync(out, { recursive: true });
const files = [
  ['node_modules/ag-grid-community/dist/ag-grid-community.min.js', 'ag-grid-community.min.js'],
  ['node_modules/ag-charts-community/dist/umd/ag-charts-community.min.js', 'ag-charts-community.min.js'],
];
for (const [src, dest] of files) {
  copyFileSync(join(root, src), join(out, dest));
  console.log(`vendor: ${dest}`);
}
