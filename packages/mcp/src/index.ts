import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';

import { fromEnv } from './config.js';
import { createSodiMcpServer } from './tools.js';

async function main() {
  const { client, options } = await fromEnv();
  const server = createSodiMcpServer(client, options);
  await server.connect(new StdioServerTransport());
  // stdout carries the MCP protocol; log to stderr only.
  console.error('sodi MCP server ready');
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
