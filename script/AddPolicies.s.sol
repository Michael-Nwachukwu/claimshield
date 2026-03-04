// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "forge-std/Script.sol";
import "../src/PolicyRegistry.sol";

/// @notice Registers additional demo policies (DEMO-002 through DEMO-005)
///         on an already-deployed PolicyRegistry.
///
/// Run this when DEMO-001 has been claimed and you need fresh policies for
/// repeated demos. Each policy can only be claimed once by design.
///
/// Prerequisites:
///   POLICY_REGISTRY_ADDRESS, DEPLOYER_PRIVATE_KEY, ENCLAVE_WALLET_ADDRESS in .env
///
/// Usage:
///   forge script script/AddPolicies.s.sol --rpc-url $TENDERLY_RPC_URL --broadcast -vvv
contract AddPolicies is Script {

    function registerAndActivate(
        PolicyRegistry registry,
        string memory policyName,
        address enclaveWallet
    ) internal {
        bytes32 policyId = keccak256(abi.encodePacked(policyName));
        registry.registerPolicy(
            policyId,
            1704067200, // 2024-01-01 00:00:00 UTC
            1735689600, // 2024-12-31 00:00:00 UTC
            500_000000, // $500.00 max payout (USDC 6 decimals)
            enclaveWallet
        );
        registry.payPremium{value: 0.01 ether}(policyId);
        console.log("  Registered and activated:", policyName);
    }

    function run() external {
        uint256 deployerKey  = vm.envUint("DEPLOYER_PRIVATE_KEY");
        address registryAddr = vm.envAddress("POLICY_REGISTRY_ADDRESS");
        address enclaveWallet = vm.envAddress("ENCLAVE_WALLET_ADDRESS");

        vm.startBroadcast(deployerKey);

        PolicyRegistry registry = PolicyRegistry(registryAddr);

        registerAndActivate(registry, "DEMO-002", enclaveWallet);
        registerAndActivate(registry, "DEMO-003", enclaveWallet);
        registerAndActivate(registry, "DEMO-004", enclaveWallet);
        registerAndActivate(registry, "DEMO-005", enclaveWallet);

        vm.stopBroadcast();

        console.log("=======================================================");
        console.log("  POLICIES ADDED");
        console.log("=======================================================");
        console.log("  DEMO-002 through DEMO-005 are now active.");
        console.log("  Use each Policy ID once in bun scripts/demo.ts");
        console.log("=======================================================");
    }
}
