# Sodi Stealth

**Merchants get paid at a new address every time.**

rx402 hides who is paying. Stealth addresses hide who is being paid. A merchant that opts in never receives a payment at its public address: every x402 payment lands at a fresh one-time address that only the merchant can find and spend from. Anyone watching the chain sees unrelated addresses, not one merchant's revenue.

- **Opt in on both sides.** Merchants offer it per endpoint. Agents use it by default and can turn it off. Merchants that don't offer it are paid exactly as before.
- **Built on the standards.** ERC-5564 stealth addresses (scheme 1, secp256k1 with view tags) and the ERC-6538 registry, using the canonical contracts already on Robinhood Chain. Cross-checked against the ERC-5564 reference SDK.
- **Found from the chain alone.** Every payment is announced on-chain in the same transaction that moves the funds, so a merchant recovers everything from its wallet, with no database.
- **No gas in stealth addresses.** Funds move in and out with EIP-3009 signatures, the same mechanism x402 uses, so a stealth address never needs ETH.
- **The server can't spend.** A merchant's server needs only the viewing key to accept payments. The spending key can stay offline.

> Experimental and unaudited.

## How it works

1. **The merchant publishes a meta-address**, two public keys derived from its wallet, in the ERC-6538 registry, and adds it to its x402 payment requirements.
2. **The agent derives a one-time address** from the meta-address and a random ephemeral key, and signs its EIP-3009 authorization to that address instead of `payTo`. It attaches the ephemeral public key and a one-byte view tag.
3. **The merchant's server checks** that the address is one of its own, using the viewing key, and that the authorization is valid. Then it settles through `SodiStealthSettler`, which moves the funds and emits the ERC-5564 announcement in one transaction.
4. **Later, the merchant scans** the announcements. The view tag lets it skip about 255 of every 256 that aren't for it. It computes the private key of each of its addresses and sweeps the funds with signed transfers.

## The x402 extension

The merchant adds a `stealth` object to the requirement's `extra`. `payTo` stays its normal address, so clients that don't know the extension can still pay it:

```json
{
  "scheme": "exact",
  "network": "eip155:46630",
  "asset": "0x7E955252E15c84f5768B83c41a71F9eba181802F",
  "payTo": "0x…merchant",
  "amount": "50000",
  "maxTimeoutSeconds": 300,
  "extra": {
    "name": "Global Dollar",
    "version": "1",
    "stealth": { "scheme": "erc5564:1", "metaAddress": "st:eth:0x02…03…" }
  }
}
```

A client that supports the extension pays the stealth address and adds the proof to the payload:

```json
{
  "signature": "0x…",
  "authorization": { "from": "0x…session", "to": "0x…one-time address", "value": "50000", "…": "…" },
  "stealth": { "ephemeralPublicKey": "0x02…", "viewTag": "0xa7" }
}
```

A merchant that offers stealth must verify these payments itself, or through a facilitator that understands the extension, because a standard facilitator rejects any `to` that isn't `payTo`.

## Live on Robinhood Chain testnet

| Contract | Address |
| --- | --- |
| SodiStealthSettler | `0x271320B5dF6fc8Dc778304f53B1D7b01B0c2855E` |
| ERC-5564 Announcer (canonical) | `0x55649E01B5Df198D18D95b5cc5051630cfD45564` |
| ERC-6538 Registry (canonical) | `0x6538E6bf4B0eBd30A8Ea093027Ac2422ce5d6538` |
| TestDollar3009 (demo token) | `0xb7226697f7dF4D260C72deA506C4f7e14c7761F1` |

`sdk/demo/stealth-pay.ts` ran live. A merchant registered its meta-address, an agent session paid it three times, and the merchant found and swept the payments:

```
3. An agent session pays three times
   payment 1: 0.05 tUSD to 0x4b469D3728271df66F0eC878b9CBCc8311d889aC
   payment 2: 0.05 tUSD to 0x742E4A6a42D3dcc010ff316C8Bb4DB2EeFb89dB7
   payment 3: 0.05 tUSD to 0xe09Dc77CF6255c90cb5f8979bb6C5b6a32e7b5D1
   merchant's public address received: 0 tUSD
4. The merchant finds its payments from the chain alone
   (all three, 0.05 tUSD each)
5. And sweeps them; the stealth addresses never need gas
   vault 0x97205A55a7F171e5C8EEe45Eaf21041da838B669 holds 0.15 tUSD
```

Transactions are in [`deployments/46630.json`](./deployments/46630.json). The demo uses a test dollar with EIP-3009, because testnet USDG is scarce. The end-to-end test uses real USDG and the real pool on a fork.

## Usage

```ts
import { StealthMerchant, StealthReceiver, deriveStealthKeys, registerMetaAddress, viewingOnly } from '@sodi/stealth';

// Merchant, once: derive keys from the wallet and publish the meta-address
const keys = await deriveStealthKeys(merchantWallet);
await registerMetaAddress(merchantWallet, publicClient, new StealthMerchant(keys).metaAddress);

// Merchant server: viewing key only
const receiver = new StealthReceiver(viewingOnly(keys));
const requirement = receiver.offer(baseRequirement);                  // 402 response
const verified = await receiver.verify(payment, { asset, amount, chainId, domain });
await receiver.settle(facilitatorWallet, publicClient, SETTLER, verified);

// Merchant, offline: find and sweep
const merchant = new StealthMerchant(keys);
const found = await merchant.scan(publicClient, { fromBlock, caller: SETTLER });
await merchant.sweep({ publicClient, gasPayer, payments: found, token, domain, to });
```

Agents need nothing new. `Rx402Client` pays stealth addresses whenever a merchant offers one. Set `stealth: false` to always pay `payTo`; in the MCP server, the setting is `RX402_STEALTH=false`.

## What it hides, and what it doesn't

- **Hidden:** which payments went to which merchant, and a merchant's total revenue. Its public address never receives anything.
- **Visible:** amounts, timing, and the paying session. rx402 is what keeps the session unlinked from the agent's owner.
- **Whoever pays settlement gas is visible.** If a merchant settles every payment from its own wallet, that wallet links its stealth addresses. Settle through a facilitator that many merchants share.
- **Sweeping can re-link.** Moving many stealth addresses to one destination, or all at once, ties them back together. Sweep to different destinations, at different times, or into a privacy pool.
- **The viewing key sees all incoming payments.** It can't spend them, but treat it as confidential.
- **The key signature is the spending key.** Keys are derived from a wallet signature, so anyone who obtains that signature can spend. The message says so.

## Tests

- `contracts/`: 7 Foundry tests for the settler: settlement and announcement in one transaction, the ERC-5564 metadata layout, anyone can settle, a redirected recipient or a replay fails, malformed ephemeral keys are rejected, nothing stays in the contract.
- `sdk/test/unit`: 15 tests. Addresses, ephemeral keys and view tags match the ERC-5564 reference SDK byte for byte, and each implementation recognises and spends the other's addresses. Also covered: meta-address parsing, key derivation, the x402 extension, and payment verification (another merchant's address, underpayment, expiry, forged signatures).
- `sdk/test/e2e/run-fork.sh`: on a testnet fork with the real pool, USDG, announcer and registry. An `Rx402Client` pays a stealth merchant three times, to three different addresses and never `payTo`. A merchant without the offer, and an agent with stealth off, pay `payTo`. The merchant finds exactly its three payments from announcements, a stranger finds none, and the sweep empties every stealth address without gas.
