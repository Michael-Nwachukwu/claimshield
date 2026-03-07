/**
 * demo.ts — Interactive ClaimShield Demo
 *
 * Usage:
 *   bun scripts/demo.ts
 *
 * Prompts for claim details, then runs the full end-to-end flow:
 *   Phase 1: FHIR Preview    — fetch live medical record, show what the enclave will see
 *   Phase 2: Submit Claim     — encrypt payload, submit onchain, get tx hash
 *   Phase 3: CRE Enclave     — run `cre workflow simulate` with real EVM Log Trigger
 *   Phase 4: Verdict Write    — write the CRE verdict onchain (WriteTarget in production)
 *   Phase 5: Verdict Display  — read from chain, show privacy proof panel
 */

import { ethers } from 'ethers'
import * as readline from 'readline'
import fs from 'fs'
import path from 'path'
import { spawn } from 'child_process'
import { encryptPayload, decryptPayload } from '../enclave/crypto'

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
    const line = '\u2501'.repeat(62)
    console.log(`\n${C.cyan}${line}${C.reset}`)
    console.log(`  ${bold(cyan(title))}`)
    console.log(`${C.cyan}${line}${C.reset}`)
}

function banner(lines: string[]) {
    const inner = '\u2550'.repeat(62)
    console.log(`\n${bold(cyan('\u2554' + inner + '\u2557'))}`)
    for (const l of lines) console.log(`${bold(cyan('\u2551'))}  ${l.padEnd(60)}${bold(cyan('\u2551'))}`)
    console.log(`${bold(cyan('\u255a' + inner + '\u255d'))}`)
}

// ─── ABIs ────────────────────────────────────────────────────────────────────

const POLICY_REGISTRY_ABI = [
    'function getPolicy(bytes32 policyId) external view returns (address owner, bool premiumPaid, uint256 coverageStart, uint256 coverageEnd, uint256 maxPayout, address approvedEnclave, bool active)',
    'function getVerdict(bytes32 policyId) external view returns (tuple(string status, uint256 payoutAmount, uint8 reasonCode, bytes32 complianceHash, uint256 timestamp))',
    'function claimProcessed(bytes32 policyId) external view returns (bool)',
    'function recordVerdict(bytes32 policyId, string calldata status, uint256 payoutAmount, uint8 reasonCode, bytes32 complianceHash) external',
]

const CLAIM_REQUEST_ABI = [
    'function submitClaim(bytes32 policyId, bytes calldata encryptedPayload) external',
    'event ClaimSubmitted(bytes32 indexed policyId, address indexed claimant, bytes encryptedPayload, uint256 timestamp)',
]

const CLAIM_SETTLEMENT_ABI = [
    'function executePayout(bytes32 policyId, address recipient, uint256 amount) external',
    'function recordDenial(bytes32 policyId, uint8 reasonCode) external',
    'function poolBalance() external view returns (uint256)',
]

const REASON_CODE_LABELS: Record<number, string> = {
    0: 'APPROVED',
    1: 'NOT_COVERED',
    2: 'OUTSIDE_PERIOD',
    3: 'DUPLICATE',
    4: 'POLICY_INACTIVE',
    5: 'UNAUTHORIZED',
    6: 'API_ERROR',
    7: 'ESCALATED',
}

// ─── Interactive Helpers ──────────────────────────────────────────────────────

const rl = readline.createInterface({ input: process.stdin, output: process.stdout })

function ask(question: string): Promise<string> {
    return new Promise(resolve => rl.question(question, resolve))
}

function pause(message: string): Promise<void> {
    return new Promise(resolve => rl.question(message, () => resolve()))
}

// ─── CRE Simulate Runner ────────────────────────────────────────────────────

type CREResult = { stdout: string; stderr: string; exitCode: number }

function runCRESimulate(txHash: string): Promise<CREResult> {
    return new Promise((resolve) => {
        const args = [
            'workflow', 'simulate', './workflow',
            '--target=staging-settings',
            '--evm-tx-hash=' + txHash,
            '--evm-event-index=0',
            '--trigger-index=0',
            '--non-interactive',
        ]

        const child = spawn('cre', args, {
            cwd: process.cwd(),
            env: { ...process.env },
        })

        let stdout = ''
        let stderr = ''

        child.stdout.on('data', (data: Buffer) => {
            const text = data.toString()
            stdout += text
            // Stream CRE output to terminal in real time
            process.stdout.write(text)
        })

        child.stderr.on('data', (data: Buffer) => {
            const text = data.toString()
            stderr += text
            process.stderr.write(text)
        })

        child.on('close', (code: number | null) => {
            resolve({ stdout, stderr, exitCode: code ?? 1 })
        })
    })
}

