import fs from "node:fs";

export const REQUIRED_VARIABLES = [
  "APPWRITE_SITE_ENDPOINT",
  "APPWRITE_SITE_PROJECT_ID",
  "APPWRITE_SITE_API_KEY",
  "APPWRITE_BACKEND_A_ENDPOINT",
  "APPWRITE_BACKEND_A_PROJECT_ID",
  "APPWRITE_BACKEND_A_API_KEY",
  "APPWRITE_BACKEND_B_ENDPOINT",
  "APPWRITE_BACKEND_B_PROJECT_ID",
  "APPWRITE_BACKEND_B_API_KEY",
  "WEBHOOK_DATABASE_ID",
  "WEBHOOK_DELIVERY_COLLECTION_ID",
  "APPWRITE_FUNCTION_GITHUB_PR_REVIEWER_ID",
  "APPWRITE_FUNCTION_GITHUB_PROFILE_INSIGHTS_ID",
  "APPWRITE_FUNCTION_GITHUB_DASHBOARD_ID",
  "APPWRITE_FUNCTION_HEALTH_CHECK_ID",
  "APP_ID",
  "PRIVATE_KEY",
  "WEBHOOK_SECRET",
  "NVIDIA_API_KEY",
];

export const SECRET_VARIABLES = new Set([
  "APPWRITE_SITE_API_KEY",
  "APPWRITE_BACKEND_A_API_KEY",
  "APPWRITE_BACKEND_B_API_KEY",
  "APPWRITE_DATA_API_KEY",
  "APPWRITE_API_KEY",
  "PRIVATE_KEY",
  "WEBHOOK_SECRET",
  "NVIDIA_API_KEY",
  "OPENROUTER_API_KEY",
  "GITHUB_TOKEN",
]);

export function parseEnvText(text) {
  const values = {};
  for (const [index, rawLine] of text.split(/\r?\n/).entries()) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const match = line.match(/^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!match) throw new Error(`Invalid environment entry on line ${index + 1}.`);
    let value = match[2].trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    values[match[1]] = value;
  }
  return values;
}

export function loadEnvFile(filePath, processEnv = process.env) {
  const fileValues = parseEnvText(fs.readFileSync(filePath, "utf8"));
  // A blank process value is treated as absent, so shells and CI cannot
  // accidentally erase a useful value from the selected env file.
  const nonBlankProcessValues = Object.fromEntries(
    Object.entries(processEnv).filter(([, value]) => String(value ?? "").trim()),
  );
  return { ...fileValues, ...nonBlankProcessValues };
}

export function missingRequiredVariables(values) {
  return REQUIRED_VARIABLES.filter((name) => {
    return !String(values[name] ?? "").trim();
  });
}

export function resolveAppwriteContexts(values) {
  const site = {
    endpoint: values.APPWRITE_SITE_ENDPOINT,
    projectId: values.APPWRITE_SITE_PROJECT_ID,
    apiKey: values.APPWRITE_SITE_API_KEY,
  };
  const backendA = {
    endpoint: values.APPWRITE_BACKEND_A_ENDPOINT,
    projectId: values.APPWRITE_BACKEND_A_PROJECT_ID,
    apiKey: values.APPWRITE_BACKEND_A_API_KEY,
  };
  const backendB = {
    endpoint: values.APPWRITE_BACKEND_B_ENDPOINT,
    projectId: values.APPWRITE_BACKEND_B_PROJECT_ID,
    apiKey: values.APPWRITE_BACKEND_B_API_KEY,
  };
  return { site, backendA, backendB };
}

export const FUNCTION_PROJECTS = {
  "github-pr-reviewer": "backendA",
  "github-profile-insights": "backendA",
  "github-dashboard": "backendB",
  "health-check": "backendB",
};

export function validateFunctionProjectLimits(functionProjects = FUNCTION_PROJECTS) {
  const counts = {};
  for (const project of Object.values(functionProjects)) counts[project] = (counts[project] || 0) + 1;
  return Object.entries(counts)
    .filter(([, count]) => count > 2)
    .map(([project, count]) => `${project} contains ${count} Functions; Appwrite free tier allows at most 2 per project.`);
}

export function redactedVariableNames(values) {
  return Object.keys(values).filter((name) => SECRET_VARIABLES.has(name));
}
