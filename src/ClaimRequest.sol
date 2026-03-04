// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/// @title ClaimRequest
/// @notice Intentionally thin — its sole job is to emit a ClaimSubmitted event
///         that the Chainlink CRE enclave listens for via an EVM Log Trigger.
///
/// @dev Privacy design:
///      - The fhir_claim_id (e.g. "131299879") is NEVER stored or logged onchain.
///      - The claimant provides only an `encryptedPayloadHash` — the keccak256 hash
///        of an off-chain encrypted payload that contains the FHIR claim ID.
///      - In production, the payload is asymmetrically encrypted to the enclave's public key.
///      - An observer can see "a claim was submitted by address X for policy Y"
///        but cannot determine WHICH medical claim is being processed.
///      - The CRE EVM Log Trigger fires on ClaimSubmitted and passes the claim ID
///        to the enclave via an encrypted off-chain channel — never through calldata.
contract ClaimRequest {
    /// @notice Emitted when a claimant submits a medical claim for processing.
    ///         The CRE workflow's EVM Log Trigger listens for this event.
    /// @param policyId            keccak256 of the policy identifier
    /// @param claimant            The wallet submitting the claim (must match policy owner)
    /// @param encryptedPayloadHash keccak256 hash of the encrypted payload containing fhir_claim_id
    ///                            This is a HASH of the encrypted data — not the data itself
    /// @param timestamp           Block timestamp for ordering and replay protection
    event ClaimSubmitted(
        bytes32 indexed policyId,
        address indexed claimant,
        bytes32 encryptedPayloadHash,
        uint256 timestamp
    );

    /// @notice Submit a medical claim for enclave processing.
    ///         The actual medical claim ID is NOT an argument to this function.
    ///         It is delivered to the enclave separately via an encrypted channel.
    /// @param policyId             keccak256 of the policy string identifier (e.g. keccak256("DEMO-001"))
    /// @param encryptedPayloadHash keccak256 hash of the encrypted payload (proves submission without revealing claim ID)
    function submitClaim(
        bytes32 policyId,
        bytes32 encryptedPayloadHash
    ) external {
        require(policyId != bytes32(0), "ClaimRequest: invalid policy ID");
        require(
            encryptedPayloadHash != bytes32(0),
            "ClaimRequest: invalid payload hash"
        );

        emit ClaimSubmitted(
            policyId,
            msg.sender,
            encryptedPayloadHash,
            block.timestamp
        );
    }
}
