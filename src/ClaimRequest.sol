// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/// @title ClaimRequest
/// @notice Intentionally thin — its sole job is to emit a ClaimSubmitted event
///         that the Chainlink CRE enclave listens for via an EVM Log Trigger.
///
/// @dev Privacy design:
///      - The fhir_claim_id and World ID proof are NEVER stored or logged onchain in plaintext.
///      - The claimant provides an `encryptedPayload` — a variable-length XOR-encrypted blob
///        containing both the FHIR claim ID and the World ID proof fields.
///      - Only the TEE (which holds the shared secret) can decrypt it.
///      - The CRE enclave verifies the World ID proof AND the FHIR claim inside the TEE —
///        both checks happen privately before any verdict is written onchain.
///      - An observer can see "a claim was submitted by address X for policy Y"
///        but cannot determine WHICH medical claim or WHO the human is.
contract ClaimRequest {
    /// @notice Emitted when a claimant submits a medical claim for processing.
    ///         The CRE workflow's EVM Log Trigger listens for this event.
    /// @param policyId        keccak256 of the policy identifier
    /// @param claimant        The wallet submitting the claim (must match policy owner)
    /// @param encryptedPayload XOR-encrypted JSON bundle containing fhir_claim_id + World ID proof
    ///                         Only the TEE enclave can decrypt this — it never appears in plaintext onchain
    /// @param timestamp       Block timestamp for ordering and replay protection
    event ClaimSubmitted(
        bytes32 indexed policyId,
        address indexed claimant,
        bytes encryptedPayload,
        uint256 timestamp
    );

    /// @notice Submit a medical claim for enclave processing.
    ///         The FHIR claim ID and World ID proof are bundled, encrypted, and passed
    ///         as `encryptedPayload` — the TEE decrypts and verifies both inside the enclave.
    /// @param policyId         keccak256 of the policy string identifier (e.g. keccak256("DEMO-001"))
    /// @param encryptedPayload XOR-encrypted JSON: {fhirId, nullifier_hash, merkle_root, proof, verification_level}
    function submitClaim(
        bytes32 policyId,
        bytes calldata encryptedPayload
    ) external {
        require(policyId != bytes32(0), "ClaimRequest: invalid policy ID");
        require(encryptedPayload.length > 0, "ClaimRequest: invalid payload");

        emit ClaimSubmitted(
            policyId,
            msg.sender,
            encryptedPayload,
            block.timestamp
        );
    }
}
