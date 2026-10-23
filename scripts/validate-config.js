import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));

export function validateConfig() {
  const errors = [];
  const configs = ["appwrite.config.json", "appwrite.backend-b.config.json"].map((name) => JSON.parse(fs.readFileSync(path.join(root, name), "utf8")));
  const workflow = fs.readFileSync(path.join(root, ".github/workflows/deploy.yml"), "utf8");
  const dashboardHtml = fs.readFileSync(path.join(root, "dashboard/index.html"), "utf8");
  const dashboardJs = fs.readFileSync(path.join(root, "dashboard/app.js"), "utf8");
  const entrypoints = [...workflow.matchAll(/--entrypoint="([^"]+)"/g)].map((match) => match[1]);
  const checkFile = (relative) => {
    const absolute = path.resolve(root, relative);
    if (!absolute.startsWith(root) || !fs.existsSync(absolute) || !fs.statSync(absolute).isFile()) errors.push(`Missing or unsafe file: ${relative}`);
  };
  const functions = configs.flatMap((config) => config.functions);
  for (const fn of functions) {
    checkFile(path.join(fn.path, fn.entrypoint));
    checkFile(path.join(fn.path, "package-lock.json"));
    if (!new Set(["node-20", "node-22"]).has(fn.runtime)) errors.push(`Unexpected runtime for ${fn.name}`);
    if (fn.commands !== "npm ci") errors.push(`Non-reproducible install for ${fn.name}`);
    if (!entrypoints.includes(fn.entrypoint)) errors.push(`Function absent from workflow: ${fn.name}`);
  }
  for (const entrypoint of entrypoints) checkFile(entrypoint);
  const dashboard = functions.find((fn) => fn.name === "github-dashboard");
  if (!dashboard || JSON.stringify(dashboard.execute) !== JSON.stringify(["users"])) errors.push("github-dashboard must use authenticated-user execution (users)");
  if (!workflow.includes('--execute="users"')) errors.push("Deployment workflow must configure authenticated-user execution");
  const profileJob = workflow.match(/deploy-profile:[\s\S]*?(?=\n  deploy-|$)/)?.[0] ?? "";
  const prJob = workflow.match(/deploy-pr-reviewer:[\s\S]*?(?=\n  deploy-|$)/)?.[0] ?? "";
  const backendBJob = workflow.match(/deploy-github-dashboard:[\s\S]*?(?=\n  deploy-|$)/)?.[0] ?? "";
  const healthJob = workflow.match(/deploy-health-check:[\s\S]*?(?=\n  deploy-|$)/)?.[0] ?? "";
  for (const [job, names] of [[profileJob, ["APPWRITE_BACKEND_A_ENDPOINT", "APPWRITE_BACKEND_A_PROJECT_ID", "APPWRITE_BACKEND_A_API_KEY"]], [prJob, ["APPWRITE_BACKEND_A_ENDPOINT", "APPWRITE_BACKEND_A_PROJECT_ID", "APPWRITE_BACKEND_A_API_KEY"]], [backendBJob, ["APPWRITE_BACKEND_B_ENDPOINT", "APPWRITE_BACKEND_B_PROJECT_ID", "APPWRITE_BACKEND_B_API_KEY", "APPWRITE_FUNCTION_GITHUB_DASHBOARD_ID"]], [healthJob, ["APPWRITE_BACKEND_B_ENDPOINT", "APPWRITE_BACKEND_B_PROJECT_ID", "APPWRITE_BACKEND_B_API_KEY"]]]) {
    for (const name of names) if (!job.includes(`secrets.${name}`)) errors.push(`Workflow job is missing dedicated secret: ${name}`);
  }
  const siteJob = workflow.match(/deploy-site:[\s\S]*?(?=\n  deploy-|$)/)?.[0] ?? "";
  for (const name of ["APPWRITE_SITE_ENDPOINT", "APPWRITE_SITE_PROJECT_ID", "APPWRITE_SITE_API_KEY", "APPWRITE_SITE_ID"]) if (!siteJob.includes(`secrets.${name}`)) errors.push(`Site workflow must use dedicated secret: ${name}`);
  if (siteJob.includes("APPWRITE_BACKEND_A_API_KEY") || siteJob.includes("APPWRITE_BACKEND_B_API_KEY")) errors.push("Site workflow must not use backend API keys");
  if (!dashboardHtml.includes('<script src="config.js"></script>')) errors.push("Dashboard must load generated config.js");
  if (dashboardJs.includes("cloud.appwrite.io/v1")) errors.push("Dashboard app.js must not contain an ambiguous default endpoint");
  // The profile ID is deliberately supplied by the deployment environment.
  for (const directory of fs.readdirSync(path.join(root, "functions"), { withFileTypes: true }).filter((entry) => entry.isDirectory())) {
    const entrypoint = `functions/${directory.name}/src/main.js`;
    if (!entrypoints.includes(entrypoint)) errors.push(`Source absent from workflow: ${entrypoint}`);
  }
  const projectCounts = configs.map((config) => config.functions.length);
  if (projectCounts.some((count) => count > 2)) errors.push("Appwrite free tier allows at most 2 Functions per project configuration");
  if (projectCounts.reduce((sum, count) => sum + count, 0) !== 4) errors.push("Expected exactly four Functions across Backend A and Backend B configurations");
  return { ok: errors.length === 0, errors, functions: functions.length, workflowEntrypoints: entrypoints.length };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const result = validateConfig();
  if (!result.ok) { console.error(result.errors.join("\n")); process.exitCode = 1; }
  else console.log(`Configuration valid: ${result.functions} declared functions, ${result.workflowEntrypoints} workflow entrypoints`);
}
