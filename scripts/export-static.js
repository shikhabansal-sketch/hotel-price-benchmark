const fs = require("fs");
const path = require("path");
const { buildDashboardState } = require("../dashboard/server");

const repoRoot = path.resolve(__dirname, "..");
const docsDir = path.join(repoRoot, "docs");
const sourceStyles = path.join(repoRoot, "dashboard", "public", "styles.css");
const targetStyles = path.join(docsDir, "styles.css");
const targetData = path.join(docsDir, "data.json");

fs.mkdirSync(docsDir, { recursive: true });
fs.copyFileSync(sourceStyles, targetStyles);

const state = {
  ...buildDashboardState(),
  publishedAtIso: new Date().toISOString(),
  job: null,
};

fs.writeFileSync(targetData, `${JSON.stringify(state, null, 2)}\n`);

console.log(`Wrote ${targetData}`);
