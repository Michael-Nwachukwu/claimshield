// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "forge-std/Script.sol";
import "../src/PolicyRegistry.sol";
import "../src/ClaimSettlement.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";

/// @notice Seeds demo data on Tenderly Virtual Testnet.
///         Registers policies DEMO-001 through DEMO-005 and funds the settlement pool.
///         Multiple policies let you run the demo repeatedly without redeploying —
///         each policy can only be claimed once (duplicate-prevention by design).
///
/// Prerequisites:
///   1. Run Deploy.s.sol first and populate POLICY_REGISTRY_ADDRESS + CLAIM_SETTLEMENT_ADDRESS in .env
///   2. Use Tenderly dashboard "Fund Account" to give the deployer wallet USDC
///      (at 0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913 — Base USDC)
///
/// Usage:
///   forge script script/Seed.s.sol --rpc-url $TENDERLY_RPC_URL --broadcast -vvv
contract Seed is Script {
    address constant USDC = 0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913;

    function registerAndActivate(
        PolicyRegistry registry,
        bytes32 policyId,
        address enclaveWallet
    ) internal {
        registry.registerPolicy(
            policyId,
            1704067200, // 2024-01-01 00:00:00 UTC
            1735689600, // 2024-12-31 00:00:00 UTC
            500_000000, // $500.00 max payout (USDC 6 decimals)
            enclaveWallet
        );
        registry.payPremium{value: 0.01 ether}(policyId);
    }

    function run() external {
        uint256 deployerKey = vm.envUint("DEPLOYER_PRIVATE_KEY");
        address registryAddr = vm.envAddress("POLICY_REGISTRY_ADDRESS");
        address settlementAddr = vm.envAddress("CLAIM_SETTLEMENT_ADDRESS");
        address enclaveWallet = vm.envAddress("ENCLAVE_WALLET_ADDRESS");

        vm.startBroadcast(deployerKey);

        PolicyRegistry registry = PolicyRegistry(registryAddr);
        ClaimSettlement settlement = ClaimSettlement(settlementAddr);
        IERC20 usdc = IERC20(USDC);

        // Register DEMO-001 through DEMO-005
        // All share the same coverage period (all of 2024) and enclave.
        // Each can only be claimed once — cycle through them for repeated demos.
        registerAndActivate(registry, keccak256(abi.encodePacked("DEMO-001")), enclaveWallet);
        registerAndActivate(registry, keccak256(abi.encodePacked("DEMO-002")), enclaveWallet);
        registerAndActivate(registry, keccak256(abi.encodePacked("DEMO-003")), enclaveWallet);
        registerAndActivate(registry, keccak256(abi.encodePacked("DEMO-004")), enclaveWallet);
        registerAndActivate(registry, keccak256(abi.encodePacked("DEMO-005")), enclaveWallet);

        // Fund settlement pool with $10,000 USDC
        uint256 poolAmount = 10_000_000000;
        usdc.approve(settlementAddr, poolAmount);
        settlement.depositLiquidity(poolAmount);

        vm.stopBroadcast();

        console.log("=======================================================");
        console.log("  SEED COMPLETE");
        console.log("=======================================================");
        console.log("  Policies registered: DEMO-001 through DEMO-005");
        console.log("  Coverage           : 2024-01-01 to 2024-12-31");
        console.log("  Max payout         : $500.00 USDC per policy");
        console.log("  Approved enclave   :", enclaveWallet);
        console.log("  Pool funded        : $10,000 USDC");
        console.log("=======================================================");
        console.log("  FHIR Claim ID      : 131299879");
        console.log("  Expected ICD-10    : J06.9 (covered)");
        console.log("  Expected payout    : $120.00 USDC (80% of $150)");
        console.log("-------------------------------------------------------");
        console.log("  TIP: Each policy can only be claimed once.");
        console.log("  Use DEMO-001, then DEMO-002, etc. for repeated demos.");
        console.log("=======================================================");
    }
}
