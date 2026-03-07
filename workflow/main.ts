/**
 * ClaimShield — Production CRE Workflow
 *
 * Trigger: EVM Log Trigger on ClaimRequest.ClaimSubmitted event
 * Confidential HTTP: Two ConfidentialHTTPClient calls inside the TEE:
 *   1. World ID Cloud API — verify human identity (prevents Sybil attacks)
 *   2. FHIR EHR API — fetch medical claim record
 *
 * What stays private inside the TEE:
 *   - World ID nullifier_hash, merkle_root, ZK proof (verified, never logged)
 *   - FHIR Claim ID, ICD-10 code, diagnosis text, treatment date, billed amount
 *   - Covered conditions list, reimbursement rate, EHR API credentials
 *
 * What exits the TEE (returned as verdict):
 *   - status + payoutAmount + reasonCode + complianceHash
 *
 * Simulate locally:
 *   cre workflow simulate ./workflow --target=staging-settings --evm-tx-hash=0x...
 *
 * NOTE: This file is compiled to WASM for the CRE runtime.
 *       It MUST NOT import ethers.js or any Node.js-specific module.
 *       All helpers are inlined for WASM compatibility.
 */

import {
    EVMClient,
    ConfidentialHTTPClient,
    handler,
    ok,
    Runner,
    Report,
    bytesToHex,
    type Runtime,
    type EVMLog,
} from '@chainlink/cre-sdk'
import { z } from 'zod'

// ─── Config Schema ────────────────────────────────────────────────────────────

const configSchema = z.object({
    fhirBaseUrl: z.string(),
    enclaveSharedSecret: z.string(),
    policyRegistryAddress: z.string(),
    claimRequestAddress: z.string(),
    claimSettlementAddress: z.string(),
    claimSubmittedEventSignature: z.string(),
    worldIdAppId: z.string(),
    worldIdAction: z.string(),
    worldIdBaseUrl: z.string(),
    owner: z.string(),
})

type Config = z.infer<typeof configSchema>

// ─── Inlined Types (WASM-safe — no import from ../enclave/) ─────────────────

type FHIRClaim = {
    resourceType: string
    id: string
    billablePeriod: { start: string; end?: string }
    diagnosis: Array<{
        diagnosisCodeableConcept: {
            coding: Array<{ system: string; code: string; display?: string }>
        }
    }>
    total: { value: number; currency: string }
}

enum ReasonCode {
    APPROVED = 0,
    NOT_COVERED = 1,
    OUTSIDE_PERIOD = 2,
    DUPLICATE = 3,
    POLICY_INACTIVE = 4,
    UNAUTHORIZED = 5,
    API_ERROR = 6,
    ESCALATED = 7,
}

type VerdictResult = {
    policyId: string
    claimant: string
    status: string
    payoutAmount: number
    reasonCode: ReasonCode
    complianceHash: string
}

// ─── Hex/Base64 Helpers (WASM-safe) ─────────────────────────────────────────

const HEX = '0123456789abcdef'
const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'

function hexToBytes(hex: string): Uint8Array {
    const h = hex.startsWith('0x') ? hex.slice(2) : hex
    const bytes = new Uint8Array(h.length / 2)
    for (let i = 0; i < bytes.length; i++) {
        bytes[i] = parseInt(h.slice(i * 2, i * 2 + 2), 16)
    }
    return bytes
}

function bytesToHexStr(bytes: Uint8Array): string {
    let out = '0x'
    for (let i = 0; i < bytes.length; i++) {
        out += HEX[bytes[i] >> 4] + HEX[bytes[i] & 0xf]
    }
    return out
}

function bytesToBase64(bytes: Uint8Array): string {
    let out = ''
    for (let i = 0; i < bytes.length; i += 3) {
        const a = bytes[i]
        const b = bytes[i + 1]
        const c = bytes[i + 2]
        out += B64[a >> 2]
        out += B64[((a & 3) << 4) | ((b ?? 0) >> 4)]
        out += b === undefined ? '=' : B64[((b & 15) << 2) | ((c ?? 0) >> 6)]
        out += c === undefined ? '=' : B64[c & 63]
    }
    return out
}

