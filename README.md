# ClaimShield

> *"The insurer approved a medical claim — verified against live patient records — without ever seeing the diagnosis, the treatment date, or the billed amount."*

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
  This traditional method forces the patient to surrender all of their sensitive medical data to a third-party insurer, creating a honeypot of private health records on centralized servers. Furthermore, the process lacks transparency and accountability—patients are forced to blindly trust the insurer's eligibility rules and operators, with no on-chain audit trail to verify how claims or settlements are handled.
```

**The core tension:** To get paid, the patient must reveal private health data. There is currently no way to prove eligibility *without* exposure.

Solving this problem is ClaimShield — a privacy-preserving insurance claims processor that verifies eligibility against live electronic health records (EHR) *without* exposing the underlying medical data. It shifts the paradigm from "share data to prove eligibility" to "run trusted code to prove eligibility," ensuring the insurer process claims trustlessly while keeping patient records strictly confidential.

Here's how it works: A patient receives medical treatment and their healthcare provider logs the details in an Electronic Health Record (EHR) system, generating a unique FHIR claim ID. The patient comes to ClaimShield and submits a claim by providing their policy ID and the FHIR claim ID. A unique hash of this information is sent on-chain, triggering the ClaimShield enclave. The enclave securely connects to the live EHR system, retrieves the patient's medical data, and evaluates it against the policy's covered conditions and limits. Once verified, the enclave securely records an "Approved" or "Denied" verdict on-chain and triggers an automatic USDC payout to the patient's wallet, all without ever exposing the sensitive medical diagnosis.

---

## 2. The Solution

```
CLAIMSHIELD — Privacy-Preserving Claims

  Patient         Blockchain          CRE Enclave (TEE)        FHIR API
    │                  │                      │                    │
    │── hash only ────▶│                      │                    │
    │   (no PII)       │── event triggers ───▶│                    │
    │                  │                      │── confidential ───▶│
    │                  │                      │   HTTP fetch       │
    │                  │                      │◀── full record ────│
    │                  │                      │   (stays in TEE)   │
    │                  │                      │                    │
    │                  │                      │  [runs eligibility
    │                  │                      │   in private]
    │                  │                      │
    │                  │◀── verdict only ─────│
    │                  │    APPROVED + $120    │
    │                  │    no diagnosis data  │
    │◀── $120 USDC ────│                      │
    
  Results:
  ✅  Patient proves eligibility WITHOUT revealing diagnosis
  ✅  Insurer processes the claim WITHOUT seeing raw medical data
  ✅  Verdict and USDC payout are on-chain and publicly auditable
  ✅  No single operator can forge a verdict (DON consensus)
  ✅  EHR credentials are never in code or logs — Vault DON only
