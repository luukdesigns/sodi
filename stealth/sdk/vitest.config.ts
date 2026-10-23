import { defineConfig } from 'vitest/config';

// The ERC-5564 reference SDK (used only to cross-check our implementation) ships ESM with directory
// imports Node can't resolve; let Vite bundle it instead.
export default defineConfig({
  test: { server: { deps: { inline: ['@scopelift/stealth-address-sdk'] } }, testTimeout: 120_000, hookTimeout: 300_000 },
});
