import { fromEnv } from './config.js';
import { createPaidProxy } from './proxy.js';

/**
 * rx402-proxy: run Claude Code with no API key, paid per request from a private session.
 *
 *   npx -y -p @sodi/rx402-mcp rx402-proxy
 *   ANTHROPIC_BASE_URL=http://127.0.0.1:8411 ANTHROPIC_API_KEY=unused claude
 */
async function main() {
  const { client, options } = await fromEnv();
  if (!options.gateway) throw new Error('set RX402_GATEWAY_URL: the proxy needs an inference gateway');
  const port = Number(process.env.RX402_PROXY_PORT ?? 8411);
  const proxy = createPaidProxy(client, {
    gatewayUrl: options.gateway.url,
    defaultModel: process.env.RX402_PROXY_MODEL ?? options.gateway.defaultModel,
    maxTokens: Number(process.env.RX402_PROXY_MAX_TOKENS ?? 8192),
    maxTotalSpend: options.maxTotalSpend,
    log: (line) => console.error(`${new Date().toISOString()} ${line}`),
  });
  proxy.server.listen(port, '127.0.0.1', () => {
    console.error(`rx402 proxy on http://127.0.0.1:${port} -> ${options.gateway!.url}, spending at most ${process.env.RX402_MAX_TOTAL_SPEND ?? '5'} USDG`);
    console.error(`run: ANTHROPIC_BASE_URL=http://127.0.0.1:${port} ANTHROPIC_API_KEY=unused claude`);
  });
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
