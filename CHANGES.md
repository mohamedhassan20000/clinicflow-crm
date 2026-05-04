Read CLAUDE.md and PRD.md before starting. This is an existing project — do NOT scaffold anything new. Apply only the changes listed below, section by section. After each section, pause and confirm before moving to the next.

---

## SECTION 1 — ADMIN DASHBOARD

1. **Deduplication:** Audit all data rendered on the dashboard. If any item (card, stat, chart, list entry) appears more than once, keep only one instance and remove the duplicates.

2. **Dark mode text fix:** Any text, numbers, or labels currently hardcoded in black (`text-black`, `#000`, `gray-900` etc.) must switch to white in dark mode and return to black in light mode. Apply this fix globally across the entire admin dashboard — use Tailwind's `dark:` variant or the existing theme class pattern used in the project.

3. **Receptionist performance chart:** Add a chart for receptionists on the admin dashboard — identical in design and data structure to the existing doctors chart on the same page, but for receptionists. This chart must span the full page width.

4. **All dashboard charts — add percentages:** For every chart currently on the admin dashboard, if it shows counts/numbers and percentages are meaningful, display both the count and the percentage (e.g., inside tooltip, inside pie slice, or as a label next to the bar).

5. **Follow-up outcome chart (Admin):** Add a new chart to the admin dashboard showing follow-up results across the entire clinic. It must:
   - Show: % of follow-ups marked "All Fine" vs % marked "Has Problem"
   - Support filtering by: Entire Clinic / Department / Doctor
   - Display both count and percentage for each segment
   - Use the same chart style/component as the rest of the dashboard

---

## SECTION 2 — PATIENTS PAGE (Admin)

1. **Table column alignment:** Ensure all table rows and columns across the patients page are visually aligned — columns should line up vertically even if there are multiple separate tables on the same page. Use consistent column widths.

2. **Follow-ups page tables:** Apply the same column alignment fix to all tables on the follow-ups page. Every column must be consistently positioned across all tables on that page.

---

## SECTION 3 — REVENUE PAGE (Admin)

1. **Print statement — total placement:** When printing a revenue statement, the "Total" row must appear only on the last page of the printed document, not repeated at the bottom of every page. Fix the print CSS/logic accordingly.

---

## SECTION 4 — SETTINGS PAGE (Admin)

1. **Soft delete / Recycle Bin:** For the following sections: **Staff, Insurance Providers, Services, Departments** — replace permanent deletion with soft delete:
   - Deleted items go to a "Recycle Bin" (trash) specific to each section
   - Items stay in the bin for **30 days**, then are permanently deleted automatically
   - Each section should have a way to view its trash and restore items within the 30-day window
   - Add a visible trash/bin icon or tab per section

2. **Table column alignment:** Apply the same column alignment fix described in Section 2 to all tables across all sections of the Settings page (Staff, Insurance, Services, Departments). Columns must be consistently aligned and visually balanced.

---

## SECTION 5 — APPOINTMENTS PAGE (Admin) + SETTINGS PAGE

1. **Undo after delete or status change:** After any of the following actions:
   - Deleting an appointment
   - Deleting any item in Settings (Staff / Insurance / Services / Departments)
   - Changing an appointment's status

   Show a toast/snackbar with an **Undo** button that is active for **10 seconds**. If clicked, reverse the action. After 10 seconds, finalize the action permanently.

---

## SECTION 6 — MANAGER DASHBOARD

1. **Dark mode text fix:** Same fix as admin — all black text, numbers, and lines must become white in dark mode and return to black in light mode. Apply globally across the manager dashboard.

2. **Receptionist performance chart:** Add the same receptionist performance chart from Section 1 (item 3) to the manager dashboard as well.

3. **Follow-up outcome chart (Manager):** Add the same follow-up chart from Section 1 (item 5) to the manager dashboard — same filtering options (Clinic / Department / Doctor), same layout.

4. **Settings page for Manager:** Add a full Settings page for the manager role — same structure and sections as the admin settings page (Staff, Insurance, Services, Departments, with soft delete and recycle bin).

---

## SECTION 7 — DOCTOR ROLE

### Dashboard

1. **Follow-up outcome chart (Doctor):** Add a chart to the doctor's dashboard showing:
   - % of their own patients' follow-ups marked "All Fine" vs "Has Problem"
   - Display both count and percentage
   - Scoped to this doctor's patients only

### Patients Page

2. **Scope patient search to department:** When a doctor searches for patients, only show patients who belong to the doctor's own department. Do not show patients from other departments.

### Appointments Page

3. **Remove department filter:** Remove the department filter option from the appointments search/filter UI — it's irrelevant since the doctor only sees their own appointments.
4. **Scope appointments to logged-in doctor:** Ensure all appointment queries on this page are filtered to the currently authenticated doctor. No other doctor's appointments should appear regardless of search input.

### Follow-ups Page

5. **Remove department filter:** Remove the ability to filter by department name on the follow-ups page.
6. **Scope to doctor's department and patients:** Only show follow-ups for the doctor's own department and their own patients. No cross-department data should be visible.

---

## EXECUTION RULES

- Do NOT rewrite working code unnecessarily — make targeted, minimal changes
- Preserve all existing functionality
- After finishing each numbered section, output a short summary of what was changed and ask for approval before proceeding to the next section
- If a change requires a DB migration or new column (e.g., `deleted_at` for soft delete), generate the migration file and mention it explicitly
- Use the same component patterns, naming conventions, and styling system already in use in the project
