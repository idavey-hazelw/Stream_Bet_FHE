pragma solidity ^0.8.24;
import { FHE, euint32, ebool } from "@fhevm/solidity/lib/FHE.sol";
import { SepoliaConfig } from "@fhevm/solidity/config/ZamaConfig.sol";

contract StreamBetFHE is SepoliaConfig {
    using FHE for euint32;
    using FHE for ebool;

    error NotOwner();
    error NotProvider();
    error Paused();
    error InvalidState();
    error CooldownActive();
    error BatchClosed();
    error BatchFull();
    error InvalidBatch();
    error InvalidRequest();
    error StaleWrite();
    error NotInitialized();
    error InvalidInput();

    address public owner;
    bool public paused;
    uint256 public cooldownSeconds;
    uint256 public maxBatchSize;
    uint256 public currentModelVersion;
    uint256 public totalBets;
    uint256 public totalBatches;
    uint256 public totalPayouts;

    mapping(address => bool) public providers;
    mapping(address => uint256) public lastActionAt;
    mapping(uint256 => Batch) public batches;
    mapping(uint256 => DecryptionContext) public decryptionContexts;
    mapping(uint256 => mapping(address => uint256)) public userBetsInBatch;
    mapping(address => mapping(uint256 => euint32)) public encryptedBets;
    mapping(address => mapping(uint256 => euint32)) public encryptedOdds;

    struct Batch {
        uint256 id;
        uint256 modelVersion;
        uint256 totalEncryptedBets;
        uint256 totalEncryptedOdds;
        bool isOpen;
        uint256 createdAt;
        uint256 updatedAt;
    }

    struct DecryptionContext {
        uint256 batchId;
        uint256 modelVersion;
        bytes32 stateHash;
        bool processed;
        address requester;
    }

    event OwnershipTransferred(address indexed previousOwner, address indexed newOwner);
    event ProviderAdded(address indexed provider);
    event ProviderRemoved(address indexed provider);
    event Paused(address indexed account);
    event Unpaused(address indexed account);
    event CooldownUpdated(uint256 previousCooldown, uint256 newCooldown);
    event MaxBatchSizeUpdated(uint256 previousMaxBatchSize, uint256 newMaxBatchSize);
    event BatchOpened(uint256 indexed batchId, uint256 modelVersion);
    event BatchClosed(uint256 indexed batchId);
    event BetPlaced(address indexed user, uint256 indexed batchId, bytes32 encryptedBet, bytes32 encryptedOdds);
    event DecryptionRequested(uint256 indexed requestId, uint256 indexed batchId, bytes32 stateHash);
    event DecryptionComplete(uint256 indexed requestId, uint256 indexed batchId, uint256 totalBets, uint256 totalOdds);
    event PayoutProcessed(uint256 indexed batchId, uint256 totalPayout);

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    modifier onlyProvider() {
        if (!providers[msg.sender]) revert NotProvider();
        _;
    }

    modifier whenNotPaused() {
        if (paused) revert Paused();
        _;
    }

    modifier checkCooldown() {
        if (block.timestamp < lastActionAt[msg.sender] + cooldownSeconds) {
            revert CooldownActive();
        }
        lastActionAt[msg.sender] = block.timestamp;
        _;
    }

    constructor() {
        owner = msg.sender;
        providers[owner] = true;
        cooldownSeconds = 30;
        maxBatchSize = 100;
        currentModelVersion = 1;
        totalBets = 0;
        totalBatches = 0;
        totalPayouts = 0;
        emit ProviderAdded(owner);
    }

    function transferOwnership(address newOwner) external onlyOwner {
        emit OwnershipTransferred(owner, newOwner);
        owner = newOwner;
    }

    function addProvider(address provider) external onlyOwner {
        if (provider == address(0)) revert InvalidInput();
        providers[provider] = true;
        emit ProviderAdded(provider);
    }

    function removeProvider(address provider) external onlyOwner {
        if (provider == address(0)) revert InvalidInput();
        providers[provider] = false;
        emit ProviderRemoved(provider);
    }

    function setPaused(bool _paused) external onlyOwner {
        if (_paused) {
            paused = true;
            emit Paused(msg.sender);
        } else {
            paused = false;
            emit Unpaused(msg.sender);
        }
    }

    function setCooldown(uint256 newCooldown) external onlyOwner {
        emit CooldownUpdated(cooldownSeconds, newCooldown);
        cooldownSeconds = newCooldown;
    }

    function setMaxBatchSize(uint256 newMaxBatchSize) external onlyOwner {
        if (newMaxBatchSize == 0) revert InvalidInput();
        emit MaxBatchSizeUpdated(maxBatchSize, newMaxBatchSize);
        maxBatchSize = newMaxBatchSize;
    }

    function openBatch() external onlyProvider whenNotPaused checkCooldown {
        uint256 batchId = totalBatches + 1;
        if (batches[batchId].id != 0) revert InvalidBatch();

        batches[batchId] = Batch({
            id: batchId,
            modelVersion: currentModelVersion,
            totalEncryptedBets: 0,
            totalEncryptedOdds: 0,
            isOpen: true,
            createdAt: block.timestamp,
            updatedAt: block.timestamp
        });
        totalBatches = batchId;
        emit BatchOpened(batchId, currentModelVersion);
    }

    function closeBatch(uint256 batchId) external onlyProvider whenNotPaused {
        Batch storage batch = batches[batchId];
        if (batch.id == 0 || !batch.isOpen) revert InvalidBatch();

        batch.isOpen = false;
        batch.updatedAt = block.timestamp;
        emit BatchClosed(batchId);
    }

    function placeBet(
        uint256 batchId,
        euint32 encryptedBet,
        euint32 encryptedOdds
    ) external whenNotPaused checkCooldown {
        Batch storage batch = batches[batchId];
        if (batch.id == 0 || !batch.isOpen) revert BatchClosed();

        if (userBetsInBatch[msg.sender][batchId] > 0) {
            revert InvalidState();
        }

        if (batch.totalEncryptedBets >= maxBatchSize) {
            revert BatchFull();
        }

        _requireInitialized(encryptedBet, "encryptedBet");
        _requireInitialized(encryptedOdds, "encryptedOdds");

        encryptedBets[msg.sender][batchId] = encryptedBet;
        encryptedOdds[msg.sender][batchId] = encryptedOdds;
        userBetsInBatch[msg.sender][batchId] = 1;

        batch.totalEncryptedBets = FHE.add(batch.totalEncryptedBets, encryptedBet).value;
        batch.totalEncryptedOdds = FHE.add(batch.totalEncryptedOdds, encryptedOdds).value;
        batch.updatedAt = block.timestamp;

        totalBets++;
        emit BetPlaced(msg.sender, batchId, FHE.toBytes32(encryptedBet), FHE.toBytes32(encryptedOdds));
    }

    function requestBatchDecryption(uint256 batchId) external onlyProvider whenNotPaused {
        Batch storage batch = batches[batchId];
        if (batch.id == 0 || batch.isOpen) revert InvalidBatch();

        bytes32[] memory cts = new bytes32[](2);
        cts[0] = FHE.toBytes32(batch.totalEncryptedBets);
        cts[1] = FHE.toBytes32(batch.totalEncryptedOdds);

        bytes32 stateHash = _hashCiphertexts(cts);
        uint256 requestId = FHE.requestDecryption(cts, this.onBatchDecrypted.selector);

        decryptionContexts[requestId] = DecryptionContext({
            batchId: batchId,
            modelVersion: batch.modelVersion,
            stateHash: stateHash,
            processed: false,
            requester: msg.sender
        });

        emit DecryptionRequested(requestId, batchId, stateHash);
    }

    function onBatchDecrypted(
        uint256 requestId,
        bytes memory cleartexts,
        bytes memory proof
    ) public {
        DecryptionContext storage context = decryptionContexts[requestId];
        if (context.processed) revert InvalidRequest();

        Batch storage batch = batches[context.batchId];
        if (batch.id == 0) revert InvalidBatch();

        // Rebuild cts from current storage state
        bytes32[] memory cts = new bytes32[](2);
        cts[0] = FHE.toBytes32(batch.totalEncryptedBets);
        cts[1] = FHE.toBytes32(batch.totalEncryptedOdds);

        bytes32 currHash = _hashCiphertexts(cts);
        if (currHash != context.stateHash) {
            revert InvalidState();
        }

        FHE.checkSignatures(requestId, cleartexts, proof);

        // Decode cleartexts in the same order as cts
        (uint32 totalBetsCleartext, uint32 totalOddsCleartext) = abi.decode(cleartexts, (uint32, uint32));

        // Emit minimal plaintext results
        emit DecryptionComplete(requestId, context.batchId, totalBetsCleartext, totalOddsCleartext);

        // Process payout (example)
        uint256 payout = (totalBetsCleartext * totalOddsCleartext) / 100;
        totalPayouts += payout;
        emit PayoutProcessed(context.batchId, payout);

        context.processed = true;
        delete decryptionContexts[requestId];
    }

    function _hashCiphertexts(bytes32[] memory cts) internal pure returns (bytes32) {
        return keccak256(abi.encode(cts, address(this)));
    }

    function _initIfNeeded(euint32 x) internal pure returns (euint32) {
        if (!FHE.isInitialized(x)) {
            return FHE.asEuint32(0);
        }
        return x;
    }

    function _requireInitialized(euint32 x, string memory tag) internal pure {
        if (!FHE.isInitialized(x)) {
            revert NotInitialized();
        }
    }

    // Additional helper for batch management
    function _updateBatchTotals(
        Batch storage batch,
        euint32 encryptedBet,
        euint32 encryptedOdds
    ) internal {
        batch.totalEncryptedBets = FHE.add(batch.totalEncryptedBets, encryptedBet);
        batch.totalEncryptedOdds = FHE.add(batch.totalEncryptedOdds, encryptedOdds);
        batch.updatedAt = block.timestamp;
    }

    // Security commentary: The decryption callback is protected against replay attacks
    // by checking the stateHash computed from ciphertexts against the stored hash.
    // This ensures that the ciphertexts haven't changed since the decryption request.
    // Only minimal plaintext results are revealed after proof verification, maintaining
    // privacy of individual bets and odds. The system prioritizes confidentiality
    // by keeping all sensitive data encrypted in storage and only decrypting
    // aggregated results when necessary for payouts.

    // Note: This contract demonstrates a simplified betting system. In production,
    // additional features like dispute resolution, more complex odds calculations,
    // and enhanced security measures would be required. The current implementation
    // focuses on core FHE operations and secure state management.
}