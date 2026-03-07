/**
 * submit-claim.ts — Submit a medical claim onchain
 *
 * Usage:
 *   bun scripts/submit-claim.ts --policy DEMO-001 --fhir 131299879
 *
 * What this script does:
 *   1. Reads the World ID proof from world-id-proof.json
 *   2. Bundles FHIR claim ID + World ID proof into an encrypted JSON payload
 *   3. Calls ClaimRequest.submitClaim(policyId, encryptedPayload)
 *
 * World ID verification happens INSIDE the CRE enclave (TEE), not here.
 * The encrypted payload contains the proof — the enclave decrypts it and
 * calls the World ID Cloud API via ConfidentialHTTPClient before processing.
 *
 * ── World ID Prerequisites ───────────────────────────────────────────────────
 * Before running this script you must have a World ID proof ready:
 *   1. bun worldid-gen/signing-server.ts        (Terminal 1)
 *   2. cd worldid-gen && npm run dev             (Terminal 2)
 *   3. Open: http://localhost:4567/#YOUR_APP_ID|submit-claim
 *   4. Click "Verify with World ID Simulator", scan QR in simulator.worldcoin.org
 *   5. Copy the proof JSON → save to: claimshield/world-id-proof.json
 *
 * The CRE EVM Log Trigger fires when ClaimSubmitted is emitted.
 * The enclave decrypts the payload, verifies World ID + FHIR inside the TEE.
 */

import { ethers } from 'ethers'
import fs from 'fs'
import path from 'path'
import { encryptPayload } from '../enclave/crypto'

const CLAIM_REQUEST_ABI = [
    'function submitClaim(bytes32 policyId, bytes calldata encryptedPayload) external',
    'event ClaimSubmitted(bytes32 indexed policyId, address indexed claimant, bytes encryptedPayload, uint256 timestamp)',
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

    console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━')
    console.log('  CLAIMSHIELD — Claim Submission')
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━')
    console.log(`  Policy    : ${args.policy}`)
    console.log(`  FHIR ID   : ${args.fhir}`)
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━')

    // ── Step 1: Read World ID proof ───────────────────────────────────────────
    console.log('\n  [Step 1/3] Reading World ID proof from world-id-proof.json...')
    const proofPath = path.resolve(process.cwd(), 'world-id-proof.json')
    if (!fs.existsSync(proofPath)) {
        console.error(`\n  ❌ world-id-proof.json not found: ${proofPath}`)
        console.error('  Generate a proof first using the worldid-gen app.')
        process.exit(1)
    }
    const worldIdProof = JSON.parse(fs.readFileSync(proofPath, 'utf-8'))
    const nullifier = worldIdProof.nullifier_hash ?? (worldIdProof.responses ? worldIdProof.responses[0]?.nullifier : 'unknown')
    console.log(`  [World ID] Nullifier : ${nullifier}`)
    console.log(`  [World ID] Proof will be verified inside the TEE — not client-side.`)

    // ── Step 2: Encrypt the bundle ────────────────────────────────────────────
    // FHIR ID + World ID proof encrypted together — only enclave can decrypt.
    // Production CRE: asymmetric encryption to DON's public key via Vault DON.
    console.log('\n  [Step 2/3] Building and encrypting payload bundle...')
    const bundle = JSON.stringify({
        fhirId: args.fhir,
        idkitProof: worldIdProof,
    })
    const encryptedPayloadHex = encryptPayload(bundle, process.env.ENCLAVE_SHARED_SECRET!)
    const policyIdBytes = ethers.id(args.policy)

    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━')
    console.log(`  FHIR Claim ID   : ${args.fhir}  ← encrypted, NOT going onchain as plaintext`)
    console.log(`  World ID proof  : [bundled]     ← verified by enclave in TEE`)
    console.log(`  policyId (hex)  : ${policyIdBytes}`)
    console.log(`  Payload size    : ${(encryptedPayloadHex.length - 2) / 2} bytes`)
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━')

    // ── Step 3: Submit Claim Onchain ──────────────────────────────────────────
    console.log('\n  [Step 3/3] Broadcasting ClaimRequest.submitClaim()...')
    const provider = new ethers.JsonRpcProvider(process.env.TENDERLY_RPC_URL!)
    const signer = new ethers.Wallet(process.env.DEPLOYER_PRIVATE_KEY!, provider)
    const contract = new ethers.Contract(process.env.CLAIM_REQUEST_ADDRESS!, CLAIM_REQUEST_ABI, signer)

    console.log(`  Claimant wallet : ${signer.address}`)

    const tx = await contract.submitClaim(policyIdBytes, encryptedPayloadHex)
    const receipt = await tx.wait()

    console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━')
    console.log('  ✅ TRANSACTION CONFIRMED')
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━')
    console.log(`  TX Hash     : ${receipt.hash}`)
    console.log(`  Block       : ${receipt.blockNumber}`)
    console.log(`  Gas used    : ${receipt.gasUsed.toString()}`)
    console.log('\n  ClaimSubmitted event:')
    console.log(`    ✅ policyId         : ${policyIdBytes}`)
    console.log(`    ✅ claimant         : ${signer.address}`)
    console.log(`    ✅ encryptedPayload : [ciphertext — ${(encryptedPayloadHex.length - 2) / 2} bytes]`)
    console.log('  What is NOT in the transaction:')
    console.log('    🔒 FHIR Claim ID  → NEVER in calldata as plaintext')
    console.log('    🔒 World ID proof → NEVER readable without the enclave secret')
    console.log('    🔒 ICD-10 code    → NEVER visible onchain')
    console.log('\n  The enclave will:')
    console.log('    1. Decrypt the payload (TEE)')
    console.log('    2. Verify World ID via ConfidentialHTTPClient (TEE)')
    console.log('    3. Fetch FHIR record via ConfidentialHTTPClient (TEE)')
    console.log('    4. Write verdict onchain')
    console.log('  Run: bun scripts/run-enclave.ts --policy DEMO-001 --fhir 131299879')
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n')
}

main().catch(console.error)
