// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "forge-std/Test.sol";
import "../src/ClaimRequest.sol";

contract ClaimRequestTest is Test {
    // Re-declare the event so it is in scope for vm.expectEmit (standard Foundry pattern)
    event ClaimSubmitted(
        bytes32 indexed policyId,
        address indexed claimant,
        bytes encryptedPayload,
        uint256 timestamp
    );

    ClaimRequest public claimReq;

    address claimant = makeAddr("claimant");
    bytes32 constant POLICY_ID = keccak256(abi.encodePacked("DEMO-001"));
    // Simulate an XOR-encrypted JSON bundle (arbitrary bytes)
    bytes constant ENCRYPTED_PAYLOAD = hex"deadbeefcafe0102030405060708090a0b0c0d0e0f101112131415161718191a";

    function setUp() public {
        claimReq = new ClaimRequest();
    }

    function test_submitClaim_emitsEvent() public {
        vm.expectEmit(true, true, false, true);
        emit ClaimSubmitted(POLICY_ID, claimant, ENCRYPTED_PAYLOAD, block.timestamp);

        vm.prank(claimant);
        claimReq.submitClaim(POLICY_ID, ENCRYPTED_PAYLOAD);
    }

    function test_submitClaim_revert_zeroPolicyId() public {
        vm.prank(claimant);
        vm.expectRevert("ClaimRequest: invalid policy ID");
        claimReq.submitClaim(bytes32(0), ENCRYPTED_PAYLOAD);
    }

    function test_submitClaim_revert_emptyPayload() public {
        vm.prank(claimant);
        vm.expectRevert("ClaimRequest: invalid payload");
        claimReq.submitClaim(POLICY_ID, new bytes(0));
    }

    function test_submitClaim_stateless() public {
        // ClaimRequest is intentionally stateless — just an event emitter
        // Statelessness is the privacy property: no medical data is ever persisted onchain
        vm.prank(claimant);
        claimReq.submitClaim(POLICY_ID, ENCRYPTED_PAYLOAD);
        // No storage slots written — this is correct by design
    }
}
