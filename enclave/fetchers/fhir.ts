/**
 * fetchFHIRClaim.ts
 *
 * Fetches a live FHIR R4 Claim record from the HAPI FHIR public sandbox.
 *
 * ┌─────────────────────────────────────────────────────────────────────┐
 * │  ARCHITECTURE NOTE — TWO MODES OF OPERATION                        │
 * │                                                                     │
 * │  1. LOCAL SIMULATION (scripts/run-enclave.ts):                      │
 * │     Uses standard `fetch()`. The HTTP call happens locally in       │
 * │     Node.js. Credentials visible in process env. Logs are visible.  │
 * │                                                                     │
 * │  2. CRE WORKFLOW (workflow/main.ts):                                 │
 * │     The fetch is executed via ConfidentialHTTPClient.sendRequest()  │
 * │     from @chainlink/cre-sdk. The HTTP call happens INSIDE the TEE.  │
 * │     API credentials are injected via vaultDonSecrets at runtime —   │
 * │     they never appear in code, logs, or node memory.                │
 * │     The response body stays encrypted until it reaches the handler  │
 * │     function inside the enclave.                                    │
 * │                                                                     │
 * │  The eligibility logic (evaluateMedicalClaim) is IDENTICAL in both  │
 * │  modes — it operates only on in-memory data, so privacy properties  │
 * │  are the same. The difference is WHERE the HTTP call executes.      │
 * └─────────────────────────────────────────────────────────────────────┘
 *
 * Demo claim URL (no auth required):
 *   https://hapi.fhir.org/baseR4/Claim/131299879
 *
 * In production, replace the HAPI sandbox URL with your real EHR endpoint.
 * The PRODUCTION_EHR_TOKEN env var shows where OAuth2 credentials live —
 * in the CRE workflow, this token is stored encrypted in the Vault DON
 * and injected via {{.ehrAuthToken}} template syntax inside the enclave.
 */

import type { FHIRClaim } from '../types'

const FHIR_BASE_URL = 'https://hapi.fhir.org/baseR4'

/**
 * Fetch a FHIR R4 Claim resource by ID.
 *
 * Used by scripts/run-enclave.ts (local simulation).
 * In the CRE workflow, the equivalent fetch is performed via:
 *   ConfidentialHTTPClient.sendRequest({ request, vaultDonSecrets })
 * which runs this inside the TEE with the ehrAuthToken injected at runtime.
 *
 * @param claimId  The FHIR claim ID (e.g. "131299879")
 * @returns        Parsed FHIRClaim object — never written to disk or logged externally
 */
export async function fetchFHIRClaim(claimId: string): Promise<FHIRClaim> {
    const url = `${FHIR_BASE_URL}/Claim/${claimId}`

    const headers: Record<string, string> = {
        'Accept': 'application/fhir+json',
    }

    // PRODUCTION: This auth header is where the EHR API OAuth2 token goes.
    // In the CRE workflow, this is NOT set here — instead, it is injected
    // automatically inside the enclave using the vaultDonSecrets mechanism:
    //
    //   sendRequester.sendRequest({
    //     request: {
    //       url,
    //       method: 'GET',
    //       multiHeaders: {
    //         Authorization: { values: ['Bearer {{.ehrAuthToken}}'] }
    //       }
    //     },
    //     vaultDonSecrets: [{ key: 'ehrAuthToken', owner: config.owner }]
    //   })
    //
    // The token is pulled from the Vault DON at request time, never stored.
    // process.env.PRODUCTION_EHR_TOKEN is a placeholder showing where it would
    // go in a non-CRE integration — in CRE it's never in process.env.
    //
    // if (process.env.PRODUCTION_EHR_TOKEN) {
    //   headers['Authorization'] = `Bearer ${process.env.PRODUCTION_EHR_TOKEN}`
    // }

    const response = await fetch(url, { method: 'GET', headers })

    if (!response.ok) {
        throw new Error(
            `FHIR API error: ${response.status} ${response.statusText} for claim ${claimId}`
        )
    }

    const data = await response.json() as Record<string, unknown>

    if (data['resourceType'] !== 'Claim') {
        throw new Error(
            `Unexpected FHIR resource type: ${String(data['resourceType'])} (expected "Claim")`
        )
    }

    return data as FHIRClaim
}

/**
 * The CRE-compatible fetch function signature.
 * This is the function passed to ConfidentialHTTPClient.sendRequest() in the workflow.
 * It receives a `sendRequester` object that executes the HTTP call inside the TEE.
 *
 * Note: In the local simulation, we use fetchFHIRClaim() with standard fetch().
 *       In the CRE workflow, this signature is used with the confidential HTTP client.
 *
 * @param sendRequester  Injected by ConfidentialHTTPClient — executes inside TEE
 * @param config         Workflow config (contains fhirBaseUrl, fhir_claim_id, owner)
 */
export type CREFetchConfig = {
    fhirBaseUrl: string
    fhirClaimId: string
    owner: string
}

export type CREFetchResult = {
    claimJson: string // Serialized FHIRClaim — stays inside the enclave handler
}