```

### The Key Insight

You don't need to *share* your medical records to *prove* you're eligible for reimbursement. You just need a trusted, verifiable computation to check them on your behalf and produce a verdict — without leaking what it found.

Chainlink CRE's TEE is that verifiable computation.

---

## 3. Why This Works

- Code runs in **hardware-enforced isolation** — the host OS cannot read memory inside the enclave
- Execution is **remotely attestable** — anyone can verify the exact code that ran inside the enclave
- **No single operator** can observe or tamper with the computation, including the CRE node operator

Without a TEE, any oracle solution would either: (a) give a centralized server access to the data, or (b) reveal the data in on-chain calldata/logs.

CRE adds three capabilities on top of a basic TEE:

| CRE Capability | What it provides |
|---|---|
| **ConfidentialHTTPClient** | HTTPS requests execute *inside* the TEE — the response body is decrypted only inside the enclave. Nothing is visible to external observers, including the node operator. |
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
│   Deployer ──▶ PolicyRegistry.registerPolicy()  ──▶ Policy registered      │
│   Deployer ──▶ PolicyRegistry.payPremium()       ──▶ Policy activated       │
│   Deployer ──▶ ClaimSettlement.depositLiquidity() ──▶ $10,000 USDC in pool  │
│                                                                             │
└─────────────────────────────────┬───────────────────────────────────────────┘
                                  │
┌─────────────────────────────────▼───────────────────────────────────────────┐
│                                                                             │
│  ② SUBMISSION (claimant triggers the flow)                                  │
│                                                                             │
│   scripts/submit-claim.ts                                                  │
│                                                                             │
│   1. Build payload: { policy_id, wallet, fhir_claim_id }                   │
│   2. Hash it:  encryptedPayloadHash = keccak256(payload)                   │
│      └─ fhir_claim_id "131299879" NEVER touches the blockchain             │
│   3. Call:  ClaimRequest.submitClaim(policyId, encryptedPayloadHash)       │
│   4. Emits: ClaimSubmitted(policyId, claimant, hash, timestamp)            │
│                                                                             │
└─────────────────────────────────┬───────────────────────────────────────────┘
                                  │  ClaimSubmitted event
                                  ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                                                                             │
│  ③ CRE ENCLAVE (fully private — nothing inside is visible externally)       │
│                                                                             │
│   EVM Log Trigger detects ClaimSubmitted                                   │
│         │                                                                   │
│         ▼                                                                   │
│   ┌───────────────────────────────────────────────────────────────────┐    │
│   │  TEE BOUNDARY — hardware-enforced isolation                       │    │
│   │                                                                    │    │
│   │  Step A: Read policy from PolicyRegistry (on-chain read)          │    │
│   │          → verify active, premium paid, not duplicate             │    │
│   │                                                                    │    │
│   │  Step B: ConfidentialHTTPClient.sendRequest()                     │    │
│   │          → GET https://hapi.fhir.org/baseR4/Claim/131299879      │    │
│   │          → Auth token injected from Vault DON   ← PRIVATE        │    │
│   │          → Full FHIR response received          ← STAYS IN TEE   │    │
│   │                                                                    │    │
│   │  Step C: evaluateMedicalClaim()                                   │    │
│   │          → ICD-10 "J06.9" — in covered list?   YES   ← PRIVATE   │    │
│   │          → Date "2024-06-10" in 2024 coverage?  YES   ← PRIVATE   │    │
│   │          → Payout: $150 × 80% = $120.00                ← PRIVATE  │    │
│   │                                                                    │    │
│   │  Step D: Compute compliance hash                                  │    │
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
│  ④ ON-CHAIN SETTLEMENT (public, verifiable)                                 │
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
| 2 | Claimant | Call `submitClaim(policyId, hash)` | FHIR ID, diagnosis | policyId, claimant wallet, hash |
| 3 | CRE TEE | Fetch FHIR record via Confidential HTTP | Everything in FHIR response | Nothing |
| 4 | CRE TEE | Run eligibility against covered ICD-10 list | ICD-10 code, date, amount, rules | Nothing |
| 5 | CRE TEE | Write verdict + trigger payout | — | status, payout amount, compliance hash |
| 6 | Chain | USDC transfer to claimant | — | Transfer visible in block explorer |

---

## 5. Architecture

### System Layers

```
┌─────────────────────────────────────────────────────────────────────────┐
│  LAYER 1 — Terminal Scripts (User Interface / Demo)                     │
│  submit-claim.ts   run-enclave.ts   check-verdict.ts                    │
└────────────────────────────────┬────────────────────────────────────────┘
                                 │
┌────────────────────────────────▼────────────────────────────────────────┐
│  LAYER 2 — Smart Contracts (Tenderly Virtual Testnet)                   │
│  PolicyRegistry.sol   ClaimRequest.sol   ClaimSettlement.sol            │
└────────────────────────────────┬────────────────────────────────────────┘
                                 │  ClaimSubmitted event
┌────────────────────────────────▼────────────────────────────────────────┐
│  LAYER 3 — CRE Workflow (workflow/main.ts)                              │
│  EVM Log Trigger → ConfidentialHTTPClient → onClaimSubmitted()          │
└────────────────────────────────┬────────────────────────────────────────┘
                                 │  Confidential HTTP
┌────────────────────────────────▼────────────────────────────────────────┐
│  LAYER 4 — Enclave Logic (enclave/)                                     │
│  types.ts   fetchers/fhir.ts   eligibility/medical.ts   processor.ts   │
└────────────────────────────────┬────────────────────────────────────────┘
                                 │
