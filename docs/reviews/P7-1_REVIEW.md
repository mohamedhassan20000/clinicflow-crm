# P7-1 — Document Rendering Engine — Independent Engineering Review

**Reviewer:** Claude (independent review; validated against the local tree — focused suite, typecheck, and git plumbing — not the report alone)
**Date:** 2026-08-01
**Branch:** `feat/p7-document-platform`
**Scope reviewed:** every file changed by P7-1 (per `docs/reports/P7-1_IMPLEMENTATION.md`), the approved architecture (`docs/designs/document-platform/analysis/01–15` + `README`), the reconciled roadmap (`13-implementation-roadmap.md` §P7-1), the frozen contract (`docs/designs/document-platform/P7-1_PRIMITIVE_CONTRACT.md`), `docs/AI_AGENT_PLAN.md` (Phase 7), and the P7-0 foundation boundary. Figma intake references consulted where present (Patient File / Prescription refs are empty, as the report notes).

Finding IDs are stable for the Claude→Codex handoff contract.

---

## 0. Re-review (final, 2026-08-01)

The P7-1 fixes were re-reviewed independently against the working tree and git plumbing. **P71-R1 is fully resolved** and no new scope was introduced. Verdict upgraded to **APPROVED**.

| Re-verification | Result |
|---|---|
| `git check-ignore -v app/fonts/manrope/manrope-latin-variable.woff2` | **not ignored** — the file is no longer excluded |
| `.gitignore` negation | `!/app/fonts/manrope/*.woff2` added on line 40 (below `*.woff2`), with the comment updated to name the Manrope runtime face |
| `git ls-files app/fonts/manrope/` | **tracked** — `app/fonts/manrope/manrope-latin-variable.woff2` is staged (`A `) |
| Font artifact validity | valid `wOF2` header, 24,576 bytes (real variable face, not a placeholder) |
| `next.config.ts` tracing | `outputFileTracingIncludes` traces both `./app/fonts/manrope/*.woff2` and `./app/fonts/thmanyah/*.woff2`; `serverExternalPackages: ["@sparticuz/chromium"]` present |
| Regression gate | `p71-document-bundle-size.test.ts` adds a third case that, for **every** `DOCUMENT_FONT_SOURCE_PATHS` entry, asserts on-disk size > 0 **and** `git ls-files --error-unmatch` tracking — exactly the P71-R1 failure mode, so a future un-tracked font fails CI instead of production |
| Focused P7-1 suite | **16/16 passed** (4 files; the added regression case brings the count from 15 to 16) |
| `tsc --noEmit` | **pass** (clean; the new `DOCUMENT_FONT_SOURCE_PATHS` export compiles) |
| Fix scope | limited to `.gitignore`, the tracked font, `next.config.ts` tracing, `fonts.ts` (`DOCUMENT_FONT_SOURCE_PATHS` export), and the regression test. **No P7-2 scope, no template/action/verify-route, no unrelated production change.** |

**One trivial, non-blocking report nit (not a required fix):** the report's Validation Results table (§Validation Results, "Focused P7-1 Vitest suite") still reads "4 files, 15 tests" while the suite now has 16 tests and the report's own Tests-Added summary correctly says "16 tests passed." Cosmetic count drift in the report only; production and the gate are correct.

The Manrope runtime font is now tracked correctly, the regression test is sufficient to prevent recurrence, and the implementation report's substantive claim ("stored as the tracked runtime asset … a regression gate verifies that every PDF font source remains present and tracked") is now accurate. **P71-N1…N3 remain non-blocking recommendations carried forward to P7-2+.**

**Final verdict: APPROVED.**

---

## 1. Verdict summary

P7-1 is a faithful, well-structured implementation of the approved Layer-0 + Layer-1 rendering engine. `DocumentPage`, all 15 frozen primitives, the primitive contract, the browser-print CSS, the Chromium PDF renderer, QR generation, watermark lifecycle rules, RTL/LTR + bidi handling, Latin-digit invariance, font embedding, and the security boundaries all match the locked architecture and the frozen contract. **No P7-2+ scope is present** — no Layer-2 templates, no `/verify` route, no issuance actions, no Documents-module product UI (the one route added is an explicitly non-indexed developer harness).

There is **one blocking, production-breaking defect**: the Manrope WOFF2 the PDF renderer loads at runtime is **git-ignored** and will not be committed or deployed, so server-side PDF rendering fails in any clean checkout (CI / Vercel). The fix is a one-line `.gitignore` change plus force-adding the file; it does not touch the engine design. Everything else is sound.

**Verdict: APPROVED WITH REQUIRED FIXES.**

---

## 2. Independent validation performed

| Check | Result |
|---|---|
| Focused P7-1 suite (4 files) | **15/15 passed** (re-run locally) |
| `tsc --noEmit` | **pass** (clean) |
| `git check-ignore` on the Manrope font | **reproduced** — file is ignored (§4, P71-R1) |
| `git ls-files app/fonts/` | only the 5 Thmanyah faces are tracked; Manrope is not |
| App-formatter leakage into primitives/engine | **none** — primitives use only `lib/documents/format.ts` |
| `useDocumentRenderContext` consumers | **none** in P7-1 (forward-looking API; §5, P71-N1) |

