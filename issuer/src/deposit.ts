/**
 * Deposits USDG from the owner wallet into the pool, on the issuer's behalf.
 *
 *   OWNER_PRIVATE_KEY=0x… RX402_MNEMONIC="…" npm run deposit --workspace issuer -- 5
 *
 * Stop the issuer first: both write the same store.
 */
import { formatUnits, parseUnits } from 'viem';

import { lockStore, poolFromEnv } from './setup.js';

const amount = process.argv[2];
if (!amount || !/^\d+(\.\d{1,6})?$/.test(amount)) {
  console.error('usage: npm run deposit --workspace issuer -- <amount in USDG>');
  process.exit(1);
}
if (!process.env.OWNER_PRIVATE_KEY) {
  console.error('set OWNER_PRIVATE_KEY (the wallet holding the USDG)');
  process.exit(1);
}
const { wallet, storePath } = await poolFromEnv({ withRelayer: false });
const release = lockStore(storePath);
try {
  const note = await wallet.deposit(parseUnits(amount, 6));
  console.log(`deposited ${formatUnits(BigInt(note.value), 6)} USDG in ${note.depositTx} (label ${note.label})`);
  console.log(`pool balance: ${formatUnits(wallet.poolBalance(), 6)} USDG; the approval service must approve it before sessions can use it`);
} finally {
  release();
}
process.exit(0);
