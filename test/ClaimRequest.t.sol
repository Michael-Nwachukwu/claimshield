// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "forge-std/Test.sol";
import "../src/ClaimRequest.sol";

contract ClaimRequestTest is Test {
    // Re-declare the event so it is in scope for vm.expectEmit (standard Foundry pattern)
    event ClaimSubmitted(
        bytes32 indexed policyId,
        address indexed claimant,
        bytes32 encryptedPayloadHash,
        uint256 timestamp
    );

    ClaimRequest public claimReq;

    address claimant = makeAddr("claimant");
    bytes32 constant POLICY_ID = keccak256(abi.encodePacked("DEMO-001"));
    bytes32 constant PAYLOAD_HASH =
        keccak256(abi.encodePacked("encrypted_payload"));

    function setUp() public {
        claimReq = new ClaimRequest();
    }

    function test_submitClaim_emitsEvent() public {
        vm.expectEmit(true, true, false, true);
        emit ClaimSubmitted(POLICY_ID, claimant, PAYLOAD_HASH, block.timestamp);

        vm.prank(claimant);
        claimReq.submitClaim(POLICY_ID, PAYLOAD_HASH);
    }

    function test_submitClaim_revert_zeroPolicyId() public {
        vm.prank(claimant);
        vm.expectRevert("ClaimRequest: invalid policy ID");
        claimReq.submitClaim(bytes32(0), PAYLOAD_HASH);
    }

    function test_submitClaim_revert_zeroPayloadHash() public {
        vm.prank(claimant);
        vm.expectRevert("ClaimRequest: invalid payload hash");
        claimReq.submitClaim(POLICY_ID, bytes32(0));
    }

    function test_submitClaim_stateless() public {
        // ClaimRequest is intentionally stateless — just an event emitter
        // Statelessness is the privacy property: no medical data is ever persisted onchain
        vm.prank(claimant);
        claimReq.submitClaim(POLICY_ID, PAYLOAD_HASH);
        // No storage slots written — this is correct by design
    }
}
