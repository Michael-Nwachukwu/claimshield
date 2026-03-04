// ClaimShield — Shared TypeScript types
// These types are used by both the CRE workflow (workflow/main.ts)
// and the local simulation scripts (scripts/run-enclave.ts).

// ─── Claim Payload ────────────────────────────────────────────────────────────

/**
 * The payload that the enclave receives for each claim.
 * `fhir_claim_id` is the ONLY sensitive input — it is passed to the enclave
 * via an encrypted channel and NEVER appears onchain.
 */
export type ClaimPayload = {
    policy_id: string     // Human-readable policy ID, e.g. "DEMO-001"
    wallet: string        // Claimant's Ethereum address
    fhir_claim_id: string // e.g. "131299879" — the sensitive field
}

// ─── Verdict ──────────────────────────────────────────────────────────────────

/**
 * The verdict produced inside the enclave after eligibility evaluation.
 * This is the ONLY data that leaves the TEE. It contains no medical information.
 */
export type Verdict = {
    status: 'approved' | 'denied' | 'escalated'
    payoutAmount: number  // USDC in 6-decimal units (e.g. 120_000000 = $120.00)
    reasonCode: ReasonCode
}

// ─── FHIR Types ───────────────────────────────────────────────────────────────

/**
 * Relevant fields from a FHIR R4 Claim resource.
 * The full response is fetched live by the enclave via Confidential HTTP
 * and processed entirely inside the TEE — never stored or logged externally.
 *
 * Demo FHIR claim: https://hapi.fhir.org/baseR4/Claim/131299879
 * Fields we use:
 *   - diagnosis[0].diagnosisCodeableConcept.coding[0].code  → "J06.9"
 *   - billablePeriod.start                                  → "2024-06-10"
 *   - total.value                                           → 150.00
 */
export type FHIRClaim = {
    resourceType: string
    id: string
    billablePeriod: {
        start: string
        end?: string
    }
    diagnosis: Array<{
        diagnosisCodeableConcept: {
            coding: Array<{
                system: string
                code: string
                display?: string
            }>
        }
    }>
    procedure?: Array<{
        procedureCodeableConcept: {
            coding: Array<{
                system: string
                code: string
            }>
        }
    }>
    total: {
        value: number
        currency: string
    }
    patient?: {
        reference: string
    }
}

// ─── Reason Codes ─────────────────────────────────────────────────────────────

/**
 * Numeric reason codes written onchain in the verdict.
 * These codes convey the outcome category WITHOUT revealing medical data.
 * A judge can see reasonCode=1 meaning "not covered" without knowing which code.
 */
export enum ReasonCode {
    APPROVED = 0,
    NOT_COVERED = 1,  // ICD-10 not in covered conditions list
    OUTSIDE_PERIOD = 2,  // Treatment date outside policy coverage period
    DUPLICATE = 3,  // Policy already has a processed claim
    POLICY_INACTIVE = 4,  // Policy not active or premiums not paid
    UNAUTHORIZED = 5,  // Submitting wallet doesn't match policy owner
    API_ERROR = 6,  // FHIR fetch failed or returned malformed data
    ESCALATED = 7,  // Edge case requiring human review
}

// ─── CRE Workflow Config ──────────────────────────────────────────────────────

/**
 * Config schema for the CRE workflow (defined in config.staging.json / config.production.json).
 * These values are loaded by the CRE Runner at startup.
 */
export type WorkflowConfig = {
    fhirBaseUrl: string         // "https://hapi.fhir.org/baseR4"
    enclaveSharedSecret: string // bytes32 hex — XOR key for decrypting FHIR ID from event data
    policyRegistryAddress: string
    claimRequestAddress: string
    claimSettlementAddress: string
    claimSubmittedEventSignature: string
    owner: string               // Workflow owner address (for vaultDonSecrets in production)
}

/**
 * The result returned by the CRE enclave handler.
 * This is what exits the TEE and gets processed for onchain writing.
 */
export type VerdictResult = {
    policyId: string            // bytes32 hex
    claimant: string            // Ethereum address
    status: 'approved' | 'denied' | 'escalated'
    payoutAmount: number        // USDC 6-decimal
    reasonCode: ReasonCode
    complianceHash: string      // bytes32 hex — non-reversible proof
}