┌────────────────────────────────▼────────────────────────────────────────┐
│  LAYER 5 — External Healthcare API                                      │
│  HAPI FHIR Sandbox: hapi.fhir.org/baseR4/Claim/131299879               │
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
          │  (calls both       │
          │   contracts above) │         ┌──────────────────┐
          └────────┬───────────┘         │   ClaimRequest   │
                   │                     │                  │
                   │ triggered by        │ • stateless      │
                   └─────────────────────│ • emits events   │
                          event          │ • no PII stored  │
                                         └──────────────────┘
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

Its only job is to fire the CRE EVM Log Trigger.

```solidity
// What goes onchain (in the ClaimSubmitted event):
policyId             // bytes32 — keccak256("DEMO-001")
claimant             // address — the submitting wallet
encryptedPayloadHash // bytes32 — keccak256 of the payload, NOT the payload itself
timestamp            // uint256 — block.timestamp

// What NEVER goes onchain:
// fhir_claim_id "131299879" — never in calldata, never in logs
// diagnosis, treatment date, billed amount — never anywhere onchain
```

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
    // keccak256("ClaimSubmitted(bytes32,address,bytes32,uint256)")
    values: [topicToBase64(config.claimSubmittedEventSignature)],
  }],
})

return [handler(logTrigger, onClaimSubmitted)]
```

The moment a claim is submitted on-chain, the CRE DON fires `onClaimSubmitted()` inside the TEE.

### 7.2 ConfidentialHTTPClient — The Core Privacy Primitive

This is what makes ClaimShield possible. The FHIR API call lives *inside* the TEE:

```
Standard HTTP (no privacy):
  Node.js ── GET /Claim/131299879 ──▶ FHIR API
    ↑ response visible in logs,             │
      network traces, process memory  ◀─────┘
  
  
Confidential HTTP (CRE TEE):
  ┌──────────────────── TEE BOUNDARY ────────────────────────────────┐
  │                                                                   │
  │  handler ──▶ confHTTP.sendRequest(runtime, {                     │
  │                request: {                                         │
  │                  url: "https://hapi.fhir.org/baseR4/Claim/...", │
  │                  headers: {                                       │
  │                    Accept: "application/fhir+json",              │
  │                    // PRODUCTION:                                 │
  │                    // Authorization: "Bearer {{.ehrAuthToken}}"  │
  │                    //   ↑ injected from Vault DON at runtime     │
  │                    //     never in code, logs, or env vars       │
  │                  }                                                │
  │                }                                                  │
  │              })                                                   │
  │                                                                   │
  │         ┌── HTTP call executes inside enclave ──▶ FHIR API ──┐  │
  │         │                                                      │  │
  │         └── Full FHIR response ◀────────────────────────────-─┘  │
  │              decrypted only inside this enclave                   │
  │                                                                   │
  │  evaluateMedicalClaim(fhirRecord, ...) ← runs privately here      │
  │                                                                   │
  └───────────────────────┬───────────────────────────────────────────┘
                          │
     ONLY THIS EXITS: { status, payoutAmount, reasonCode, complianceHash }
```

### 7.3 Eligibility Engine — `enclave/eligibility/medical.ts`

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

### 7.4 Reason Codes — Privacy-Preserving Denial Notices

When a claim is denied, only a numeric code is written onchain — not the reason text. This prevents inference of medical information from denials.

| Code | Meaning |
|------|---------|
| `0` | APPROVED |
| `1` | NOT_COVERED — ICD-10 code not in the insurer's covered list |
| `2` | OUTSIDE_PERIOD — treatment date outside the coverage window |
| `3` | DUPLICATE — this policy has already been claimed |
| `4` | POLICY_INACTIVE — premium not paid |
| `5` | UNAUTHORIZED — submitting wallet doesn't match policy owner |
| `6` | API_ERROR — FHIR fetch failed or returned unexpected data |
| `7` | ESCALATED — edge case requiring human review |

An observer can see that a claim was denied with code `1` but **cannot determine which ICD-10 code was rejected** — that information never left the enclave.

---

## 8. Privacy Model — Three Layers

### Layer 1 — Input Privacy (before submission)

```
Client-side:
  fhir_claim_id = "131299879"
        │
        ▼
  payload = JSON({ policy_id, wallet, fhir_claim_id })
        │
        ▼
  hash = keccak256(payload)
        │
        ▼ only this goes onchain ──▶ ClaimSubmitted event

