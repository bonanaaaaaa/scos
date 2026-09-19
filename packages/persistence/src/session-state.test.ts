/**
 * Static guard: no session-scoped database state (#28, ADR 0005).
 *
 * Cloudflare Hyperdrive pools in transaction mode. A client holds an origin
 * connection only for one transaction, and the connection is reset when it
 * goes back to the pool. So whatever a statement leaves on the session can be
 * missing on the next checkout, or can reach another client before the reset.
 * test/transaction-pooling.integration.test.ts proves the current behaviour
 * against real PostgreSQL. This guard keeps new session state out of the
 * package's SQL:
 *
 * - `set_config(name, value, is_local)` unless `is_local` is literally `true`
 * - a statement starting with `SET` other than `SET LOCAL` or `SET TRANSACTION`
 *   (`UPDATE ... SET` and `DO UPDATE SET` do not start a statement)
 * - session advisory locks: `pg_advisory_lock`, `pg_advisory_unlock`,
 *   `pg_try_advisory_lock` and their `_shared`/`_all` forms (the `_xact_`
 *   variants end with the transaction and are fine)
 * - `LISTEN`, `UNLISTEN`, `NOTIFY` and `pg_notify()`
 * - `PREPARE` and `DEALLOCATE` statements
 * - `CREATE TEMP` or `CREATE TEMPORARY` objects
 * - `DECLARE ... CURSOR WITH HOLD`
 *
 * Scope: the non-test, non-generated TypeScript sources of
 * packages/persistence/src, where all of the repository's raw SQL lives.
 * apps/api/src has no raw SQL today and is not scanned; extend the scan if
 * that changes. It reads the text of string and template literals: TypeScript
 * comments, identifiers (`server.listen()`, a `set` accessor) and regex
 * literals are skipped by a small lexer, and each `${...}` interpolation
 * becomes `$X`.
 *
 * Statement-start rules (`SET`, `LISTEN`, `UNLISTEN`, `NOTIFY`, `PREPARE`,
 * `DEALLOCATE`) match UPPERCASE keywords only, because the repository writes
 * SQL keywords in uppercase and every literal is scanned, including ordinary
 * messages such as "Set up the database first." Lowercase SQL (`set x = 1`)
 * is therefore not caught; keep SQL keywords uppercase. SQL comments
 * (`-- ...` to end of line and `/* ... *\/`, outside single-quoted strings)
 * are stripped before these rules run, so `-- note\nSET x = 1` is caught.
 * Function-style rules (`set_config`, `pg_advisory_*`, `pg_notify`) and the
 * remaining keyword rules match in any case: they are specific enough not to
 * appear in prose.
 *
 * @module
 */

import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, test } from "vitest";

const sourceDirectory = fileURLToPath(new URL(".", import.meta.url));

/** The text of one string or template literal and the line it starts on. */
interface Literal {
  readonly text: string;
  readonly line: number;
}

/** Characters after which a `/` starts a regex literal rather than a division. */
const REGEX_PRECEDERS = new Set("(,=:[!&|?{};+-*%<>~^");
const REGEX_KEYWORDS = /(?:^|[^\w$])(?:return|typeof|case|do|else|in|of|void|yield|await)$/;

/**
 * Extracts every string and template literal from TypeScript source. A small
 * lexer, not a parser: enough to skip comments and regex literals and to
 * follow nested `${...}` interpolations. Throws on an unterminated literal.
 */
