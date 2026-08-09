/**
 * The browser preview, browser print path, and Chromium PDF path all consume
 * this exact stylesheet. Keep document-specific styling out of this file.
 */
export const DOCUMENT_ENGINE_CSS = String.raw`
:root {
  --doc-ink: #001f35;
  --doc-ink-soft: #001b29;
  --doc-accent: #006575;
  --doc-accent-bright: #0095ab;
  --doc-panel: #ebf6f8;
  --doc-panel-soft: #f3fbff;
  --doc-panel-blue: #e5f6ff;
  --doc-panel-strong: #001f35;
  --doc-muted: #3d494c;
  --doc-muted-light: #6d797c;
  --doc-divider: #d7e4e7;
  --doc-success: #00b26a;
  --doc-warning: #f2a618;
  --doc-danger: #ba1a1a;
  --doc-paper: #ffffff;
}

@page document-en-portrait {
  size: A4 portrait;
  margin: 0 0 7mm;

  @bottom-center {
    color: #3d494c;
    content: "Page " counter(page) " of " counter(pages);
    direction: ltr;
    font-family: "ClinicFlow Document Manrope", Manrope, sans-serif;
    font-size: 8px;
  }
}

@page document-ar-portrait {
  size: A4 portrait;
  margin: 0 0 7mm;

  @bottom-center {
    color: #3d494c;
    content: "صفحة " counter(page) " من " counter(pages);
    direction: rtl;
    font-family: "ClinicFlow Document Thmanyah", Thmanyah, sans-serif;
    font-size: 8px;
  }
}

@page document-en-landscape {
  size: A4 landscape;
  margin: 0 0 7mm;

  @bottom-center {
    color: #3d494c;
    content: "Page " counter(page) " of " counter(pages);
    direction: ltr;
    font-family: "ClinicFlow Document Manrope", Manrope, sans-serif;
    font-size: 8px;
  }
}

@page document-ar-landscape {
  size: A4 landscape;
  margin: 0 0 7mm;

  @bottom-center {
    color: #3d494c;
    content: "صفحة " counter(page) " من " counter(pages);
    direction: rtl;
    font-family: "ClinicFlow Document Thmanyah", Thmanyah, sans-serif;
    font-size: 8px;
  }
}

.cf-document-surface,
.cf-document-surface * {
  box-sizing: border-box;
}

.cf-document-surface {
  color: var(--doc-ink-soft);
  background: #edf5f8;
  display: flex;
  justify-content: center;
  min-inline-size: min-content;
  padding-block: 24px;
  padding-inline: 24px;
  -webkit-print-color-adjust: exact;
  print-color-adjust: exact;
}

.cf-document-page {
  --doc-page-inline: 210mm;
  --doc-page-block: 297mm;
  --doc-content-inline: 180mm;
  background: var(--doc-paper);
  color: var(--doc-ink-soft);
  direction: inherit;
  font-family: var(--doc-font-latin, var(--font-manrope, Manrope, sans-serif));
  font-size: 10px;
  line-height: 1.4;
  inline-size: var(--doc-page-inline);
  min-block-size: var(--doc-page-block);
  overflow: visible;
  position: relative;
  isolation: isolate;
  box-shadow: 0 0 20px rgb(0 0 0 / 10%);
}

.cf-document-pagination {
  border-collapse: collapse;
  inline-size: 100%;
  min-block-size: var(--doc-page-block);
  table-layout: fixed;
}

.cf-document-pagination > thead {
  display: table-header-group;
}

.cf-document-pagination > tfoot {
  display: table-footer-group;
}

.cf-document-pagination > thead > tr > td {
  padding-block-start: 15mm;
  padding-inline: 15mm;
}

.cf-document-pagination > tbody > tr > td {
  padding-inline: 15mm;
  vertical-align: top;
}

.cf-document-pagination > tfoot > tr > td {
  padding-block-end: 12mm;
  padding-inline: 15mm;
  vertical-align: bottom;
}

.cf-document-page[dir="rtl"] {
  --doc-font-active: var(--doc-font-arabic, var(--font-thmanyah, Thmanyah, sans-serif));
  font-family: var(--doc-font-active);
}

.cf-document-page[data-orientation="landscape"] {
  --doc-page-inline: 297mm;
  --doc-page-block: 210mm;
  --doc-content-inline: 267mm;
}

.cf-document-chrome,
.cf-document-body {
  position: relative;
  z-index: 1;
}

.cf-document-body {
  display: flex;
  flex-direction: column;
  gap: 16px;
  min-block-size: 220mm;
  padding-block: 8mm;
}

.cf-document-page[data-orientation="landscape"] .cf-document-body {
  min-block-size: 133mm;
}

.cf-document-watermark {
  align-items: center;
  color: var(--doc-ink);
  display: flex;
  font-family: inherit;
  font-size: 120px;
  font-weight: 900;
  inset: 20mm 10mm;
  justify-content: center;
  line-height: 1;
  opacity: 0.045;
  overflow: hidden;
  pointer-events: none;
  position: absolute;
  transform: rotate(-45deg);
  user-select: none;
  white-space: nowrap;
  z-index: 0;
}

.cf-document-page[dir="rtl"] .cf-document-watermark {
  transform: rotate(45deg);
}

.cf-document-page[data-lifecycle="cancelled"] .cf-document-watermark {
  color: var(--doc-danger);
  opacity: 0.2;
}

.cf-doc-header {
  align-items: flex-start;
  border-block-end: 2px solid var(--doc-ink);
  display: flex;
  gap: 24px;
  justify-content: space-between;
  padding-block-end: 18px;
}

.cf-doc-branding {
  align-items: center;
  display: flex;
  gap: 20px;
  max-inline-size: 55%;
  min-inline-size: 0;
}

.cf-doc-logo {
  /* Every configured clinic logo shares the same maximum height and width.
     Intrinsic inline sizing keeps the box tight around each mark, while the
     caps and contain fit prevent distortion in preview or PDF. */
  block-size: 80px;
  flex: none;
  inline-size: auto;
  max-inline-size: 200px;
  object-fit: contain;
  object-position: center;
}

.cf-doc-logo-fallback {
  align-items: center;
  background: var(--doc-accent);
  color: white;
  display: flex;
  font-size: 18px;
  font-weight: 800;
  /* Keep the no-logo typographic fallback at its established visual size. */
  block-size: 56px;
  inline-size: 56px;
  justify-content: center;
}

.cf-doc-branding-copy {
  flex: 1;
  min-inline-size: 0;
}

.cf-doc-clinic-name {
  color: var(--doc-ink);
  font-size: 16px;
  font-weight: 700;
  line-height: 24px;
  margin: 0;
}

.cf-doc-contact-lines {
  color: var(--doc-muted);
  font-size: 9px;
  line-height: 14px;
  margin-block-start: 2px;
}

.cf-doc-contact-lines p,
.cf-doc-title,
.cf-doc-meta-grid,
.cf-doc-footer p {
  margin: 0;
}

.cf-doc-identity {
  max-inline-size: 45%;
  min-inline-size: 220px;
  text-align: end;
}

.cf-doc-title {
  color: var(--doc-accent);
  font-size: 24px;
  font-weight: 800;
  letter-spacing: 0.04em;
  line-height: 32px;
  text-transform: uppercase;
}

.cf-document-page[dir="rtl"] .cf-doc-title,
.cf-document-page[dir="rtl"] .cf-doc-label {
  letter-spacing: normal;
  text-transform: none;
}

.cf-doc-meta-grid {
  display: grid;
  font-size: 9px;
  gap: 2px 12px;
  grid-template-columns: auto minmax(90px, 1fr);
  justify-content: end;
  margin-block-start: 4px;
}

.cf-doc-meta-label,
.cf-doc-label {
  color: var(--doc-muted);
  font-size: 8px;
  font-weight: 700;
  letter-spacing: 0.02em;
  text-transform: uppercase;
}

.cf-doc-meta-value {
  color: var(--doc-ink-soft);
  font-weight: 500;
}

.cf-doc-ltr {
  direction: ltr;
  unicode-bidi: isolate;
}

.cf-doc-footer {
  align-items: flex-end;
  border-block-start: 1px solid var(--doc-divider);
  color: var(--doc-muted);
  display: flex;
  font-size: 8px;
  gap: 16px;
  justify-content: space-between;
  min-block-size: 42px;
  padding-block-start: 12px;
}

.cf-doc-footer-main {
  display: flex;
  flex: 1;
  flex-direction: column;
  gap: 4px;
  text-align: start;
}

.cf-doc-footer-links {
  display: flex;
  flex-wrap: wrap;
  gap: 12px;
}

.cf-doc-footer a {
  color: var(--doc-accent);
  text-decoration: none;
}

.cf-doc-footer > .cf-doc-verification {
  border: 0;
  max-inline-size: 44%;
  padding: 0;
}

.cf-doc-footer > .cf-doc-verification .cf-doc-qr {
  block-size: 58px;
  inline-size: 58px;
  padding: 3px;
}

.cf-doc-footer > .cf-doc-verification .cf-doc-verification-title {
  font-size: 8px;
}

.cf-doc-footer > .cf-doc-verification .cf-doc-verification-caption,
.cf-doc-footer > .cf-doc-verification .cf-doc-verification-key {
  font-size: 7px;
}

.cf-doc-page-number {
  direction: ltr;
  flex: none;
  unicode-bidi: isolate;
}

.cf-doc-page-current,
.cf-doc-page-total {
  font-size: inherit;
}

.cf-doc-section {
  break-inside: avoid;
}

.cf-doc-section-header {
  align-items: center;
  color: var(--doc-ink);
  display: flex;
  font-size: 12px;
  font-weight: 700;
  gap: 7px;
  line-height: 16px;
  margin: 0;
  text-transform: uppercase;
}

.cf-document-page[dir="rtl"] .cf-doc-section-header {
  text-transform: none;
}

.cf-doc-section-header::before {
  background: var(--doc-accent);
  block-size: 16px;
  content: "";
  inline-size: 3px;
}

.cf-doc-stat-row,
.cf-doc-totals {
  border: 1px solid var(--doc-divider);
  border-radius: 8px;
  display: grid;
  grid-template-columns: repeat(var(--doc-column-count, 3), minmax(0, 1fr));
  overflow: hidden;
}

.cf-doc-stat,
.cf-doc-total-item {
  background: rgb(235 246 248 / 32%);
  border-inline-end: 1px solid var(--doc-divider);
  min-inline-size: 0;
  padding: 10px;
}

.cf-doc-stat:last-child,
.cf-doc-total-item:last-child {
  border-inline-end: 0;
}

.cf-doc-stat-value,
.cf-doc-total-value {
  color: var(--doc-ink);
  direction: ltr;
  font-size: 16px;
  font-weight: 700;
  line-height: 22px;
  margin-block-start: 4px;
  unicode-bidi: isolate;
  font-variant-numeric: tabular-nums;
  overflow-wrap: anywhere;
}

.cf-doc-stat-row[style*="--doc-column-count: 6"] .cf-doc-stat-value {
  font-size: 13px;
  line-height: 18px;
}

.cf-doc-stat-detail {
  color: var(--doc-muted);
  font-size: 8px;
  margin-block-start: 2px;
}

.cf-doc-total-item[data-emphasis="strong"] {
  background: var(--doc-panel-strong);
  color: white;
}

.cf-doc-total-item[data-emphasis="strong"] .cf-doc-label,
.cf-doc-total-item[data-emphasis="strong"] .cf-doc-total-value {
  color: white;
}

.cf-doc-table-wrap {
  inline-size: 100%;
  overflow: visible;
}

.cf-doc-table {
  border-collapse: collapse;
  inline-size: 100%;
  table-layout: fixed;
}

.cf-doc-table thead {
  display: table-header-group;
}

.cf-doc-table tfoot {
  display: table-row-group;
}

.cf-doc-table th {
  background: var(--doc-panel);
  border-block: 2px solid var(--doc-ink);
  color: var(--doc-ink);
  font-size: 8px;
  font-weight: 700;
  padding-block: 8px;
  padding-inline: 8px;
  text-align: start;
  text-transform: uppercase;
}

.cf-document-page[dir="rtl"] .cf-doc-table th {
  text-transform: none;
}

.cf-doc-table td {
  border-block-end: 1px solid var(--doc-divider);
  color: var(--doc-ink-soft);
  font-size: 10px;
  padding-block: 8px;
  padding-inline: 8px;
  vertical-align: top;
  overflow-wrap: anywhere;
}

.cf-doc-table tbody tr,
.cf-doc-table tfoot tr {
  break-inside: avoid;
}

.cf-doc-table tbody tr:nth-child(even) td {
  background: rgb(243 251 255 / 58%);
}

.cf-doc-table [data-align="end"] {
  text-align: end;
}

.cf-doc-table [data-align="center"] {
  text-align: center;
}

.cf-doc-table [data-direction="ltr"] {
  direction: ltr;
  unicode-bidi: isolate;
}

.cf-doc-table tfoot td {
  background: var(--doc-panel-soft);
  border-block-start: 2px solid var(--doc-ink);
  font-size: 12px;
  font-weight: 700;
}

.cf-doc-table tfoot [data-direction="ltr"] {
  font-size: 9px;
  overflow-wrap: normal;
  padding-inline: 4px;
  white-space: nowrap;
}

.cf-doc-table-total-label {
  font-size: 9px !important;
  overflow-wrap: normal !important;
  padding-inline: 4px !important;
  white-space: nowrap;
}

.cf-doc-empty {
  color: var(--doc-muted-light);
  padding: 20px !important;
  text-align: center !important;
}

.cf-doc-grouped-tables {
  display: flex;
  flex-direction: column;
  gap: 16px;
}

.cf-doc-group-heading {
  align-items: center;
  background: var(--doc-panel);
  border-inline-start: 4px solid var(--doc-accent);
  display: flex;
  font-size: 11px;
  font-weight: 700;
  justify-content: space-between;
  padding-block: 7px;
  padding-inline: 10px;
}

.cf-doc-group-count {
  background: #cdedfb;
  border-radius: 999px;
  direction: ltr;
  font-size: 8px;
  font-weight: 600;
  padding-block: 2px;
  padding-inline: 8px;
  unicode-bidi: isolate;
}

.cf-doc-field-grid {
  border: 1px solid var(--doc-divider);
  display: grid;
  gap: 14px 20px;
  grid-template-columns: repeat(var(--doc-column-count, 2), minmax(0, 1fr));
  padding: 14px;
}

.cf-doc-field {
  min-inline-size: 0;
}

.cf-doc-field-value {
  color: var(--doc-ink-soft);
  font-size: 10px;
  font-weight: 600;
  margin-block-start: 3px;
  overflow-wrap: anywhere;
}

.cf-doc-identity-hero {
  align-items: center;
  background: var(--doc-panel-soft);
  border: 1px solid var(--doc-divider);
  border-radius: 12px;
  display: flex;
  gap: 16px;
  padding: 16px;
}

.cf-doc-avatar {
  align-items: center;
  background: var(--doc-panel-blue);
  block-size: 72px;
  border: 1px solid var(--doc-divider);
  border-radius: 8px;
  color: var(--doc-accent);
  display: flex;
  flex: none;
  font-size: 24px;
  font-weight: 800;
  inline-size: 72px;
  justify-content: center;
  object-fit: cover;
  object-position: center;
}

.cf-doc-avatar-layered {
  isolation: isolate;
  overflow: hidden;
  position: relative;
}

.cf-doc-avatar-background,
.cf-doc-avatar-foreground {
  block-size: 100%;
  inline-size: 100%;
  inset: 0;
  object-position: center;
  position: absolute;
}

.cf-doc-avatar-background {
  filter: blur(6px);
  object-fit: cover;
  opacity: 0.82;
  transform: scale(1.18);
  z-index: 0;
}

.cf-doc-avatar-foreground {
  object-fit: contain;
  z-index: 1;
}

.cf-doc-avatar-name {
  align-items: center;
  display: inline-flex;
  gap: 6px;
  max-inline-size: 100%;
  min-inline-size: 0;
  vertical-align: middle;
}

.cf-doc-list-avatar {
  background: var(--doc-panel-blue);
  block-size: 22px;
  border: 1px solid var(--doc-divider);
  border-radius: 999px;
  flex: none;
  inline-size: 22px;
  object-fit: contain;
  object-position: center;
}

.cf-doc-list-avatar-fallback {
  align-items: center;
  color: var(--doc-accent);
  display: inline-flex;
  font-size: 7px;
  font-weight: 800;
  justify-content: center;
}

.cf-doc-avatar-name-copy {
  display: flex;
  flex-direction: column;
  min-inline-size: 0;
}

.cf-doc-avatar-name-copy strong,
.cf-doc-avatar-name-copy small {
  overflow-wrap: anywhere;
}

.cf-doc-hero-main {
  flex: 1;
  min-inline-size: 0;
}

.cf-doc-hero-name {
  color: var(--doc-ink);
  font-size: 18px;
  font-weight: 800;
  margin: 0;
}

.cf-doc-hero-detail {
  color: var(--doc-muted);
  font-size: 9px;
  margin-block-start: 3px;
}

.cf-doc-callout {
  background: var(--doc-panel-blue);
  border: 1px solid var(--doc-divider);
  border-radius: 4px;
  break-inside: avoid;
  color: var(--doc-ink-soft);
  font-size: 9px;
  padding: 14px;
  text-align: start;
}

.cf-doc-callout[data-tone="neutral"] {
  background: var(--doc-panel-soft);
}

.cf-doc-callout-content {
  display: flex;
  flex-direction: column;
  gap: 6px;
  line-height: 1.55;
  margin-block-start: 5px;
  text-align: start;
  white-space: pre-wrap;
}

.cf-doc-callout-content > * {
  margin: 0;
}

.cf-doc-certifying-prose {
  border-block: 1px solid var(--doc-divider);
  color: var(--doc-ink-soft);
  font-size: 12px;
  line-height: 1.9;
  padding-block: 16px;
}

.cf-doc-generic-paragraph {
  color: var(--doc-ink);
  font-size: 12.5px;
  line-height: 1.9;
  margin-block: 0 12px;
  white-space: pre-line;
}

.cf-doc-generic-paragraph:last-child {
  margin-block-end: 0;
}

.cf-doc-checklist {
  border: 1px solid var(--doc-divider);
  display: grid;
  gap: 16px;
  grid-template-columns: repeat(var(--doc-column-count, 3), minmax(0, 1fr));
  padding: 14px;
}

.cf-doc-checklist-title {
  border-block-end: 1px solid var(--doc-accent);
  color: var(--doc-accent);
  font-size: 8px;
  font-weight: 700;
  padding-block-end: 5px;
  text-transform: uppercase;
}

.cf-document-page[dir="rtl"] .cf-doc-checklist-title {
  text-transform: none;
}

.cf-doc-checklist-items {
  display: flex;
  flex-direction: column;
  gap: 6px;
  margin-block-start: 7px;
}

.cf-doc-check-item {
  align-items: flex-start;
  color: var(--doc-muted-light);
  display: flex;
  font-size: 9px;
  gap: 6px;
}

.cf-doc-check-item[data-checked="true"] {
  color: var(--doc-ink-soft);
}

.cf-doc-checkbox {
  align-items: center;
  block-size: 12px;
  border: 1px solid var(--doc-divider);
  direction: ltr;
  display: inline-flex;
  flex: none;
  font-size: 9px;
  inline-size: 12px;
  justify-content: center;
}

.cf-doc-check-item[data-checked="true"] .cf-doc-checkbox {
  border-color: var(--doc-accent);
  color: var(--doc-accent);
}

.cf-doc-badge {
  border: 1px solid currentColor;
  border-radius: 999px;
  display: inline-flex;
  font-size: 8px;
  font-weight: 700;
  line-height: 1;
  padding-block: 4px;
  padding-inline: 8px;
  white-space: nowrap;
}

.cf-doc-badge[data-tone="success"] { color: var(--doc-success); }
.cf-doc-badge[data-tone="warning"] { color: var(--doc-warning); }
.cf-doc-badge[data-tone="danger"] { color: var(--doc-danger); }
.cf-doc-badge[data-tone="info"] { color: var(--doc-accent); }
.cf-doc-badge[data-tone="neutral"] { color: var(--doc-muted); }

.cf-doc-signatures {
  align-items: end;
  break-inside: avoid;
  display: grid;
  gap: 28px;
  grid-template-columns: repeat(var(--doc-column-count, 1), minmax(0, 1fr));
}

.cf-doc-signature-line {
  align-items: center;
  border-block-end: 1px solid var(--doc-ink);
  display: flex;
  justify-content: center;
  min-block-size: 46px;
  padding-block-end: 5px;
}

.cf-doc-signature-image {
  block-size: 42px;
  inline-size: min(150px, 100%);
  object-fit: contain;
}

.cf-doc-signature-empty {
  color: var(--doc-muted-light);
  font-size: 8px;
  text-align: center;
}

.cf-doc-signature-label {
  color: var(--doc-muted);
  font-size: 8px;
  margin-block-start: 5px;
  text-align: center;
  text-transform: uppercase;
}

.cf-document-page[dir="rtl"] .cf-doc-signature-label {
  text-transform: none;
}

.cf-doc-stamp-slot {
  align-items: center;
  border: 1px dashed var(--doc-divider);
  color: var(--doc-muted-light);
  display: flex;
  font-size: 8px;
  justify-content: center;
  min-block-size: 54px;
}

.cf-doc-verification {
  align-items: center;
  border: 1px solid var(--doc-divider);
  break-inside: avoid;
  display: flex;
  gap: 10px;
  padding: 8px;
  text-align: start;
}

.cf-doc-verification > div {
  min-inline-size: 0;
  text-align: start;
}

.cf-document-page[dir="rtl"] .cf-doc-callout,
.cf-document-page[dir="rtl"] .cf-doc-callout-content,
.cf-document-page[dir="rtl"] .cf-doc-verification,
.cf-document-page[dir="rtl"] .cf-doc-verification > div,
.cf-document-page[dir="rtl"] .cf-doc-footer-main {
  direction: rtl;
  text-align: start;
}

.cf-document-page[dir="ltr"] .cf-doc-callout,
.cf-document-page[dir="ltr"] .cf-doc-callout-content,
.cf-document-page[dir="ltr"] .cf-doc-verification,
.cf-document-page[dir="ltr"] .cf-doc-verification > div,
.cf-document-page[dir="ltr"] .cf-doc-footer-main {
  direction: ltr;
  text-align: start;
}

.cf-doc-qr {
  background: white;
  block-size: 96px;
  border: 1px solid var(--doc-divider);
  flex: none;
  inline-size: 96px;
  object-fit: contain;
  padding: 5px;
}

.cf-doc-verification-title {
  color: var(--doc-ink);
  font-size: 10px;
  font-weight: 800;
}

.cf-doc-verification-caption,
.cf-doc-verification-key {
  color: var(--doc-muted);
  font-size: 8px;
  margin-block-start: 3px;
}

@media screen and (max-width: 900px) {
  .cf-document-surface {
    justify-content: flex-start;
    overflow: auto;
    padding: 12px;
  }
}

@media print {
  html,
  body {
    background: white !important;
    margin: 0 !important;
    padding: 0 !important;
  }

  body:has(.cf-document-print-root) * {
    visibility: hidden;
  }

  body:has(.cf-document-print-root) .cf-document-print-root,
  body:has(.cf-document-print-root) .cf-document-print-root * {
    visibility: visible;
  }

  .cf-document-print-root,
  .cf-document-surface {
    background: white;
    display: block;
    margin: 0;
    padding: 0;
  }

  .cf-document-print-root {
    inset: 0;
    position: absolute;
  }

  .cf-document-page {
    box-shadow: none;
    break-after: auto;
    margin: 0;
    min-block-size: calc(var(--doc-page-block) - 7mm);
  }

  .cf-document-watermark {
    position: fixed;
  }

  .cf-document-page[lang="en"][data-orientation="portrait"] { page: document-en-portrait; }
  .cf-document-page[lang="ar"][data-orientation="portrait"] { page: document-ar-portrait; }
  .cf-document-page[lang="en"][data-orientation="landscape"] { page: document-en-landscape; }
  .cf-document-page[lang="ar"][data-orientation="landscape"] { page: document-ar-landscape; }

  /* Restore the document engine after the legacy application-report print
     rules in globals.css. Preview, browser Print, and Chromium PDF therefore
     retain the same semantic header, footer, pagination, and table geometry. */
  .cf-document-print-root header.cf-doc-header {
    display: flex !important;
  }

  .cf-document-print-root nav.cf-doc-footer-links {
    display: flex !important;
  }

  .cf-document-print-root main.cf-document-body {
    display: flex !important;
    padding-block: 8mm !important;
  }

  .cf-document-print-root table.cf-document-pagination {
    background: transparent !important;
    border: 0 !important;
    color: inherit !important;
    font-size: inherit !important;
    min-block-size: calc(var(--doc-page-block) - 7mm) !important;
    table-layout: fixed !important;
  }

  .cf-document-print-root .cf-document-pagination > thead > tr > td {
    background: transparent !important;
    border: 0 !important;
    color: inherit !important;
    padding-block: 0 !important;
    padding-block-start: 15mm !important;
    padding-inline: 15mm !important;
  }

  .cf-document-print-root .cf-document-pagination > tbody > tr > td {
    background: transparent !important;
    border: 0 !important;
    color: inherit !important;
    padding-block: 0 !important;
    padding-inline: 15mm !important;
    vertical-align: top !important;
  }

  .cf-document-print-root .cf-document-pagination > tfoot > tr > td {
    background: transparent !important;
    border: 0 !important;
    color: inherit !important;
    padding-block: 0 !important;
    padding-block-end: 5mm !important;
    padding-inline: 15mm !important;
    vertical-align: bottom !important;
  }

  .cf-document-print-root table.cf-doc-table {
    background: transparent !important;
    border: 0 !important;
    color: inherit !important;
    font-size: inherit !important;
    table-layout: fixed !important;
  }

  .cf-document-print-root .cf-doc-table th {
    background: var(--doc-panel) !important;
    border-block: 2px solid var(--doc-ink) !important;
    border-inline: 0 !important;
    color: var(--doc-ink) !important;
    font-size: 8px !important;
    padding-block: 8px !important;
    padding-inline: 8px !important;
  }

  .cf-document-print-root .cf-doc-table td {
    background: transparent !important;
    border-block-end: 1px solid var(--doc-divider) !important;
    border-inline: 0 !important;
    color: var(--doc-ink-soft) !important;
    font-size: 10px !important;
    padding-block: 8px !important;
    padding-inline: 8px !important;
  }

  .cf-document-print-root .cf-doc-table tbody tr:nth-child(even) td {
    background: rgb(243 251 255 / 58%) !important;
  }

  .cf-document-print-root .cf-doc-table tfoot td {
    background: var(--doc-panel-soft) !important;
    border-block-start: 2px solid var(--doc-ink) !important;
    font-size: 9px !important;
  }

  .cf-doc-section,
  .cf-doc-stat,
  .cf-doc-total-item,
  .cf-doc-callout,
  .cf-doc-identity-hero,
  .cf-doc-verification,
  .cf-doc-signatures {
    break-inside: avoid;
  }

  .cf-doc-page-number {
    display: none;
  }
}
`;
