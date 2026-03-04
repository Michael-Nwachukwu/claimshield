// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "forge-std/Test.sol";
import "../src/PolicyRegistry.sol";

contract PolicyRegistryTest is Test {
    // Re-declare events in scope for vm.expectEmit (standard Foundry pattern)
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

    PolicyRegistry public registry;

    address deployer = makeAddr("deployer");
    address enclave = makeAddr("enclave");
    address stranger = makeAddr("stranger");

    bytes32 constant POLICY_ID = keccak256(abi.encodePacked("DEMO-001"));
    uint256 constant COVERAGE_START = 1704067200; // 2024-01-01
    uint256 constant COVERAGE_END = 1735689600; // 2024-12-31
    uint256 constant MAX_PAYOUT = 500_000000; // $500 USDC

    function setUp() public {
        vm.prank(deployer);
        registry = new PolicyRegistry();
    }

    // ─── registerPolicy ────────────────────────────────────────────────────────

    function test_registerPolicy_success() public {
        vm.prank(deployer);
        registry.registerPolicy(
            POLICY_ID,
            COVERAGE_START,
            COVERAGE_END,
            MAX_PAYOUT,
            enclave
        );

        PolicyRegistry.Policy memory p = registry.getPolicy(POLICY_ID);
        assertEq(p.owner, deployer);
        assertEq(p.approvedEnclave, enclave);
        assertEq(p.maxPayout, MAX_PAYOUT);
        assertFalse(p.active);
        assertFalse(p.premiumPaid);
    }

    function test_registerPolicy_emitsEvent() public {
        vm.expectEmit(true, true, true, false);
        emit PolicyRegistered(POLICY_ID, deployer, enclave);

        vm.prank(deployer);
        registry.registerPolicy(
            POLICY_ID,
            COVERAGE_START,
            COVERAGE_END,
            MAX_PAYOUT,
            enclave
        );
    }

    function test_registerPolicy_revert_alreadyExists() public {
        vm.startPrank(deployer);
        registry.registerPolicy(
            POLICY_ID,
            COVERAGE_START,
            COVERAGE_END,
            MAX_PAYOUT,
            enclave
        );

        vm.expectRevert("PolicyRegistry: policy already exists");
        registry.registerPolicy(
            POLICY_ID,
            COVERAGE_START,
            COVERAGE_END,
            MAX_PAYOUT,
            enclave
        );
        vm.stopPrank();
    }

    function test_registerPolicy_revert_invalidEnclave() public {
        vm.prank(deployer);
        vm.expectRevert("PolicyRegistry: invalid enclave address");
        registry.registerPolicy(
            POLICY_ID,
            COVERAGE_START,
            COVERAGE_END,
            MAX_PAYOUT,
            address(0)
        );
    }

    function test_registerPolicy_revert_invalidPeriod() public {
        vm.prank(deployer);
        vm.expectRevert("PolicyRegistry: invalid coverage period");
        registry.registerPolicy(
            POLICY_ID,
            COVERAGE_END,
            COVERAGE_START,
            MAX_PAYOUT,
            enclave
        );
    }

    // ─── payPremium ────────────────────────────────────────────────────────────

    function test_payPremium_activatesPolicy() public {
        vm.prank(deployer);
        registry.registerPolicy(
            POLICY_ID,
            COVERAGE_START,
            COVERAGE_END,
            MAX_PAYOUT,
            enclave
        );

        vm.deal(deployer, 1 ether);
        vm.prank(deployer);
        registry.payPremium{value: 0.01 ether}(POLICY_ID);

        PolicyRegistry.Policy memory p = registry.getPolicy(POLICY_ID);
        assertTrue(p.active);
        assertTrue(p.premiumPaid);
    }

    function test_payPremium_emitsEvent() public {
        vm.prank(deployer);
        registry.registerPolicy(
            POLICY_ID,
            COVERAGE_START,
            COVERAGE_END,
            MAX_PAYOUT,
            enclave
        );

        vm.deal(deployer, 1 ether);

        vm.expectEmit(true, true, false, false);
        emit PremiumPaid(POLICY_ID, deployer);

        vm.prank(deployer);
        registry.payPremium{value: 0.01 ether}(POLICY_ID);
    }

    function test_payPremium_revert_notOwner() public {
        vm.prank(deployer);
        registry.registerPolicy(
            POLICY_ID,
            COVERAGE_START,
            COVERAGE_END,
            MAX_PAYOUT,
            enclave
        );

        vm.deal(stranger, 1 ether);
        vm.prank(stranger);
        vm.expectRevert("PolicyRegistry: not policy owner");
        registry.payPremium{value: 0.01 ether}(POLICY_ID);
    }

    function test_payPremium_revert_alreadyPaid() public {
        vm.prank(deployer);
        registry.registerPolicy(
            POLICY_ID,
            COVERAGE_START,
            COVERAGE_END,
            MAX_PAYOUT,
            enclave
        );

        vm.deal(deployer, 1 ether);
        vm.startPrank(deployer);
        registry.payPremium{value: 0.01 ether}(POLICY_ID);

        vm.expectRevert("PolicyRegistry: premium already paid");
        registry.payPremium{value: 0.01 ether}(POLICY_ID);
        vm.stopPrank();
    }

    // ─── isEligible ────────────────────────────────────────────────────────────

    function test_isEligible_trueWhenActive() public {
        vm.prank(deployer);
        registry.registerPolicy(
            POLICY_ID,
            COVERAGE_START,
            COVERAGE_END,
            MAX_PAYOUT,
            enclave
        );
        vm.deal(deployer, 1 ether);
        vm.prank(deployer);
        registry.payPremium{value: 0.01 ether}(POLICY_ID);

        assertTrue(registry.isEligible(POLICY_ID, deployer));
    }

    function test_isEligible_falseForStranger() public {
        vm.prank(deployer);
        registry.registerPolicy(
            POLICY_ID,
            COVERAGE_START,
            COVERAGE_END,
            MAX_PAYOUT,
            enclave
        );
        vm.deal(deployer, 1 ether);
        vm.prank(deployer);
        registry.payPremium{value: 0.01 ether}(POLICY_ID);

        assertFalse(registry.isEligible(POLICY_ID, stranger));
    }

    // ─── recordVerdict ─────────────────────────────────────────────────────────

    function _activatePolicy() internal {
        vm.prank(deployer);
        registry.registerPolicy(
            POLICY_ID,
            COVERAGE_START,
            COVERAGE_END,
            MAX_PAYOUT,
            enclave
        );
        vm.deal(deployer, 1 ether);
        vm.prank(deployer);
        registry.payPremium{value: 0.01 ether}(POLICY_ID);
    }

    function test_recordVerdict_approved() public {
        _activatePolicy();
        bytes32 ch = keccak256(abi.encodePacked("proof"));

        vm.prank(enclave);
        registry.recordVerdict(POLICY_ID, "approved", 120_000000, 0, ch);

        PolicyRegistry.Verdict memory v = registry.getVerdict(POLICY_ID);
        assertEq(v.status, "approved");
        assertEq(v.payoutAmount, 120_000000);
        assertEq(v.reasonCode, 0);
        assertEq(v.complianceHash, ch);
        assertTrue(v.timestamp > 0);
        assertTrue(registry.claimProcessed(POLICY_ID));
    }

    function test_recordVerdict_denied() public {
        _activatePolicy();

        vm.prank(enclave);
        registry.recordVerdict(POLICY_ID, "denied", 0, 1, bytes32(0));

        PolicyRegistry.Verdict memory v = registry.getVerdict(POLICY_ID);
        assertEq(v.status, "denied");
        assertEq(v.payoutAmount, 0);
        assertEq(v.reasonCode, 1);
    }

    function test_recordVerdict_emitsEvent() public {
        _activatePolicy();
        bytes32 ch = keccak256(abi.encodePacked("hash"));

        vm.expectEmit(true, false, false, true);
        emit VerdictRecorded(POLICY_ID, "approved", 120_000000, ch);

        vm.prank(enclave);
        registry.recordVerdict(POLICY_ID, "approved", 120_000000, 0, ch);
    }

    function test_recordVerdict_revert_notEnclave() public {
        _activatePolicy();

        vm.prank(stranger);
        vm.expectRevert("PolicyRegistry: not approved enclave");
        registry.recordVerdict(
            POLICY_ID,
            "approved",
            120_000000,
            0,
            bytes32(0)
        );
    }

    function test_recordVerdict_revert_duplicate() public {
        _activatePolicy();

        vm.startPrank(enclave);
        registry.recordVerdict(
            POLICY_ID,
            "approved",
            120_000000,
            0,
            bytes32(0)
        );

        vm.expectRevert("PolicyRegistry: claim already processed");
        registry.recordVerdict(
            POLICY_ID,
            "approved",
            120_000000,
            0,
            bytes32(0)
        );
        vm.stopPrank();
    }

    function test_recordVerdict_revert_exceedsMaxPayout() public {
        _activatePolicy();

        vm.prank(enclave);
        vm.expectRevert("PolicyRegistry: exceeds max payout");
        registry.recordVerdict(
            POLICY_ID,
            "approved",
            600_000000,
            0,
            bytes32(0)
        ); // $600 > $500 cap
    }
}
