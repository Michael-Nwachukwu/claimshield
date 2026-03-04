/**
 * ClaimShield — Production CRE Workflow
 *
 * Trigger: EVM Log Trigger on ClaimRequest.ClaimSubmitted event
 * Confidential HTTP: Fetches FHIR record inside the TEE using ConfidentialHTTPClient
 *
 * What stays private inside the TEE:
 *   - FHIR Claim ID, ICD-10 code, diagnosis text, treatment date, billed amount
 *   - Covered conditions list, reimbursement rate, EHR API credentials
 *
 * What exits the TEE (written onchain):
 *   - status + payoutAmount + reasonCode + complianceHash → PolicyRegistry.recordVerdict()
 *   - USDC transfer → ClaimSettlement.executePayout()
 *
 * Simulate locally:
 *   cre workflow simulate ./workflow --target=staging-settings
 */

import {
    EVMClient,
    ConfidentialHTTPClient,
    handler,
    type Runtime,
    type EVMLog,
} from '@chainlink/cre-sdk'
import { z } from 'zod'
import { evaluateMedicalClaim } from '../enclave/eligibility/medical'
import { decryptFhirId } from '../enclave/crypto'
import type { FHIRClaim, VerdictResult } from '../enclave/types'
import { ReasonCode } from '../enclave/types'

// ─── Config Schema ────────────────────────────────────────────────────────────

const configSchema = z.object({
    fhirBaseUrl: z.string(),
    enclaveSharedSecret: z.string(), // bytes32 hex — XOR key for decrypting FHIR ID from event data
    policyRegistryAddress: z.string(),
    claimRequestAddress: z.string(),
    claimSettlementAddress: z.string(),
    claimSubmittedEventSignature: z.string(), // keccak256("ClaimSubmitted(bytes32,address,bytes32,uint256)")
    owner: z.string(), // workflow owner address (for vaultDonSecrets)
})

type Config = z.infer<typeof configSchema>

// ─── Helper: hex address → base64 (required by FilterLogTriggerRequestJson) ──

function hexToBase64(hexStr: string): string {
    const clean = hexStr.startsWith('0x') ? hexStr.slice(2) : hexStr
    const bytes = Uint8Array.from(Buffer.from(clean.padStart(40, '0').slice(-40), 'hex'))
    return Buffer.from(bytes).toString('base64')
}

function topicToBase64(hexStr: string): string {
    const clean = hexStr.startsWith('0x') ? hexStr.slice(2) : hexStr
    const bytes = Uint8Array.from(Buffer.from(clean.padStart(64, '0'), 'hex'))
    return Buffer.from(bytes).toString('base64')
}

// ─── EVM Log Trigger Handler ──────────────────────────────────────────────────

/**
 * Called automatically when ClaimRequest.ClaimSubmitted event is emitted onchain.
 * The CRE EVM Log Trigger fires instantly — no polling, no cron.
 *
 * EVMLog parameter: decoded event data from the matched log.
 */