An observer sees: "some hash was submitted for policy 0x2df8..."
They CANNOT determine the FHIR ID from the hash.
```

**Production enhancement:** In a full deployment, the payload would be asymmetrically encrypted to the enclave's public key before hashing — meaning only the CRE enclave can decrypt and obtain the FHIR ID. The demo uses `keccak256` as a simplified stand-in.

### Layer 2 — Processing Privacy (inside the TEE)

Nothing that happens inside the enclave is observable:

- The FHIR API call and its response
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
├── src/                            Smart Contracts
│   ├── PolicyRegistry.sol          Stores policies & verdicts. Authority layer.
│   ├── ClaimRequest.sol            Stateless event emitter. Privacy layer.
│   └── ClaimSettlement.sol         USDC pool. Payout executor.
│
├── test/                           Foundry Tests (34 total)
│   ├── PolicyRegistry.t.sol         17 tests
│   ├── ClaimRequest.t.sol            4 tests
│   └── ClaimSettlement.t.sol        13 tests
│
├── script/                         Foundry Scripts
│   ├── Deploy.s.sol                Deploys all 3 contracts
│   └── Seed.s.sol                  Registers DEMO-001 policy, funds USDC pool
│
├── workflow/                       CRE Workflow (Production)
│   ├── main.ts                     EVM Log Trigger + ConfidentialHTTPClient
│   ├── workflow.yaml               Staging / production targets
│   └── config.staging.json         Contract addresses (fill after deploy)
│
├── enclave/                        Enclave Logic (runs in both CRE TEE & local sim)
│   ├── types.ts                    TypeScript types (ClaimPayload, Verdict, etc.)
│   ├── processor.ts                Local simulation orchestrator (ethers.js)
│   ├── fetchers/fhir.ts            Fetches live FHIR record
│   └── eligibility/medical.ts      ICD-10 eligibility + payout calculation
│
├── scripts/                        Terminal Demo Scripts
│   ├── submit-claim.ts             Submit claim hash onchain
│   ├── run-enclave.ts              Simulate enclave locally (shows private data)
│   └── check-verdict.ts            Read verdict + print privacy panel
│
├── docs/
│   └── ARCHITECTURE.md             Full 900-line technical deep-dive
│
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
- Node.js ≥ 18 with `npm` and `ts-node`
- A [Tenderly](https://dashboard.tenderly.co/) account with a **Virtual Testnet forking mainnet**
- Two wallets: **deployer** (needs ETH + USDC on the virtual testnet) and **enclave signer** (needs ETH only)

---

### Step 0 — Install & Configure

```bash
# Install TypeScript dependencies
npm install

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

- Deployer: ETH (gas) + USDC at `0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48`
- Enclave signer: ETH (gas only)

---

### Step 1 — Deploy Contracts

```bash
forge script script/Deploy.s.sol \
  --rpc-url $TENDERLY_RPC_URL \
  --broadcast -vvv
```

Copy the three deployed addresses into `.env` and `workflow/config.staging.json`:

```
POLICY_REGISTRY_ADDRESS=0x...
CLAIM_REQUEST_ADDRESS=0x...
CLAIM_SETTLEMENT_ADDRESS=0x...
```

Also update `workflow/config.staging.json`:

- `demoPolicyId` → run `cast keccak "DEMO-001"` to get the bytes32
- `demoClaimant` → your claimant wallet address
- `claimSubmittedEventSignature` → `cast keccak "ClaimSubmitted(bytes32,address,bytes32,uint256)"`

---

### Step 2 — Seed the Demo State

```bash
forge script script/Seed.s.sol \
  --rpc-url $TENDERLY_RPC_URL \
  --broadcast -vvv
```

