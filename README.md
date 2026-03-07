# ClaimShield

> *"The insurer approved a medical claim — verified against live patient records and a real human identity — without ever seeing the diagnosis, the treatment date, or who the claimant was."*

A **privacy-preserving medical insurance claims processor** built for the [Chainlink CRE Hackathon](https://chain.link/) — Privacy Track.

**🔗 [View Live Virtual Testnet Transactions on Tenderly](https://dashboard.tenderly.co/explorer/vnet/f0623146-5cc8-41fe-8cb6-fd43f0528cc0/transactions)**

---

## Table of Contents

1. [The Problem](#1-the-problem)
2. [The Solution](#2-the-solution)
3. [Why This Works](#3-why-this-works)
4. [How It Works — Full Flow](#4-how-it-works--full-flow)
5. [Architecture](#5-architecture)
6. [Smart Contracts](#6-smart-contracts)
7. [CRE Workflow & Enclave Logic](#7-cre-workflow--enclave-logic)
8. [Privacy Model — Three Layers](#8-privacy-model--three-layers)
9. [Access Control & Security](#9-access-control--security)
10. [Project Structure](#10-project-structure)
11. [Running the Demo](#11-running-the-demo)
12. [Demo Reference Data](#12-demo-reference-data)

---

## 1. The Problem

Traditional medical insurance claims processing requires a patient to hand over their most sensitive data — diagnoses, treatment records, billing history — to an insurer's centralized database in order to receive reimbursement.

```
TRADITIONAL SYSTEM — The Privacy Problem
─────────────────────────────────────────

  Patient         Insurer Server
    │                   │
    │── "I had J06.9, treated on    │
    │   2024-06-10, billed $120" ──▶│  stores all of it
    │                               │  runs rules
    │◀── "Approved. $100 payout" ───│  transfers money
    │                               │
  The Problem:
  This traditional method forces the patient to surrender all of their sensitive
  medical data to a third-party insurer, creating a honeypot of private health
  records on centralized servers. The process also lacks transparency —
  patients blindly trust the insurer's eligibility rules with no on-chain
  audit trail to verify how claims or settlements are handled.
```

**The core tension:** To get paid, the patient must reveal private health data. And to submit a claim, *anyone* with a wallet can call the contract — nothing stops a bot from spamming claims under stolen policy IDs.

ClaimShield solves both: privacy via TEE processing, and Sybil resistance via World ID.

---

## 2. The Solution

```
CLAIMSHIELD — Privacy-Preserving Claims with Sybil Resistance

  Patient         Blockchain          CRE Enclave (TEE)        External APIs
    │                  │                      │                      │
    │                  │                      │                      │
    │  1. Bundle:      │                      │                      │
    │  { fhirId,       │                      │                      │
    │    World ID ZKP} │                      │                      │
    │  encrypted ─────▶│                      │                      │
    │  (XOR, TEE key)  │── event triggers ───▶│                      │
    │                  │                      │                      │
    │                  │                      │── Step 1: World ID ─▶│
    │                  │                      │   POST /verify        │
    │                  │                      │   (inside TEE)        │
    │                  │                      │◀── { success: true } ─│
    │                  │                      │   proof verified      │
    │                  │                      │                      │
    │                  │                      │── Step 2: FHIR ──────▶│
    │                  │                      │   GET /Claim/131...   │
    │                  │                      │   (inside TEE)        │
    │                  │                      │◀── full FHIR record ──│
    │                  │                      │   stays in TEE        │
    │                  │                      │                      │
    │                  │                      │  [runs eligibility
    │                  │                      │   in private]
    │                  │                      │
    │                  │◀── verdict only ─────│
    │                  │    APPROVED + $120   │
    │                  │    no medical data   │
    │◀── $120 USDC ────│                      │

  Results:
  ✅  Patient proves eligibility WITHOUT revealing diagnosis
  ✅  Insurer processes the claim WITHOUT seeing raw medical data
  ✅  World ID ensures ONE human = ONE claim (Sybil resistant)
  ✅  Verdict and USDC payout are on-chain and publicly auditable
  ✅  No single operator can forge a verdict (DON consensus)
  ✅  EHR credentials are never in code or logs — Vault DON only
```

### The Key Insight

You don't need to *share* your medical records or identity to *prove* you're eligible for reimbursement. You just need trusted, verifiable computation to check them on your behalf and produce a verdict — without leaking what it found.

Chainlink CRE's TEE is that verifiable computation. World ID is the proof that a real human submitted it.

---

## 3. Why This Works

- Code runs in **hardware-enforced isolation** — the host OS cannot read memory inside the enclave
- Execution is **remotely attestable** — anyone can verify the exact code that ran inside the enclave
- **No single operator** can observe or tamper with the computation, including the CRE node operator

Without a TEE, any oracle solution would either: (a) give a centralized server access to the data, or (b) reveal the data in on-chain calldata/logs.

CRE adds three capabilities on top of a basic TEE:

| CRE Capability | What it provides |
|---|---|
| **ConfidentialHTTPClient** | HTTPS requests execute *inside* the TEE — both the World ID verification and FHIR fetch happen here. Responses are decrypted only inside the enclave. Nothing is visible to external observers, including the node operator. |
| **Vault DON Secrets** | API credentials (e.g., EHR OAuth2 tokens) are stored encrypted in the Vault DON and injected at request time via `{{.secret}}` template syntax. They never appear in code, logs, or process memory. |
| **EVM Log Trigger** | The workflow fires *automatically and instantly* when a `ClaimSubmitted` event is emitted on-chain — no polling, no cron, no manual intervention. |

---

## 4. How It Works — Full Flow

### High-Level Flowchart

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                                                                             │
│  ① SETUP (done once by insurer)                                             │
│                                                                             │
│   Deployer ──▶ PolicyRegistry.registerPolicy()   ──▶ Policy registered     │
│   Deployer ──▶ PolicyRegistry.payPremium()        ──▶ Policy activated      │
│   Deployer ──▶ ClaimSettlement.depositLiquidity() ──▶ $10,000 USDC in pool  │
│                                                                             │
└─────────────────────────────────┬───────────────────────────────────────────┘
                                  │
┌─────────────────────────────────▼───────────────────────────────────────────┐
│                                                                             │
│  ② PRE-SUBMISSION — World ID Proof Generation (client-side, one-time)      │
│                                                                             │
│   1. Claimant visits worldid-gen app (bun worldid-gen/signing-server.ts)   │
│   2. Server signs rp_context with RP private key → IDKit widget shown      │
│   3. World ID Simulator scans QR code → issues ZK proof                    │
│   4. Proof saved to world-id-proof.json:                                   │
│      { nullifier_hash, merkle_root, proof, verification_level }            │
│                                                                             │
│   ⚠ Proofs are single-use. Generate a fresh one before each demo run.      │
│                                                                             │
└─────────────────────────────────┬───────────────────────────────────────────┘
                                  │
┌─────────────────────────────────▼───────────────────────────────────────────┐
│                                                                             │
│  ③ SUBMISSION (claimant triggers the flow)                                  │
│                                                                             │
│   scripts/demo.ts  (or submit-claim.ts)                                    │
│                                                                             │
│   1. Read world-id-proof.json                                               │
│   2. Bundle: { fhirId, nullifier_hash, merkle_root, proof,                 │
│               verification_level }                                          │
│   3. Encrypt bundle with shared secret (XOR cipher)                        │
│      └─ FHIR ID and World ID proof NEVER touch the blockchain in plaintext │
│   4. Call: ClaimRequest.submitClaim(policyId, encryptedPayload)             │
│   5. Emits: ClaimSubmitted(policyId, claimant, bytes encryptedPayload, ts) │
│                                                                             │
└─────────────────────────────────┬───────────────────────────────────────────┘
                                  │  ClaimSubmitted event
                                  ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                                                                             │
│  ④ CRE ENCLAVE (fully private — nothing inside is visible externally)       │
│                                                                             │
│   EVM Log Trigger detects ClaimSubmitted                                   │
│         │                                                                   │
│         ▼                                                                   │
│   ┌───────────────────────────────────────────────────────────────────┐    │
│   │  TEE BOUNDARY — hardware-enforced isolation                       │    │
│   │                                                                    │    │
│   │  Step A: Decrypt payload → extract fhirId + World ID fields       │    │
│   │                                                                    │    │
│   │  Step B: ConfidentialHTTPClient POST → World ID Cloud API         │    │
│   │          → POST /api/v1/verify/{appId}                            │    │
│   │          → Body: { nullifier_hash, merkle_root, proof, action }  │    │
│   │          → Response: { success: true }     ← STAYS IN TEE        │    │
│   │          If fails → DENIED (ReasonCode.UNAUTHORIZED)              │    │
│   │                                                                    │    │
│   │  Step C: ConfidentialHTTPClient GET → FHIR EHR API               │    │
│   │          → GET /baseR4/Claim/{fhirId}                             │    │
│   │          → Auth token injected from Vault DON   ← PRIVATE        │    │
│   │          → Full FHIR response received          ← STAYS IN TEE   │    │
│   │                                                                    │    │
│   │  Step D: evaluateMedicalClaim()                                   │    │
│   │          → ICD-10 "J06.9" — in covered list?   YES   ← PRIVATE   │    │
│   │          → Date "2024-06-10" in 2024 coverage?  YES   ← PRIVATE   │    │
│   │          → Payout: $150 × 80% = $120.00                ← PRIVATE  │    │
│   │                                                                    │    │
│   │  Step E: Compute compliance hash                                  │    │
│   │          complianceHash = keccak256(policyId + status + ts)      │    │
│   │          Non-reversible. Proves verification occurred.            │    │
│   │                                                                    │    │
│   └───────────────┬───────────────────────────────────────────────────┘    │
│                   │                                                         │
│   ONLY THIS EXITS THE ENCLAVE:                                              │
│     { status: "approved", payoutAmount: 120_000000,                        │
│       reasonCode: 0, complianceHash: 0x... }                               │
│                                                                             │
└─────────────────────────────────┬───────────────────────────────────────────┘
                                  │
┌─────────────────────────────────▼───────────────────────────────────────────┐
│                                                                             │
│  ⑤ ON-CHAIN SETTLEMENT (public, verifiable)                                 │
│                                                                             │
│   Enclave wallet calls:                                                     │
│   PolicyRegistry.recordVerdict(policyId, "approved", 120_000000, 0, hash) │
│     └─ gated by: msg.sender == approvedEnclave                              │
│     └─ stores: verdict onchain — no medical data                           │
│                                                                             │
│   ClaimSettlement.executePayout(policyId, claimant, 120_000000)            │
│     └─ USDC.transfer(claimant, 120_000000)                                 │
│     └─ $120.00 lands in claimant's wallet                                  │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘
```

### Step-by-Step Narrative

| Step | Actor | Action | What's Private | What's Public |
|---|---|---|---|---|
| 1 | Insurer | Register policy, pay premium, fund USDC pool | Coverage rules | Policy exists, enclave address |
| 2 | Claimant | Generate World ID ZK proof via worldid-gen app | Proof fields, identity | Nothing |
| 3 | Claimant | Bundle { fhirId + World ID proof }, encrypt, call `submitClaim()` | FHIR ID, proof | policyId, claimant wallet, encrypted blob |
| 4 | CRE TEE | Decrypt bundle, verify World ID via ConfidentialHTTPClient | nullifier, merkle root, proof | Nothing |
| 5 | CRE TEE | Fetch FHIR record via Confidential HTTP | Everything in FHIR response | Nothing |
| 6 | CRE TEE | Run eligibility against covered ICD-10 list | ICD-10 code, date, amount, rules | Nothing |
| 7 | CRE TEE | Write verdict + trigger payout | — | status, payout amount, compliance hash |
| 8 | Chain | USDC transfer to claimant | — | Transfer visible in block explorer |

---

## 5. Architecture

### System Layers

```
┌─────────────────────────────────────────────────────────────────────────┐
│  LAYER 0 — World ID Proof Generation (worldid-gen/)                     │
│  signing-server.ts (rp_context)   src/main.jsx (IDKit widget)           │
└────────────────────────────────┬────────────────────────────────────────┘
                                 │ world-id-proof.json
┌────────────────────────────────▼────────────────────────────────────────┐
│  LAYER 1 — Terminal Scripts (User Interface / Demo)                     │
│  demo.ts   submit-claim.ts   run-enclave.ts   check-verdict.ts          │
└────────────────────────────────┬────────────────────────────────────────┘
                                 │
┌────────────────────────────────▼────────────────────────────────────────┐
│  LAYER 2 — Smart Contracts (Tenderly Virtual Testnet)                   │
│  PolicyRegistry.sol   ClaimRequest.sol   ClaimSettlement.sol            │
└────────────────────────────────┬────────────────────────────────────────┘
                                 │  ClaimSubmitted event
┌────────────────────────────────▼────────────────────────────────────────┐
│  LAYER 3 — CRE Workflow (workflow/main.ts)                              │
│  EVM Log Trigger → decrypt bundle → World ID verify → FHIR fetch       │
└────────────────────────────────┬────────────────────────────────────────┘
                                 │  Confidential HTTP (both APIs)
┌────────────────────────────────▼────────────────────────────────────────┐
│  LAYER 4 — Enclave Logic (enclave/)                                     │
│  types.ts   fetchers/fhir.ts   eligibility/medical.ts   processor.ts   │
└────────────────────────────────┬────────────────────────────────────────┘
                                 │
┌────────────────────────────────▼────────────────────────────────────────┐
│  LAYER 5 — External APIs                                                │
│  World ID Cloud API: developer.worldcoin.org/api/v1/verify              │
│  HAPI FHIR Sandbox:  hapi.fhir.org/baseR4/Claim/131299879              │
└─────────────────────────────────────────────────────────────────────────┘
```

### Component Interaction Map

```
                   ┌──────────────┐
                   │   Deployer   │
                   └──┬───────┬───┘
                      │       │
          registerPolicy()    depositLiquidity()
          payPremium()                │
                      │              │
                      ▼              ▼
          ┌───────────────────┐  ┌───────────────────────┐
          │  PolicyRegistry   │  │   ClaimSettlement      │
          │                   │  │                        │
          │ • stores policies │  │ • holds USDC pool      │
          │ • stores verdicts │  │ • executes payouts     │
          │ • onlyEnclave:    │  │ • onlyEnclave:         │
          │   recordVerdict() │  │   executePayout()      │
          └────────┬──────────┘  └──────────┬─────────────┘
                   │                        │ USDC.transfer()
                   │ reads:                 │
                   │ isEligible()           ▼
                   │ getPolicy()    ┌──────────────────────┐
                   │                │   Claimant Wallet    │
                   ▼                │   receives $120 USDC │
          ┌────────────────────┐    └──────────────────────┘
          │    CRE Enclave     │
          │  Step 1: World ID  │         ┌──────────────────┐
          │  Step 2: FHIR      │         │   ClaimRequest   │
          │  (ConfHTTPClient)  │         │                  │
          └────────┬───────────┘         │ • stateless      │
                   │                     │ • emits events   │
                   │ triggered by        │ • no PII stored  │
                   └─────────────────────│ • bytes payload  │
                          event          └──────────────────┘
```

---

## 6. Smart Contracts

### 6.1 `PolicyRegistry.sol` — The Authority Layer

Stores policies and verdicts. The only contract that holds persistent state about claims.

**What it stores:**

```solidity
struct Policy {
    address owner;           // wallet that registered the policy
    bool premiumPaid;        // false until payPremium() is called
    uint256 coverageStart;   // Unix timestamp
    uint256 coverageEnd;     // Unix timestamp
    uint256 maxPayout;       // USDC 6-decimal cap (e.g. 500_000000 = $500)
    address approvedEnclave; // ONLY this address can call recordVerdict()
    bool active;             // true once premium is paid
}

struct Verdict {
    string status;           // "approved" | "denied" | "escalated"
    uint256 payoutAmount;    // USDC 6-decimal (e.g. 120_000000 = $120)
    uint8 reasonCode;        // 0=APPROVED, 1=NOT_COVERED, 2=OUTSIDE_PERIOD...
    bytes32 complianceHash;  // keccak256(policyId+status+ts) — non-reversible
    uint256 timestamp;       // block.timestamp when verdict was recorded
}
```

**Key design:** `recordVerdict()` is gated by `modifier onlyApprovedEnclave(policyId)`, which requires `msg.sender == policies[policyId].approvedEnclave`. In production CRE, this address is the DON's consensus key — no single party controls it.

### 6.2 `ClaimRequest.sol` — The Privacy Layer

Intentionally the simplest contract in the system. **Zero storage. One function. One event.**

Its only job is to fire the CRE EVM Log Trigger with the encrypted bundle.

```solidity
// What goes onchain (in the ClaimSubmitted event):
policyId          // bytes32 — keccak256("DEMO-001")
claimant          // address — the submitting wallet
encryptedPayload  // bytes   — XOR-encrypted bundle containing:
                  //             { fhirId, nullifier_hash, merkle_root,
                  //               proof, verification_level }
                  //           Only the TEE can decrypt this
timestamp         // uint256 — block.timestamp

// What NEVER goes onchain in plaintext:
// fhir_claim_id  — bundled into encryptedPayload, XOR-encrypted
// nullifier_hash — bundled into encryptedPayload, XOR-encrypted
// merkle_root    — bundled into encryptedPayload, XOR-encrypted
// ZK proof       — bundled into encryptedPayload, XOR-encrypted
// diagnosis, treatment date, billed amount — never onchain
```

> **Why `bytes` and not `bytes32`?** The World ID proof alone is hundreds of bytes. A fixed `bytes32` hash would let the enclave verify it but lose the proof data needed for the World ID Cloud API. Using variable-length `bytes` lets the TEE receive the full proof and verify it via ConfidentialHTTPClient.

> **Why stateless?** If ClaimRequest stored anything — even a mapping of who submitted what — it would create a linkability risk. Storing nothing makes it a pure event bus with no information leakage.

### 6.3 `ClaimSettlement.sol` — The Liquidity Layer

Holds the insurer's USDC pool and releases it when the enclave approves a claim.

```
USDC Pool Flow:

  Insurer ──▶ USDC.approve(claimSettlement, 10_000_000000)
           ──▶ depositLiquidity(10_000_000000)  ← $10,000 USDC

  Enclave ──▶ executePayout(policyId, claimant, 120_000000)
           └─ USDC.transfer(claimant, 120_000000)  ← $120.00 to claimant
```

Only `approvedEnclave` can call `executePayout()` and `recordDenial()`. The insurer funds the pool but cannot directly trigger payouts — only the verified enclave can.

---

## 7. CRE Workflow & Enclave Logic

### 7.1 EVM Log Trigger — Event-Driven, Not Polling

```
Traditional oracle approach:      CRE EVM Log Trigger:
  polls every N seconds            reacts instantly
  introduces latency               zero delay
  wastes computation               fires exactly once per event
  misses events if down            fault-tolerant DON network
```

`workflow/main.ts` creates a trigger that watches `ClaimRequest` for `ClaimSubmitted`:

```typescript
const logTrigger = evmClient.logTrigger({
  addresses: [hexToBase64(config.claimRequestAddress)],
  topics: [{
    // keccak256("ClaimSubmitted(bytes32,address,bytes,uint256)")
    values: [topicToBase64(config.claimSubmittedEventSignature)],
  }],
})

return [handler(logTrigger, onClaimSubmitted)]
```

The moment a claim is submitted on-chain, the CRE DON fires `onClaimSubmitted()` inside the TEE.

### 7.2 Two ConfidentialHTTPClient Calls Inside the TEE

Both API calls execute inside the TEE — no external observer can see the request bodies, response contents, or the decision logic applied to them.

```
TEE BOUNDARY ─────────────────────────────────────────────────────────────────

  1. Decrypt payload (ABI decode log.data → XOR decrypt → JSON.parse)
     → fhirId, nullifier_hash, merkle_root, proof, verification_level

  2. World ID Cloud API (ConfidentialHTTPClient):
     POST https://developer.worldcoin.org/api/v1/verify/{appId}
     Body: { nullifier_hash, merkle_root, proof, action, signal: "" }
     ← { success: true }   if valid, unused nullifier for this action
     ← { code: "..." }     if invalid or already used → DENIED

  3. FHIR EHR API (ConfidentialHTTPClient):
     GET https://hapi.fhir.org/baseR4/Claim/{fhirId}
     Authorization: Bearer {{.ehrAuthToken}}  ← injected from Vault DON
     ← Full FHIR R4 Claim resource → processed inside TEE, discarded

  4. evaluateMedicalClaim() → verdict

─────────────────────────────────────────────────────────────────── TEE BOUNDARY
ONLY THIS EXITS: { status, payoutAmount, reasonCode, complianceHash }
```

### 7.3 World ID — Sybil Resistance Inside the TEE

World ID ensures that each real human can only submit one claim per action. The ZK proof is verified inside the TEE — not client-side, not in the smart contract.

```
Why inside the TEE (not client-side)?

  Client-side check:               TEE check (ClaimShield):
  ─────────────────                ───────────────────────
  Anyone can bypass by             Cannot bypass — the smart contract
  calling submitClaim()            only emits the encrypted bundle.
  directly without a proof.        The enclave decrypts and verifies
                                   before any verdict is written.

Why not in the smart contract?

  On-chain check:                  TEE check (ClaimShield):
  ──────────────                   ───────────────────────
  Would expose nullifier_hash      Proof fields are inside the
  and merkle_root in calldata.     encrypted payload — only the
  Observer could link submissions  enclave can see them.
  to identities over time.
```

**Proof lifecycle:**

1. Claimant generates ZK proof using World ID Simulator (`worldid-gen` app)
2. Proof is bundled with FHIR ID → encrypted → submitted as opaque bytes onchain
3. Enclave decrypts → extracts proof → calls World ID Cloud API via ConfidentialHTTPClient
4. API returns `{ success: true }` → enclave proceeds to FHIR step
5. Nullifier is now consumed — the same proof cannot be reused for this action

### 7.4 Eligibility Engine — `enclave/eligibility/medical.ts`

The rules that determine claim approval are **private**. They live inside the enclave binary and are never published on-chain.

```
Private inputs (stay inside TEE):         Public outputs (written onchain):
─────────────────────────────────         ─────────────────────────────────
COVERED_ICD10_CODES (10 codes)     ──▶   status: "approved"
REIMBURSEMENT_RATE: 80%            ──▶   payoutAmount: 120_000000
MAX_PAYOUT_USD: $500               ──▶   reasonCode: 0

ICD-10 code from FHIR: "J06.9"    ──▶   (NEVER written onchain)
Treatment date: "2024-06-10"      ──▶   (NEVER written onchain)
Billed amount: $150.00            ──▶   (NEVER written onchain)
```

**Payout calculation for the demo:**

```
billedAmount ($150.00)
    × REIMBURSEMENT_RATE (0.80)
    = rawPayout ($120.00)
    → min($120.00, $500.00) = cappedPayout ($120.00)
    × 1_000_000 (USDC 6-decimal conversion)
    = 120_000_000 (payoutAmount written onchain)
```

### 7.5 Reason Codes — Privacy-Preserving Denial Notices

When a claim is denied, only a numeric code is written onchain — not the reason text. This prevents inference of medical information from denials.

| Code | Meaning |
|------|---------|
| `0` | APPROVED |
| `1` | NOT_COVERED — ICD-10 code not in the insurer's covered list |
| `2` | OUTSIDE_PERIOD — treatment date outside the coverage window |
| `3` | DUPLICATE — this policy has already been claimed |
| `4` | POLICY_INACTIVE — premium not paid |
| `5` | UNAUTHORIZED — World ID proof invalid, already used, or wallet mismatch |
| `6` | API_ERROR — FHIR fetch failed or returned unexpected data |
| `7` | ESCALATED — edge case requiring human review |

An observer can see that a claim was denied with code `5` but **cannot determine why** — they can't see the proof, the nullifier, or whether the human had already claimed.

---

## 8. Privacy Model — Three Layers

### Layer 1 — Input Privacy (before submission)

```
Client-side:
  fhir_claim_id = "131299879"
  World ID proof = { nullifier_hash: 0x2dff..., merkle_root: 0x...,
                     proof: 0x..., verification_level: "orb" }
        │
        ▼
  bundle = JSON({ fhirId, nullifier_hash, merkle_root, proof, verification_level })
        │
        ▼
  encryptedPayload = XOR(bundle, sharedSecret)  ← 743-byte ciphertext
        │
        ▼ only this goes onchain ──▶ ClaimSubmitted(policyId, claimant, encryptedPayload, ts)

An observer sees: "743 bytes of ciphertext were submitted for policy 0x2df8..."
They CANNOT determine the FHIR ID or reconstruct the World ID proof.
```

**Production encryption:** In a full deployment, asymmetric encryption to the DON's public key would replace the XOR cipher — only the TEE could decrypt. The XOR demo cipher serves the same architectural purpose with a simpler key management story.

### Layer 2 — Processing Privacy (inside the TEE)

Nothing that happens inside the enclave is observable:

- The decrypted FHIR ID and the FHIR API call
- The World ID proof verification response
- The ICD-10 code matched against the covered list
- The reimbursement rate and payout cap applied
- The EHR API credentials (injected from Vault DON, never in code)

> CRE node operators run the enclave but **cannot observe its internals** — that is the hardware guarantee of a TEE.

### Layer 3 — Output Privacy (on-chain verdict)

Only a minimal, non-reversible verdict exits the enclave:

```
onchain verdict:
  status          → "approved"          ← outcome only
  payoutAmount    → 120_000000          ← USDC amount, not the billed amount
  reasonCode      → 0                   ← numeric, not textual explanation
  complianceHash  → 0x...              ← keccak256(policyId+status+ts)
                                          proves verification happened
                                          cannot be reversed to recover any field
```

**What you can verify from the blockchain alone:**

- ✅ A valid policy existed and was active at claim time
- ✅ An approved enclave produced the verdict
- ✅ The verdict was either `approved`, `denied`, or `escalated`
- ✅ A specific USDC amount was paid (or nothing was paid on denial)
- ✅ Verification occurred (compliance hash as a non-reversible proof)

**What you cannot determine from the blockchain:**

- 🔒 The patient's diagnosis or ICD-10 code
- 🔒 The World ID nullifier (Sybil resistance without identity exposure)
- 🔒 The treatment date or provider
- 🔒 The billed amount
- 🔒 Which specific condition was not covered (on denial)
- 🔒 The insurer's covered conditions list or reimbursement rate

---

## 9. Access Control & Security

### Who Can Call What

| Function | Caller | Guard |
|---|---|---|
| `registerPolicy()` | Anyone | — |
| `payPremium()` | Policy owner only | `msg.sender == policy.owner` |
| `recordVerdict()` | Approved enclave only | `msg.sender == approvedEnclave` |
| `getPolicy()` / `getVerdict()` | Anyone (view) | — |
| `submitClaim()` | Anyone | — |
| `depositLiquidity()` | Anyone with USDC | — |
| `executePayout()` | Approved enclave only | `msg.sender == approvedEnclave` |
| `recordDenial()` | Approved enclave only | `msg.sender == approvedEnclave` |
| `setApprovedEnclave()` | Contract owner only | `msg.sender == owner` |

### Attack Scenarios & Mitigations

| Attack | Mitigation |
|---|---|
| Attacker calls `submitClaim()` without a World ID proof | Enclave decrypts bundle, calls World ID API → rejects missing/invalid proof → DENIED (code 5) |
| Same human submits two claims (Sybil) | World ID nullifier is single-use per action — second verification returns error → DENIED (code 5) |
| Attacker forges a verdict | Reverts: `msg.sender != approvedEnclave` |
| Attacker drains the USDC pool | Reverts: `msg.sender != approvedEnclave` |
| Same claim submitted twice | Reverts: `claimProcessed[policyId] == true` |
| Enclave pays more than policy allows | Reverts: `payoutAmount > maxPayout` |
| Claim on inactive policy | Reverts: `!policy.active` |
| Pool runs out of USDC | Reverts: `poolBalance < amount` |

### The Enclave Address in Production

In the demo, `ENCLAVE_WALLET_ADDRESS` is a raw private key wallet. In a real CRE deployment, this is the **DON's collective consensus key** — distributed across all CRE nodes so that:

1. No single operator can forge a verdict
2. The workflow result requires consensus across all nodes
3. The enclave code is publicly auditable and attestable

This is why registering an `approvedEnclave` address per policy is the correct security architecture — when that address is the DON key, the trust model is fully decentralized.

---

## 10. Project Structure

```
claimshield/
│
├── worldid-gen/                    World ID Proof Generator
│   ├── signing-server.ts           Bun server: signs rp_context with RP private key
│   ├── src/main.jsx                React frontend: IDKit widget, QR code flow
│   ├── vite.config.js              WASM-safe Vite config (excludes idkit-core from pre-bundling)
│   └── package.json
│
├── src/                            Smart Contracts
│   ├── PolicyRegistry.sol          Stores policies & verdicts. Authority layer.
│   ├── ClaimRequest.sol            Stateless event emitter. Privacy layer. (bytes payload)
│   └── ClaimSettlement.sol         USDC pool. Payout executor.
│
├── test/                           Foundry Tests (34 total)
│   ├── PolicyRegistry.t.sol         17 tests
│   ├── ClaimRequest.t.sol            4 tests
│   └── ClaimSettlement.t.sol        13 tests
│
├── script/                         Foundry Scripts
│   ├── Deploy.s.sol                Deploys all 3 contracts
│   └── Seed.s.sol                  Registers DEMO-001 through DEMO-005, funds USDC pool
│
├── workflow/                       CRE Workflow (Production)
│   ├── main.ts                     EVM Log Trigger → decrypt → World ID → FHIR → verdict
│   ├── workflow.yaml               Staging / production targets
│   └── config.staging.json         Contract addresses + worldIdAppId/worldIdAction
│
├── enclave/                        Enclave Logic (runs in both CRE TEE & local sim)
│   ├── types.ts                    TypeScript types (ClaimPayload, Verdict, etc.)
│   ├── crypto.ts                   encryptPayload / decryptPayload (XOR cipher)
│   ├── processor.ts                Local simulation: World ID verify + FHIR + verdict
│   ├── fetchers/fhir.ts            Fetches live FHIR record
│   └── eligibility/medical.ts      ICD-10 eligibility + payout calculation
│
├── scripts/                        Terminal Demo Scripts
│   ├── demo.ts                     Full interactive demo (all phases)
│   ├── submit-claim.ts             Submit encrypted claim onchain (standalone)
│   ├── run-enclave.ts              Simulate enclave locally (shows private data)
│   └── check-verdict.ts            Read verdict + print privacy panel
│
├── world-id-proof.example.json     Proof shape reference (do not commit real proofs)
├── secrets.yaml                    Vault DON secrets config
├── project.yaml                    CRE project settings
├── .env.example                    All required env vars documented
├── foundry.toml
├── tsconfig.json
└── package.json
```

---

## 11. Running the Demo

### Prerequisites

- [Foundry](https://getfoundry.sh/) — `forge`, `cast`
- [Bun](https://bun.sh/) — `bun`
- A [Tenderly](https://dashboard.tenderly.co/) account with a **Virtual Testnet forking Base mainnet**
- Two wallets: **deployer** (needs ETH + USDC on the virtual testnet) and **enclave signer** (needs ETH only)

---

### Step 0 — Install & Configure

```bash
# Install TypeScript dependencies
bun install

# Copy environment template
cp .env.example .env
```

Fill in `.env`:

| Variable | Description |
|---|---|
| `TENDERLY_RPC_URL` | Your Tenderly Virtual Testnet RPC URL |
| `DEPLOYER_PRIVATE_KEY` | Wallet that deploys contracts and seeds data |
| `ENCLAVE_PRIVATE_KEY` | Separate wallet — the approved enclave signer |
| `ENCLAVE_WALLET_ADDRESS` | Public address of the enclave wallet |
| `CLAIMANT_WALLET` | For demo: can be the same as deployer address |

Fund wallets via the Tenderly dashboard:

- Deployer: ETH (gas) + USDC at `0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913` (Base USDC)
- Enclave signer: ETH (gas only)

---

### Step 0b — Set Up World ID (required before submitting claims)

ClaimShield verifies claimant identity via World ID **inside the TEE** — not client-side, not in the smart contract. The ZK proof travels encrypted onchain and is only decrypted and verified by the enclave via `ConfidentialHTTPClient`. This ensures no bot or attacker can bypass it by calling `submitClaim()` directly.

**One-time setup:**

1. Go to [https://developer.worldcoin.org/](https://developer.worldcoin.org/) and create a new app.
2. Set the environment to **Staging**.
3. Create an **Action** named exactly: `submit-claim`
4. Under **Relying Party**, copy your `rp_id` and generate a signing key.
5. Fill in `.env`:

   ```bash
   WORLD_ID_APP_ID=app_staging_xxxxxxxxxxxxxxxx
   WORLD_ID_ACTION=submit-claim
   RP_ID=rp_xxxxxxxxxxxxxxxx
   RP_SIGNING_KEY=0x...   # 32-byte hex from Developer Portal
   ```

**Before each demo run — generate a fresh World ID proof:**

World ID proofs are single-use. Generate one before each demo:

```bash
# Terminal 1 — start the RP signing server (signs rp_context for IDKit v4)
bun --env-file .env worldid-gen/signing-server.ts

# Terminal 2 — start the proof generator UI
cd worldid-gen && bun run dev
```

Then open `http://localhost:4567` in your browser:

1. Click **"Verify with World ID Simulator"** — a QR code appears
2. Open the [World ID Simulator](https://simulator.worldcoin.org/), scan the QR
3. Click Approve in the simulator
4. The proof JSON appears in the browser — copy it and save to `claimshield/world-id-proof.json`:

   ```json
   {
     "merkle_root": "0x...",
     "nullifier_hash": "0x...",
     "proof": "0x...",
     "verification_level": "orb"
   }
   ```

> The `world-id-proof.json` file is gitignored — never commit it. See `world-id-proof.example.json` for the shape.

---

### Step 1 — Deploy Contracts

```bash
forge script script/Deploy.s.sol \
  --rpc-url $TENDERLY_RPC_URL \
  --broadcast -vvv
```

Copy the three deployed addresses into `.env` **and** `workflow/config.staging.json`.

> **Note:** Verify the addresses are correct by checking bytecode sizes:
> - ClaimRequest should be ~526 bytes (smallest — only one function)
> - PolicyRegistry ~4333 bytes
> - ClaimSettlement ~2449 bytes

---

### Step 2 — Seed the Demo State

```bash
forge script script/Seed.s.sol \
  --rpc-url $TENDERLY_RPC_URL \
  --broadcast -vvv
```

This registers policies **DEMO-001** through **DEMO-005** (each claimable once) and deposits $10,000 USDC into the settlement pool.

If Seed fails mid-run because policies already exist, fund the pool manually:

```bash
# Set $10,000 USDC balance via Tenderly admin RPC
curl -X POST $TENDERLY_RPC_URL -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","method":"tenderly_setErc20Balance","params":["0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913","<DEPLOYER_ADDR>","0x2540BE400"],"id":1}'

# Approve + deposit
cast send 0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913 \
  "approve(address,uint256)" $CLAIM_SETTLEMENT_ADDRESS 10000000000 \
  --private-key $DEPLOYER_PRIVATE_KEY --rpc-url $TENDERLY_RPC_URL

cast send $CLAIM_SETTLEMENT_ADDRESS \
  "depositLiquidity(uint256)" 10000000000 \
  --private-key $DEPLOYER_PRIVATE_KEY --rpc-url $TENDERLY_RPC_URL
```

---

### Step 3 — Show the Raw FHIR Data (before privacy)

Demonstrate everything that would be exposed in a traditional system — and prove that *none of it* will appear on-chain:

```bash
curl -s https://hapi.fhir.org/baseR4/Claim/131299879 | python3 -m json.tool
```

Look for:

- `"code": "J06.9"` — ICD-10 diagnosis
- `"start": "2024-06-10"` — treatment date
- `"value": 150.00` — billed amount
- Patient references, provider details

**None of this will appear in any transaction.**

---

### Step 4 — Run the Interactive Demo

```bash
bun scripts/demo.ts
```

The demo runs four phases automatically:

```
Phase 1 — FHIR Preview
  Fetches live medical record. Shows what the enclave will see.
  None of this appears onchain.

Phase 2 — Submit Claim Onchain
  Bundles FHIR ID + World ID proof into a single encrypted payload.
  Submits as opaque bytes. Only the enclave can decrypt.

Phase 3 — Enclave Processing (Simulated CRE TEE)
  [TEE] Step 0: Decrypts the bundle from the onchain event
  [TEE] Step 1: Calls World ID Cloud API — shows real API request + response
        → POST https://developer.worldcoin.org/api/v1/verify/app_...
        ← { success: true, uses: 1, ... }
  [TEE] Step 2: Fetches live FHIR record via ConfidentialHTTPClient
  [TEE] Step 3: Runs eligibility — ICD-10, date, payout
  [TEE] Step 4: Writes verdict + executes payout

Phase 4 — Verdict
  Reads verdict from chain.
  Shows what IS onchain vs what NEVER left the enclave.
```

> Each policy (DEMO-001 through DEMO-005) can only be claimed once. After DEMO-001, use DEMO-002 for the next run.

---

### Step 5 — Verify the USDC Payout

```bash
cast call 0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913 \
  "balanceOf(address)(uint256)" $CLAIMANT_WALLET \
  --rpc-url $TENDERLY_RPC_URL
# Expected: 120000000  (= $120.00 USDC)
```

---

### Running Tests

```bash
# Foundry unit tests (34 tests)
forge test -vv

# TypeScript compilation check
bunx tsc --noEmit

# CRE workflow simulation (requires CRE CLI)
cre workflow simulate ./workflow --target=staging-settings
```

---

## 12. Demo Reference Data

| Field | Value |
|---|---|
| **Policy IDs** | `DEMO-001` through `DEMO-005` (use sequentially — one claim each) |
| **Coverage Period** | 2024-01-01 to 2024-12-31 |
| **FHIR Claim ID** | `131299879` |
| **FHIR Sandbox URL** | `https://hapi.fhir.org/baseR4/Claim/131299879` |
| **ICD-10 Diagnosis** | `J06.9` — Acute upper respiratory infection |
| **Treatment Date** | `2024-06-10` (within coverage period ✅) |
| **Billed Amount** | `$150.00 USD` |
| **Reimbursement Rate** | `80%` (private — computed inside TEE) |
| **Expected Payout** | `$120.00 USDC` = `120_000000` (6 decimals) |
| **World ID Action** | `submit-claim` (must match Developer Portal exactly) |
| **World ID API** | `https://developer.worldcoin.org/api/v1/verify/{appId}` |
| **USDC Contract (Base)** | `0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913` |

---

### What's Real vs. Simulated

| Component | Demo | Production CRE |
|---|---|---|
| World ID proof generation | Real World ID Simulator + real ZK proof | Same |
| World ID verification | Real Cloud API call via `fetch()` (simulation) | `ConfidentialHTTPClient` inside TEE |
| FHIR data | Real live HAPI FHIR sandbox | Same (production EHR with Vault DON auth) |
| Encryption | XOR cipher with shared secret | Asymmetric encryption to DON public key |
| Enclave execution | Local Node.js with visible logs | Hardware TEE — logs stay inside enclave |
| Onchain writes | Real ethers.js wallet (`ENCLAVE_PRIVATE_KEY`) | DON consensus key |
| Smart contracts | Real Solidity on Tenderly Virtual Testnet | Same contracts on target chain |

*For the full technical deep-dive including detailed sequence diagrams, per-function call traces, and the complete privacy threat model, see [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md).*
