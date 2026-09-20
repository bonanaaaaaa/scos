/**
 * The titles of table-driven tests.
 *
 * Playwright has no `test.each`, so a table is an ordinary `for` loop around
 * `test()` at the call site — deliberately at the call site, because
 * Playwright takes a test's reported source location from wherever `test()`
 * was called, and a shared helper would point every one of these ~190 cases
 * at this file instead of at its own table.
 *
 * What is shared is only the title, built from the same printf-style template
 * Vitest's `test.each` used. The titles are reproduced rather than reinvented
 * on purpose: they are how each case is identified in a report, and a runner
 * migration must not rename tests.
 *
 * `%s`, `%d`, `%i`, `%f`, `%j`, `%o`, `%O` and `%%` are supported, which is
 * every placeholder this suite uses; anything else is rejected rather than
 * printed wrong. Values are formatted the way Vitest formatted them, which
 * for `%o` means loupe's rendering — hence `+0` for positive zero.
 *
 * @module
 */

function inspectNumber(value: number): string {
  if (value === 0) {
    return Object.is(value, -0) ? "-0" : "+0";
  }
  return String(value);
}

/** Loupe's rendering, for the values these tables hold. */
function inspect(value: unknown): string {
  if (typeof value === "string") {
    return `'${value}'`;
  }
  if (typeof value === "number") {
    return inspectNumber(value);
  }
  if (typeof value === "bigint") {
    return `${value}n`;
  }
  if (value === null || value === undefined || typeof value !== "object") {
    return String(value);
  }
  if (Array.isArray(value)) {
    return value.length === 0 ? "[]" : `[ ${value.map(inspect).join(", ")} ]`;
  }
  const entries = Object.entries(value).map(([key, entry]) => `${key}: ${inspect(entry)}`);
  return entries.length === 0 ? "{}" : `{ ${entries.join(", ")} }`;
}

function formatValue(placeholder: string, value: unknown): string {
  switch (placeholder) {
    case "s":
      return typeof value === "string" ? value : inspect(value);
    case "d":
    case "i":
      return typeof value === "bigint" ? String(value) : String(Math.trunc(Number(value)));
    case "f":
      return String(Number(value));
    case "j":
      return JSON.stringify(value) ?? "undefined";
    case "o":
    case "O":
      return inspect(value);
    default:
      throw new Error(`Unsupported title placeholder %${placeholder}`);
  }
}

/** The title Vitest's `test.each` would have produced for `template` and `values`. */
export function formatTitle(template: string, values: readonly unknown[]): string {
  let next = 0;
  return template.replaceAll(/%(.)/g, (match, placeholder: string) => {
    if (placeholder === "%") {
      return "%";
    }
    if (next >= values.length) {
      return match;
    }
    const value = values[next];
    next += 1;
    return formatValue(placeholder, value);
  });
}
