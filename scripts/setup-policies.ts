/**
 * setup-policies.ts — Idempotent Policy Setup
 *
 * Registers and activates DEMO-001 through DEMO-015.
 * Safe to run multiple times — skips already-registered and already-active policies.
 * Auto-funds the deployer wallet via Tenderly setBalance if ETH is low.
 *
 * Usage:
 *   bun scripts/setup-policies.ts
 */

import { ethers } from 'ethers'

const POLICY_REGISTRY_ABI = [
    'function registerPolicy(bytes32 policyId, uint256 coverageStart, uint256 coverageEnd, uint256 maxPayout, address enclave) external',
    'function payPremium(bytes32 policyId) external payable',
    'function getPolicy(bytes32 policyId) external view returns (address owner, bool premiumPaid, uint256 coverageStart, uint256 coverageEnd, uint256 maxPayout, address approvedEnclave, bool active)',
    'function claimProcessed(bytes32 policyId) external view returns (bool)',
]

const CLAIM_SETTLEMENT_ABI = [
    'function poolBalance() external view returns (uint256)',
]

const COVERAGE_START = 1704067200n  // 2024-01-01
const COVERAGE_END   = 1735689600n  // 2024-12-31
const MAX_PAYOUT     = 500_000000n  // $500.00 USDC (6 decimals)
const PREMIUM_ETH    = ethers.parseEther('0.01')
const TOTAL_POLICIES = 15

const C = {
    green: '\x1b[32m', yellow: '\x1b[33m', cyan: '\x1b[36m',
    red:   '\x1b[31m', gray:   '\x1b[90m', bold: '\x1b[1m',
    dim:   '\x1b[2m',  reset:  '\x1b[0m',
}
const green  = (s: string) => `${C.green}${s}${C.reset}`
const yellow = (s: string) => `${C.yellow}${s}${C.reset}`
const cyan   = (s: string) => `${C.cyan}${s}${C.reset}`
const red    = (s: string) => `${C.red}${s}${C.reset}`
const gray   = (s: string) => `${C.gray}${s}${C.reset}`
const bold   = (s: string) => `${C.bold}${s}${C.reset}`
const dim    = (s: string) => `${C.dim}${s}${C.reset}`