function extractLiterals(source: string): Literal[] {
  const literals: Literal[] = [];
  const lineAt = (index: number) => source.slice(0, index).split("\n").length;

  const readQuoted = (start: number): number => {
    const quote = source[start];
    let text = "";
    let i = start + 1;
    while (i < source.length && source[i] !== quote) {
      if (source[i] === "\\") {
        text += source.slice(i, i + 2);
        i += 2;
      } else {
        text += source[i];
        i += 1;
      }
    }
    if (i >= source.length) {
      throw new SyntaxError(`Unterminated string literal at line ${lineAt(start)}`);
    }
    literals.push({ text, line: lineAt(start) });
    return i + 1;
  };

  const readRegex = (start: number): number => {
    let i = start + 1;
    let inClass = false;
    while (i < source.length && source[i] !== "\n") {
      const char = source[i];
      if (char === "\\") {
        i += 2;
        continue;
      }
      if (char === "[") inClass = true;
      else if (char === "]") inClass = false;
      else if (char === "/" && !inClass) return i + 1;
      i += 1;
    }
    throw new SyntaxError(`Unterminated regex literal at line ${lineAt(start)}`);
  };

  // Scans code until the end, or until the `}` closing an interpolation.
  const readCode = (start: number, inInterpolation: boolean): number => {
    let depth = 0;
    let previous = "";
    let i = start;
    while (i < source.length) {
      const char = source[i] as string;
      const next = source[i + 1];
      if (char === "/" && next === "/") {
        const end = source.indexOf("\n", i);
        i = end === -1 ? source.length : end;
      } else if (char === "/" && next === "*") {
        const end = source.indexOf("*/", i + 2);
        if (end === -1) throw new SyntaxError(`Unterminated comment at line ${lineAt(i)}`);
        i = end + 2;
      } else if (/\s/.test(char)) {
        i += 1;
      } else {
        if (char === "'" || char === '"') {
          i = readQuoted(i);
        } else if (char === "`") {
          i = readTemplate(i);
        } else if (
          char === "/" &&
          (previous === "" ||
            REGEX_PRECEDERS.has(previous) ||
            REGEX_KEYWORDS.test(source.slice(Math.max(0, i - 12), i).trimEnd()))
        ) {
          i = readRegex(i);
        } else {
          if (char === "{") depth += 1;
          if (char === "}") {
            if (depth === 0 && inInterpolation) return i + 1;
            depth -= 1;
          }
          i += 1;
        }
        previous = char;
      }
    }
    if (inInterpolation) {
      throw new SyntaxError(`Unterminated template interpolation at line ${lineAt(start)}`);
    }
    return i;
  };

  const readTemplate = (start: number): number => {
    let text = "";
    let i = start + 1;
    while (i < source.length && source[i] !== "`") {
      if (source[i] === "\\") {
        text += source.slice(i, i + 2);
        i += 2;
      } else if (source[i] === "$" && source[i + 1] === "{") {
        text += "$X";
        i = readCode(i + 2, true);
      } else {
        text += source[i];
        i += 1;
      }
    }
    if (i >= source.length) {
      throw new SyntaxError(`Unterminated template literal at line ${lineAt(start)}`);
    }
    literals.push({ text, line: lineAt(start) });
    return i + 1;
  };

  readCode(0, false);
  return literals;
}

/** Splits the arguments of the call whose `(` is at `open`; undefined if unclosed. */
function callArguments(sql: string, open: number): string[] | undefined {
  const args: string[] = [];
  let depth = 0;
  let current = "";
  let quoted = false;
  for (let i = open + 1; i < sql.length; i += 1) {
    const char = sql[i] as string;
    if (char === "'") quoted = !quoted;
    if (!quoted && char === "(") depth += 1;
    if (!quoted && char === ")") {
      if (depth === 0) return [...args, current];
      depth -= 1;
    }
    if (!quoted && char === "," && depth === 0) {
      args.push(current);
      current = "";
    } else {
      current += char;
    }
  }
  return undefined;
}

/**
 * Rules that apply to the start of each statement (the text and after every
 * `;`, once SQL comments are stripped). Case-sensitive: UPPERCASE keywords
 * only, so prose such as "Set up ..." or "Prepare ..." in a message does not
 * match.
 */
const STATEMENT_START_RULES: readonly (readonly [string, RegExp])[] = [
  ["session SET (use SET LOCAL or set_config(..., true))", /^SET\s+(?!LOCAL\b|TRANSACTION\b)/],
  ["LISTEN/UNLISTEN/NOTIFY", /^(?:UN)?LISTEN\b|^NOTIFY\b/],
  ["PREPARE/DEALLOCATE", /^(?:PREPARE|DEALLOCATE)\b/],
];

/**
 * Removes SQL comments (`-- ...` to end of line, `/* ... *\/`) outside
 * single-quoted strings. The newline ending a line comment is kept; an
 * unterminated block comment runs to the end.
 */
function stripSqlComments(sql: string): string {
  let result = "";
  let quoted = false;
  let i = 0;
  while (i < sql.length) {
    const char = sql[i] as string;
    const next = sql[i + 1];
    if (!quoted && char === "-" && next === "-") {
      const end = sql.indexOf("\n", i);
      i = end === -1 ? sql.length : end;
    } else if (!quoted && char === "/" && next === "*") {
      const end = sql.indexOf("*/", i + 2);
      i = end === -1 ? sql.length : end + 2;
      result += " ";
    } else {
      if (char === "'") quoted = !quoted;
      result += char;
      i += 1;
    }
  }
  return result;
}