// ─── Parse CRE verdict from stdout ──────────────────────────────────────────

type ParsedVerdict = {
    status: string
    payoutAmount: number
    reasonCode: number
}

function parseCREVerdict(stdout: string): ParsedVerdict | null {
    // Strip ANSI escape codes for reliable parsing
    const clean = stdout.replace(/\x1b\[[0-9;]*m/g, '')
    // Primary: parse the structured JSON from "Workflow Simulation Result:"
    const jsonMatch = clean.match(/Workflow Simulation Result:\s*\n(\{[\s\S]*?\n\})/)
    if (jsonMatch) {
        try {
            const result = JSON.parse(jsonMatch[1]) as {
                status?: string
                payoutAmount?: number
                reasonCode?: number
            }
            if (result.status) {
                return {
                    status: result.status,
                    payoutAmount: result.payoutAmount ?? 0,
                    reasonCode: result.reasonCode ?? 0,
                }
            }
        } catch { /* fall through to regex parsing */ }
    }

    // Fallback: parse from runtime.log output
    const verdictMatch = clean.match(/\[CRE ENCLAVE\] Verdict: (\w+) .* \$([0-9.]+) USDC/)
    if (verdictMatch) {
        const status = verdictMatch[1].toLowerCase()
        const payoutUSD = parseFloat(verdictMatch[2])
        return { status, payoutAmount: Math.floor(payoutUSD * 1_000_000), reasonCode: status === 'approved' ? 0 : 5 }
    }

    if (clean.includes('World ID verification FAILED')) {
        return { status: 'denied', payoutAmount: 0, reasonCode: 5 }
    }

    return null
}

// ─── Main ────────────────────────────────────────────────────────────────────

async function main() {
    const provider = new ethers.JsonRpcProvider(process.env.TENDERLY_RPC_URL!)
    const signer = new ethers.Wallet(process.env.DEPLOYER_PRIVATE_KEY!, provider)
    const enclaveSigner = new ethers.Wallet(process.env.ENCLAVE_PRIVATE_KEY!, provider)
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
    const policyId = (policyRaw.trim() || 'DEMO-001').toUpperCase().replace(/[\s_]+/g, '-')

    const fhirRaw = await ask(`  ${bold('FHIR Claim ID')} ${gray('[131299879]')}: `)
    const fhirClaimId = fhirRaw.trim() || '131299879'

    console.log(`\n  ${gray('Policy ID     ')} ${cyan(policyId)}`)
    console.log(`  ${gray('FHIR Claim ID ')} ${cyan(fhirClaimId)}`)
    console.log(`  ${gray('Claimant      ')} ${cyan(signer.address)}`)

    // ── Pre-validate policy ─────────────────────────────────────────────────
    console.log(`\n  ${dim('Verifying policy onchain...')}`)
    const policyIdBytes = ethers.id(policyId)
    const preRegistry = new ethers.Contract(process.env.POLICY_REGISTRY_ADDRESS!, POLICY_REGISTRY_ABI, provider)
    const [prePolicy, preClaimed] = await Promise.all([
        preRegistry.getPolicy(policyIdBytes),
        preRegistry.claimProcessed(policyIdBytes),
    ])

    if (prePolicy.owner === ethers.ZeroAddress) {
        console.log(`  ${red('Error: Policy not found:')} "${bold(policyId)}"`)
        console.log(`  ${dim('Run')} ${cyan('bun scripts/setup-policies.ts')} ${dim('to register and activate policies.')}`)
        rl.close(); process.exit(1)
    }
    if (!prePolicy.active) {
        console.log(`  ${red('Error: Policy not active:')} ${bold(policyId)}`)
        rl.close(); process.exit(1)
    }
    if (preClaimed) {
        console.log(`  ${yellow('Warning: Policy already claimed:')} ${bold(policyId)}`)
        console.log(`  ${dim('Each policy can only be claimed once. Use a different Policy ID.')}`)
        rl.close(); process.exit(1)
    }
    console.log(`  ${green('OK')} ${bold(policyId)} is active and ready\n`)

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
            console.log(`\n  ${gray('Reimbursement  ')} ${dim('80% x $' + billedAmount + ' =')} ${green('$' + expectedPayout + ' USDC')}`)
            console.log(`\n  ${magenta('This data NEVER goes onchain.')}`)
            console.log(`  ${dim('In CRE: fetched inside TEE via ConfidentialHTTPClient.')}`)
        }
    } catch {
        console.log(`  ${yellow('Warning: FHIR preview failed. Continuing...')}`)
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // PHASE 2: Submit Claim Onchain
    // ═══════════════════════════════════════════════════════════════════════════
    await pause(`\n  ${dim('Press Enter to continue to')} ${bold('Phase 2 — Submit Claim')}${dim('...')}`)
    header('PHASE 2  |  Submit Claim Onchain')
    console.log(`  ${dim('Building encrypted payload (FHIR ID + World ID proof)...')}`)

    // Read World ID proof
    const proofPath = path.resolve(process.cwd(), 'world-id-proof.json')
    if (!fs.existsSync(proofPath)) {
        console.log(`  ${red('Error: world-id-proof.json not found.')}`)
        console.log(`  ${dim('Generate a proof using the worldid-gen app.')}`)
        rl.close(); process.exit(1)
    }
    const worldIdProof = JSON.parse(fs.readFileSync(proofPath, 'utf-8'))
    console.log(`  ${green('OK')} World ID proof loaded`)
    console.log(`  ${dim('Verification happens inside the CRE TEE — not client-side.')}`)

    // Bundle: FHIR ID + full raw IDKit v3 proof (responses-array format for V4 API)
    const bundle = JSON.stringify({
        fhirId: fhirClaimId,
        idkitProof: worldIdProof,
    })
    const encryptedPayload = encryptPayload(bundle, sharedSecret)
    const payloadBytes = (encryptedPayload.length - 2) / 2

    console.log(`\n  ${gray('policyId (bytes32)')} ${dim(policyIdBytes)}`)
    console.log(`  ${gray('Payload size     ')} ${white(String(payloadBytes) + ' bytes')} ${dim('(XOR-encrypted)')}`)

    const claimRequest = new ethers.Contract(process.env.CLAIM_REQUEST_ADDRESS!, CLAIM_REQUEST_ABI, signer)
    const tx = await claimRequest.submitClaim(policyIdBytes, encryptedPayload)
    const receipt = await tx.wait()

    console.log(`\n  ${green('Transaction confirmed')}`)
    console.log(`  ${gray('TX Hash')}  ${cyan(receipt.hash)}`)
    console.log(`  ${gray('Block   ')} ${white(String(receipt.blockNumber))}`)
    console.log(`  ${gray('Gas used')} ${white(receipt.gasUsed.toString())}`)

    console.log(`\n  ${bold('Onchain:')}`)
    console.log(`    ${green('OK')} policyId, claimant, encryptedPayload`)
    console.log(`  ${bold('Private:')}`)
    console.log(`    ${magenta('LOCKED')} FHIR ID, World ID proof, ICD-10, diagnosis`)

    // ═══════════════════════════════════════════════════════════════════════════
    // PHASE 3: CRE Enclave Processing (REAL CRE simulate)
    // ═══════════════════════════════════════════════════════════════════════════
    await pause(`\n  ${dim('Press Enter to continue to')} ${bold('Phase 3 — CRE TEE Processing')}${dim('...')}`)
    header('PHASE 3  |  CRE TEE Processing  (cre workflow simulate)')
    console.log(`  ${green('->')} ${bold('Running Chainlink CRE workflow inside TEE simulation')}`)
    console.log(`  ${dim('Command:')} ${cyan(`cre workflow simulate ./workflow --target=staging-settings --evm-tx-hash=${receipt.hash}`)}\n`)
    console.log(`  ${dim('The CRE runtime:')}`)
    console.log(`    ${dim('1. Picks up the ClaimSubmitted event from tx')} ${dim(receipt.hash.slice(0, 10) + '...')}`)
    console.log(`    ${dim('2. Decrypts the payload inside the TEE')}`)
    console.log(`    ${dim('3. Verifies World ID proof via ConfidentialHTTPClient')}`)
    console.log(`    ${dim('4. Fetches FHIR record via ConfidentialHTTPClient')}`)
    console.log(`    ${dim('5. Runs eligibility logic — all inside TEE')}\n`)

    const creResult = await runCRESimulate(receipt.hash)

    console.log('') // blank line after CRE output

    if (creResult.exitCode !== 0) {
        console.log(`  ${red('CRE simulate exited with code ' + creResult.exitCode)}`)
        console.log(`  ${dim('Check the output above for errors.')}`)
        rl.close(); process.exit(1)
    }

    console.log(`  ${green('OK')} ${bold('CRE workflow completed successfully')}`)

    // Parse the verdict from CRE output
    const verdict = parseCREVerdict(creResult.stdout)
    if (!verdict) {
        console.log(`  ${yellow('Warning: Could not parse verdict from CRE output.')}`)
        console.log(`  ${dim('The CRE ran but verdict parsing failed. Check output above.')}`)
        rl.close(); process.exit(1)
    }

    console.log(`  ${gray('CRE Verdict  ')} ${verdict.status === 'approved' ? green(bold('APPROVED')) : red(bold(verdict.status.toUpperCase()))}`)
    console.log(`  ${gray('Payout       ')} ${green('$' + (verdict.payoutAmount / 1_000_000).toFixed(2) + ' USDC')}`)

    // ═══════════════════════════════════════════════════════════════════════════
    // PHASE 4: Write Verdict Onchain (what WriteTarget does in production CRE)
    // ═══════════════════════════════════════════════════════════════════════════
    header('PHASE 4  |  Write Verdict Onchain')
    console.log(`  ${dim('In production CRE: WriteTarget sends the verdict onchain automatically.')}`)
    console.log(`  ${dim('For the demo: writing using the approved enclave signer.')}\n`)

    const registry = new ethers.Contract(process.env.POLICY_REGISTRY_ADDRESS!, POLICY_REGISTRY_ABI, enclaveSigner)
    const settlement = new ethers.Contract(process.env.CLAIM_SETTLEMENT_ADDRESS!, CLAIM_SETTLEMENT_ABI, enclaveSigner)

    // Compute compliance hash
    const complianceHash = ethers.keccak256(
        ethers.toUtf8Bytes(`${policyIdBytes}:${verdict.status}:${Date.now()}`)
    )

    console.log(`  ${gray('Status          ')} ${verdict.status}`)
    console.log(`  ${gray('Payout          ')} $${(verdict.payoutAmount / 1_000_000).toFixed(2)} USDC`)
    console.log(`  ${gray('Reason Code     ')} ${verdict.reasonCode}`)
    console.log(`  ${gray('Compliance Hash ')} ${dim(complianceHash)}`)

    // Record verdict in PolicyRegistry
    const verdictTx = await registry.recordVerdict(
        policyIdBytes, verdict.status, verdict.payoutAmount, verdict.reasonCode, complianceHash
    )
    const verdictReceipt = await verdictTx.wait()
    console.log(`\n  ${green('OK')} Verdict recorded. TX: ${cyan(verdictReceipt.hash)}`)

    // Execute payout if approved
    if (verdict.status === 'approved' && verdict.payoutAmount > 0) {
        console.log(`  ${dim('Executing USDC payout...')}`)
        const payoutTx = await settlement.executePayout(policyIdBytes, signer.address, verdict.payoutAmount)
        const payoutReceipt = await payoutTx.wait()
        console.log(`  ${green('OK')} Payout executed. TX: ${cyan(payoutReceipt.hash)}`)
        console.log(`  ${gray('Recipient')} ${cyan(signer.address)}`)
        console.log(`  ${gray('Amount   ')} ${green('$' + (verdict.payoutAmount / 1_000_000).toFixed(2) + ' USDC')}`)
    } else if (verdict.status !== 'approved') {
        await settlement.recordDenial(policyIdBytes, verdict.reasonCode)
        console.log(`  ${yellow('Denial recorded onchain.')}`)
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // PHASE 5: Verdict Display — Read from Chain
    // ═══════════════════════════════════════════════════════════════════════════
    header('PHASE 5  |  Verdict — Reading from Chain')

    const readRegistry = new ethers.Contract(process.env.POLICY_REGISTRY_ADDRESS!, POLICY_REGISTRY_ABI, provider)
    const [verdictRaw, policyData, processed] = await Promise.all([
        readRegistry.getVerdict(policyIdBytes),
        readRegistry.getPolicy(policyIdBytes),
        readRegistry.claimProcessed(policyIdBytes),
    ])

    const status = verdictRaw.status as string
    const payoutAmount = verdictRaw.payoutAmount as bigint
    const reasonCode = verdictRaw.reasonCode as number
    const onchainHash = verdictRaw.complianceHash as string
    const timestamp = verdictRaw.timestamp as bigint

    if (timestamp === 0n) {
        console.log(`\n  ${yellow('No verdict recorded yet.')}`)
        rl.close(); return
    }

    const statusLabel = status === 'approved' ? green(bold('APPROVED'))
        : status === 'denied' ? red(bold('DENIED'))
            : yellow(bold('ESCALATED'))
    const payout = (Number(payoutAmount) / 1_000_000).toFixed(2)
    const ts = new Date(Number(timestamp) * 1000).toUTCString()

    console.log(`\n  ${gray('Status          ')} ${statusLabel}`)
    console.log(`  ${gray('Payout          ')} ${green(bold('$' + payout + ' USDC'))}`)
    console.log(`  ${gray('Reason Code     ')} ${white(String(Number(reasonCode)))} ${dim('—')} ${white(REASON_CODE_LABELS[Number(reasonCode)] ?? 'UNKNOWN')}`)
    console.log(`  ${gray('Compliance Hash ')} ${dim(onchainHash)}`)
    console.log(`  ${gray('Timestamp       ')} ${white(ts)}`)
    console.log(`  ${gray('Enclave Signer  ')} ${cyan(policyData.approvedEnclave)}`)
    console.log(`  ${gray('Claim Processed ')} ${green(String(processed))}`)

    console.log(`\n  ${bold(cyan('WHAT IS ONCHAIN (anyone can verify):'))}`)
    console.log(`    ${green('OK')} Policy exists and was active`)
    console.log(`    ${green('OK')} Claim submitted (encrypted payload only)`)
    console.log(`    ${green('OK')} Verdict: ${bold(status.toUpperCase())}`)
    console.log(`    ${green('OK')} Payout: ${green(bold('$' + payout + ' USDC'))}`)
    console.log(`    ${green('OK')} Compliance hash (non-reversible verification proof)`)
    console.log(`    ${green('OK')} Signed by approved enclave address`)

    // Decrypt the bundle to show what was private
    const decryptedBundle = JSON.parse(decryptPayload(encryptedPayload, sharedSecret))

    console.log(`\n  ${bold(magenta('WHAT NEVER LEFT THE CRE TEE:'))}`)
    const nullifier = decryptedBundle.idkitProof?.responses?.[0]?.nullifier
        ?? decryptedBundle.idkitProof?.nullifier_hash
        ?? '(inside proof)'
    console.log(`    ${magenta('LOCKED')} World ID nullifier     ${dim(nullifier)}`)
    console.log(`    ${magenta('LOCKED')} World ID proof         ${dim('[ZKP — verified inside TEE]')}`)
    console.log(`    ${magenta('LOCKED')} FHIR Claim ID         ${yellow(decryptedBundle.fhirId)}`)
    console.log(`    ${magenta('LOCKED')} ICD-10 Diagnosis Code  ${dim('(evaluated inside TEE)')}`)
    console.log(`    ${magenta('LOCKED')} Diagnosis Text         ${dim('(evaluated inside TEE)')}`)
    console.log(`    ${magenta('LOCKED')} Treatment Date         ${dim('(evaluated inside TEE)')}`)
    console.log(`    ${magenta('LOCKED')} Billed Amount          ${dim('(evaluated inside TEE)')}`)
    console.log(`    ${magenta('LOCKED')} Covered Conditions     ${dim('(private rule set)')}`)
    console.log(`    ${magenta('LOCKED')} Reimbursement Rate     ${dim('80%')}`)

    console.log(`\n  ${dim('All medical data was fetched live from HAPI FHIR,')}`)
    console.log(`  ${dim('processed inside the Chainlink CRE TEE via ConfidentialHTTPClient,')}`)
    console.log(`  ${dim('and discarded. No diagnosis, code, or amount was written onchain.')}`)

    banner([green(bold('DEMO COMPLETE')), ''])

    rl.close()
}

main().catch(err => { rl.close(); console.error(red('\nError: ' + (err?.message ?? String(err)))) })
