/**
 * crypto.ts — Encrypt/Decrypt payloads for onchain privacy
 *
 * The FHIR claim ID and World ID proof must travel from the claimant to the
 * CRE enclave without appearing as plaintext onchain. The ClaimSubmitted event
 * carries a `bytes encryptedPayload` field — a variable-length XOR-encrypted
 * JSON bundle containing both the FHIR ID and the World ID proof.
 *
 * Demo: XOR cipher with a shared secret (symmetric, key repeated/cycled).
 * Production CRE: Asymmetric encryption to the DON's public key —
 *   only the TEE can decrypt. The shared secret would be replaced
 *   by the enclave's private key stored in the Vault DON.
 */

import { ethers } from 'ethers'

/**
 * Encrypt an arbitrary-length plaintext string using XOR with a repeating key.
 *
 * @param plaintext    UTF-8 string to encrypt (e.g. JSON bundle)
 * @param sharedSecret A bytes32 hex string used as the repeating XOR key
 * @returns            Hex string (0x-prefixed) of the encrypted bytes
 */
export function encryptPayload(plaintext: string, sharedSecret: string): string {
    const plainBytes = ethers.toUtf8Bytes(plaintext)
    const keyBytes = ethers.getBytes(sharedSecret) // 32 bytes
    const encrypted = new Uint8Array(plainBytes.length)
    for (let i = 0; i < plainBytes.length; i++) {
        encrypted[i] = plainBytes[i] ^ keyBytes[i % keyBytes.length]
    }
    return ethers.hexlify(encrypted)
}

/**
 * Decrypt a hex-encoded XOR-encrypted payload back to the original UTF-8 string.
 *
 * @param encryptedHex Hex string (0x-prefixed) from the ClaimSubmitted event
 * @param sharedSecret The same bytes32 shared secret used for encryption
 * @returns            The original plaintext string
 */
export function decryptPayload(encryptedHex: string, sharedSecret: string): string {
    const encBytes = ethers.getBytes(encryptedHex)
    const keyBytes = ethers.getBytes(sharedSecret)
    const decrypted = new Uint8Array(encBytes.length)
    for (let i = 0; i < encBytes.length; i++) {
        decrypted[i] = encBytes[i] ^ keyBytes[i % keyBytes.length]
    }
    return new TextDecoder().decode(decrypted)
}

/**
 * Encrypt a FHIR claim ID into a bytes32 using XOR with a shared secret.
 *
 * @param fhirClaimId    The FHIR claim ID string (e.g. "131299879")
 * @param sharedSecret   A bytes32 hex string used as the XOR key
 * @returns              bytes32 hex string — the encrypted payload
 */
export function encryptFhirId(fhirClaimId: string, sharedSecret: string): string {
    const plainBytes = ethers.toUtf8Bytes(fhirClaimId)
    if (plainBytes.length > 32) {
        throw new Error(`FHIR claim ID too long: ${plainBytes.length} bytes (max 32)`)
    }

    // Right-align the data (left-pad with zeros to 32 bytes)
    const padded = new Uint8Array(32)
    padded.set(plainBytes, 32 - plainBytes.length)

    // XOR with shared secret
    const keyBytes = ethers.getBytes(sharedSecret)
    const encrypted = new Uint8Array(32)
    for (let i = 0; i < 32; i++) {
        encrypted[i] = padded[i] ^ keyBytes[i]
    }

    return ethers.hexlify(encrypted)
}

/**
 * Decrypt a bytes32 encrypted payload back to the FHIR claim ID.
 *
 * @param encryptedHex   bytes32 hex string from the ClaimSubmitted event
 * @param sharedSecret   The same bytes32 shared secret used for encryption
 * @returns              The original FHIR claim ID string
 */
export function decryptFhirId(encryptedHex: string, sharedSecret: string): string {
    const encBytes = ethers.getBytes(encryptedHex)
    const keyBytes = ethers.getBytes(sharedSecret)

    const decrypted = new Uint8Array(32)
    for (let i = 0; i < 32; i++) {
        decrypted[i] = encBytes[i] ^ keyBytes[i]
    }

    // Strip leading zero padding, decode UTF-8
    let start = 0
    while (start < 32 && decrypted[start] === 0) start++

    return new TextDecoder().decode(decrypted.slice(start))
}
