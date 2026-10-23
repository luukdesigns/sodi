# @sodi/rx402

Agent SDK for private x402 payments.

Planned API: a drop-in replacement for `fetch` that handles the full rx402 flow.

1. Opens a session by proving pool ownership and withdrawing a budget to a fresh address via the relayer.
2. On `402 Payment Required`, signs a USDG EIP-3009 authorization from the session address.
3. Rotates to a new session when the budget or time limit is reached.

Status: not yet implemented.
