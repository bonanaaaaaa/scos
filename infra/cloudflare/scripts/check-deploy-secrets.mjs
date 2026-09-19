// Fails when the shared deploy workflow reads a secret outside the allow-list,
// or the secrets context as a whole. deploy-prod.yml passes `secrets: inherit`,
// so deploy.yml could otherwise read any repository secret (#15).
//
// Usage: node infra/cloudflare/scripts/check-deploy-secrets.mjs [workflow]
import { readFileSync } from "node:fs";

const path = process.argv[2] ?? ".github/workflows/deploy.yml";
const allowed = new Set([
  "R2_ACCESS_KEY_ID",
  "R2_SECRET_ACCESS_KEY",
  "PLANETSCALE_SERVICE_TOKEN",
  "CLOUDFLARE_API_TOKEN",
  "OTEL_EXPORTER_OTLP_HEADERS",
]);

const text = readFileSync(path, "utf8");
const bad = new Set();
// Passing every secret on to another reusable workflow is not an expression,
// so check for it separately.
for (const [line] of text.matchAll(/^\s*secrets:\s*inherit\b.*$/gim)) {
  bad.add(line.trim());
}
// Every expression, across lines and with nested single braces, up to its
// closing "}}". Context names and functions are case-insensitive.
for (const [expr] of text.matchAll(/\$\{\{[\s\S]*?\}\}/g)) {
  for (const token of expr.matchAll(/(?<![\w-])secrets(?![\w-])/gi)) {
    const name = /^\s*\.\s*(\w+)/.exec(expr.slice(token.index + token[0].length));
    if (!name || !allowed.has(name[1].toUpperCase())) {
      bad.add(expr.replace(/\s+/g, " "));
    }
  }
}

if (bad.size > 0) {
  console.log(
    `::error::${path} reads secrets outside the allow-list, or the whole secrets context:`,
  );
  for (const expr of bad) console.log(expr);
  process.exit(1);
}
console.log(`${path} reads only allow-listed secrets.`);