I did not re-run the full `pnpm test`, `pnpm build`, or the RTL/i18n gates; the report records them green and I read the exercised paths directly. A live Arabic Chromium PDF roundtrip was not run here (same sandbox constraint the report documents) — but note that constraint would **not** have surfaced P71-R1 either, because the ignored font is present in the working tree locally (see §4).

---

## 3. Architecture & scope conformance (confirmed correct)

- **Layer 0 `DocumentPage`** — sole owner of chrome: A4 portrait/landscape geometry (15 mm content margins), direction from `localeDirection`, invariant `digits: "latn"`, lifecycle, branding/identity injection, watermark, and a render context. Header/footer are wrapped in a `<thead>`/`<tfoot>` pagination table so print repeats them per page. Matches contract §1 and doc 03. ✔
- **Watermark lifecycle** — `effectiveWatermark`: preview always renders `DRAFT`/`مسودة` regardless of the issued toggle; issued+disabled renders nothing; issued+enabled uses trimmed custom text and falls back to `branding.name`. Pointer-inert, low opacity, behind content (`z-index:0`, `isolation:isolate`), rotation flips for RTL, and `position:fixed` in print repeats it per page. Matches contract §1 and the three lifecycle unit tests. ✔
- **15 Layer-1 primitives** — the exact frozen set; each takes generic presentation props, fetches no domain data, and honors its omission/degradation contract (empty lists render nothing; `FieldGrid` strips null/undefined/`""`; `DataTable` renders one honest empty-state row; logo→initial, image→initials fallbacks; independent optional-field omission). Break-avoidance (`break-inside: avoid`, `table-header-group`/`table-footer-group`) matches the pagination column of contract §2. ✔
- **Chromium renderer** — `puppeteer-core` + `@sparticuz/chromium`, local-Chrome discovery + `CHROME_EXECUTABLE_PATH` override, `printBackground`, `preferCSSPageSize`, `tagged`, landscape wired to orientation, guaranteed `browser.close()` in `finally`. Externalized via `serverExternalPackages`; fonts traced via `outputFileTracingIncludes`. Matches contract §5. ✔
- **Single CSS source of truth** — screen, browser print, and Chromium all consume `DOCUMENT_ENGINE_CSS` and the same React tree; `buildDocumentHtml` inlines font CSS + engine CSS. Matches contract §5 and doc 03. ✔
- **QR generation** — `qrcode` renders a PNG data URI; the URL is only ever `https://clinicflow.fit/verify/<token>` built through `new URL(...)` after an opaque-token regex (`^[A-Za-z0-9_-]{20,128}$`) rejects short/path-like/spaced/absolute inputs. `VerificationBlock` hard-rejects any non-`data:image/` src. Matches contract §2/§4 and decision #3. ✔
- **Fonts** — Manrope variable (200–800) for Latin; Thmanyah 300/400/500/700/900 (no synthetic 600) for Arabic; all embedded as base64 `data:font/woff2` with `font-display:block`, no CDN/network. Matches contract §3 and decision #5. ✔
- **Latin digits + bidi** — `format.ts` forces `nu-latn` across number/money/percent/date/time and normalizes both Arabic-Indic ranges; identifiers/codes/phones/emails/URLs/numeric cells/QR keys are wrapped in `<bdi class="cf-doc-ltr">` with `unicode-bidi: isolate`; logical CSS properties throughout; Arabic never uppercased/letter-spaced (`[dir="rtl"]` resets). Tests assert no Arabic-Indic glyphs reach the DOM in EN or AR. Matches contract §4 and decision #6. ✔
- **Security boundaries** — `render.ts`/`html.ts`/`fonts.ts`/`verification-qr.ts` are `server-only`; page JS disabled; all requests aborted except `data:`/`about:`; title HTML-attribute-escaped; QR/logo/avatar restricted to inlined data URIs. Solid. ✔
- **Dependencies** — exactly the approved set (`puppeteer-core`, `@sparticuz/chromium`, `qrcode`, `@types/qrcode`); bundle-size gate test enforces the 120 MiB operational budget (report: 74.51 MiB). ✔

**No P7-2+ scope present.** No Layer-2 template, no data resolver, no `actions/documents.ts`, no preview/issue/reprint/regenerate/void action, no `/verify/[token]` route, no Documents-module or Documents-settings UI. `lib/documents/{catalog,issuance,format,bidi}.ts` belong to P7-0 and are reused, not modified by P7-1. ✔

---

## 4. Findings

### P71-R1 — REQUIRED (BLOCKER) — ✅ RESOLVED (see §0) — the Manrope PDF font is git-ignored and will not deploy

**Files:** `.gitignore:38-39`, `lib/documents/pdf/fonts.ts:12-25`, `next.config.ts` (`outputFileTracingIncludes`), `app/fonts/manrope/manrope-latin-variable.woff2`