/** Rules that apply anywhere in the SQL. */
const ANYWHERE_RULES: readonly (readonly [string, RegExp])[] = [
  [
    "session advisory lock (use the _xact_ variant)",
    /\bpg_(?:try_)?advisory_(?:lock|unlock)(?:_shared|_all)?\b/i,
  ],
  ["pg_notify()", /\bpg_notify\s*\(/i],
  ["temporary object", /\bCREATE\s+(?:(?:GLOBAL|LOCAL)\s+)?TEMP(?:ORARY)?\b/i],
  ["cursor WITH HOLD", /\bDECLARE\b[^;]*?\bCURSOR\s+WITH\s+HOLD\b/i],
];

/** The session-state rules one literal's SQL breaks, by name. */
function findSessionState(sql: string): string[] {
  const found: string[] = [];
  const code = stripSqlComments(sql);
  const starts = [0];
  for (let i = code.indexOf(";"); i !== -1; i = code.indexOf(";", i + 1)) starts.push(i + 1);
  for (const start of starts) {
    const statement = code.slice(start).trimStart();
    for (const [name, pattern] of STATEMENT_START_RULES) {
      if (pattern.test(statement)) found.push(name);
    }
  }
  for (const [name, pattern] of ANYWHERE_RULES) {
    if (pattern.test(sql)) found.push(name);
  }
  for (const match of sql.matchAll(/\bset_config\s*\(/gi)) {
    const args = callArguments(sql, match.index + match[0].length - 1);
    if (args?.length !== 3 || args[2]?.trim().toLowerCase() !== "true") {
      found.push("set_config not transaction-local (is_local must be true)");
    }
  }
  return found;
}

/** Every session-state violation in TypeScript source, as `line: rule`. */
function scanSource(source: string): string[] {
  return extractLiterals(source).flatMap(({ text, line }) =>
    findSessionState(text).map((rule) => `${line}: ${rule}`),
  );
}

function productionSources(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      return entry.name === "generated" ? [] : productionSources(path);
    }
    return entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts") ? [path] : [];
  });
}

