import React, { useState, useEffect } from 'react'
import ReactDOM from 'react-dom/client'
import { IDKit, IDKitRequestWidget, deviceLegacy } from '@worldcoin/idkit'

// Expose IDKit globally for console debugging
window._IDKit = IDKit
window._deviceLegacy = deviceLegacy

// Read app_id and action from the URL hash: #APP_ID|ACTION
const rawHash = window.location.hash.slice(1)
const hash = decodeURIComponent(rawHash)
const [APP_ID, ACTION] = hash.includes('|') ? hash.split('|') : [hash || '', 'submit-claim']

const styles = {
    page: {
        minHeight: '100vh',
        background: '#0f172a',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        fontFamily: 'system-ui, -apple-system, sans-serif',
        padding: 20,
    },
    card: {
        background: '#1e293b',
        borderRadius: 16,
        padding: 40,
        maxWidth: 560,
        width: '100%',
        boxShadow: '0 25px 60px rgba(0,0,0,0.5)',
    },
}

function App() {
    const [proof, setProof] = useState(null)
    const [copied, setCopied] = useState(false)
    const [err, setErr] = useState(null)
    const [rpContext, setRpContext] = useState(null)
    const [open, setOpen] = useState(false)
    const [loading, setLoading] = useState(false)

    // Catch unhandled promise rejections (WASM errors)
    useEffect(() => {
        const handler = (e) => {
            console.error('[IDKit unhandled]', e.reason)
            if (String(e.reason).includes('IDKit') || String(e.reason).includes('wasm')) {
                setErr(`IDKit internal error: ${e.reason}`)
            }
        }
        window.addEventListener('unhandledrejection', handler)
        return () => window.removeEventListener('unhandledrejection', handler)
    }, [])

    if (!APP_ID) {
        return (
            <div style={styles.page}><div style={styles.card}>
                <h1 style={{ color: '#f1f5f9', marginBottom: 12 }}>ClaimShield</h1>
                <p style={{ color: '#f87171', marginBottom: 16 }}>No App ID found in URL.</p>
                <p style={{ color: '#94a3b8', fontSize: 14, lineHeight: 1.8 }}>
                    Open this page as:<br />
                    <code style={{ color: '#60a5fa' }}>
                        http://localhost:4567/#YOUR_APP_ID|submit-claim
                    </code>
                </p>
            </div></div>
        )
    }

    const handleVerifyClick = async () => {
        setLoading(true)
        setErr(null)
        try {
            const res = await fetch(`http://localhost:4568/rp-context?action=${encodeURIComponent(ACTION)}`)
            const data = await res.json()
            if (data.error) throw new Error(data.error)
            console.log('[ClaimShield] rp_context:', JSON.stringify(data))

            // Test IDKit.request() directly to get the real error
            try {
                console.log('[ClaimShield] Testing IDKit.request() directly...')
                const req = await IDKit.request({
                    app_id: APP_ID,
                    action: ACTION,
                    rp_context: data,
                    allow_legacy_proofs: true,
                    environment: 'staging',
                }).preset(deviceLegacy())
                console.log('[ClaimShield] IDKit request created! connectorURI:', req.connectorURI)
                // If we get here, the request works — proceed with widget
                req.free?.()
            } catch (testErr) {
                console.error('[ClaimShield] IDKit.request() REAL ERROR:', testErr)
                console.error('[ClaimShield] Error message:', testErr?.message)
                console.error('[ClaimShield] Error stack:', testErr?.stack)
                setErr(`IDKit error: ${testErr?.message || testErr}`)
                setLoading(false)
                return
            }

            setRpContext(data)
            setOpen(true)
        } catch (e) {
            setErr(`Signing server error: ${e.message}. Is it running? Run: bun worldid-gen/signing-server.ts`)
        } finally {
            setLoading(false)
        }
    }

    const onSuccess = (result) => {
        console.log('[ClaimShield] IDKit result:', JSON.stringify(result, null, 2))
        // v4 format: proof data is in responses[0], field is "nullifier" not "nullifier_hash"
        const r = result.responses?.[0]
        if (r) {
            setProof({
                merkle_root: r.merkle_root,
                nullifier_hash: r.nullifier,
                proof: r.proof,
                verification_level: r.identifier ?? 'device',
            })
        } else {
            // v3 fallback
            setProof({
                merkle_root: result.merkle_root,
                nullifier_hash: result.nullifier_hash,
                proof: result.proof,
                verification_level: result.verification_level ?? 'device',
            })
        }
        setOpen(false)
    }

    const copy = () => {
        navigator.clipboard.writeText(JSON.stringify(proof, null, 2)).then(() => {
            setCopied(true)
            setTimeout(() => setCopied(false), 2500)
        })
    }

    return (
        <div style={styles.page}>
            <div style={styles.card}>
                <h1 style={{ color: '#f1f5f9', marginBottom: 4, fontSize: 28 }}>ClaimShield</h1>
                <p style={{ color: '#94a3b8', marginBottom: 20, fontSize: 15 }}>World ID Proof Generator</p>

                <div style={{
                    background: '#0f172a', borderRadius: 8, padding: '12px 16px',
                    marginBottom: 24, fontSize: 12, color: '#64748b', fontFamily: 'monospace', wordBreak: 'break-all'
                }}>
                    App: {APP_ID}<br />
                    Action: {ACTION}
                </div>

                {rpContext && (
                    <IDKitRequestWidget
                        app_id={APP_ID}
                        action={ACTION}
                        rp_context={rpContext}
                        allow_legacy_proofs={true}
                        preset={deviceLegacy()}
                        environment="staging"
                        open={open}
                        onOpenChange={setOpen}
                        onSuccess={onSuccess}
                        onError={(code) => {
                            console.error('[ClaimShield] IDKit onError code:', code)
                            setErr(`World ID error: ${code}`)
                        }}
                    />
                )}

                {!proof ? (
                    <>
                        <button
                            onClick={handleVerifyClick}
                            disabled={loading}
                            style={{
                                background: loading ? '#1e40af' : '#3b82f6',
                                color: '#fff', border: 'none',
                                borderRadius: 10, padding: '14px 28px', fontSize: 16,
                                cursor: loading ? 'not-allowed' : 'pointer', width: '100%',
                            }}
                        >
                            {loading ? 'Connecting...' : 'Verify with World ID Simulator'}
                        </button>

                        {err && (
                            <p style={{ color: '#f87171', fontSize: 13, marginTop: 12 }}>Error: {err}</p>
                        )}

                        <ol style={{ color: '#64748b', fontSize: 13, marginTop: 20, lineHeight: 2, paddingLeft: 18 }}>
                            <li>Make sure the signing server is running on port 4568</li>
                            <li>Click the button above — IDKit modal opens with a QR code</li>
                            <li>Open <a href="https://simulator.worldcoin.org" target="_blank" style={{ color: '#60a5fa' }}>simulator.worldcoin.org</a> — Scanner — scan QR code</li>
                            <li>Click Approve in the Simulator</li>
                            <li>Proof JSON appears below — Copy — save as <code style={{ color: '#86efac' }}>world-id-proof.json</code></li>
                        </ol>
                    </>
                ) : (
                    <>
                        <p style={{ color: '#4ade80', fontWeight: 700, fontSize: 18, marginBottom: 8 }}>Proof Generated!</p>
                        <p style={{ color: '#94a3b8', fontSize: 13, marginBottom: 16 }}>
                            Copy this JSON and save it to <code style={{ color: '#86efac' }}>claimshield/world-id-proof.json</code>
                        </p>
                        <pre style={{
                            background: '#0f172a', color: '#86efac', borderRadius: 8,
                            padding: 16, fontSize: 12, overflow: 'auto', maxHeight: 260,
                        }}>
                            {JSON.stringify(proof, null, 2)}
                        </pre>
                        <button onClick={copy} style={{
                            background: copied ? '#166534' : '#16a34a',
                            color: '#fff', border: 'none', borderRadius: 10,
                            padding: '12px 24px', fontSize: 15, cursor: 'pointer',
                            width: '100%', marginTop: 12,
                        }}>
                            {copied ? 'Copied!' : 'Copy JSON'}
                        </button>
                    </>
                )}
            </div>
        </div>
    )
}

ReactDOM.createRoot(document.getElementById('root')).render(<App />)
