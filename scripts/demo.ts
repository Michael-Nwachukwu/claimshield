/**
 * demo.ts — Interactive ClaimShield Demo
 *
 * Usage:
 *   bun scripts/demo.ts
 *
 * Prompts for claim details, then runs the full end-to-end flow:
 *   Phase 1: FHIR Preview    — fetch live medical record, show what the enclave will see
 *   Phase 2: Submit Claim     — encrypt FHIR ID, submit onchain, listen for the event
 *   Phase 3: Enclave Process  — auto-triggered by event: decrypt, fetch FHIR, evaluate, write verdict
 *   Phase 4: Verdict Display  — read from chain, show privacy proof panel
 */

import { ethers } from 'ethers'
import * as readline from 'readline'
import { encryptFhirId, decryptFhirId } from '../enclave/crypto'
import { processClaim } from '../enclave/processor'

// ─── ANSI Colors ──────────────────────────────────────────────────────────────

const C = {
    reset: '\x1b[0m',
    bold: '\x1b[1m',
    dim: '\x1b[2m',
    cyan: '\x1b[36m',
    green: '\x1b[32m',
    yellow: '\x1b[33m',
    red: '\x1b[31m',
    magenta: '\x1b[35m',
    gray: '\x1b[90m',
    white: '\x1b[97m',
}

const bold = (s: string) => `${C.bold}${s}${C.reset}`
const cyan = (s: string) => `${C.cyan}${s}${C.reset}`
const white = (s: string) => `${C.white}${s}${C.reset}`
const green = (s: string) => `${C.green}${s}${C.reset}`
const yellow = (s: string) => `${C.yellow}${s}${C.reset}`
const red = (s: string) => `${C.red}${s}${C.reset}`
const magenta = (s: string) => `${C.magenta}${s}${C.reset}`
const gray = (s: string) => `${C.gray}${s}${C.reset}`
const dim = (s: string) => `${C.dim}${s}${C.reset}`

function header(title: string) {
    const line = '━'.repeat(62)
    console.log(`\n${C.cyan}${line}${C.reset}`)
    console.log(`  ${bold(cyan(title))}`)
    console.log(`${C.cyan}${line}${C.reset}`)
}

function banner(lines: string[]) {
    const inner = '═'.repeat(62)
    console.log(`\n${bold(cyan('╔' + inner + '╗'))}`)
    for (const l of lines) console.log(`${bold(cyan('║'))}  ${l.padEnd(60)}${bold(cyan('║'))}`)
    console.log(`${bold(cyan('╚' + inner + '╝'))}`)
}

// ─── ABIs ────────────────────────────────────────────────────────────────────

// NOTE: getVerdict returns a Verdict struct containing a `string` field.
// Ethers.js v6 requires tuple() syntax for correct ABI decoding of dynamic struct members.
const POLICY_REGISTRY_ABI = [
    'function getPolicy(bytes32 policyId) external view returns (address owner, bool premiumPaid, uint256 coverageStart, uint256 coverageEnd, uint256 maxPayout, address approvedEnclave, bool active)',
    'function getVerdict(bytes32 policyId) external view returns (tuple(string status, uint256 payoutAmount, uint8 reasonCode, bytes32 complianceHash, uint256 timestamp))',
    'function claimProcessed(bytes32 policyId) external view returns (bool)',
]

const CLAIM_REQUEST_ABI = [
    'function submitClaim(bytes32 policyId, bytes32 encryptedPayload) external',
    'event ClaimSubmitted(bytes32 indexed policyId, address indexed claimant, bytes32 encryptedPayload, uint256 timestamp)',
]

const REASON_CODE_LABELS: Record<number, string> = {
    0: 'APPROVED',
    1: 'NOT_COVERED — ICD-10 not in covered list',
    2: 'OUTSIDE_PERIOD — treatment outside coverage window',
    3: 'DUPLICATE — claim already processed',
    4: 'POLICY_INACTIVE — premiums not paid',
    5: 'UNAUTHORIZED — wallet mismatch',
    6: 'API_ERROR — FHIR fetch failed',
    7: 'ESCALATED — needs human review',
}

// ─── Interactive Helpers ──────────────────────────────────────────────────────

const rl = readline.createInterface({ input: process.stdin, output: process.stdout })

function ask(question: string): Promise<string> {
    return new Promise(resolve => rl.question(question, resolve))
}