async function main() {
    const provider   = new ethers.JsonRpcProvider(process.env.TENDERLY_RPC_URL!)
    const signer     = new ethers.Wallet(process.env.DEPLOYER_PRIVATE_KEY!, provider)
    const registry   = new ethers.Contract(process.env.POLICY_REGISTRY_ADDRESS!, POLICY_REGISTRY_ABI, signer)
    const settlement = new ethers.Contract(process.env.CLAIM_SETTLEMENT_ADDRESS!, CLAIM_SETTLEMENT_ABI, provider)
    const enclaveWallet = process.env.ENCLAVE_WALLET_ADDRESS!

    console.log(`\n${bold(cyan('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━'))}`)
    console.log(`  ${bold('CLAIMSHIELD — Policy Setup')}`)
    console.log(`  ${gray('Registers and activates DEMO-001 through DEMO-015')}`)
    console.log(`${bold(cyan('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━'))}\n`)
    console.log(`  ${gray('Wallet    ')} ${cyan(signer.address)}`)
    console.log(`  ${gray('Registry  ')} ${cyan(process.env.POLICY_REGISTRY_ADDRESS!)}`)
    console.log(`  ${gray('Settlement')} ${cyan(process.env.CLAIM_SETTLEMENT_ADDRESS!)}`)

    // ── Auto-fund wallet ETH via Tenderly setBalance ───────────────────────────
    // Need: 0.01 ETH × 15 policies + gas buffer = ~2 ETH to be safe
    const balance = await provider.getBalance(signer.address)
    const minNeeded = PREMIUM_ETH * BigInt(TOTAL_POLICIES) + ethers.parseEther('1')

    if (balance < minNeeded) {
        console.log(`\n  ${yellow('⚠ ETH balance low:')} ${ethers.formatEther(balance)} ETH`)
        console.log(`  ${dim('Auto-funding 10 ETH via Tenderly setBalance...')}`)
        try {
            await provider.send('tenderly_setBalance', [
                [signer.address],
                ethers.toQuantity(ethers.parseEther('10')),
            ])
            const newBal = await provider.getBalance(signer.address)
            console.log(`  ${green('✓ Funded to')} ${ethers.formatEther(newBal)} ETH`)
        } catch (e: unknown) {
            console.log(`  ${red('✗ Auto-fund failed:')} ${e instanceof Error ? e.message : String(e)}`)
            console.log(`  ${yellow('Fund the wallet manually from the Tenderly dashboard, then re-run.')}`)
            process.exit(1)
        }
    } else {
        console.log(`  ${gray('ETH balance')} ${green(ethers.formatEther(balance) + ' ETH')} ${dim('(sufficient)')}`)
    }

    // ── Settlement pool balance ────────────────────────────────────────────────
    try {
        const pool = await settlement.poolBalance()
        const poolUSD = (Number(pool) / 1_000_000).toFixed(2)
        const minPoolNeeded = TOTAL_POLICIES * 500  // worst case: all approved at max
        const poolNote = Number(poolUSD) < minPoolNeeded
            ? yellow(`$${poolUSD} USDC ⚠ may run low`)
            : green(`$${poolUSD} USDC`)
        console.log(`  ${gray('Pool balance')} ${poolNote}`)
    } catch { /* non-critical */ }

    // ── Register and activate policies ────────────────────────────────────────
    console.log(`\n  ${bold('Processing DEMO-001 through DEMO-015...')}\n`)

    const results: { name: string; status: 'READY' | 'CLAIMED' | 'INACTIVE' }[] = []
    let registered = 0
    let activated  = 0

    for (let i = 1; i <= TOTAL_POLICIES; i++) {
        const name     = `DEMO-${String(i).padStart(3, '0')}`
        const policyId = ethers.id(name)

        let policy = await registry.getPolicy(policyId)

        // ── Register if missing ────────────────────────────────────────────────
        if (policy.owner === ethers.ZeroAddress) {
            process.stdout.write(`  ${dim(name)}  registering...`)
            try {
                const tx = await registry.registerPolicy(
                    policyId, COVERAGE_START, COVERAGE_END, MAX_PAYOUT, enclaveWallet
                )
                await tx.wait()
                policy = await registry.getPolicy(policyId)
                registered++
                process.stdout.write(` ${green('registered')}\n`)
            } catch (e: unknown) {
                process.stdout.write(` ${red('FAILED')}\n`)
                console.log(`    ${red(e instanceof Error ? e.message : String(e))}`)
                results.push({ name, status: 'INACTIVE' })
                continue
            }
        }

        // ── Activate if premium not paid ───────────────────────────────────────
        if (!policy.active) {
            process.stdout.write(`  ${dim(name)}  paying premium...`)
            try {
                const tx = await registry.payPremium(policyId, { value: PREMIUM_ETH })
                await tx.wait()
                policy = await registry.getPolicy(policyId)
                activated++
                process.stdout.write(` ${green('activated')}\n`)
            } catch (e: unknown) {
                process.stdout.write(` ${red('FAILED')}\n`)
                console.log(`    ${red(e instanceof Error ? e.message : String(e))}`)
                results.push({ name, status: 'INACTIVE' })
                continue
            }
        }

        // ── Final status ───────────────────────────────────────────────────────
        const claimed = await registry.claimProcessed(policyId)

        if (!policy.active) {
            results.push({ name, status: 'INACTIVE' })
            console.log(`  ${red('❌')}  ${bold(name)}  ${gray('INACTIVE')}`)
        } else if (claimed) {
            results.push({ name, status: 'CLAIMED' })
            console.log(`  ${yellow('🔒')}  ${bold(name)}  ${gray('CLAIMED')}`)
        } else {
            results.push({ name, status: 'READY' })
            console.log(`  ${green('✅')}  ${bold(name)}  ${gray('READY')}`)
        }
    }

    // ── Summary ────────────────────────────────────────────────────────────────
    const ready    = results.filter(r => r.status === 'READY')
    const claimed  = results.filter(r => r.status === 'CLAIMED')
    const inactive = results.filter(r => r.status === 'INACTIVE')

    console.log(`\n${bold(cyan('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━'))}`)
    if (registered > 0) console.log(`  ${dim('Newly registered:')} ${registered}`)
    if (activated  > 0) console.log(`  ${dim('Newly activated :')} ${activated}`)
    console.log(``)
    console.log(`  ${green('✅ Ready   ')} ${bold(String(ready.length))}  ${gray('— unclaimed, use for demos')}`)
    console.log(`  ${yellow('🔒 Claimed ')} ${bold(String(claimed.length))}  ${gray('— already processed, do not reuse')}`)
    if (inactive.length > 0) {
        console.log(`  ${red('❌ Inactive')} ${bold(String(inactive.length))}  ${gray('— re-run this script to retry')}`)
    }

    if (ready.length > 0) {
        console.log(`\n  ${bold('Next available policy:')} ${cyan(ready[0].name)}`)
        console.log(`  ${gray('Run:')} ${cyan('bun scripts/demo.ts')}`)
    } else {
        console.log(`\n  ${yellow('⚠ No ready policies. All are either claimed or inactive.')}`)
        console.log(`  ${dim('Deploy fresh contracts, or re-run after investigating inactive policies.')}`)
    }
    console.log(`${bold(cyan('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━'))}\n`)

    if (inactive.length > 0) process.exit(1)
}

main().catch(err => {
    console.error(red('\nSetup failed: ' + (err?.message ?? String(err))))
    process.exit(1)
})
