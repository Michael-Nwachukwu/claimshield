/**
 * submit-claim.ts — Submit a medical claim onchain
 *
 * Usage:
 *   bun scripts/submit-claim.ts --policy DEMO-001 --fhir 131299879
 *
 * What this script does:
 *   1. Encrypts the fhir_claim_id (so it never appears in plaintext onchain)
 *   2. Calls ClaimRequest.submitClaim(policyId, encryptedPayload)
 *   3. Prints exactly what IS and IS NOT in the transaction
 *
 * The CRE EVM Log Trigger fires when ClaimSubmitted is emitted.
 * The enclave decrypts the FHIR ID from the event data inside the TEE.
 *
 * Demo: XOR cipher with ENCLAVE_SHARED_SECRET (symmetric).
 * Production CRE: asymmetric encryption to the DON's public key.
 */

import { ethers } from 'ethers'
import { encryptFhirId } from '../enclave/crypto'

const CLAIM_REQUEST_ABI = [
    'function submitClaim(bytes32 policyId, bytes32 encryptedPayload) external',
    'event ClaimSubmitted(bytes32 indexed policyId, address indexed claimant, bytes32 encryptedPayload, uint256 timestamp)',
]

function parseArgs(): { policy: string; fhir: string } {
    const args = process.argv.slice(2)
    const policyIdx = args.indexOf('--policy')
    const fhirIdx = args.indexOf('--fhir')

    if (policyIdx === -1 || fhirIdx === -1) {
        console.error('Usage: bun scripts/submit-claim.ts --policy DEMO-001 --fhir 131299879')
        process.exit(1)
    }

    return {
        policy: args[policyIdx + 1],
        fhir: args[fhirIdx + 1],
    }
}

async function main() {
    const args = parseArgs()

    const provider = new ethers.JsonRpcProvider(process.env.TENDERLY_RPC_URL!)
    const signer = new ethers.Wallet(process.env.DEPLOYER_PRIVATE_KEY!, provider)
    const contract = new ethers.Contract(process.env.CLAIM_REQUEST_ADDRESS!, CLAIM_REQUEST_ABI, signer)

    // Encrypt the FHIR claim ID so it travels onchain as ciphertext.
    // Only the enclave (which knows the shared secret) can decrypt it.
    // Production CRE: asymmetric encryption to DON's public key via Vault DON.
    const encryptedPayload = encryptFhirId(args.fhir, process.env.ENCLAVE_SHARED_SECRET!)
    const policyIdBytes = ethers.id(args.policy)  // keccak256("DEMO-001")

    console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━')
    console.log('  CLAIMSHIELD — Submitting Claim Onchain')
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━')
    console.log(`  Policy          : ${args.policy}`)
    console.log(`  FHIR Claim ID   : ${args.fhir}  ← encrypted, NOT going onchain as plaintext`)
    console.log(`  Claimant wallet : ${signer.address}`)
    console.log(`  policyId (hex)  : ${policyIdBytes}`)
    console.log(`  Encrypted FHIR  : ${encryptedPayload}  (only enclave can decrypt)`)
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━')
    console.log('\nBroadcasting transaction...')

    const tx = await contract.submitClaim(policyIdBytes, encryptedPayload)
    const receipt = await tx.wait()

    console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━')
    console.log('  TRANSACTION CONFIRMED')
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━')
    console.log(`  TX Hash     : ${receipt.hash}`)
    console.log(`  Block       : ${receipt.blockNumber}`)
    console.log(`  Gas used    : ${receipt.gasUsed.toString()}`)
    console.log(`\n  Tenderly    : https://dashboard.tenderly.co/tx/${receipt.hash}`)
    console.log('\n  ── Inspect this transaction on Tenderly. You will find: ──')
    console.log('  ClaimSubmitted event:')
    console.log(`    ✅ policyId            : ${policyIdBytes}`)
    console.log(`    ✅ claimant            : ${signer.address}`)
    console.log(`    ✅ encryptedPayload: ${encryptedPayload}`)
    console.log(`    ✅ timestamp           : (block timestamp)`)
    console.log('  What is NOT in the transaction:')
    console.log('    🔒 FHIR Claim ID  → NEVER in calldata or logs')
    console.log('    🔒 ICD-10 code    → NEVER visible onchain')
    console.log('    🔒 Diagnosis text → NEVER visible onchain')
    console.log('    🔒 Treatment date → NEVER visible onchain')
    console.log('\n  The CRE EVM Log Trigger fires on ClaimSubmitted.')
    console.log('  Run: bun scripts/run-enclave.ts --policy DEMO-001 --fhir 131299879')
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n')
}

main().catch(console.error)
