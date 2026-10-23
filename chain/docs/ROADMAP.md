# Sodi L3: roadmap and open questions

## Stages

### 0. Draft (now)

- [x] Confirm Robinhood Chain is a supported Orbit parent: RollupCreator and TokenBridgeCreator are live on testnet and mainnet, and the chain SDK knows both networks.
- [x] Deployment scripts: core contracts, node config, token bridge.
- [x] Rehearse the core deployment on a testnet fork against the real RollupCreator.
- [ ] Measure an rx402 session's gas on Robinhood Chain, to know what the L3 needs to beat.

### 1. Devnet (days)

- [ ] Deploy core contracts on Robinhood Chain testnet (needs ~0.13 testnet ETH).
- [ ] Run one Nitro node as sequencer, batch poster and validator.
- [ ] Deploy the token bridge; bridge ETH in and out.
- [ ] Deploy the Sodi contracts; run the A2A, memory and ERC-8183 demos on the L3.
- [ ] Public RPC and a Blockscout explorer.

### 2. Testnet (weeks)

- [ ] Custom USDG gateway with an EIP-3009 L3 token; run rx402 end to end on the L3.
- [ ] Separate machines and keys for sequencer, batch poster and validator.
- [ ] Prototype a Stylus Poseidon and measure the saving.
- [ ] Gas policy: decide the gas token; prototype gasless session actions.
- [ ] Publish the ordering policy.

### 3. Mainnet (months, gated)

Launch only when all of these hold:

- [ ] The measured case: the L3 is cheaper, faster or more private for an rx402 session by a margin worth the split anonymity set.
- [ ] Audits of any changed pool code (Stylus primitives), the custom gateway and the deployment.
- [ ] Chain ID registered; gas token and DA mode final (both are fixed at genesis).
- [ ] Owner is a multisig with a timelock; keys in hardware or a KMS.
- [ ] Fast exits for USDG.
- [ ] Revenue-share terms confirmed with Offchain Labs.
- [ ] At least one x402 facilitator and a set of merchants accept the L3 network.
- [ ] Sequencer redundancy, monitoring and an incident runbook.

## Open questions

1. **One pool or two?** Does the pool move to the L3, stay on Robinhood Chain, or run on both? Two pools halve the crowd each user hides in.
2. **Gas token.** ETH, USDG or a Sodi token? Does Nitro support a 6-decimal gas token on our target version?
3. **USDG on the L3.** Native issuance by Paxos, or a bridged token with EIP-3009? Who signs off?
4. **Stock tokens.** Can they bridge at all, given their transfer rules? Is there demand for private stock-token payments, or is USDG enough?
5. **Merchant reach.** Will facilitators add chain 7634, or do L3 sessions need to settle merchant payments back on Robinhood Chain?
6. **Encrypted ordering.** Which approach, and when is it ready for Nitro?
7. **Naming.** Sodi Chain, or a name of its own (Pardes was the other candidate)?
