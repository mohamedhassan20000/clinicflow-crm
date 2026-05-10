export function formatDoctorName(name: string | null | undefined) {
  if (!name) return "—";
  const trimmed = name.trim();
  const withoutTitle = trimmed.replace(/^(?:dr\.?\s*)+/i, "").trim();
  return withoutTitle ? `Dr. ${withoutTitle}` : "Dr.";
}

export function formatDoctorFirstName(name: string | null | undefined) {
  const formatted = formatDoctorName(name);
  if (formatted === "—") return formatted;
  const withoutTitle = formatted.replace(/^dr\.?\s+/i, "");
  return `Dr. ${withoutTitle.split(" ")[0]}`;
}