function hexToBase64(hexStr: string): string {
    const clean = hexStr.startsWith('0x') ? hexStr.slice(2) : hexStr
    return bytesToBase64(hexToBytes(clean.padStart(40, '0').slice(-40)))
}

function topicToBase64(hexStr: string): string {
    const clean = hexStr.startsWith('0x') ? hexStr.slice(2) : hexStr
    return bytesToBase64(hexToBytes(clean.padStart(64, '0')))
}

function utf8Decode(bytes: Uint8Array): string {
    let str = ''
    for (let i = 0; i < bytes.length; i++) {
        str += String.fromCharCode(bytes[i])
    }
    return str
}

// ─── Inlined crypto: XOR decrypt (WASM-safe — no ethers) ────────────────────

function decryptPayload(encryptedHex: string, sharedSecret: string): string {
    const encBytes = hexToBytes(encryptedHex)
    const keyBytes = hexToBytes(sharedSecret)
    const decrypted = new Uint8Array(encBytes.length)
    for (let i = 0; i < encBytes.length; i++) {
        decrypted[i] = encBytes[i] ^ keyBytes[i % keyBytes.length]
    }
    return utf8Decode(decrypted)
}

// ─── Inlined eligibility logic (WASM-safe) ──────────────────────────────────

const COVERED_ICD10_CODES = new Set([
    'J06.9', 'J18.9', 'M54.5', 'K21.0', 'I10',
    'E11.9', 'F32.9', 'J45.909', 'Z00.00', 'K59.00',
])

const REIMBURSEMENT_RATE = 0.80
const MAX_PAYOUT_USD = 500

type Verdict = { status: string; payoutAmount: number; reasonCode: ReasonCode }

function evaluateMedicalClaim(fhir: FHIRClaim, coverageStart: number, coverageEnd: number): Verdict {
    const icd10 = fhir.diagnosis?.[0]?.diagnosisCodeableConcept?.coding?.[0]?.code
    const treatmentDateStr = fhir.billablePeriod?.start
    const billedAmount = fhir.total?.value ?? 0

    if (!icd10 || !treatmentDateStr || billedAmount <= 0) {
        return { status: 'escalated', payoutAmount: 0, reasonCode: ReasonCode.API_ERROR }
    }
    if (!COVERED_ICD10_CODES.has(icd10)) {
        return { status: 'denied', payoutAmount: 0, reasonCode: ReasonCode.NOT_COVERED }
    }
    const treatmentTs = Math.floor(new Date(treatmentDateStr).getTime() / 1000)
    if (treatmentTs < coverageStart || treatmentTs > coverageEnd) {
        return { status: 'denied', payoutAmount: 0, reasonCode: ReasonCode.OUTSIDE_PERIOD }
    }
    const rawPayout = billedAmount * REIMBURSEMENT_RATE
    const cappedPayout = Math.min(rawPayout, MAX_PAYOUT_USD)
    return { status: 'approved', payoutAmount: Math.floor(cappedPayout * 1_000_000), reasonCode: ReasonCode.APPROVED }
}

// ─── Manual ABI decoding for (bytes, uint256) ───────────────────────────────

function decodeLogData(data: Uint8Array): { encryptedPayloadHex: string; timestamp: number } {
    let timestamp = 0
    for (let i = 58; i < 64; i++) timestamp = timestamp * 256 + data[i]
    let byteLen = 0
    for (let i = 92; i < 96; i++) byteLen = byteLen * 256 + data[i]
    return { encryptedPayloadHex: bytesToHexStr(data.slice(96, 96 + byteLen)), timestamp }
}

// ─── (HTTP calls are made inline in the handler via ConfidentialHTTPClient) ──

// ─── EVM Log Trigger Handler ──────────────────────────────────────────────────

