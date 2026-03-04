/**
 * medical.ts — Eligibility Engine
 *
 * This entire file runs inside the CRE TEE (Trusted Execution Environment).
 * Everything in this file is PRIVATE. Judges cannot see this logic by
 * inspecting the blockchain — it never leaves the enclave.
 *
 * What stays private:
 *   - The list of covered ICD-10 codes (the insurer's policy rules)
 *   - The reimbursement rate (80%)
 *   - The per-claim payout cap ($500)
 *   - The actual ICD-10 code and diagnosis from the FHIR record
 *   - The treatment date and billed amount
 *
 * What exits the enclave (written onchain):
 *   - status: "approved" | "denied" | "escalated"
 *   - payoutAmount: USDC in 6-decimal integer format
 *   - reasonCode: numeric enum (e.g. 1 = NOT_COVERED, not "J99.9 not covered")
 *   - complianceHash: keccak256 of verdict context (non-reversible)
 *
 * This design means an observer can verify that:
 *   ✅ A claim was processed by a verified enclave
 *   ✅ The verdict was approved/denied
 *   ✅ A specific payout amount was authorised
 *   🔒 But they CANNOT determine why — no diagnosis, no code, no amount revealed
 */

import type { FHIRClaim, Verdict } from '../types'
import { ReasonCode } from '../types'

// ─── Private Eligibility Rules (never published onchain) ──────────────────────

/** ICD-10 codes covered by this policy tier. This list is PRIVATE. */
const COVERED_ICD10_CODES: ReadonlySet<string> = new Set([
    'J06.9',   // Acute upper respiratory infection  ← demo claim has this code
    'J18.9',   // Pneumonia, unspecified
    'M54.5',   // Low back pain
    'K21.0',   // Gastro-esophageal reflux disease with oesophagitis
    'I10',     // Essential (primary) hypertension
    'E11.9',   // Type 2 diabetes mellitus without complications
    'F32.9',   // Major depressive disorder, single episode, unspecified
    'J45.909', // Unspecified asthma, uncomplicated
    'Z00.00',  // Encounter for general adult medical examination without abnormal findings
    'K59.00',  // Constipation, unspecified
])

/** Percentage of the billed amount to reimburse. PRIVATE. */
const REIMBURSEMENT_RATE = 0.80

/** Maximum USDC payout per claim in dollars. PRIVATE. */
const MAX_PAYOUT_USD = 500

// ─── Eligibility Evaluator ───────────────────────────────────────────────────

/**
 * Evaluate a medical claim against the eligibility rules.
 *
 * This function runs INSIDE the TEE. The FHIR data is live and real-time —
 * fetched via Confidential HTTP from the HAPI FHIR API moments before this
 * function is called. The data is never persisted; it exists only in memory
 * for the duration of this function call.
 *
 * @param fhir           The live FHIR Claim record fetched in the enclave
 * @param coverageStart  Policy coverage start as Unix timestamp (from PolicyRegistry)
 * @param coverageEnd    Policy coverage end as Unix timestamp (from PolicyRegistry)
 * @returns              Verdict with status, payoutAmount (USDC 6-decimal), and reasonCode
 */
export function evaluateMedicalClaim(
    fhir: FHIRClaim,
    coverageStart: number,
    coverageEnd: number
): Verdict {

    // ── Extract fields from live FHIR response ───────────────────────────────
    const icd10 = fhir.diagnosis?.[0]
        ?.diagnosisCodeableConcept?.coding?.[0]?.code

    const treatmentDateStr = fhir.billablePeriod?.start
    const billedAmount = fhir.total?.value ?? 0

    // ── Guard: malformed FHIR response ───────────────────────────────────────
    if (!icd10 || !treatmentDateStr || billedAmount <= 0) {
        console.log('[ENCLAVE] Escalated — malformed FHIR response or missing fields')
        return { status: 'escalated', payoutAmount: 0, reasonCode: ReasonCode.API_ERROR }
    }

    // ── Check 1: Is the ICD-10 code in the covered conditions list? ──────────
    // The covered list (COVERED_ICD10_CODES) is PRIVATE — only the boolean result exits.
    if (!COVERED_ICD10_CODES.has(icd10)) {
        // We log the code here because we're running inside the TEE — in production
        // these logs are NOT visible externally. In local simulation, they intentionally
        // are visible so you can trace the logic.
        console.log(`[ENCLAVE] Denied — ICD-10 ${icd10} not in covered conditions (private list)`)
        return { status: 'denied', payoutAmount: 0, reasonCode: ReasonCode.NOT_COVERED }
    }

    // ── Check 2: Does treatment fall within the policy coverage period? ───────
    const treatmentTs = Math.floor(new Date(treatmentDateStr).getTime() / 1000)
    if (treatmentTs < coverageStart || treatmentTs > coverageEnd) {
        console.log(
            `[ENCLAVE] Denied — treatment date ${treatmentDateStr} outside coverage period`
        )
        return { status: 'denied', payoutAmount: 0, reasonCode: ReasonCode.OUTSIDE_PERIOD }
    }

    // ── Calculate payout from live billed amount ──────────────────────────────
    // The reimbursement rate and cap are PRIVATE — only the final amount exits.
    const rawPayout = billedAmount * REIMBURSEMENT_RATE
    const cappedPayout = Math.min(rawPayout, MAX_PAYOUT_USD)
    // Convert to USDC 6-decimal integer
    const payoutUSDC = Math.floor(cappedPayout * 1_000_000)

    console.log(
        `[ENCLAVE] Approved — ICD-10: ${icd10} (covered), ` +
        `billed: $${billedAmount}, rate: ${REIMBURSEMENT_RATE * 100}%, ` +
        `payout: $${cappedPayout.toFixed(2)} USDC`
    )
    console.log('[ENCLAVE] The above details are PRIVATE — they remain inside the TEE')

    return {
        status: 'approved',
        payoutAmount: payoutUSDC,
        reasonCode: ReasonCode.APPROVED,
    }
}