function pause(message: string): Promise<void> {
    return new Promise(resolve => rl.question(message, () => resolve()))
}

// ─── Main ────────────────────────────────────────────────────────────────────

async function main() {
    const provider = new ethers.JsonRpcProvider(process.env.TENDERLY_RPC_URL!)
    const signer = new ethers.Wallet(process.env.DEPLOYER_PRIVATE_KEY!, provider)
    const sharedSecret = process.env.ENCLAVE_SHARED_SECRET!

    // ── Welcome ──────────────────────────────────────────────────────────────
    banner([
        bold('CLAIMSHIELD — INTERACTIVE DEMO'),
        'Privacy-Preserving Medical Claims on Chainlink CRE',
    ])
    console.log(`\n  ${gray('Verifies insurance claims via live FHIR data without')}`)
    console.log(`  ${gray('exposing diagnosis, treatment, or billing data onchain.')}`)
    console.log(`  ${gray('All medical records stay inside the Chainlink CRE TEE.')}`)
    console.log(`\n  ${gray('Connected wallet:')} ${cyan(signer.address)}`)

    // ── Collect Inputs ───────────────────────────────────────────────────────
    header('Enter Claim Details')
    console.log(`  ${dim('Press Enter to use defaults shown in brackets.')}\n`)

    const policyRaw = await ask(`  ${bold('Policy ID')} ${gray('[DEMO-001]')}: `)
    // Normalize: trim whitespace, uppercase, replace spaces/underscores with hyphens
    // e.g. "demo 003" → "DEMO-003", "DEMO_002" → "DEMO-002"
    const policyId = (policyRaw.trim() || 'DEMO-001').toUpperCase().replace(/[\s_]+/g, '-')

    const fhirRaw = await ask(`  ${bold('FHIR Claim ID')} ${gray('[131299879]')}: `)
    const fhirClaimId = fhirRaw.trim() || '131299879'

    console.log(`\n  ${gray('Policy ID     ')} ${cyan(policyId)}`)
    console.log(`  ${gray('FHIR Claim ID ')} ${cyan(fhirClaimId)}`)
    console.log(`  ${gray('Claimant      ')} ${cyan(signer.address)}`)

    // ── Pre-validate policy before spending any gas ───────────────────────────
    console.log(`\n  ${dim('Verifying policy onchain...')}`)
    const policyIdBytes = ethers.id(policyId)
    const preRegistry = new ethers.Contract(process.env.POLICY_REGISTRY_ADDRESS!, POLICY_REGISTRY_ABI, provider)
    const [prePolicy, preClaimed] = await Promise.all([
        preRegistry.getPolicy(policyIdBytes),
        preRegistry.claimProcessed(policyIdBytes),
    ])

    if (prePolicy.owner === ethers.ZeroAddress) {
        console.log(`  ${red('✗ Policy not found:')} "${bold(policyId)}"`)
        console.log(`  ${dim('Run')} ${cyan('bun scripts/setup-policies.ts')} ${dim('to register and activate policies.')}`)
        rl.close(); process.exit(1)
    }
    if (!prePolicy.active) {
        console.log(`  ${red('✗ Policy not active:')} ${bold(policyId)} ${dim('(premium not paid)')}`)
        console.log(`  ${dim('Run')} ${cyan('bun scripts/setup-policies.ts')} ${dim('to activate it.')}`)
        rl.close(); process.exit(1)
    }
    if (preClaimed) {
        console.log(`  ${yellow('⚠ Policy already claimed:')} ${bold(policyId)}`)
        console.log(`  ${dim('Each policy can only be claimed once. Use a different Policy ID.')}`)
        console.log(`  ${dim('Run')} ${cyan('bun scripts/setup-policies.ts')} ${dim('to see which are available.')}`)
        rl.close(); process.exit(1)
    }
    console.log(`  ${green('✓')} ${bold(policyId)} is active and ready\n`)

    // ═══════════════════════════════════════════════════════════════════════════
    // PHASE 1: FHIR Preview
    // ═══════════════════════════════════════════════════════════════════════════
    await pause(`\n  ${dim('Press Enter to start')} ${bold('Phase 1 — FHIR Preview')}${dim('...')}`)
    header('PHASE 1  |  FHIR Preview')
    console.log(`  ${dim('Fetching live medical record from HAPI FHIR sandbox...')}`)

    let billedAmount = 0
    try {
        const resp = await fetch(`https://hapi.fhir.org/baseR4/Claim/${fhirClaimId}`)
        const fhir = await resp.json() as Record<string, unknown>

        if (fhir.resourceType === 'Claim') {
            const diag = (fhir as any).diagnosis?.[0]?.diagnosisCodeableConcept?.coding?.[0]
            const dateStr = (fhir as any).billablePeriod?.start
            billedAmount = (fhir as any).total?.value ?? 0
            const expectedPayout = (billedAmount * 0.80).toFixed(2)

            console.log(`\n  ${gray('Resource Type  ')} ${white(String(fhir.resourceType))}`)
            console.log(`  ${gray('FHIR Claim ID  ')} ${cyan(fhirClaimId)}`)
            console.log(`  ${gray('ICD-10 Code    ')} ${yellow(diag?.code ?? 'N/A')}`)
            console.log(`  ${gray('Diagnosis      ')} ${yellow(diag?.display ?? 'N/A')}`)
            console.log(`  ${gray('Treatment Date ')} ${yellow(dateStr ?? 'N/A')}`)
            console.log(`  ${gray('Billed Amount  ')} ${white('$' + billedAmount)}`)
            console.log(`\n  ${gray('Reimbursement  ')} ${dim('80% × $' + billedAmount + ' =')} ${green('$' + expectedPayout + ' USDC')} ${gray('← insurer rate, stays private in TEE')}`)
            console.log(`\n  ${magenta('🔒 This data NEVER goes onchain.')}`)
            console.log(`  ${dim('In production CRE: fetched inside the TEE via ConfidentialHTTPClient.')}`)
        } else {
            console.log(`  ${yellow('Warning: unexpected resource type:')} ${fhir.resourceType}`)
        }
    } catch (err) {
        console.log(`  ${yellow('Warning: FHIR preview failed. Continuing...')}`)
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // PHASE 2: Submit Claim Onchain + Parse Event
    // ═══════════════════════════════════════════════════════════════════════════
    await pause(`\n  ${dim('Press Enter to continue to')} ${bold('Phase 2 — Submit Claim')}${dim('...')}`)
    header('PHASE 2  |  Submit Claim Onchain')
    console.log(`  ${dim('Encrypting FHIR ID and broadcasting transaction...')}`)

    const encryptedPayload = encryptFhirId(fhirClaimId, sharedSecret)

    console.log(`\n  ${gray('policyId (bytes32)')} ${dim(policyIdBytes)}`)
    console.log(`  ${gray('Encrypted FHIR   ')} ${dim(encryptedPayload)}`)
    console.log(`  ${dim('XOR-encrypted — only the enclave can decrypt with the shared secret.')}\n`)

    const claimRequest = new ethers.Contract(process.env.CLAIM_REQUEST_ADDRESS!, CLAIM_REQUEST_ABI, signer)
    const tx = await claimRequest.submitClaim(policyIdBytes, encryptedPayload)
    const receipt = await tx.wait()

    console.log(`  ${green('✓ Transaction confirmed')}`)
    console.log(`  ${gray('TX Hash')}  ${cyan(receipt.hash)}`)
    console.log(`  ${gray('Block   ')} ${white(String(receipt.blockNumber))}`)
    console.log(`  ${gray('Gas used')} ${white(receipt.gasUsed.toString())}`)

    console.log(`\n  ${bold('What IS onchain:')}`)
    console.log(`    ${green('✅')} policyId           ${dim(policyIdBytes)}`)
    console.log(`    ${green('✅')} claimant           ${cyan(signer.address)}`)
    console.log(`    ${green('✅')} encryptedPayload   ${dim(encryptedPayload)} ${dim('(ciphertext)')}`)
    console.log(`  ${bold('What is NOT onchain:')}`)
    console.log(`    ${magenta('🔒')} FHIR Claim ID, ICD-10 code, diagnosis, treatment date, billed amount`)

    // Parse the ClaimSubmitted event from the receipt.
    // This simulates exactly what the CRE EVM Log Trigger delivers to the enclave.
    console.log(`\n  ${dim('Parsing ClaimSubmitted event from receipt...')}`)

    const iface = new ethers.Interface(CLAIM_REQUEST_ABI)
    let eventPolicyId = policyIdBytes
    let eventClaimant = signer.address
    let eventEncryptedPayload = encryptedPayload

    for (const log of receipt.logs) {
        try {
            const parsed = iface.parseLog({ topics: log.topics as string[], data: log.data })
            if (parsed?.name === 'ClaimSubmitted') {
                eventPolicyId = parsed.args[0]
                eventClaimant = parsed.args[1]
                eventEncryptedPayload = parsed.args[2]
                break
            }
        } catch { /* not this event */ }
    }

    console.log(`  ${green('✓')} ${bold('ClaimSubmitted event detected')} ${dim('→ CRE EVM Log Trigger fires')}`)
    console.log(`    ${gray('policyId  ')} ${dim(eventPolicyId)}`)
    console.log(`    ${gray('claimant  ')} ${cyan(eventClaimant)}`)
    console.log(`    ${gray('encrypted ')} ${dim(eventEncryptedPayload)}`)

    // ═══════════════════════════════════════════════════════════════════════════
    // PHASE 3: Enclave Processing — auto-triggered by event (no prompt)
    // ═══════════════════════════════════════════════════════════════════════════
    header('PHASE 3  |  Enclave Processing  (Simulated CRE TEE)')
    console.log(`  ${green('→')} ${bold('Event received — enclave activates automatically.')}`)
    console.log(`  ${dim('Decrypting FHIR ID from the event\'s encryptedPayload...')}\n`)

    // Demonstrate the decryption — this is what workflow/main.ts does from log.data inside TEE
    const decryptedFhirId = decryptFhirId(eventEncryptedPayload, sharedSecret)
    console.log(`  ${gray('Encrypted payload ')} ${dim(eventEncryptedPayload)}`)
    console.log(`  ${gray('Shared secret     ')} ${dim(sharedSecret.slice(0, 10) + '...')} ${gray('(Vault DON managed in production)')}`)
    console.log(`  ${green('✓')} ${bold('Decrypted FHIR ID:')} ${yellow(decryptedFhirId)}\n`)
    console.log(`  ${dim('In production CRE: workflow/main.ts decrypts inside the TEE — never logged externally.')}\n`)

    // Check if claim was already processed (e.g. demo run more than once on same testnet)
    const registryCheck = new ethers.Contract(process.env.POLICY_REGISTRY_ADDRESS!, POLICY_REGISTRY_ABI, provider)
    const alreadyProcessed = await registryCheck.claimProcessed(policyIdBytes)

    if (alreadyProcessed) {
        console.log(`  ${yellow('⚠')}  ${bold('Claim already processed on this testnet.')}`)
        console.log(`  ${dim('The enclave ran on a previous demo. Showing existing verdict from chain...')}`)
        console.log(`  ${dim('To run a fresh demo: re-deploy contracts or use a different Policy ID.')}\n`)
    } else {
        // Run the full enclave: fetch FHIR, evaluate, write verdict, payout
        await processClaim({
            policy_id: policyId,
            wallet: eventClaimant,
            fhir_claim_id: decryptedFhirId,
        })
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // PHASE 4: Verdict — auto-displayed after payout (no prompt)
    // ═══════════════════════════════════════════════════════════════════════════
    header('PHASE 4  |  Verdict — Reading from Chain')

    const registry = new ethers.Contract(process.env.POLICY_REGISTRY_ADDRESS!, POLICY_REGISTRY_ABI, provider)
    const [verdictRaw, policyData, processed] = await Promise.all([
        registry.getVerdict(policyIdBytes),
        registry.getPolicy(policyIdBytes),
        registry.claimProcessed(policyIdBytes),
    ])

    // getVerdict returns a single unnamed tuple — ethers.js v6 decodes it as the struct directly
    const status = verdictRaw.status as string
    const payoutAmount = verdictRaw.payoutAmount as bigint
    const reasonCode = verdictRaw.reasonCode as number
    const complianceHash = verdictRaw.complianceHash as string
    const timestamp = verdictRaw.timestamp as bigint

    // Guard: if timestamp is 0, no verdict was written (enclave returned early unexpectedly)
    if (timestamp === 0n) {
        console.log(`\n  ${yellow('⚠ No verdict recorded yet.')}`)
        console.log(`  ${dim('The enclave may have exited early. Check Phase 3 output above for details.')}`)
        console.log(`  ${dim('Run')} ${cyan('bun scripts/setup-policies.ts')} ${dim('to verify policy status, then retry.')}\n`)
        banner([yellow('DEMO INCOMPLETE — no verdict written'), ''])
        rl.close(); return
    }

    const statusLabel = status === 'approved' ? green(bold('✅ APPROVED'))
        : status === 'denied' ? red(bold('❌ DENIED'))
            : yellow(bold('⚠️  ESCALATED'))
    const payout = (Number(payoutAmount) / 1_000_000).toFixed(2)
    const ts = new Date(Number(timestamp) * 1000).toUTCString()

    console.log(`\n  ${gray('Status          ')} ${statusLabel}`)
    console.log(`  ${gray('Payout          ')} ${green(bold('$' + payout + ' USDC'))}`)
    console.log(`  ${gray('Reason Code     ')} ${white(String(Number(reasonCode)))} ${dim('—')} ${white(REASON_CODE_LABELS[Number(reasonCode)] ?? 'UNKNOWN')}`)
    console.log(`  ${gray('Compliance Hash ')} ${dim(complianceHash)}`)
    console.log(`  ${gray('Timestamp       ')} ${white(ts)}`)
    console.log(`  ${gray('Enclave Signer  ')} ${cyan(policyData.approvedEnclave)}`)
    console.log(`  ${gray('Claim Processed ')} ${green(String(processed))}`)

    console.log(`\n  ${bold(cyan('── WHAT IS ONCHAIN (anyone can verify):'))}`)
    console.log(`    ${green('✅')} Policy exists and was active`)
    console.log(`    ${green('✅')} Claim submitted ${dim('(encrypted payload only — no FHIR ID in plaintext)')}`)
    console.log(`    ${green('✅')} Verdict: ${bold(status.toUpperCase())}`)
    console.log(`    ${green('✅')} Payout amount: ${green(bold('$' + payout + ' USDC'))}`)
    console.log(`    ${green('✅')} Compliance hash ${dim('(non-reversible verification proof)')}`)
    console.log(`    ${green('✅')} Verdict signed by approved enclave address`)
    console.log(`    ${green('✅')} USDC transfer TXs visible in block explorer`)

    console.log(`\n  ${bold(magenta('── WHAT NEVER LEFT THE ENCLAVE (CRE TEE):'))}`)
    console.log(`    ${magenta('🔒')} FHIR Claim ID         ${yellow(decryptedFhirId)} ${gray('← decrypted inside TEE, never logged')}`)
    console.log(`    ${magenta('🔒')} ICD-10 Diagnosis Code  ${dim('(evaluated inside TEE)')}`)
    console.log(`    ${magenta('🔒')} Diagnosis Text         ${dim('(evaluated inside TEE)')}`)
    console.log(`    ${magenta('🔒')} Treatment Date         ${dim('(evaluated inside TEE)')}`)
    console.log(`    ${magenta('🔒')} Billed Amount          ${dim('(evaluated inside TEE)')}`)
    console.log(`    ${magenta('🔒')} Covered Conditions List`)
    console.log(`    ${magenta('🔒')} Reimbursement Rate     ${dim('80%')}`)
    console.log(`    ${magenta('🔒')} EHR API Credentials`)

    console.log(`\n  ${dim('The above medical data was fetched live from HAPI FHIR,')}`)
    console.log(`  ${dim('processed inside the Chainlink CRE TEE, and discarded.')}`)
    console.log(`  ${dim('No diagnosis, code, amount, or credential was written')}`)
    console.log(`  ${dim('to any persistent storage or emitted in any event.')}`)

    banner([green(bold('DEMO COMPLETE')), ''])

    console.log(`  ${gray('Verify USDC payout with cast:')}`)
    console.log(`  ${dim('cast call 0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913 \\')}`)
    console.log(`  ${dim('  "balanceOf(address)(uint256)" $CLAIMANT_WALLET \\')}`)
    console.log(`  ${dim('  --rpc-url $TENDERLY_RPC_URL')}`)
    console.log(`  ${gray('Expected:')} ${green(String(Number(payoutAmount)))} ${dim('→')} ${green(bold('$' + payout + ' USDC'))}\n`)

    rl.close()
}

main().catch(err => { rl.close(); console.error(red('\nError: ' + (err?.message ?? String(err)))) })
