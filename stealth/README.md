# Sodi Stealth

**Merchants get paid at a new address every time.**

rx402 hides who is paying. Stealth addresses hide who is being paid. A merchant that opts in never receives a payment at its public address: every x402 payment lands at a fresh one-time address that only the merchant can find and spend from. Anyone watching the chain sees unrelated addresses, not one merchant's revenue.

- **Opt in on both sides.** Merchants offer it per endpoint. Agents use it by default and can turn it off. Merchants that don't offer it are paid exactly as before.
- **Built on the standards.** ERC-5564 stealth addresses (scheme 1, secp256k1 with view tags) and the ERC-6538 registry, using the canonical contracts already on Robinhood Chain. Cross-checked against the ERC-5564 reference SDK.
- **Found from the chain alone.** Every payment is announced on-chain in the same transaction that moves the funds, and the payer's signature fixes what the announcement says, so no one can settle a payment in a way the merchant can't find. A merchant recovers everything from its wallet, with no database.
- **No gas in stealth addresses.** Funds move in and out with EIP-3009 signatures, the same mechanism x402 uses, so a stealth address never needs ETH.
- **The server can't spend.** A merchant's server needs only the viewing key to accept payments. The spending key can stay offline.

> Experimental and unaudited.

## How it works

1. **The merchant publishes a meta-address**, two public keys derived from its wallet, in the ERC-6538 registry, and adds it to its x402 payment requirements.
2. **The agent derives a one-time address** from the meta-address and a random ephemeral key. It signs an EIP-3009 `ReceiveWithAuthorization` paying the merchant's settler, with a nonce that commits to the stealth address, the ephemeral public key and the view tag.
3. **The merchant's server checks** that the address is one of its own, using the viewing key, and that the authorization is valid. Then it settles through `SodiStealthSettler`, which receives the funds, passes them to the stealth address and emits the ERC-5564 announcement, all in one transaction.

Only the settler can execute a `ReceiveWithAuthorization` made out to it, and only with the data the nonce commits to. So whoever submits the payment (the merchant, a shared facilitator, or someone who copied the signed payload), it lands at the right address and is announced exactly as the merchant needs to find it. The settler accepts only tokens fixed when it was deployed, so its announcements always describe real payments.
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
    "stealth": { "scheme": "erc5564:1", "metaAddress": "st:eth:0x02…03…", "settler": "0xb29990E4C28737ab9B0aFae0c308ae9D025AEB31" }
  }
}
```

A client that supports the extension signs a `ReceiveWithAuthorization` to the settler and adds the stealth data to the payload:

```json
{
  "signature": "0x…",
  "authorization": { "from": "0x…session", "to": "0x…settler", "value": "50000", "nonce": "0x…commitment", "…": "…" },
  "stealth": { "stealthAddress": "0x…one-time address", "ephemeralPublicKey": "0x02…", "viewTag": "0xa7" }
}
```

The nonce is `keccak256(abi.encode(keccak256("sodi-stealth-settle-v1"), stealthAddress, keccak256(ephemeralPublicKey), viewTag))`.

A merchant that offers stealth must verify these payments itself, or through a facilitator that understands the extension, because a standard facilitator rejects any `to` that isn't `payTo`.

## Live on Robinhood Chain testnet

| Contract | Address |
| --- | --- |
| SodiStealthSettler (accepts USDG and the demo token) | `0xb29990E4C28737ab9B0aFae0c308ae9D025AEB31` |
| ERC-5564 Announcer (canonical) | `0x55649E01B5Df198D18D95b5cc5051630cfD45564` |
| ERC-6538 Registry (canonical) | `0x6538E6bf4B0eBd30A8Ea093027Ac2422ce5d6538` |
| TestDollar3009 (demo token) | `0x023eA2939e1744B158F01138f3F1dD6DcFcABf59` |

The first settler (`0x2713…855E`) was replaced after the [security review](../docs/security-review-2026-10.md): it didn't bind the announcement to the payer's signature.

`sdk/demo/stealth-pay.ts` ran live. A merchant registered its meta-address, an agent session paid it three times, and the merchant found and swept the payments:

```
3. An agent session pays three times
   payment 1: 0.05 tUSD to 0xcedD040c3B048027036AB00126b381a07EFe566d
   payment 2: 0.05 tUSD to 0xCdb03f63dd1a7d8644888E0de7991978c563f304
   payment 3: 0.05 tUSD to 0x84B5b3eA140fc00782ac55a1D960cf83900f51d0
   merchant's public address received: 0 tUSD
