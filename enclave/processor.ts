/**
 * processor.ts — Local Simulation Enclave Orchestrator
 *
 * This file simulates what runs inside the Chainlink CRE TEE.
 * It is used by scripts/demo.ts for the terminal demo.
 *
 * In the production CRE workflow (workflow/main.ts), this same logic is executed
 * inside the TEE using the CRE SDK's ConfidentialHTTPClient. The key differences:
 *
 *   SIMULATION (this file):
 *   - Uses ethers.js with a raw private key from ENCLAVE_PRIVATE_KEY env var
 *   - Uses standard fetch() for HTTP calls (ConfidentialHTTPClient in production)
 *   - Logs are visible in the terminal (intentional — shows judges the private data)
 *   - Point out: "In production CRE, these logs stay inside the TEE"
 *
 *   PRODUCTION CRE (workflow/main.ts):
 *   - The EVM Log Trigger fires automatically when ClaimSubmitted is emitted
 *   - HTTP calls use ConfidentialHTTPClient — request executes inside TEE
 *   - API credentials injected via vaultDonSecrets (Vault DON), never in code
 *   - Onchain writes use the DON-managed signer (not a raw private key)
 *   - Logs stay inside the TEE — nobody outside can see diagnosis or FHIR data
 */

import { ethers } from 'ethers'
import { fetchFHIRClaim } from './fetchers/fhir'
import { evaluateMedicalClaim } from './eligibility/medical'
import type { ClaimPayload } from './types'
import { ReasonCode } from './types'

// ABIs — stripped to only the functions we call (copy from out/ after forge build)
const POLICY_REGISTRY_ABI = [
    'function getPolicy(bytes32 policyId) external view returns (address owner, bool premiumPaid, uint256 coverageStart, uint256 coverageEnd, uint256 maxPayout, address approvedEnclave, bool active)',
    'function claimProcessed(bytes32 policyId) external view returns (bool)',
    'function recordVerdict(bytes32 policyId, string calldata status, uint256 payoutAmount, uint8 reasonCode, bytes32 complianceHash) external',
    'function isEligible(bytes32 policyId, address wallet) external view returns (bool)',
] as const

const CLAIM_SETTLEMENT_ABI = [
    'function executePayout(bytes32 policyId, address recipient, uint256 amount) external',
    'function recordDenial(bytes32 policyId, uint8 reasonCode) external',
    'function poolBalance() external view returns (uint256)',
] as const

const POLICY_REGISTRY_ADDRESS = process.env.POLICY_REGISTRY_ADDRESS!
const CLAIM_SETTLEMENT_ADDRESS = process.env.CLAIM_SETTLEMENT_ADDRESS!
const ENCLAVE_PRIVATE_KEY = process.env.ENCLAVE_PRIVATE_KEY!
const TENDERLY_RPC_URL = process.env.TENDERLY_RPC_URL!

/**
 * World ID proof fields — bundled inside the encrypted payload onchain.
 * The enclave decrypts these and verifies them via World ID Cloud API.
 */
export type WorldIdProof = Record<string, any>

/**
 * Main entry point for local simulation.
 * In production CRE, this logic runs as the EVM Log Trigger handler inside the TEE.
 *
 * @param payload   Policy + FHIR claim ID (decrypted from the onchain payload)
 * @param worldId   World ID proof fields (decrypted from the same onchain payload)
 *                  If provided, the simulation calls the real World ID Cloud API.
 */
