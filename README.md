# Sodi

**Privacy-first infrastructure for agentic finance.**

Sodi builds **rx402**: private x402 payments for AI agents. Agents pay for APIs, data and compute over x402 without exposing what they buy, how much they spend, or who owns them.

> Status: early development. Nothing here is audited or ready for real funds.

## Why

Agents increasingly pay their own way over [x402](https://www.x402.org/), settling in stablecoins on-chain. Every one of those payments is public: anyone watching can see which services an agent uses, how often, how much it spends, and trace it back to the owner's wallet. For a trading agent that is its strategy; for a business it is its suppliers and costs.

Sodi gives agents the same privacy a bank account gives people, while staying compatible with existing x402 merchants and with compliance requirements.

## How rx402 works

1. **Deposit.** The agent's owner deposits USDG into Sodi's shielded pool. Deposits are screened on entry.
2. **Open a session.** The agent proves with a zero-knowledge proof that it owns funds in the pool and withdraws a small budget to a brand-new session address. A relayer pays the gas, so the session address needs no ETH and has no history.
3. **Pay.** The agent calls an x402 endpoint, receives `402 Payment Required`, and signs a standard USDG transfer (EIP-3009) from the session address. Any x402 facilitator can settle it. Merchants change nothing.
4. **Rotate.** When the budget runs out or a time limit passes, the agent opens a new session from a new address. Leftover funds can return to the pool.

### What is private, and what is not

| Hidden | Still visible |
| --- | --- |
| The link between the owner's wallet and the agent's spending | Individual payments within one session |
| The link between one session and the next | Amounts and timing of each payment |
| An agent's total spend across sessions | That a session address was funded from the pool |

Privacy strengthens as more agents share the pool. Smaller budgets and faster rotation trade cost for privacy.

## Repository layout

```
sodi/
├── contracts/        Pool deployment and Sodi contracts (Foundry)
├── packages/
│   ├── rx402/        Agent SDK: deposits, private sessions, x402 payments (@sodi/rx402)
│   └── mcp/          MCP server: private x402 payments as agent tools (@sodi/mcp)
├── asp/              Approval service: screens deposits, publishes the approved set
├── relayer/          Gasless withdrawals to session addresses
├── dashboard/        Owner app: spend limits, kill switch, view keys
└── docs/             Specs and guides
```

## Built on

- **[Privacy Pools](https://github.com/0xbow-io/privacy-pools-core)** by 0xbow: the audited shielded pool, contracts and circuits, used as a dependency and deployed unchanged. See [`NOTICE`](./NOTICE).
- **[x402](https://www.x402.org/)**: the HTTP 402 payment standard for agents.
- **Robinhood Chain**: settlement in USDG (chain ID 4663; testnet 46630).

## Roadmap

- [x] USDG privacy pool live on Robinhood Chain testnet ([addresses](./contracts/README.md#deployments))
- [x] Approval service that screens deposits and publishes the approved set
- [x] rx402 SDK: private sessions paying x402 v1 and v2 merchants, tested end to end on a testnet fork
- [x] Relayer service and MCP server, tested together end to end on a testnet fork
- [ ] Owner dashboard and a public demo agent
- [ ] Capped mainnet beta with partner merchants
- [ ] Sodi L3 for per-payment privacy and near-zero fees

## Security

Do not use this code with real funds. To report a vulnerability, see [`SECURITY.md`](./SECURITY.md).

## License

[Apache License 2.0](./LICENSE).

Sodi is an independent project and is not affiliated with Robinhood Markets, Inc.