`.gitignore` line 38 ignores `*.woff2`; line 39 re-includes **only** `!/app/fonts/thmanyah/*.woff2`. There is no negation for `app/fonts/manrope/`, so the newly added `app/fonts/manrope/manrope-latin-variable.woff2` is ignored:

```
$ git check-ignore -v app/fonts/manrope/manrope-latin-variable.woff2
.gitignore:38:*.woff2   app/fonts/manrope/manrope-latin-variable.woff2
$ git status --ignored --short app/fonts/
!! app/fonts/manrope/
$ git ls-files app/fonts/          # only Thmanyah is tracked
app/fonts/thmanyah/thmanyahsans-Black.woff2
… (5 Thmanyah faces, no Manrope)
```

Impact: `getDocumentFontCss` reads **all** faces at runtime with `readFile(join(process.cwd(), relativePath))` and `Promise.all`s them, so a missing Manrope file makes the whole promise reject (`ENOENT`) — the entire PDF render fails, not merely the Latin face. A normal `git add -A`/`git commit` will **silently skip** this file, and `outputFileTracingIncludes` traces nothing because the file is absent from the repo — so CI and every Vercel deploy render zero PDFs. The implementation report states the file "was checked into `app/fonts/manrope/`"; it was written to the working tree but is not tracked, so that claim is inaccurate.

Why the green suite did not catch it: `p71-document-pdf.test.tsx` reads the font from the working tree, where the file physically exists locally. Tests and typecheck pass while the artifact that production needs is unshippable. (The blocked live-roundtrip validation would also have passed locally for the same reason — this defect is invisible to every check that runs against the working tree.)

**Fix:** add `!/app/fonts/manrope/*.woff2` to `.gitignore` and force-add the file (`git add -f app/fonts/manrope/manrope-latin-variable.woff2`); confirm with `git ls-files app/fonts/manrope/`. Optionally add a static assertion (e.g. in the bundle-size or a new test) that every `DOCUMENT_FONT_SOURCE_PATHS` entry is a tracked file, so this class of packaging gap fails CI rather than production.

---

## 5. Non-blocking observations (recommendations)

### P71-N1 — render context is provided but consumed by nothing in P7-1
`DocumentPage` builds a `DocumentRenderContextValue` (locale, direction, `digits`, lifecycle, orientation, branding, identity) and exports `useDocumentRenderContext`, but no P7-1 primitive reads it — branding/identity/digits are also threaded explicitly through props. This is a deliberate forward-looking API for Layer-2 (contract §1), and it is harmless, but it is currently unused indirection behind a `"use client"` boundary. Recommend P7-2 either genuinely consume it (and drop the now-redundant explicit prop threading where it overlaps) or trim it, so the engine keeps a single source of truth for context.

### P71-N2 — the developer harness ships to production
`app/(protected)/documents/engine-harness/page.tsx` is auth-protected and `robots:{index:false}`, and it is legitimately "an implementation surface, not the Documents module." But it is a live, reachable route for any authenticated user in production and sits inside the real `/documents` namespace that P7-8 will own. Recommend gating it behind a non-production guard (e.g. `notFound()` when `process.env.NODE_ENV === "production"`) so the internal primitive playground cannot be reached in prod and cannot later collide with a real `/documents/*` product route.

### P71-N3 — `measuredPageCount` is a screen-heuristic returned as renderer metadata
`renderDocumentPdf` returns `pageCount` from `Math.ceil(scrollHeight / A4pxHeight)` with hardcoded 96-dpi pixel constants. The **visible** page counters come from CSS `counter(pages)`, so this value is informational only; but it is approximate (it does not account for `@page` pagination breaks) and a future caller that trusts it for the printed "X of Y" would be misled. Recommend documenting it as an estimate, or deriving the true count from the generated PDF, when a caller actually needs it in P7-3+.

---

## 6. Conformance to the frozen contract

Every clause of `P7-1_PRIMITIVE_CONTRACT.md` §1–§6 is satisfied by the delivered code: the Layer-0 ownership rules, the per-primitive required/degradation/pagination table, the shared token palette (verified against `styles.ts` `:root`), the direction/digit/bidi rules, the three-path CSS unification, the Chromium externalization + 120 MiB gate, and the Layer-2 restrictions (no template may add chrome, bypass Latin digits, load remote assets, or add a primitive). The contract is genuinely frozen and testable, which is the deliverable P7-2's conformance gate depends on. ✔

---

## 7. Final verdict

**APPROVED WITH REQUIRED FIXES**

The engine, primitives, contract, renderer, QR, watermark, RTL/LTR + bidi, digit invariance, font embedding, security boundaries, dependencies, and tests are correct and match the approved architecture with no P7-2+ scope leakage. The single required fix (**P71-R1** — un-ignore and track the Manrope PDF font) is blocking for production but small and localized; P71-N1…N3 are non-blocking recommendations. Re-review only P71-R1 (confirm the font is tracked and traced) before this is considered production-ready.
