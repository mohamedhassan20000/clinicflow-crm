/**
 * Prompt-injection and abuse defenses (§9.4). These are defense-in-depth: real
 * enforcement is that tool authorization lives in code at the data layer (§9.1)
 * and the doctor persona mounts only its own read-only tools. The exhaustive
 * adversarial corpus is P6A; this module provides the runtime primitives those
 * suites and the P4B route rely on.
 */

/**
 * Wraps untrusted content (tool results, and later patient messages) in a
 * clearly delimited, role-tagged block so instructions embedded inside it are
 * treated as data, never as directives to the model.
 */
export function wrapUntrustedContent(source: string, content: string): string {
  const tag = source.replace(/[^a-z0-9_-]/gi, "_").toUpperCase();
  return `<untrusted source="${tag}">\n${content}\n</untrusted>`;
}

// Common override/injection phrasings in English and Arabic. Used to flag a
// turn for review — not to hard-block, since false positives are possible.
const INJECTION_PATTERNS: RegExp[] = [
  /ignore (all |your |the )?(previous|prior|above) (instructions|rules|prompt)/i,
  /disregard (all |your |the )?(previous|prior|above)/i,
  /you are now (a|an|the)/i,
  /system prompt/i,
  /reveal (your |the )?(system )?(prompt|instructions)/i,
  /developer mode/i,
  /تجاهل (كل )?(التعليمات|الأوامر|القواعد)/,
  /تصرف كأنك/,
  /اكشف (عن )?(التعليمات|النظام)/,
];

export function detectInjectionAttempt(input: string): boolean {
  if (!input) return false;
  return INJECTION_PATTERNS.some((re) => re.test(input));
}

// Emergency signals route to a canned response with clinic + local emergency
// contacts (patient side, P5). Exposed here so both personas share one list.
const EMERGENCY_PATTERNS: RegExp[] = [
  /\b(emergency|ambulance|heart attack|stroke|bleeding|unconscious|can'?t breathe)\b/i,
  /(طوارئ|إسعاف|نزيف|فاقد الوعي|لا أستطيع التنفس|أزمة قلبية)/,
];

export function detectEmergency(input: string): boolean {
  if (!input) return false;
  return EMERGENCY_PATTERNS.some((re) => re.test(input));
}
