// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "forge-std/Test.sol";
import "../src/ClaimSettlement.sol";
import "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/// @notice Mock USDC for local testing only.
///         In the actual deployment, real USDC on Tenderly Virtual Testnet is used.
contract MockUSDC is ERC20 {
    constructor() ERC20("Mock USDC", "mUSDC") {}

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }

    function decimals() public pure override returns (uint8) {
        return 6;
    }
}

contract ClaimSettlementTest is Test {
    // Re-declare events in scope for vm.expectEmit (standard Foundry pattern)
    event LiquidityDeposited(address indexed depositor, uint256 amount);
    event PayoutExecuted(
        bytes32 indexed policyId,
        address indexed recipient,
        uint256 amount
    );
    event ClaimDenied(bytes32 indexed policyId, uint8 reasonCode);
    event EnclaveUpdated(
        address indexed oldEnclave,
        address indexed newEnclave
    );

    ClaimSettlement public settlement;
    MockUSDC public usdc;

    address owner = makeAddr("owner");
    address enclave = makeAddr("enclave");
    address claimant = makeAddr("claimant");
    address stranger = makeAddr("stranger");

    bytes32 constant POLICY_ID = keccak256(abi.encodePacked("DEMO-001"));

    function setUp() public {
        usdc = new MockUSDC();
        vm.prank(owner);
        settlement = new ClaimSettlement(address(usdc), enclave);
    }

    // ─── depositLiquidity ──────────────────────────────────────────────────────

    function test_depositLiquidity_success() public {
        uint256 amount = 10_000_000000;
        usdc.mint(owner, amount);
        vm.startPrank(owner);
        usdc.approve(address(settlement), amount);
        settlement.depositLiquidity(amount);
        vm.stopPrank();

        assertEq(settlement.poolBalance(), amount);
    }

    function test_depositLiquidity_emitsEvent() public {
        uint256 amount = 1_000_000000;
        usdc.mint(owner, amount);
        vm.startPrank(owner);
        usdc.approve(address(settlement), amount);

        vm.expectEmit(true, false, false, true);
        emit LiquidityDeposited(owner, amount);
        settlement.depositLiquidity(amount);
        vm.stopPrank();
    }

    function test_depositLiquidity_revert_zeroAmount() public {
        vm.prank(owner);
        vm.expectRevert("ClaimSettlement: amount must be non-zero");
        settlement.depositLiquidity(0);
    }

    // ─── executePayout ─────────────────────────────────────────────────────────

    function _fundPool(uint256 amount) internal {
        usdc.mint(owner, amount);
        vm.startPrank(owner);
        usdc.approve(address(settlement), amount);
        settlement.depositLiquidity(amount);
        vm.stopPrank();
    }

    function test_executePayout_success() public {
        uint256 pool = 10_000_000000;
        uint256 payout = 120_000000;
        _fundPool(pool);

        vm.prank(enclave);
        settlement.executePayout(POLICY_ID, claimant, payout);

        assertEq(usdc.balanceOf(claimant), payout);
        assertEq(settlement.poolBalance(), pool - payout);
    }

    function test_executePayout_emitsEvent() public {
        _fundPool(10_000_000000);

        vm.expectEmit(true, true, false, true);
        emit PayoutExecuted(POLICY_ID, claimant, 120_000000);

        vm.prank(enclave);
        settlement.executePayout(POLICY_ID, claimant, 120_000000);
    }

    function test_executePayout_revert_notEnclave() public {
        _fundPool(10_000_000000);
        vm.prank(stranger);
        vm.expectRevert("ClaimSettlement: not approved enclave");
        settlement.executePayout(POLICY_ID, claimant, 120_000000);
    }

    function test_executePayout_revert_insufficientLiquidity() public {
        _fundPool(50_000000); // Only $50 in pool
        vm.prank(enclave);
        vm.expectRevert("ClaimSettlement: insufficient liquidity");
        settlement.executePayout(POLICY_ID, claimant, 120_000000); // Try to pay $120
    }

    function test_executePayout_revert_invalidRecipient() public {
        _fundPool(10_000_000000);
        vm.prank(enclave);
        vm.expectRevert("ClaimSettlement: invalid recipient");
        settlement.executePayout(POLICY_ID, address(0), 120_000000);
    }

    function test_executePayout_revert_zeroAmount() public {
        _fundPool(10_000_000000);
        vm.prank(enclave);
        vm.expectRevert("ClaimSettlement: payout amount must be non-zero");
        settlement.executePayout(POLICY_ID, claimant, 0);
    }

    // ─── setApprovedEnclave ────────────────────────────────────────────────────

    function test_setApprovedEnclave_success() public {
        address newEnclave = makeAddr("newEnclave");
        vm.prank(owner);
        settlement.setApprovedEnclave(newEnclave);
        assertEq(settlement.approvedEnclave(), newEnclave);
    }

    function test_setApprovedEnclave_revert_notOwner() public {
        vm.prank(stranger);
        vm.expectRevert("ClaimSettlement: not owner");
        settlement.setApprovedEnclave(makeAddr("newEnclave"));
    }

    // ─── recordDenial ──────────────────────────────────────────────────────────

    function test_recordDenial_success() public {
        vm.expectEmit(true, false, false, true);
        emit ClaimDenied(POLICY_ID, 1);

        vm.prank(enclave);
        settlement.recordDenial(POLICY_ID, 1);
    }

    function test_recordDenial_revert_notEnclave() public {
        vm.prank(stranger);
        vm.expectRevert("ClaimSettlement: not approved enclave");
        settlement.recordDenial(POLICY_ID, 1);
    }
}
