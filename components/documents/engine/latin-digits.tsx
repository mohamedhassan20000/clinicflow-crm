import {
  Children,
  cloneElement,
  isValidElement,
  type ReactElement,
  type ReactNode,
} from "react";
import { toLatinDigits } from "@/lib/documents/format";

/**
 * Normalizes every textual leaf in the document tree before either React DOM
 * preview or static PDF rendering. Formatters already emit `nu-latn`; this
 * closes the remaining gap for identifiers and authored text that may contain
 * Arabic-Indic digit code points.
 */
export function normalizeDocumentDigits<Value>(value: Value): Value {
  return normalizeValue(value, new WeakMap<object, unknown>()) as Value;
}

function normalizeValue(value: unknown, seen: WeakMap<object, unknown>): unknown {
  if (typeof value === "string") return toLatinDigits(value);
  if (value == null || typeof value !== "object") return value;

  if (isValidElement(value)) {
    const element = value as ReactElement<Record<string, unknown>>;
    const { children, ...rest } = element.props;
    const props = normalizeValue(rest, seen) as Record<string, unknown>;
    if (!("children" in element.props)) return cloneElement(element, props);
    const normalizedChildren = Children.map(
      Children.toArray(children as ReactNode),
      (child) => normalizeValue(child, seen) as ReactNode,
    );
    return cloneElement(element, props, normalizedChildren);
  }

  if (seen.has(value)) return seen.get(value);

  if (Array.isArray(value)) {
    const normalized: unknown[] = [];
    seen.set(value, normalized);
    for (const item of value) normalized.push(normalizeValue(item, seen));
    return normalized;
  }

  if (Object.getPrototypeOf(value) !== Object.prototype) return value;
  const normalized: Record<string, unknown> = {};
  seen.set(value, normalized);
  for (const [key, item] of Object.entries(value)) {
    normalized[key] = normalizeValue(item, seen);
  }
  return normalized;
}
