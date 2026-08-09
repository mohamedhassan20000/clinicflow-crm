# 07 · Verification

## Objective

Specify the machine-readable verification mark and the public verification page it opens, with
strict disclosure limits.

Binding requirements: evaluate QR vs linear barcode (§5); the mark opens a public verification
page (§6); the page shows only status, document number, document type, issue date, issuing
clinic (§7) and nothing sensitive; correct bidi handling of the payload (correction #4).

---

## 1. QR vs linear barcode — decision

| Criterion | Linear barcode (1D) | QR (2D) |
|-----------|--------------------|---------|
| Can encode a full verification URL | ❌ impractical (length) | ✅ compact, easy |
| Scannable by any phone camera | ❌ needs a scanner app | ✅ native camera |
| Error correction (print/scan robustness) | weak | ✅ strong |
| Footprint on the page | wide strip | ✅ compact square (matches designs) |
| Opens a page directly | ❌ | ✅ |

**Recommendation: QR.** Every design already reserves a square "SCAN TO VERIFY" slot, and the
requirement is to *open a page*, which a 1D barcode cannot do comfortably. The QR placeholders
in the Stitch exports are **non-production** (§5) and are replaced with a real generated code.

---

## 2. What the QR encodes

```
https://clinicflow.fit/verify/<token>
```

- **Canonical domain** `clinicflow.fit` (production canonical per project convention; the
  `*.vercel.app` domain is preview-only and must never be embedded in an issued document).
- **`<token>`** is an **opaque, unguessable identifier** (e.g. a 128-bit random / nanoid),
  distinct from the sequential document number.
  - **Never encode the sequential number** in the QR: sequential numbers are enumerable, and a
    guessable verification URL would let anyone probe `INV-2026-0002`, `0003`, … The opaque token
    breaks enumeration.
  - The token is generated at issue and stored with the document (`verification_token`, unique).
- The payload is plain ASCII (LTR); the QR image is direction-neutral and positioned by the
  engine (doc 03 §4, §8). No bidi reordering can affect it.

---

## 3. The public verification page

- **Route:** `app/(public)/verify/[token]/page.tsx` — **unauthenticated**, outside the protected
  area, and excluded from any auth redirect. Public and indexable-safe (no sensitive data).
- **Lookup:** by `verification_token` only (never by number). Unknown/blank token → `unavailable`.
- **Localized:** renders in Arabic or English (next-intl), with Latin digits and correct bidi,
  consistent with the documents themselves.
- **Rate-limited:** reuse `lib/rate-limit` to throttle probing.
- **Read path:** a dedicated, minimal read (a `SECURITY DEFINER` RPC or a tightly-scoped public
  view) returns **only** the safe fields — the public role has no access to the `documents`
  table's sensitive columns (snapshot, params, patient/staff refs, pdf path).

### Disclosure — the complete allowed set (§7)

| Field | Shown | Example |
|-------|-------|---------|
| Status | ✅ | `Valid` / `Void` / `Cancelled` / `Unavailable` |
| Document number | ✅ | `INV-2026-0001` |
| Document type | ✅ | `Invoice` |
| Issue date | ✅ | `29 Jul 2026` |
| Issuing clinic name | ✅ | `ClinicFlow Medical Group` |
| Anything else | ❌ | no patient/medical/financial/employee/contact data |

The page is deliberately boring: it confirms authenticity and nothing more. No line items, no
diagnosis, no names beyond the clinic, no amounts.

---

## 4. Status semantics

| Status | Condition |
|--------|-----------|
| `valid` | Document exists and is issued (not void/cancelled) |
| `void` | Document was voided |
| `cancelled` | Document was cancelled |
| `unavailable` | Token not found / malformed (indistinguishable to prevent enumeration) |

---

## 5. Security properties

- **Enumeration-safe:** opaque token, unknown-vs-invalid both return `unavailable`, rate-limited.
- **No sensitive leakage:** public read surface exposes only the five safe fields; RLS/definer
  boundary keeps everything else unreadable to the anonymous role.
- **Tamper-evident by design:** the QR points at the clinic's own record; a forged PDF with a
  fake number won't resolve to a valid token, and a copied token resolves to the *real* clinic +
  type + date, exposing mismatches.
- **Generation dependency:** QR image generation uses the small, vetted `qrcode` dependency,
  rendered server-side to an inlined SVG/PNG data-URI embedded in the template (no runtime
  network, consistent with the app's self-contained asset policy).
