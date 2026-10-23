import { parseAbi } from 'viem';

export const sodiA2AAbi = parseAbi([
  'function setKey(bytes32 key)',
  'function setKeyFor(address agent, bytes32 key, uint256 deadline, bytes signature)',
  'function createChannel(bool restricted, address[] writers) returns (uint256)',
  'function setWriter(uint256 channelId, address writer, bool allowed)',
  'function post(uint256 channelId, bytes envelope)',
  'function postFor(address author, uint256 channelId, bytes envelope, uint256 deadline, bytes signature)',
  'function encryptionKey(address) view returns (bytes32)',
  'function nonces(address) view returns (uint256)',
  'function canPost(uint256 channelId, address author) view returns (bool)',
  'function channelCount() view returns (uint256)',
  'event Posted(uint256 indexed channelId, address indexed author, bytes envelope)',
  'event ChannelCreated(uint256 indexed channelId, address indexed owner, bool restricted)',
  'error NotAWriter()',
  'error InvalidEnvelope()',
  'error UnknownChannel()',
  'error BadSignature()',
]);
