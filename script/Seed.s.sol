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
        address enclaveWallet = vm.envAddress("ENCLAVE_WALLET_ADDRESS");

        vm.startBroadcast(deployerKey);

        PolicyRegistry registry = PolicyRegistry(registryAddr);

        // Register DEMO-016 through DEMO-030
        // Extend the batch — pool is already funded from first seed run.
        registerAndActivate(
            registry,
            keccak256(abi.encodePacked("DEMO-016")),
            enclaveWallet
        );
        registerAndActivate(
            registry,
            keccak256(abi.encodePacked("DEMO-017")),
            enclaveWallet
        );
        registerAndActivate(
            registry,
            keccak256(abi.encodePacked("DEMO-018")),
            enclaveWallet
        );
        registerAndActivate(
            registry,
            keccak256(abi.encodePacked("DEMO-019")),
            enclaveWallet
        );
        registerAndActivate(
            registry,
            keccak256(abi.encodePacked("DEMO-020")),
            enclaveWallet
        );
        registerAndActivate(
            registry,
            keccak256(abi.encodePacked("DEMO-021")),
            enclaveWallet
        );
        registerAndActivate(
            registry,
            keccak256(abi.encodePacked("DEMO-022")),
            enclaveWallet
        );
        registerAndActivate(
            registry,
            keccak256(abi.encodePacked("DEMO-023")),
            enclaveWallet
        );
        registerAndActivate(
            registry,
            keccak256(abi.encodePacked("DEMO-024")),
            enclaveWallet
        );
        registerAndActivate(
            registry,
            keccak256(abi.encodePacked("DEMO-025")),
            enclaveWallet
        );
        registerAndActivate(
            registry,
            keccak256(abi.encodePacked("DEMO-026")),
            enclaveWallet
        );
        registerAndActivate(
            registry,
            keccak256(abi.encodePacked("DEMO-027")),
            enclaveWallet
        );
        registerAndActivate(
            registry,
            keccak256(abi.encodePacked("DEMO-028")),
            enclaveWallet
        );
        registerAndActivate(
            registry,
            keccak256(abi.encodePacked("DEMO-029")),
            enclaveWallet
        );
        registerAndActivate(
            registry,
            keccak256(abi.encodePacked("DEMO-030")),
            enclaveWallet
        );

        vm.stopBroadcast();

        console.log("=======================================================");
        console.log("  SEED COMPLETE");
        console.log("=======================================================");
        console.log("  Policies registered: DEMO-013 through DEMO-030");
        console.log("  Coverage           : 2024-01-01 to 2024-12-31");
        console.log("  Max payout         : $500.00 USDC per policy");
        console.log("  Approved enclave   :", enclaveWallet);
        console.log("=======================================================");
        console.log("  FHIR Claim ID      : 131299879");
        console.log("  Expected ICD-10    : J06.9 (covered)");
        console.log("  Expected payout    : $120.00 USDC (80% of $150)");
        console.log("=======================================================");
    }
}