describe("the session-state matcher", () => {
  test.each([
    ["tx.$queryRaw`SELECT set_config('lock_timeout', ${value}, false)`", "set_config"],
    ["pool.query(\"SELECT set_config('lock_timeout', '1s', FALSE)\")", "set_config"],
    ["pool.query(\"SELECT set_config('a', '1', ${isLocal})\")", "set_config"],
    ["pool.query(\"SELECT set_config('a', '1')\")", "set_config"],
    ["pool.query(\"SET lock_timeout = '1s'\")", "session SET"],
    ["pool.query('SET search_path = public')", "session SET"],
    ["sql`BEGIN; SET statement_timeout TO 5000`", "session SET"],
    ["sql`\n  SET SESSION lock_timeout = 1`", "session SET"],
    ["sql`SELECT pg_advisory_lock(1)`", "session advisory lock"],
    ["sql`SELECT pg_advisory_unlock(${key})`", "session advisory lock"],
    ["sql`SELECT pg_try_advisory_lock(1)`", "session advisory lock"],
    ["sql`SELECT pg_advisory_lock_shared(1)`", "session advisory lock"],
    ["sql`SELECT pg_advisory_unlock_all()`", "session advisory lock"],
    ["pool.query('LISTEN orders')", "LISTEN/UNLISTEN/NOTIFY"],
    ["pool.query('UNLISTEN *')", "LISTEN/UNLISTEN/NOTIFY"],
    ["pool.query(\"NOTIFY orders, 'x'\")", "LISTEN/UNLISTEN/NOTIFY"],
    ["pool.query(\"SELECT pg_notify('orders', 'x')\")", "pg_notify()"],
    ["pool.query('PREPARE lookup AS SELECT 1')", "PREPARE/DEALLOCATE"],
    ["pool.query('DEALLOCATE ALL')", "PREPARE/DEALLOCATE"],
    ["sql`CREATE TEMP TABLE scratch (id int)`", "temporary object"],
    ["sql`CREATE TEMPORARY TABLE scratch (id int)`", "temporary object"],
    ["sql`CREATE GLOBAL TEMPORARY TABLE scratch (id int)`", "temporary object"],
    ["sql`DECLARE c CURSOR WITH HOLD FOR SELECT 1`", "cursor WITH HOLD"],
    ["sql`DECLARE c NO SCROLL CURSOR WITH HOLD FOR SELECT 1`", "cursor WITH HOLD"],
    ["const a = `x ${`${b}` + 'SET lock_timeout = 1'} y`;", "session SET"],
    // Uppercase keywords are matched whatever the case of the rest.
    ['pool.query("SET search_path TO my_schema, public")', "session SET"],
    ["sql`select 1; LISTEN orders`", "LISTEN/UNLISTEN/NOTIFY"],
    // SQL comments before a statement do not hide it.
    ["sql`-- note\nSET x = 1`", "session SET"],
    ["sql`/* note */ SET x = 1`", "session SET"],
    ["sql`SELECT 1; -- note\n  PREPARE p AS SELECT 1`", "PREPARE/DEALLOCATE"],
    // `--` inside a quoted SQL string is not a comment.
    ["sql`SELECT '--'; SET x = 1`", "session SET"],
  ])("flags %s", (source, rule) => {
    const found = scanSource(source);
    expect(found).toHaveLength(1);
    expect(found[0]).toContain(rule);
  });

  test.each([
    "tx.$queryRaw`SELECT set_config('lock_timeout', ${`${ms}ms`}, true)`",
    "pool.query(\"SELECT set_config('a', format('%s', 'b'), TRUE)\")",
    "sql`SET LOCAL lock_timeout = '1s'`",
    "sql`SET TRANSACTION ISOLATION LEVEL READ COMMITTED`",
    "sql`BEGIN; SET LOCAL statement_timeout = 5000`",
    "sql`\n  UPDATE warehouses\n  SET stock = stock - ${quantity}\n  WHERE id = ${id}`",
    "sql`INSERT INTO t (id) VALUES (1) ON CONFLICT (id) DO UPDATE SET id = excluded.id`",
    "sql`SELECT pg_advisory_xact_lock(1)`",
    "sql`SELECT pg_try_advisory_xact_lock(1)`",
    "// SET lock_timeout = '1s' and LISTEN orders, in a comment",
    "/* SELECT pg_advisory_lock(1); CREATE TEMP TABLE t */",
    "server.listen(3000); notify(); class A { set value(v) {} }",
    "const re = /'SET x = 1'/; const s = 'SELECT 1';",
    "sql`DECLARE c CURSOR WITHOUT HOLD FOR SELECT 1`",
    "sql`CREATE TABLE temp_orders (id int)`",
    "sql`SELECT 'reset' AS settings_note`",
    // Prose in messages: statement-start keywords must be UPPERCASE.
    "throw new Error('Set up the database first.')",
    "const hint = 'Prepare the seed data; Listen for errors.'",
    // Documented limit: lowercase SQL keywords are not caught.
    "pool.query('set search_path = public')",
    "sql`SELECT 1 -- SET x = 1`",
  ])("allows %s", (source) => {
    expect(scanSource(source)).toStrictEqual([]);
  });

  test("reads literals across comments, escapes and nested interpolations", () => {
    const source = [
      "// 'not a string'",
      "const a = 'it\\'s';",
      "/* `not a template` */",
      "const b = `outer ${f(`inner ${c}`, { d: '}' })} end`;",
    ].join("\n");
    expect(extractLiterals(source)).toStrictEqual([
      { text: "it\\'s", line: 2 },
      { text: "inner $X", line: 4 },
      { text: "}", line: 4 },
      { text: "outer $X end", line: 4 },
    ]);
    expect(() => extractLiterals("const a = `open ${b")).toThrow(SyntaxError);
  });
});

describe("persistence sources", () => {
  const files = productionSources(sourceDirectory);
  const scanned = new Map(
    files.map((path) => [relative(sourceDirectory, path), readFileSync(path, "utf8")]),
  );

  test("are scanned, including the submission store's SQL", () => {
    expect([...scanned.keys()]).toContain("submission-store.ts");
    expect([...scanned.keys()].some((path) => path.startsWith("generated/"))).toBe(false);
    expect([...scanned.keys()].some((path) => path.endsWith(".test.ts"))).toBe(false);
    // The store's timeouts and its UPDATE ... SET are seen, and pass.
    const storeSql = extractLiterals(scanned.get("submission-store.ts") ?? "").map((l) => l.text);
    expect(storeSql.some((sql) => /set_config\('lock_timeout', \$X, true\)/.test(sql))).toBe(true);
    expect(storeSql.some((sql) => /UPDATE warehouses\s+SET stock/.test(sql))).toBe(true);
  });

  test("hold no session state a transaction-mode pooler would break", () => {
    const violations = [...scanned].flatMap(([path, source]) =>
      scanSource(source).map((violation) => `${path}:${violation}`),
    );
    expect(violations).toStrictEqual([]);
  });
});
