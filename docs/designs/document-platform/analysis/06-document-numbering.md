# 06 · Document Numbering

## Objective

Recommend and justify the document numbering strategy, and specify how numbers are allocated
atomically, kept immutable, and never reused.

Binding requirements: server-side, atomic, **per-clinic + per-type** (§8); preview consumes no
number (§9); reprints retain the original (§10); issued numbers never reused, even after void
(§11); plus corrections #6 (new type ≠ migration by default) and #7 (prefix changes never touch
history; full visible number stored immutably; no collisions).

---

## 1. Options considered

| Option | Description | Verdict |
|--------|-------------|---------|
| **Global** | One sequence for the whole platform across all clinics/types | ❌ Cross-tenant contention; leaks total volume across clinics; a shared hotspot row |
| **Per clinic only** | One sequence per clinic, all types mixed | ❌ A prescription and an invoice share a run — confusing, no type prefixes, mixes clinical/financial audit trails, still a per-clinic hotspot for all issuance |
| **Per document type only** | One sequence per type across all clinics | ❌ Cross-tenant leak (clinic B infers clinic A's invoice volume) |
| **Per clinic + per type** ✅ | One independent sequence per (clinic, type) | ✅ Matches §8 exactly; clean type prefixes; independent per-type audit; contention isolated to a single low-traffic counter row per (clinic,type) |

**Recommendation: per-clinic + per-document-type.**

---

## 2. Number shape

```
<PREFIX>-<YYYY>-<SEQ>            e.g.  REV-2026-0007 · RX-2026-0142 · INV-2026-0001
```

- **PREFIX** — per-type, human-readable (`REV, FU, PLR, PF, RX, SL, LAB, CR, NS, SAL, FUA,
  DPF, RPF, SMR, STF, INV`; see doc 02). The prefix default lives in the catalog; a clinic may
  **override** it in Documents Settings (doc 09).
- **YYYY** — issue year (optional per-type; keeps sequences readable and lets them reset yearly
  if desired — a policy toggle, not required).
- **SEQ** — the atomic per-(clinic,type[,year]) counter, zero-padded, **Latin digits**.

The **complete visible string** (prefix + year + seq, exactly as shown) is stored on the issued
`documents` row and is **immutable** thereafter (correction #7). Formatting/prefix is applied at
allocation time and frozen with the document — never recomputed on read.

> The designs show varied example formats (e.g. `CF-REV-2026-06`, `RX-992-HASSAN`,
> `CF-SL-2023-44102`). Those are **placeholders**. The production format is the catalog-driven
> scheme above; the clinic prefix override covers the "CF-" style house prefix.

---

## 3. Atomic allocation

A counter table + a `SECURITY DEFINER` RPC guarantee atomicity and prevent duplicates under
concurrency:

```
document_counters (
  clinic_id  uuid,
  doc_type   text,
  period_key text,        -- e.g. '2026' when yearly reset is on, else '' 
  next_seq   bigint not null default 1,
  primary key (clinic_id, doc_type, period_key)
)

-- RPC (SECURITY DEFINER), called only inside issue():
allocate_document_number(p_clinic_id, p_doc_type, p_period_key) returns bigint
  -- upsert the counter row, `UPDATE ... SET next_seq = next_seq + 1 RETURNING next_seq - 1`
  -- row-level lock serializes concurrent issues for the same (clinic,type,period)
```

- **Atomic:** the increment-and-return is a single locked statement; two simultaneous issues
  get distinct sequential values.
- **Server-side only:** authenticated clients have no direct write to `document_counters`; only
  the definer RPC (invoked by the issue action) can advance it — mirroring the spoof-proof write
  boundary already used for `activity_events`.
- **Uniqueness:** a `unique (clinic_id, doc_type, document_number)` constraint on `documents` is
  the backstop — even a logic bug cannot persist a duplicate visible number.

---

## 4. Preview, reprint, void, reuse

- **Preview** calls no allocator — it renders a `PREVIEW` placeholder (§9).
- **Issue** calls the allocator exactly once and freezes the returned number.
- **Reprint** re-serves the stored PDF; it reuses the original number, never allocates (§10).
- **Void/Cancel** retires the number; the counter never rewinds, so the value is never handed
  out again (§11). Gaps from voids are expected and acceptable (a retired number is visible
  proof a document once existed).

---

## 5. Prefix changes never rewrite history (correction #7)

- Changing a type's prefix in Settings updates only the **default applied to future
  allocations**. Existing issued documents keep their stored visible number verbatim.
- Because the counter key is `(clinic, type, period)` and the sequence is independent of the
  prefix string, changing the prefix cannot cause a collision with past numbers (the numeric
  sequence keeps advancing). If a clinic changes a prefix mid-year, both old and new prefixes
  coexist across historical rows with distinct, non-colliding sequence values.
- The unique constraint on the full `document_number` guarantees no two issued documents ever
  share a visible number regardless of prefix edits.

---

## 6. Why this needs no per-type migration for new documents (correction #6)

`document_counters` and `documents` are **type-agnostic** — `doc_type` is data, not schema. A
new document type reuses the same tables and the same allocator RPC. Its prefix default is a
catalog value. So a new type needs **no migration** for numbering; a migration is only involved
if the founder wants a *persisted* per-type numbering configuration that doesn't already fit
`document_settings`.
