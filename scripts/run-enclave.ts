/**
 * run-enclave.ts — Local Simulation of the CRE Enclave
 *
 * Usage:
 *   bun scripts/run-enclave.ts --policy DEMO-001 --fhir 131299879
 *
 * This script simulates what happens inside the Chainlink CRE TEE.
 * In production, this logic runs automatically when the EVM Log Trigger
 * detects a ClaimSubmitted event — no manual script needed.
 *
 * ┌─────────────────────────────────────────────────────────────────────┐
 * │  LOCAL (this script):                                               │
 * │  - You can SEE all the private logs (diagnosis, ICD-10, amounts)   │
 * │  - This is intentional — you're the enclave operators              │
 * │  - Uses standard fetch() and ethers.js with a raw private key      │
 * │                                                                     │
 * │  PRODUCTION CRE (workflow/main.ts):                                 │
 * │  - EVM Log Trigger fires automatically on ClaimSubmitted event     │
 * │  - These logs STAY INSIDE the TEE — not visible to observers       │
 * │  - HTTP calls use ConfidentialHTTPClient inside the enclave        │
 * │  - Credentials injected via vaultDonSecrets (Vault DON)            │
 * │  - Onchain writes via CRE WriteTarget (DON-managed signer)         │
 * └─────────────────────────────────────────────────────────────────────┘
 */

import { processClaim } from '../enclave/processor'

function parseArgs(): { policy: string; fhir: string } {
    const args = process.argv.slice(2)
    const policyIdx = args.indexOf('--policy')
    const fhirIdx = args.indexOf('--fhir')

    if (policyIdx === -1 || fhirIdx === -1) {
        console.error('Usage: bun scripts/run-enclave.ts --policy DEMO-001 --fhir 131299879')
        process.exit(1)
    }

    return {
        policy: args[policyIdx + 1],
        fhir: args[fhirIdx + 1],
    }
}

async function main() {
    const args = parseArgs()

    console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━')
    console.log('  CLAIMSHIELD — Local Enclave Simulation')
    console.log('  (In production: this runs inside Chainlink CRE TEE)')
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━')
    console.log('  NOTE: Private data is visible here because you are running')
    console.log('  the enclave logic locally. In production CRE, these logs  ')
    console.log('  stay INSIDE the TEE — not accessible to anyone externally.')
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n')

    await processClaim({
        policy_id: args.policy,
        wallet: process.env.CLAIMANT_WALLET!,
        fhir_claim_id: args.fhir,
    })
}

main().catch(console.error)
