// Adapted from ed-creative-fusion's vitest-coverage composite action.
const fs = require("node:fs");
const path = require("node:path");

const reports = [
  ["Tooling", "coverage/coverage-summary.json"],
  ["API", "apps/api/coverage/coverage-summary.json"],
  ["Ordering", "packages/ordering/coverage/coverage-summary.json"],
  ["Persistence", "packages/persistence/coverage/coverage-summary.json"],
];
const metrics = ["statements", "branches", "functions", "lines"];
const marker = "<!-- scos-vitest-coverage -->";
const percentage = ({ total, covered }) => (total === 0 ? 100 : (covered / total) * 100);
const escape = (value) => value.replaceAll("|", "\\|").replaceAll("`", "'").replaceAll("<", "&lt;");

module.exports = async ({ github, context, core }) => {
  const totals = Object.fromEntries(metrics.map((metric) => [metric, { total: 0, covered: 0 }]));
  const rows = [];
  const below = [];

  for (const [label, reportPath] of reports) {
    const coverage = JSON.parse(fs.readFileSync(reportPath, "utf8"));
    for (const metric of metrics) {
      const value = coverage.total?.[metric];
      if (
        !value ||
        !Number.isInteger(value.total) ||
        !Number.isInteger(value.covered) ||
        value.total < 0 ||
        value.covered < 0 ||
        value.covered > value.total
      ) {
        throw new Error(`Invalid ${metric} coverage in ${reportPath}`);
      }
      totals[metric].total += value.total;
      totals[metric].covered += value.covered;
    }
    rows.push(
      `| ${label} | ${metrics.map((metric) => `${percentage(coverage.total[metric]).toFixed(1)}%`).join(" | ")} |`,
    );
    for (const [filename, value] of Object.entries(coverage)) {
      if (filename === "total" || percentage(value.lines) >= 80) continue;
      const relative = filename.replace(/^.*\/(?=(?:apps|packages|scripts)\/)/, "");
      below.push({
        name: `${label}: ${relative || path.basename(filename)}`,
        pct: percentage(value.lines),
      });
    }
  }

  const aggregate = metrics
    .map((metric) => `${metric}: **${percentage(totals[metric]).toFixed(1)}%**`)
    .join(" | ");
  const details =
    below.length === 0
      ? ""
      : `\n<details><summary>Files below 80% line coverage (${below.length})</summary>\n\n${below
          .sort((a, b) => a.pct - b.pct)
          .slice(0, 30)
          .map((file) => `- ${escape(file.name)}: ${file.pct.toFixed(1)}%`)
          .join("\n")}\n\n</details>\n`;
  const body = `${marker}\n#### SCOS Tests — Coverage\n\n${aggregate}\n\nMinimum: **80%** for each metric in every suite.\n\n| Suite | Statements | Branches | Functions | Lines |\n|---|---:|---:|---:|---:|\n${rows.join("\n")}\n${details}\nCommit: \`${context.payload.pull_request.head.sha}\` · [Workflow run](https://github.com/${context.repo.owner}/${context.repo.repo}/actions/runs/${context.runId})`;
  const request = { ...context.repo, issue_number: context.issue.number };
  const comments = await github.paginate(github.rest.issues.listComments, request);
  const existing = comments.find(
    (comment) => comment.user?.type === "Bot" && comment.body?.includes(marker),
  );
  if (existing) {
    await github.rest.issues.updateComment({ ...context.repo, comment_id: existing.id, body });
  } else {
    await github.rest.issues.createComment({ ...request, body });
  }
  core.info("Updated the SCOS Vitest coverage comment.");
};
