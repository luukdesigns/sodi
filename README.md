<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="brand/sodi-logo-light.svg">
    <img src="brand/sodi-logo-dark.svg" alt="Sodi" width="120">
  </picture>
</p>

# Sodi

[![CI](https://github.com/rowanweiss/sodi/actions/workflows/ci.yml/badge.svg)](https://github.com/rowanweiss/sodi/actions/workflows/ci.yml)

**Privacy-first infrastructure for agentic finance.**

[sodi.network](https://sodi.network) · [@SodiNetwork on X](https://x.com/SodiNetwork)

Sodi builds **rx402**: private x402 payments for AI agents. Agents pay for APIs, data and compute over x402 without exposing what they buy, how much they spend, or who owns them.

> Status: early development. Nothing here is audited or ready for real funds. An internal security review is written up in [`docs/security-review-2026-10.md`](./docs/security-review-2026-10.md).

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
├── contracts/        Pool deployment and the Sodi recycler (Foundry)
├── packages/
│   ├── rx402/        Agent SDK: deposits, private sessions, x402 payments (@sodi/rx402)
│   └── mcp/          MCP server: private x402 payments as agent tools (@sodi/mcp)
├── asp/              Approval service: screens deposits, publishes the approved set
├── relayer/          Gasless withdrawals to session addresses
├── issuer/           Session issuer: keeps the pool secret off the agent's machine
├── dashboard/        Owner app: kill switch, spend limits, sessions and payment history
├── demo-agent/       Public demo: an agent paying for data privately, with a live page
├── a2a/              Experimental: encrypted agent-to-agent messaging (MIT)
├── erc8183/          Experimental: confidential deliverables hook for ERC-8183 jobs
├── memory/           Experimental: encrypted, versioned agent memory
├── disclosure/       Experimental: scoped, verifiable disclosure to auditors
├── stealth/          Experimental: opt-in stealth addresses for x402 merchants
├── chain/            Draft: Sodi L3, an Orbit chain settling to Robinhood Chain
└── docs/             Specs and guides
```

## Experiments

- **[Sodi A2A](./a2a)**: private agent-to-agent messaging on a public chain. Agents negotiate and bid on-chain while the contract only sees ciphertext. Live on Robinhood Chain testnet; MIT licensed.
- **[ERC-8183 Privacy Hook](./erc8183)**: confidential deliverables for on-chain work. Jobs stay public and verifiable; only the client and evaluator can read the deliverable. Runs against the unmodified ERC-8183 reference. Live on Robinhood Chain testnet.
- **[Sodi Memory](./memory)**: encrypted, versioned memory for agents, recoverable from the wallet alone, with tamper-proof blob storage and safe concurrent writes. Live on Robinhood Chain testnet.
- **[Sodi Stealth](./stealth)**: merchants get paid at a new one-time address every time (ERC-5564), found and swept from the chain alone. Opt in per merchant; rx402 agents use it automatically. Live on Robinhood Chain testnet.
- **[Sodi Disclosure](./disclosure)**: show an auditor exactly the messages, memory, job deliverables or deposits you choose, verified against the chain, with revocable ongoing access. Works across every Sodi component.

## Built on

- **[Privacy Pools](https://github.com/0xbow-io/privacy-pools-core)** by 0xbow: the audited shielded pool, contracts and circuits, used as a dependency and deployed unchanged. See [`NOTICE`](./NOTICE).
- **[x402](https://www.x402.org/)**: the HTTP 402 payment standard for agents.
- **Robinhood Chain**: settlement in USDG (chain ID 4663; testnet 46630).

## Roadmap

- [x] USDG privacy pool live on Robinhood Chain testnet ([addresses](./contracts/README.md#deployments))
- [x] Approval service that screens deposits and publishes the approved set
- [x] rx402 SDK: private sessions paying x402 v1 and v2 merchants, tested end to end on a testnet fork
- [x] Relayer service and MCP server, tested together end to end on a testnet fork
- [x] rx402 live on testnet: deposit, approval, relayed ZK sessions, ordinary and stealth x402 payments ([transactions](./contracts/deployments/46630.json))
- [x] Owner dashboard: kill switch, spend limits, payment history ([dashboard](./dashboard))
- [x] Recycling: leftover session funds and stealth payments go back into the pool with no gas at the address ([SodiRecycler](./contracts/README.md#sodirecycler))
- [x] Session issuer: the agent holds only its own key; the pool secret and the hard limits live elsewhere ([issuer](./issuer))
- [x] Public demo agent: buys data privately on a loop, with a live public page ([demo-agent](./demo-agent)); needs a server to stay up
- [ ] Capped mainnet beta with partner merchants
- [ ] Yield pool: the pool earns Morpho interest, so savers deepen the anonymity set ([design and prototype](./docs/yield-pool-design.md))
- [ ] Sodi L3 for per-payment privacy and near-zero fees ([draft](./chain))

## Security

Do not use this code with real funds. To report a vulnerability, see [`SECURITY.md`](./SECURITY.md).

## License

[Apache License 2.0](./LICENSE), except [`a2a/`](./a2a), which is [MIT](./a2a/LICENSE).

Sodi is an independent project and is not affiliated with Robinhood Markets, Inc.