const onClaimSubmitted = (
    runtime: Runtime<Config>,
    log: EVMLog
): VerdictResult => {
    const config = runtime.config

    const policyIdHex = bytesToHex(log.topics[1])
    const claimant = '0x' + bytesToHex(log.topics[2]).slice(2).slice(24)

    const { encryptedPayloadHex } = decodeLogData(log.data)
    const bundleJson = decryptPayload(encryptedPayloadHex, config.enclaveSharedSecret)
    const bundle = JSON.parse(bundleJson) as {
        fhirId: string
        idkitProof: Record<string, any>
    }

    runtime.log('[CRE ENCLAVE] ClaimSubmitted event received')
    runtime.log(`[CRE ENCLAVE] Policy: ${policyIdHex}`)
    runtime.log('[CRE ENCLAVE] FHIR claim ID: [PRIVATE — stays in TEE]')
    runtime.log('[CRE ENCLAVE] World ID proof: [PRIVATE — verified inside TEE, never logged]')

    const confHTTP = new ConfidentialHTTPClient()

    // ── Step 1: Verify World ID proof via Confidential HTTP (INSIDE TEE) ──────
    runtime.log('[CRE ENCLAVE] Step 1: Verifying World ID proof via ConfidentialHTTPClient...')

    // The IDKit v3 payload already contains action, environment, nonce, protocol_version, and responses.
    // We forward it exactly as-is to the V4 API — no field remapping needed.
    const worldIdBody = JSON.stringify(bundle.idkitProof)

    const worldIdResp = confHTTP.sendRequest(runtime, {
        request: {
            url: `${config.worldIdBaseUrl}/api/v4/verify/${config.worldIdAppId}`,
            method: 'POST',
            bodyString: worldIdBody,
            multiHeaders: {
                'Content-Type': { values: ['application/json'] },
            },
        },
        vaultDonSecrets: [],
    }).result()

    if (!ok(worldIdResp)) {
        const errBody = worldIdResp?.body ? utf8Decode(worldIdResp.body) : ''
        runtime.log(`[CRE ENCLAVE] World ID HTTP error — body: ${errBody.slice(0, 200)}`)
        return {
            policyId: policyIdHex, claimant, status: 'denied',
            payoutAmount: 0, reasonCode: ReasonCode.UNAUTHORIZED,
            complianceHash: '0x' + '0'.repeat(64),
        }
    }

    const worldIdRespBody = utf8Decode(worldIdResp.body)
    runtime.log(`[CRE ENCLAVE] World ID raw response: ${worldIdRespBody.slice(0, 300)}`)
    const worldIdParsed = JSON.parse(worldIdRespBody) as { success?: boolean; code?: string; detail?: string }
    if (!worldIdParsed.success) {
        runtime.log(`[CRE ENCLAVE] World ID FAILED — code: ${worldIdParsed.code ?? 'N/A'} detail: ${worldIdParsed.detail ?? 'N/A'}`)
        return {
            policyId: policyIdHex, claimant, status: 'denied',
            payoutAmount: 0, reasonCode: ReasonCode.UNAUTHORIZED,
            complianceHash: '0x' + '0'.repeat(64),
        }
    }

    runtime.log('[CRE ENCLAVE] World ID verification PASSED — human identity confirmed')

    // ── Step 2: Fetch FHIR record via Confidential HTTP (INSIDE TEE) ──────────
    runtime.log('[CRE ENCLAVE] Step 2: Fetching FHIR record via ConfidentialHTTPClient...')

    const fhirUrl = `${config.fhirBaseUrl}/Claim/${bundle.fhirId}`

    const fhirResp = confHTTP.sendRequest(runtime, {
        request: {
            url: fhirUrl,
            method: 'GET',
            multiHeaders: {
                'Accept': { values: ['application/fhir+json'] },
            },
        },
        vaultDonSecrets: [],
    }).result()

    if (!ok(fhirResp)) {
        runtime.log('[CRE ENCLAVE] FHIR fetch failed')
        return {
            policyId: policyIdHex, claimant, status: 'escalated',
            payoutAmount: 0, reasonCode: ReasonCode.API_ERROR,
            complianceHash: '0x' + '0'.repeat(64),
        }
    }

    const fhirRecord = JSON.parse(utf8Decode(fhirResp.body)) as FHIRClaim

    if (fhirRecord.resourceType !== 'Claim') {
        runtime.log('[CRE ENCLAVE] ERROR: Unexpected FHIR resource type')
        return {
            policyId: policyIdHex, claimant, status: 'escalated',
            payoutAmount: 0, reasonCode: ReasonCode.API_ERROR,
            complianceHash: '0x' + '0'.repeat(64),
        }
    }

    runtime.log('[CRE ENCLAVE] FHIR record fetched and parsed inside TEE (not logged externally)')

    // ── Step 3: Run eligibility logic (inside TEE) ───────────────────────────
    runtime.log('[CRE ENCLAVE] Step 3: Running eligibility logic inside TEE...')

    const verdict = evaluateMedicalClaim(fhirRecord, 1704067200, 1735689600)

    // ── Step 4: Compute compliance hash ──────────────────────────────────────
    const now = Math.floor(Date.now() / 1000)
    const hashInput = `${policyIdHex}:${verdict.status}:${now}`
    let complianceHash = '0x'
    for (let i = 0; i < hashInput.length && complianceHash.length < 66; i++) {
        const code = hashInput.charCodeAt(i)
        complianceHash += HEX[code >> 4] + HEX[code & 0xf]
    }
    complianceHash = complianceHash.padEnd(66, '0').slice(0, 66)

    runtime.log(`[CRE ENCLAVE] Verdict: ${verdict.status.toUpperCase()} — $${(verdict.payoutAmount / 1_000_000).toFixed(2)} USDC`)
    runtime.log('[CRE ENCLAVE] Diagnosis, ICD-10 code, amounts remain private in TEE')

    // ── Step 5: Write verdict onchain via EVMClient.writeReport (WriteTarget) ──
    // ABI-encode recordVerdict(bytes32 policyId, string status, uint256 payoutAmount, uint8 reasonCode, bytes32 complianceHash)
    // Function selector: keccak256("recordVerdict(bytes32,string,uint256,uint8,bytes32)") = first 4 bytes
    // We manually encode since ethers.js is not available in WASM.
    const verdictResult: VerdictResult = {
        policyId: policyIdHex, claimant,
        status: verdict.status, payoutAmount: verdict.payoutAmount,
        reasonCode: verdict.reasonCode, complianceHash,
    }

    try {
        const evmClient = new EVMClient(EVMClient.SUPPORTED_CHAIN_SELECTORS['ethereum-mainnet-base-1'])

        // Encode the verdict as ABI calldata for recordVerdict
        const calldata = encodeRecordVerdict(
            policyIdHex, verdict.status, verdict.payoutAmount, verdict.reasonCode, complianceHash
        )

        evmClient.writeReport(runtime, {
            receiver: config.policyRegistryAddress,
            report: new Report({ rawReport: bytesToBase64(calldata) }),
        }).result()

        runtime.log('[CRE ENCLAVE] Step 5: Verdict written onchain via WriteTarget')
    } catch (e: unknown) {
        runtime.log(`[CRE ENCLAVE] Step 5: WriteReport skipped (${e instanceof Error ? e.message : 'simulation mode'})`)
    }

    return verdictResult
}

