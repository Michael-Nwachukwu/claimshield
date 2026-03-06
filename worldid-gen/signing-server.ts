/**
 * signing-server.ts — Local signing server for World ID v4 rp_context
 *
 * Runs on port 4568. Called by the worldid-gen frontend before opening IDKit.
 * Generates a signed rp_context using @worldcoin/idkit-server (server-side only).
 *
 * Usage:
 *   bun worldid-gen/signing-server.ts        (from claimshield/ directory)
 *
 * Required .env vars:
 *   RP_ID          — your Relying Party ID from the World ID Developer Portal (rp_...)
 *   RP_SIGNING_KEY — 32-byte hex private key for signing requests (from Developer Portal)
 */

import { signRequest } from '@worldcoin/idkit-server'

const RP_ID = process.env.RP_ID
const RP_SIGNING_KEY = process.env.RP_SIGNING_KEY

if (!RP_ID || !RP_SIGNING_KEY) {
    console.error('\n  ❌ Missing required env vars: RP_ID and/or RP_SIGNING_KEY')
    console.error('  Add them to claimshield/.env and re-run.\n')
    process.exit(1)
}

const corsHeaders = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
}

Bun.serve({
    port: 4568,
    fetch(req) {
        const url = new URL(req.url)

        if (req.method === 'OPTIONS') {
            return new Response(null, { status: 204, headers: corsHeaders })
        }

        if (url.pathname === '/rp-context') {
            const action = url.searchParams.get('action') ?? 'submit-claim'
            try {
                const result = signRequest(action, RP_SIGNING_KEY!)
                const rpContext = {
                    rp_id: RP_ID,
                    nonce: result.nonce,
                    created_at: result.createdAt,
                    expires_at: result.expiresAt,
                    signature: result.sig,
                }
                return new Response(JSON.stringify(rpContext), {
                    headers: { 'Content-Type': 'application/json', ...corsHeaders },
                })
            } catch (err) {
                console.error('[signing-server] signRequest error:', err)
                return new Response(
                    JSON.stringify({ error: String(err) }),
                    { status: 500, headers: { 'Content-Type': 'application/json', ...corsHeaders } }
                )
            }
        }

        return new Response('Not found', { status: 404 })
    },
})

console.log('\n  World ID Signing Server')
console.log('  ─────────────────────────────────')
console.log(`  Listening on http://localhost:4568`)
console.log(`  RP ID: ${RP_ID}`)
console.log('  GET /rp-context?action=<action>')
console.log('  ─────────────────────────────────\n')
