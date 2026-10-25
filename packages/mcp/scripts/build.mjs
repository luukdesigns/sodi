/**
 * Builds the npm package: one ESM file with the Sodi workspace code (rx402, stealth) bundled in, the
 * withdrawal circuit artifacts (checked against their pinned hashes at startup), and the testnet
 * deployment. Third-party dependencies stay external and are installed by npm.
 */
import { cpSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { build } from 'esbuild';

const here = dirname(fileURLToPath(import.meta.url));
const pkg = resolve(here, '..');
const repo = resolve(pkg, '../..');
const dist = resolve(pkg, 'dist');
const manifest = JSON.parse(readFileSync(resolve(pkg, 'package.json'), 'utf8'));

rmSync(dist, { recursive: true, force: true });
await build({
  // The MCP server and the local paying proxy, sharing one chunk of bundled code.
  entryPoints: { index: resolve(pkg, 'src/index.ts'), proxy: resolve(pkg, 'src/proxy-main.ts') },
  outdir: dist,
  splitting: true,
  chunkNames: 'chunks/[name]-[hash]',
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node20',
  // Everything npm installs stays external; only @sodi/* workspace sources are bundled.
  external: Object.keys(manifest.dependencies),
  banner: { js: '#!/usr/bin/env node' },
  legalComments: 'inline',
});

const circuits = resolve(repo, 'contracts/lib/privacy-pools-core/packages/circuits');
mkdirSync(resolve(dist, 'circuits'), { recursive: true });
cpSync(resolve(circuits, 'build/withdraw/withdraw_js/withdraw.wasm'), resolve(dist, 'circuits/withdraw.wasm'));
cpSync(resolve(circuits, 'trusted-setup/final-keys/withdraw.zkey'), resolve(dist, 'circuits/withdraw.zkey'));
cpSync(resolve(circuits, 'trusted-setup/final-keys/withdraw.vkey'), resolve(dist, 'circuits/withdraw.vkey'));
cpSync(resolve(repo, 'contracts/lib/privacy-pools-core/LICENSE'), resolve(dist, 'circuits/LICENSE'));
mkdirSync(resolve(dist, 'deployments'), { recursive: true });
cpSync(resolve(repo, 'contracts/deployments/46630.json'), resolve(dist, 'deployments/46630.json'));
console.log(`built ${manifest.name}@${manifest.version}`);
