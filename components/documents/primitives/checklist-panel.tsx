export type ChecklistGroup = {
  title: string;
  items: readonly { id: string; label: string; checked: boolean }[];
};

export function ChecklistPanel({ groups }: { groups: readonly ChecklistGroup[] }) {
  if (groups.length === 0) return null;
  return (
    // i18n-allow: document CSS class tokens, not user-facing copy
    <section
      className={"cf-doc-checklist cf-doc-section" /* i18n-allow: document CSS class tokens, not user-facing copy */}
      style={{ "--doc-column-count": Math.min(groups.length, 3) } as React.CSSProperties}
      data-testid="checklist-panel"
    >
      {groups.map((group) => (
        <div key={group.title}>
          <div className="cf-doc-checklist-title">{group.title}</div>
          <div className="cf-doc-checklist-items">
            {group.items.map((item) => (
              <div className="cf-doc-check-item" data-checked={item.checked} key={item.id}>
                <span className="cf-doc-checkbox" aria-hidden>{item.checked ? "✓" : ""}</span>
                <span>{item.label}</span>
              </div>
            ))}
          </div>
        </div>
      ))}
    </section>
  );
}
