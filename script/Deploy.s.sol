// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "forge-std/Script.sol";
import "../src/PolicyRegistry.sol";
import "../src/ClaimRequest.sol";
import "../src/ClaimSettlement.sol";

/// @notice Deploys all three ClaimShield contracts to Tenderly Virtual Testnet.
///
/// Usage:
///   forge script script/Deploy.s.sol --rpc-url $TENDERLY_RPC_URL --broadcast -vvv
///
/// After running, copy the printed addresses into .env:
///   POLICY_REGISTRY_ADDRESS=0x...
///   CLAIM_REQUEST_ADDRESS=0x...
///   CLAIM_SETTLEMENT_ADDRESS=0x...
contract Deploy is Script {
    // USDC on Base — Tenderly Virtual Testnet forks Base, so Base token addresses apply.
    // Use Tenderly dashboard "Fund Account" to give the deployer wallet USDC before running Seed.s.sol.
    address constant USDC = 0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913;

    function run() external {
        uint256 deployerKey = vm.envUint("DEPLOYER_PRIVATE_KEY");
        address enclaveWallet = vm.envAddress("ENCLAVE_WALLET_ADDRESS");

        vm.startBroadcast(deployerKey);

        PolicyRegistry registry = new PolicyRegistry();
        ClaimRequest claimReq = new ClaimRequest();
        ClaimSettlement settlement = new ClaimSettlement(USDC, enclaveWallet);

        vm.stopBroadcast();

        console.log("=======================================================");
        console.log("  CLAIMSHIELD DEPLOYMENT COMPLETE");
        console.log("=======================================================");
        console.log("  PolicyRegistry  :", address(registry));
        console.log("  ClaimRequest    :", address(claimReq));
        console.log("  ClaimSettlement :", address(settlement));
        console.log("  USDC (real)     :", USDC);
        console.log("  Enclave wallet  :", enclaveWallet);
        console.log("=======================================================");
        console.log("  NEXT: copy addresses to .env, then run Seed.s.sol");
        console.log("=======================================================");
    }
}
