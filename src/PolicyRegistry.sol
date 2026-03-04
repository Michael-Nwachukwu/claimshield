// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/// @title PolicyRegistry
/// @notice Stores insurance policies and claim verdicts.
///         Only the approved enclave address (set per-policy) can record verdicts.
///         No medical data is ever stored here — only verdicts and policy metadata.
contract PolicyRegistry {
    struct Policy {
        address owner;
        bool premiumPaid;
        uint256 coverageStart;
        uint256 coverageEnd;
        uint256 maxPayout; // USDC, 6 decimals
        address approvedEnclave; // Only this address can call recordVerdict
        bool active;
    }

    struct Verdict {
        string status; // "approved" | "denied" | "escalated"
        uint256 payoutAmount; // USDC, 6 decimals
        uint8 reasonCode;
        bytes32 complianceHash;
        uint256 timestamp;
    }

    mapping(bytes32 => Policy) public policies;
    mapping(bytes32 => Verdict) public verdicts;
    mapping(bytes32 => bool) public claimProcessed;

    event PolicyRegistered(
        bytes32 indexed policyId,
        address indexed owner,
        address indexed enclave
    );
    event PremiumPaid(bytes32 indexed policyId, address indexed owner);
    event VerdictRecorded(
        bytes32 indexed policyId,
        string status,
        uint256 amount,
        bytes32 complianceHash
    );

    modifier onlyApprovedEnclave(bytes32 policyId) {
        require(
            msg.sender == policies[policyId].approvedEnclave,
            "PolicyRegistry: not approved enclave"
        );
        _;
    }

    modifier policyExists(bytes32 policyId) {
        require(
            policies[policyId].owner != address(0),
            "PolicyRegistry: policy does not exist"
        );
        _;
    }

    /// @notice Register a new insurance policy.
    /// @param policyId     keccak256 hash of a human-readable policy identifier (e.g. "DEMO-001")
    /// @param coverageStart Unix timestamp for when coverage begins
    /// @param coverageEnd   Unix timestamp for when coverage ends
    /// @param maxPayout     Maximum USDC payout (6 decimal places)
    /// @param enclave       Address of the enclave wallet authorised to write verdicts
    function registerPolicy(
        bytes32 policyId,
        uint256 coverageStart,
        uint256 coverageEnd,
        uint256 maxPayout,
        address enclave
    ) external {
        require(
            policies[policyId].owner == address(0),
            "PolicyRegistry: policy already exists"
        );
        require(
            enclave != address(0),
            "PolicyRegistry: invalid enclave address"
        );
        require(
            coverageEnd > coverageStart,
            "PolicyRegistry: invalid coverage period"
        );

        policies[policyId] = Policy({
            owner: msg.sender,
            premiumPaid: false,
            coverageStart: coverageStart,
            coverageEnd: coverageEnd,
            maxPayout: maxPayout,
            approvedEnclave: enclave,
            active: false
        });

        emit PolicyRegistered(policyId, msg.sender, enclave);
    }

    /// @notice Pay the premium to activate the policy.
    ///         For the demo, any non-zero ETH value activates the policy.
    ///         In production this would validate a real premium payment.
    function payPremium(
        bytes32 policyId
    ) external payable policyExists(policyId) {
        require(
            policies[policyId].owner == msg.sender,
            "PolicyRegistry: not policy owner"
        );
        require(
            !policies[policyId].premiumPaid,
            "PolicyRegistry: premium already paid"
        );

        policies[policyId].premiumPaid = true;
        policies[policyId].active = true;

        emit PremiumPaid(policyId, msg.sender);
    }

    /// @notice Record a verdict from the CRE enclave.
    ///         Called by the enclave after running eligibility logic against live FHIR data.
    ///         Only the approvedEnclave address set at registration can call this.
    ///         The compliance hash is a non-reversible proof that verification occurred —
    ///         it contains no medical data.
    /// @param policyId      The policy being adjudicated
    /// @param status        "approved", "denied", or "escalated"
    /// @param payoutAmount  USDC payout (6 decimals). Zero if denied.
    /// @param reasonCode    Numeric reason code (see ReasonCode enum in types.ts)
    /// @param complianceHash keccak256 non-reversible proof of the verification event
    function recordVerdict(
        bytes32 policyId,
        string calldata status,
        uint256 payoutAmount,
        uint8 reasonCode,
        bytes32 complianceHash
    ) external onlyApprovedEnclave(policyId) policyExists(policyId) {
        require(
            !claimProcessed[policyId],
            "PolicyRegistry: claim already processed"
        );
        require(policies[policyId].active, "PolicyRegistry: policy not active");
        require(
            payoutAmount <= policies[policyId].maxPayout,
            "PolicyRegistry: exceeds max payout"
        );

        claimProcessed[policyId] = true;

        verdicts[policyId] = Verdict({
            status: status,
            payoutAmount: payoutAmount,
            reasonCode: reasonCode,
            complianceHash: complianceHash,
            timestamp: block.timestamp
        });

        emit VerdictRecorded(policyId, status, payoutAmount, complianceHash);
    }

    function getPolicy(bytes32 policyId) external view returns (Policy memory) {
        return policies[policyId];
    }

    function getVerdict(
        bytes32 policyId
    ) external view returns (Verdict memory) {
        return verdicts[policyId];
    }

    /// @notice Check if a wallet is the active, premium-paid owner of a policy.
    function isEligible(
        bytes32 policyId,
        address wallet
    ) external view returns (bool) {
        Policy memory p = policies[policyId];
        return p.owner == wallet && p.active && p.premiumPaid;
    }
}