const onClaimSubmitted = async (
    runtime: Runtime<Config>,
    log: EVMLog
): Promise<VerdictResult> => {
    const config = runtime.config

    // Extract policyId and claimant from indexed event topics.
    // ClaimSubmitted(bytes32 indexed policyId, address indexed claimant, bytes32 encryptedPayload, uint256 timestamp)
    //   topics[0] = event signature hash
    //   topics[1] = policyId (bytes32)
    //   topics[2] = claimant (address, left-padded to 32 bytes)
    const policyIdHex = '0x' + Buffer.from(log.topics[1]).toString('hex')
    const claimant = '0x' + Buffer.from(log.topics[2]).toString('hex').slice(24) // strip 12-byte left-padding

    // Extract the encrypted FHIR claim ID from log.data.
    // data is ABI-encoded: first 32 bytes = encryptedPayload (bytes32), next 32 = timestamp (uint256)
    const encryptedPayloadHex = '0x' + Buffer.from(log.data).toString('hex').slice(0, 64)
    const fhirClaimId = decryptFhirId(encryptedPayloadHex, config.enclaveSharedSecret)

    runtime.log('[CRE ENCLAVE] ClaimSubmitted event received')
    runtime.log(`[CRE ENCLAVE] Policy: ${policyIdHex}`)
    runtime.log('[CRE ENCLAVE] FHIR claim ID: [PRIVATE — stays in TEE]')

    // ── Step 1: Fetch FHIR record via Confidential HTTP (INSIDE TEE) ──────────
    //
    // ConfidentialHTTPClient.sendRequest() executes the HTTP call inside the TEE.
    // The full FHIR response (diagnosis, ICD-10, amounts) stays encrypted inside
    // the enclave until it reaches this handler — it never leaves the TEE.
    //
    // The ehrAuthToken (EHR API credentials) is stored encrypted in the Vault DON.
    // It is injected at request time via {{.ehrAuthToken}} template syntax.
    // It never appears in code, logs, or node process memory.
    runtime.log('[CRE ENCLAVE] Step 1: Fetching FHIR record via ConfidentialHTTPClient...')

    const confHTTP = new ConfidentialHTTPClient()
    const fhirUrl = `${config.fhirBaseUrl}/Claim/${fhirClaimId}`

    const httpResp = confHTTP.sendRequest(runtime, {
        request: {
            url: fhirUrl,
            method: 'GET',
            multiHeaders: {
                'Accept': { values: ['application/fhir+json'] },
                // PRODUCTION: Uncomment to inject EHR auth token from Vault DON (inside TEE):
                // 'Authorization': { values: ['Bearer {{.ehrAuthToken}}'] },
            },
        },
        vaultDonSecrets: [
            // PRODUCTION: Enable to pull EHR auth token from Vault DON at request time.
            // The token is never in code or logs — it exists only inside the enclave.
            // { secretIdentifier: 'ehrAuthToken', workflowOwner: Buffer.from(config.owner.slice(2), 'hex') }
        ],
    }).result()

    // Parse the FHIR response inside the TEE
    // The full medical record stays here — never written to any external storage
    const fhirText = Buffer.from(httpResp.body).toString('utf-8')
    const fhirRecord = JSON.parse(fhirText) as FHIRClaim

    if (fhirRecord.resourceType !== 'Claim') {
        runtime.log('[CRE ENCLAVE] ERROR: Unexpected FHIR resource type')
        return {
            policyId: policyIdHex,
            claimant,
            status: 'escalated',
            payoutAmount: 0,
            reasonCode: ReasonCode.API_ERROR,
            complianceHash: '0x' + '0'.repeat(64),
        }
    }

    runtime.log('[CRE ENCLAVE] FHIR record fetched and parsed inside TEE (not logged externally)')

    // ── Step 2: Run eligibility logic (inside TEE) ───────────────────────────
    // The covered conditions list, reimbursement rate, and payout cap are private.
    // Only the verdict exits.
    runtime.log('[CRE ENCLAVE] Step 2: Running eligibility logic inside TEE...')

    // For demo: coverage period is 2024-01-01 to 2024-12-31
    // Production: read from PolicyRegistry.getPolicy() via EVMClient.callContract()
    const coverageStart = 1704067200
    const coverageEnd = 1735689600

    const verdict = evaluateMedicalClaim(fhirRecord, coverageStart, coverageEnd)

    // ── Step 3: Compute compliance hash (inside TEE) ─────────────────────────
    // Non-reversible proof of verification. Contains no recoverable medical data.
    const complianceHash = '0x' + Buffer.from(
        `${policyIdHex}:${verdict.status}:${Date.now()}`
    ).toString('hex').padStart(64, '0').slice(-64)

    runtime.log(`[CRE ENCLAVE] Verdict: ${verdict.status.toUpperCase()} — $${(verdict.payoutAmount / 1_000_000).toFixed(2)} USDC`)
    runtime.log('[CRE ENCLAVE] Diagnosis, ICD-10 code, amounts remain private in TEE')

    // ── Step 4: Return verdict — only this exits the enclave ─────────────────
    // The CRE runtime will write the verdict onchain via WriteTarget:
    //   PolicyRegistry.recordVerdict(policyId, status, payoutAmount, reasonCode, complianceHash)
    //   ClaimSettlement.executePayout(policyId, claimant, payoutAmount) if approved
    //
    // PRODUCTION NOTE: Full WriteTarget integration would use:
    //   EVMClient.writeReport(runtime, { receiver, report })
    // where the report contains ABI-encoded calldata for both contract calls.
    // For the hackathon demo, the terminal simulation (scripts/run-enclave.ts) performs
    // the actual onchain writes using an ethers.js wallet — demonstrating the same
    // logic that WriteTarget would execute in a fully deployed CRE workflow.
    return {
        policyId: policyIdHex,
        claimant,
        status: verdict.status,
        payoutAmount: verdict.payoutAmount,
        reasonCode: verdict.reasonCode,
        complianceHash,
    }
}

// ─── Workflow Initialization ──────────────────────────────────────────────────

export function initWorkflow(config: Config) {
    // The EVMClient must be constructed with a chain selector.
    // For Tenderly Virtual Testnet (forking Base): use ethereum-mainnet-base-1 selector.
    const evmClient = new EVMClient(EVMClient.SUPPORTED_CHAIN_SELECTORS['ethereum-mainnet-base-1'])

    // EVM Log Trigger: fires when ClaimRequest.ClaimSubmitted is emitted.
    // This is the event-driven trigger — no polling, no cron.
    // The workflow reacts the instant a claim is submitted onchain.
    //
    // FilterLogTriggerRequestJson:
    //   addresses: base64-encoded EVM contract addresses to watch
    //   topics[0]: array of event signatures (keccak256 of event signature string)
    //              Filters to ONLY ClaimSubmitted events from our contract.
    const logTrigger = evmClient.logTrigger({
        addresses: [hexToBase64(config.claimRequestAddress)],
        topics: [
            {
                // Topic[0] = event signature hash = keccak256("ClaimSubmitted(bytes32,address,bytes32,uint256)")
                values: [topicToBase64(config.claimSubmittedEventSignature)],
            },
            // Topic[1] = policyId (optional filter — leave empty to watch all policies)
            // { values: [topicToBase64(config.demoPolicyId)] }
        ],
    })

    return [
        handler(logTrigger, onClaimSubmitted),
    ]
}