export async function processClaim(payload: ClaimPayload, worldId?: WorldIdProof): Promise<void> {
    const provider = new ethers.JsonRpcProvider(TENDERLY_RPC_URL)
    const enclaveSigner = new ethers.Wallet(ENCLAVE_PRIVATE_KEY, provider)

    const registry = new ethers.Contract(POLICY_REGISTRY_ADDRESS, POLICY_REGISTRY_ABI, enclaveSigner)
    const settlement = new ethers.Contract(CLAIM_SETTLEMENT_ADDRESS, CLAIM_SETTLEMENT_ABI, enclaveSigner)

    const policyIdBytes = ethers.id(payload.policy_id)

    const appId = process.env.WORLD_ID_APP_ID!
    const action = process.env.WORLD_ID_ACTION ?? 'submit-claim'

    console.log('\n[ENCLAVE] ══════════════════════════════════════════════════════')
    console.log('[ENCLAVE] ClaimShield — Processing medical claim inside TEE')
    console.log('[ENCLAVE] ══════════════════════════════════════════════════════')
    console.log(`[ENCLAVE] Policy ID  : ${payload.policy_id}`)
    console.log(`[ENCLAVE] FHIR ID    : ${payload.fhir_claim_id}  ← PRIVATE (in production: stays in TEE, NOT logged)`)
    console.log(`[ENCLAVE] Claimant   : ${payload.wallet}`)
    console.log('[ENCLAVE] ──────────────────────────────────────────────────────')

    // ── Step 0: Verify World ID proof via Cloud API ───────────────────────────
    // In production CRE: this call executes via ConfidentialHTTPClient inside TEE.
    // The proof fields are decrypted from the onchain payload — never logged externally.
    // Here in simulation: we call the real World ID Cloud API via fetch() to show
    // the exact request/response the enclave will execute inside the TEE.
    if (worldId) {
        console.log('\n[ENCLAVE] Step 0: Verifying World ID proof via Cloud API...')
        console.log('[ENCLAVE] Simulation: fetch() | Production: ConfidentialHTTPClient (inside TEE)')
        console.log('[ENCLAVE] ──────────────────────────────────────────────────────')
        console.log(`[ENCLAVE]   → POST https://developer.worldcoin.org/api/v4/verify/${appId}`)
        console.log(`[ENCLAVE]   → Request body:`)
        console.log(`[ENCLAVE]       (Raw IDKit payload passed to V4 API)`)
        console.log('[ENCLAVE]   Sending request to World ID Cloud API...')

        let worldIdVerified = false
        try {
            const resp = await fetch(`https://developer.worldcoin.org/api/v4/verify/${appId}`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                // IDKit v3 payload already has action/environment/responses embedded — forward as-is
                body: JSON.stringify(worldId),
            })

            const result = await resp.json() as Record<string, unknown>

            console.log(`[ENCLAVE]   ← HTTP status  : ${resp.status} ${resp.ok ? '✓ OK' : '✗ ERROR'}`)
            console.log(`[ENCLAVE]   ← Response body: ${JSON.stringify(result)}`)

            if (result.success === true) {
                worldIdVerified = true
                console.log(`[ENCLAVE]   ← success      : true`)
                if (result.uses !== undefined) {
                    console.log(`[ENCLAVE]   ← uses         : ${result.uses}  (times this nullifier verified for "${action}")`)
                }
                if (result.action !== undefined) {
                    console.log(`[ENCLAVE]   ← action       : ${result.action}`)
                }
            } else {
                const code = result.code ?? result.detail ?? 'unknown error'
                console.log(`[ENCLAVE]   ← success      : false — ${code}`)
            }
        } catch (err) {
            console.log(`[ENCLAVE]   ← Network error: ${err}`)
        }

        if (!worldIdVerified) {
            console.log('[ENCLAVE] ✗ World ID verification FAILED — identity proof invalid or already used')
            console.log('[ENCLAVE]   Claim denied. ReasonCode: UNAUTHORIZED (5)')
            return writeVerdict(registry, settlement, policyIdBytes, payload.wallet, 'denied', 0, ReasonCode.UNAUTHORIZED)
        }

        console.log('[ENCLAVE] ✓ World ID proof VERIFIED — real human identity confirmed')
        console.log('[ENCLAVE]   Sybil resistance: this nullifier cannot be reused for the same action')
        console.log('[ENCLAVE] ──────────────────────────────────────────────────────')
    }

    // ── Step 1: Verify policy status onchain ─────────────────────────────────
    console.log('[ENCLAVE] Step 1: Checking policy status onchain...')
    const policy = await registry.getPolicy(policyIdBytes)

    // Policy doesn't exist — owner will be address(0). Can't write any verdict.
    if (policy.owner === ethers.ZeroAddress) {
        console.log('[ENCLAVE] ✗ Policy does not exist — not registered onchain')
        return
    }

    if (!policy.active || !policy.premiumPaid) {
        // Contract requires active=true to record a verdict, so we can't write here.
        console.log('[ENCLAVE] ✗ Policy not active or premium not paid')
        return
    }

    if (policy.owner.toLowerCase() !== payload.wallet.toLowerCase()) {
        console.log('[ENCLAVE] ✗ Claimant wallet does not match policy owner')
        return writeVerdict(registry, settlement, policyIdBytes, payload.wallet, 'denied', 0, ReasonCode.UNAUTHORIZED)
    }

    const alreadyProcessed = await registry.claimProcessed(policyIdBytes)
    if (alreadyProcessed) {
        // Verdict already recorded onchain — contract will reject any attempt to write again.
        // Just return; the existing verdict is readable via getVerdict().
        console.log('[ENCLAVE] ✗ Claim already processed — verdict already onchain, skipping.')
        return
    }

    console.log('[ENCLAVE] ✓ Policy active, premium paid, no duplicate')

    // ── Step 2: Fetch live FHIR record via Confidential HTTP ──────────────────
    // In production CRE: ConfidentialHTTPClient.sendRequest() runs this inside TEE
    // In simulation:     standard fetch() runs here in Node.js
    console.log(`\n[ENCLAVE] Step 2: Fetching live FHIR record for claim ${payload.fhir_claim_id}...`)
    console.log('[ENCLAVE] In production CRE: this uses ConfidentialHTTPClient inside the TEE')
    console.log('[ENCLAVE] The full medical record NEVER leaves the enclave')

    let fhirRecord
    try {
        fhirRecord = await fetchFHIRClaim(payload.fhir_claim_id)
        const icd10 = fhirRecord.diagnosis?.[0]?.diagnosisCodeableConcept?.coding?.[0]?.code
        const dateStr = fhirRecord.billablePeriod?.start
        const billed = fhirRecord.total?.value
        console.log(`[ENCLAVE] ✓ FHIR record received — processing inside TEE, NOT written anywhere`)
        console.log(`[ENCLAVE] ┌─ ICD-10 code     : ${icd10}    ← [PRIVATE — stays in enclave]`)
        console.log(`[ENCLAVE] │  Treatment date  : ${dateStr}   ← [PRIVATE — stays in enclave]`)
        console.log(`[ENCLAVE] └─ Billed amount   : $${billed}       ← [PRIVATE — stays in enclave]`)
    } catch (err) {
        console.log(`[ENCLAVE] ✗ FHIR fetch failed: ${err}`)
        return writeVerdict(registry, settlement, policyIdBytes, payload.wallet, 'escalated', 0, ReasonCode.API_ERROR)
    }

    // ── Step 3: Run eligibility logic on live FHIR data ───────────────────────
    // This logic and the covered conditions list NEVER appear onchain
    console.log('\n[ENCLAVE] Step 3: Running eligibility logic on live FHIR data...')
    const verdict = evaluateMedicalClaim(
        fhirRecord,
        Number(policy.coverageStart),
        Number(policy.coverageEnd)
    )

    // ── Step 4: Write verdict onchain — this is ALL that exits the enclave ────
    await writeVerdict(
        registry, settlement, policyIdBytes, payload.wallet,
        verdict.status, verdict.payoutAmount, verdict.reasonCode
    )
}