4. The merchant finds its payments from the chain alone
   (all three, 0.05 tUSD each)
5. And sweeps them; the stealth addresses never need gas
   vault 0xA53a905994B14F65b35995464BC9e6a3CF75e697 holds 0.15 tUSD
```

Transactions are in [`deployments/46630.json`](./deployments/46630.json). The demo uses a test dollar with EIP-3009, because testnet USDG is scarce. The [demo agent](../demo-agent) has also paid with real USDG through this settler, and the end-to-end test uses real USDG and the real pool on a fork.

## Usage

```ts
import { StealthMerchant, StealthReceiver, deriveStealthKeys, registerMetaAddress, viewingOnly } from '@sodi/stealth';

// Merchant, once: derive keys from the wallet and publish the meta-address
const keys = await deriveStealthKeys(merchantWallet);
await registerMetaAddress(merchantWallet, publicClient, new StealthMerchant(keys).metaAddress);

// Merchant server: viewing key only
const receiver = new StealthReceiver(viewingOnly(keys), SETTLER);
const requirement = receiver.offer(baseRequirement);                  // 402 response
const verified = await receiver.verify(payment, { asset, amount, chainId, domain });
await receiver.settle(facilitatorWallet, publicClient, verified);

// Merchant, offline: find and sweep
const merchant = new StealthMerchant(keys, SETTLER);
const found = await merchant.scan(publicClient, { fromBlock, tokens: [USDG] });
await merchant.sweep({ publicClient, gasPayer, payments: found, token, domain, to });
```

Agents need nothing new. `Rx402Client` pays stealth addresses whenever a merchant offers one. Set `stealth: false` to always pay `payTo`; in the MCP server, the setting is `RX402_STEALTH=false`.

## What it hides, and what it doesn't

- **Hidden:** which payments went to which merchant, and a merchant's total revenue. Its public address never receives anything.
- **Visible:** amounts, timing, and the paying session. rx402 is what keeps the session unlinked from the agent's owner.
- **Whoever pays settlement gas is visible.** If a merchant settles every payment from its own wallet, that wallet links its stealth addresses. Settle through a facilitator that many merchants share.
- **Sweeping can re-link.** Moving many stealth addresses to one destination, or all at once, ties them back together. Sweep to different destinations, at different times, or into a privacy pool.
- **The viewing key sees all incoming payments.** It can't spend them, but treat it as confidential.
- **The key signature is the spending key.** Keys are derived from a wallet signature, so anyone who obtains that signature can spend. The message says so. Wallets that sign non-deterministically are refused, since their meta-address would change every time.

## Tests

- `contracts/`: 9 Foundry tests for the settler: settlement and announcement in one transaction, the ERC-5564 metadata layout, anyone can settle, forged announcement data or a redirected stealth address fails, the funds can't be moved without the settler, tokens not fixed at deployment are refused, replays and malformed ephemeral keys are rejected, nothing stays in the contract.
- `sdk/test/unit`: 19 tests. Addresses, ephemeral keys and view tags match the ERC-5564 reference SDK byte for byte, and each implementation recognises and spends the other's addresses. Also covered: meta-address parsing, key derivation (including signature encodings), the x402 extension, and payment verification (another merchant's address, a payment that bypasses the settler or doesn't commit to the stealth address, underpayment, expiry, forged signatures).
- `sdk/test/e2e/run-fork.sh`: on a testnet fork with the real pool, USDG, announcer and registry. An `Rx402Client` pays a stealth merchant three times, to three different addresses and never `payTo`. A merchant without the offer, and an agent with stealth off, pay `payTo`. The merchant finds exactly its three payments from announcements, a stranger finds none, and the sweep empties every stealth address without gas.
