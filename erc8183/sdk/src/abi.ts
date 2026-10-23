import { parseAbi } from 'viem';

/** ERC-8183 reference AgenticCommerce. */
export const agenticCommerceAbi = parseAbi([
  'function createJob(address provider, address evaluator, uint256 expiredAt, string description, address hook) returns (uint256)',
  'function setBudget(uint256 jobId, uint256 amount, bytes optParams)',
  'function fund(uint256 jobId, bytes optParams)',
  'function submit(uint256 jobId, bytes32 deliverable, bytes optParams)',
  'function complete(uint256 jobId, bytes32 reason, bytes optParams)',
  'function reject(uint256 jobId, bytes32 reason, bytes optParams)',
  'function paymentToken() view returns (address)',
  'function getJob(uint256 jobId) view returns ((uint256 id, address client, address provider, address evaluator, string description, uint256 budget, uint256 expiredAt, uint8 status, address hook))',
  'event JobCreated(uint256 indexed jobId, address indexed client, address indexed provider, address evaluator, uint256 expiredAt, address hook)',
  'event JobSubmitted(uint256 indexed jobId, address indexed provider, bytes32 deliverable)',
  'event JobCompleted(uint256 indexed jobId, address indexed evaluator, bytes32 reason)',
]);

export const hookAbi = parseAbi([
  'function parties(uint256 jobId) view returns (address client, address evaluator)',
  'function keys() view returns (address)',
  'event ConfidentialDeliverable(uint256 indexed jobId, address indexed provider, bytes32 deliverable, bytes envelope)',
  'event ConfidentialReason(uint256 indexed jobId, address indexed evaluator, bytes4 indexed action, bytes32 reason, bytes envelope)',
]);

export const erc20Abi = parseAbi([
  'function approve(address spender, uint256 amount) returns (bool)',
  'function balanceOf(address) view returns (uint256)',
]);

export const JOB_STATUS = ['Open', 'Funded', 'Submitted', 'Completed', 'Rejected', 'Expired'] as const;