async function writeVerdict(
    registry: ethers.Contract,
    settlement: ethers.Contract,
    policyIdBytes: string,
    claimant: string,
    status: string,
    amount: number,
    reasonCode: ReasonCode
): Promise<void> {
    // Compliance hash: keccak256(policyId + status + timestamp)
    // Non-reversible — proves verification occurred without revealing what was verified
    const complianceHash = ethers.keccak256(
        ethers.toUtf8Bytes(`${policyIdBytes}:${status}:${Date.now()}`)
    )

    console.log('\n[ENCLAVE] ══════════════════════════════════════════════════════')
    console.log('[ENCLAVE] Step 4: Writing verdict onchain')
    console.log('[ENCLAVE] THIS IS THE ONLY DATA THAT EXITS THE ENCLAVE:')
    console.log(`[ENCLAVE]   status          : ${status}`)
    console.log(`[ENCLAVE]   payout          : $${(amount / 1_000_000).toFixed(2)} USDC`)
    console.log(`[ENCLAVE]   reason code     : ${reasonCode} (no diagnosis text)`)
    console.log(`[ENCLAVE]   compliance hash : ${complianceHash}`)
    console.log('[ENCLAVE]   diagnosis       : [STAYS PRIVATE — not in this tx]')
    console.log('[ENCLAVE]   ICD-10 code     : [STAYS PRIVATE — not in this tx]')
    console.log('[ENCLAVE]   billed amount   : [STAYS PRIVATE — not in this tx]')
    console.log('[ENCLAVE] ──────────────────────────────────────────────────────')

    // Record the verdict in PolicyRegistry (gated by onlyApprovedEnclave)
    const tx = await registry.recordVerdict(
        policyIdBytes, status, amount, reasonCode, complianceHash
    )
    const receipt = await tx.wait()
    console.log(`[ENCLAVE] ✓ Verdict recorded. TX: ${receipt.hash}`)
    console.log(`[ENCLAVE]   Tenderly: https://dashboard.tenderly.co/tx/${receipt.hash}`)

    // Trigger payout if approved (enclave calls ClaimSettlement directly)
    if (status === 'approved' && amount > 0) {
        console.log(`\n[ENCLAVE] Step 5: Executing USDC payout of $${(amount / 1_000_000).toFixed(2)}...`)
        const poolBal = await settlement.poolBalance()
        console.log(`[ENCLAVE]   Settlement pool balance: $${(Number(poolBal) / 1_000_000).toFixed(2)} USDC`)

        const payoutTx = await settlement.executePayout(policyIdBytes, claimant, amount)
        const payoutReceipt = await payoutTx.wait()
        console.log(`[ENCLAVE] ✓ Payout executed. TX: ${payoutReceipt.hash}`)
        console.log(`[ENCLAVE]   Recipient: ${claimant}`)
        console.log(`[ENCLAVE]   Amount   : $${(amount / 1_000_000).toFixed(2)} USDC`)
        console.log(`[ENCLAVE]   Tenderly : https://dashboard.tenderly.co/tx/${payoutReceipt.hash}`)
    } else if (status !== 'approved') {
        // Log the denial onchain for record-keeping
        await settlement.recordDenial(policyIdBytes, reasonCode)
    }

    console.log('\n[ENCLAVE] ══════════════════════════════════════════════════════')
    console.log('[ENCLAVE] Enclave processing complete')
    console.log('[ENCLAVE] ══════════════════════════════════════════════════════\n')
}
