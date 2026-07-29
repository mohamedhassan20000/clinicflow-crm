# Additive Document Extension Pattern

## 1. Principle

A new document is a new registry definition and requirements specification. It must not add conditionals to an unrelated definition or force shared primitives to encode one-off business meaning.

Extend an existing definition only when the purpose, issuer, lifecycle, legal class, and core data contract remain the same. Otherwise create a new `definition_id`.

## 2. Required definition manifest

P7D’s eventual typed registry entry must express at least:

```text
definition_id
definition_version
display_name_key
purpose
paper { size, orientation }
formats { preview, print, pdf }
actor_policy
generation_points
issue_preconditions
data_contract
sections
tables
branding_placeholders
signature_policy
qr_policy
numbering_policy
locales
delivery_policy
legal_profile_requirements
retention_class
fixture_ids
```

This is a requirements shape, not a P7A runtime schema. P7D chooses the TypeScript and persistence representation after P7B fixes the primitive contract.

## 3. Required files and review sequence

1. Add `docs/documents/<definition-id>.md` using all headings in §4 below.
2. Add the document to the matrix in [README](README.md).
3. Obtain the applicable [legal-profile approval](LEGAL_VALIDATION.md).
4. Produce and approve a P7B design constrained to existing primitives.
5. Add one registry definition and one typed input contract.
6. Implement an authorized data builder and issuer action. Never let the renderer query arbitrary tables.
7. Implement immutable issue/snapshot/void/replace behavior.
8. Add preview, print, PDF, localization, RTL/LTR, long-content, missing-optionals, authorization, tenant-isolation, and concurrency fixtures.
9. Add delivery only through an already approved delivery policy; otherwise leave the output preview/print/download only.

Each step is independently reviewable. A visual design does not authorize a schema or delivery workflow.

## 4. Mandatory specification headings

Every document specification must contain:

1. purpose and non-purpose;
2. generation point, actor, trigger, and preconditions;
3. paper and output formats;
4. source-of-truth assessment;
5. complete field catalog;
6. section/table order;
7. numbering and lifecycle;
8. signature and QR behavior;
9. localization and RTL/LTR;
10. branding and optional-field degradation;
11. delivery channels;
12. legal/compliance gates;
13. fixtures and acceptance criteria; and
14. explicit out-of-scope items.

## 5. Primitive discipline

Permitted document designs compose the P7B primitive set:

- page and margin frame;
- header/footer band;
- branding block;
- identity/key-value block;
- narrative section;
- table;
- totals block;
- notice/callout;
- signature/attestation block;
- QR/verification block; and
- pagination/continuation marker.

If a new requirement cannot be represented:

1. prove that it is shared by at least one committed or approved future definition, or document why a one-definition primitive is unavoidable;
2. amend the P7B primitive contract;
3. update visual fixtures for every affected definition; and
4. version, never mutate, already issued definitions.

Free-form clinic HTML, CSS, JavaScript, remote fonts, or arbitrary template code is forbidden.

## 6. Contract and compatibility rules

- Definition ids are permanent.
- Issued instances retain their definition version forever.
- Adding an optional field is backward-compatible only when absence degrades deterministically.
- Making a field required, changing field meaning, changing a number, or changing legal text requires a new definition version.
- A data builder returns only the declared contract. Renderers do not perform authorization or database discovery.
- Clinic branding metadata renders only through approved placeholder keys.
- Locale changes system copy, not the semantic source data.
- Delivery adapters consume an issued document reference; they do not rebuild the document.

## 7. Minimum fixture set

Every definition supplies:

- English/LTR complete fixture;
- Arabic/RTL complete fixture;
- minimum-data fixture;
- all-optionals fixture;
- longest-valid-content fixture;
- multi-page fixture when length can exceed one page;
- missing-required-field denial fixture;
- void and replacement fixture when issued;
- unauthorized-role and cross-clinic denial fixtures;
- concurrent-number allocation fixture when numbered;
- preview/print/PDF parity fixture; and
- jurisdiction-not-approved denial fixture.

For sensitive clinical definitions, add a fixture proving that logs, filenames, QR payloads, and generic audit data contain no clinical content.