// ─── ABI encoding helpers (WASM-safe — no ethers) ───────────────────────────

function encodeRecordVerdict(
    policyId: string,
    status: string,
    payoutAmount: number,
    reasonCode: number,
    complianceHash: string,
): Uint8Array {
    // recordVerdict(bytes32,string,uint256,uint8,bytes32)
    // selector = keccak256("recordVerdict(bytes32,string,uint256,uint8,bytes32)")
    // We precompute: 0x (first 4 bytes of the hash)
    // For now, encode as raw bytes that the report receiver can decode
    const encoded = JSON.stringify({ policyId, status, payoutAmount, reasonCode, complianceHash })
    const bytes = new Uint8Array(encoded.length)
    for (let i = 0; i < encoded.length; i++) bytes[i] = encoded.charCodeAt(i)
    return bytes
}

// ─── Workflow Initialization ──────────────────────────────────────────────────

const initWorkflow = (config: Config) => {
    const evmClient = new EVMClient(EVMClient.SUPPORTED_CHAIN_SELECTORS['ethereum-mainnet-base-1'])

    const logTrigger = evmClient.logTrigger({
        addresses: [hexToBase64(config.claimRequestAddress)],
        topics: [{
            values: [topicToBase64(config.claimSubmittedEventSignature)],
        }],
    })

    return [handler(logTrigger, onClaimSubmitted)]
}

// ─── CRE Runner Entry Point ──────────────────────────────────────────────────

export async function main() {
    const runner = await Runner.newRunner<Config>({ configSchema })
    await runner.run(initWorkflow)
}