This registers policy **DEMO-001** with coverage 2024-01-01 to 2024-12-31, activates it by paying the premium, and deposits $10,000 USDC into the settlement pool.

The demo FHIR claim (treatment date `2024-06-10`) falls perfectly within this window.

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

### Step 4 — Submit the Claim

```bash
ts-node scripts/submit-claim.ts --policy DEMO-001 --fhir 131299879
```

The script prints exactly what IS and IS NOT in the transaction. Open the Tenderly link it prints. Inspect every internal call, every event log, every storage slot — you will find **zero medical data** anywhere.

---

### Step 5 — Run the Enclave (local simulation)

```bash
ts-node scripts/run-enclave.ts --policy DEMO-001 --fhir 131299879
```

This runs the enclave logic locally so you can observe the private data in your terminal. In production CRE, these logs stay inside the TEE and are never externally accessible.

You will see:

```
[ENCLAVE] Verifying policy DEMO-001...
[ENCLAVE] Policy active. Claimant eligible.
[ENCLAVE] Fetching FHIR 131299879 from HAPI sandbox...
[ENCLAVE] ┌─ ICD-10  : J06.9   ← [PRIVATE — stays in enclave in production]
[ENCLAVE] │  Date    : 2024-06-10
[ENCLAVE] └─ Billed  : $150.00
[ENCLAVE] ICD-10 J06.9 covered? YES
[ENCLAVE] Date in 2024 period?  YES
[ENCLAVE] Payout: $150 × 80% = $120.00 USDC
[ENCLAVE] Writing verdict to PolicyRegistry...
[ENCLAVE] Executing USDC payout...
[ENCLAVE] ✓ $120.00 transferred. TX: 0x...
```

---

### Step 6 — Read the Verdict

```bash
ts-node scripts/check-verdict.ts --policy DEMO-001
```

Prints the full privacy panel:

```
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  CLAIMSHIELD VERDICT — Policy: DEMO-001
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  Status          : ✅ APPROVED
  Payout          : $120.00 USDC
  Reason Code     : 0 — APPROVED
  Compliance Hash : 0x...

  ── WHAT IS ONCHAIN (anyone can verify): ──────────────────
    ✅ Policy exists and was active
    ✅ Verdict: APPROVED
    ✅ Payout: $120.00 USDC
    ✅ Compliance hash (non-reversible proof)
    ✅ Written by approved enclave address

  ── WHAT NEVER LEFT THE ENCLAVE: ─────────────────────────
    🔒 FHIR Claim ID     → 131299879
    🔒 ICD-10 Code       → J06.9
    🔒 Diagnosis Text    → Acute upper respiratory infection
    🔒 Treatment Date    → 2024-06-10
    🔒 Billed Amount     → $150.00
    🔒 Reimbursement Rate → 80%
    🔒 Covered Conditions List
    🔒 EHR API Credentials
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
```

---

### Step 7 — Verify the USDC Payout

```bash
cast call 0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48 \
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
npx tsc --noEmit

# CRE workflow simulation (requires CRE CLI)
cre workflow simulate ./workflow --target=staging-settings
```

---

## 12. Demo Reference Data

| Field | Value |
|---|---|
| **Policy ID** | `DEMO-001` → `keccak256("DEMO-001")` |
| **Coverage Period** | 2024-01-01 to 2024-12-31 |
| **FHIR Claim ID** | `131299879` |
| **FHIR Sandbox URL** | `https://hapi.fhir.org/baseR4/Claim/131299879` |
| **ICD-10 Diagnosis** | `J06.9` — Acute upper respiratory infection |
| **Treatment Date** | `2024-06-10` (within coverage period ✅) |
| **Billed Amount** | `$150.00 USD` |
| **Reimbursement Rate** | `80%` (private — computed inside TEE) |
| **Expected Payout** | `$120.00 USDC` = `120_000000` (6 decimals) |
| **USDC Contract (mainnet)** | `0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48` |

---

*For the full 900-line technical deep-dive including detailed sequence diagrams, per-function call traces, and the complete privacy threat model, see [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md).*
