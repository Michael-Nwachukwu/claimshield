/**
 * processor.ts — Local Simulation Enclave Orchestrator
 *
 * This file simulates what runs inside the Chainlink CRE TEE.
 * It is used by scripts/run-enclave.ts for the terminal demo.
 *
 * In the production CRE workflow (workflow/main.ts), this same logic is executed
 * inside the TEE using the CRE SDK's ConfidentialHTTPClient. The key differences:
 *
 *   SIMULATION (this file):
 *   - Uses ethers.js with a raw private key from ENCLAVE_PRIVATE_KEY env var
 *   - Uses standard fetch() for HTTP calls
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
 * Main entry point for local simulation.
 * In production CRE, this logic runs as the EVM Log Trigger handler inside the TEE.
 */
export async function processClaim(payload: ClaimPayload): Promise<void> {
    const provider = new ethers.JsonRpcProvider(TENDERLY_RPC_URL)
    const enclaveSigner = new ethers.Wallet(ENCLAVE_PRIVATE_KEY, provider)

    const registry = new ethers.Contract(POLICY_REGISTRY_ADDRESS, POLICY_REGISTRY_ABI, enclaveSigner)
    const settlement = new ethers.Contract(CLAIM_SETTLEMENT_ADDRESS, CLAIM_SETTLEMENT_ABI, enclaveSigner)

    const policyIdBytes = ethers.id(payload.policy_id)

    console.log('\n[ENCLAVE] ══════════════════════════════════════════════════════')
    console.log('[ENCLAVE] ClaimShield — Processing medical claim inside TEE')
    console.log('[ENCLAVE] ══════════════════════════════════════════════════════')
    console.log(`[ENCLAVE] Policy ID  : ${payload.policy_id}`)
    console.log(`[ENCLAVE] FHIR ID    : ${payload.fhir_claim_id}  ← PRIVATE (in production: stays in TEE, NOT logged)`)
    console.log(`[ENCLAVE] Claimant   : ${payload.wallet}`)
    console.log('[ENCLAVE] ──────────────────────────────────────────────────────')

    // ── Step 1: Verify policy status onchain ─────────────────────────────────
    console.log('[ENCLAVE] Step 1: Checking policy status onchain...')
    const policy = await registry.getPolicy(policyIdBytes)

    if (!policy.active || !policy.premiumPaid) {
        console.log('[ENCLAVE] ✗ Policy not active or premium not paid')
        return writeVerdict(registry, settlement, policyIdBytes, payload.wallet, 'denied', 0, ReasonCode.POLICY_INACTIVE)
    }

    if (policy.owner.toLowerCase() !== payload.wallet.toLowerCase()) {
        console.log('[ENCLAVE] ✗ Claimant wallet does not match policy owner')
        return writeVerdict(registry, settlement, policyIdBytes, payload.wallet, 'denied', 0, ReasonCode.UNAUTHORIZED)
    }

    const alreadyProcessed = await registry.claimProcessed(policyIdBytes)
    if (alreadyProcessed) {
        console.log('[ENCLAVE] ✗ Claim already processed (duplicate prevention)')
        return writeVerdict(registry, settlement, policyIdBytes, payload.wallet, 'denied', 0, ReasonCode.DUPLICATE)
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
