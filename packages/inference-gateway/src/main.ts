#!/usr/bin/env -S npx tsx
import { serve } from '@hono/node-server';

import { createGateway } from './app.js';
import { fromEnv } from './config.js';

async function main() {
  const { config, port, host, status } = await fromEnv();
  serve({ fetch: createGateway(config).fetch, port, hostname: host }, () => {
    // Startup only. Nothing is printed per request.
    console.error(`sodi inference gateway on ${host}:${port}: ${status}`);
  });
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
