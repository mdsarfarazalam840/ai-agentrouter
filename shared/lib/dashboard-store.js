import { randomUUID } from "node:crypto";
import { boundedFetchText } from "./bounded.js";
import { normalizeIssuePlan } from "./planner.js";

const REVIEW_FIELDS = ["reviewId", "repository", "fullName", "prNumber", "prTitle", "headSha", "baseSha", "commitUrl", "summary", "score", "verdict", "provider", "model", "deliveryId", "status", "createdAt", "findings"];
const ISSUE_FIELDS = ["repository", "fullName", "issueNumber", "issueTitle", "summary", "response", "provider", "model", "deliveryId", "status", "createdAt", "command"];
// Only these issue attributes are provisioned in setup-dashboard-project.ps1.
const STORED_ISSUE_FIELDS = ISSUE_FIELDS;
const RESPONSE_SIZE = 20000;
export function assertPatchEnvelopeSize(patch, validation) {
  const envelope = { kind: "patch", patch, ...(validation === undefined ? {} : { validation: safeValidation(validation) }) };
  if (Buffer.byteLength(JSON.stringify(envelope), "utf8") > RESPONSE_SIZE) throw new Error("PATCH_PAYLOAD_TOO_LARGE");
}
const FULL_NAME = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

function canonicalRepository(input) {
  const name = input.fullName || input.repository;
  if (typeof name !== "string" || !FULL_NAME.test(name) || (input.fullName && input.repository?.includes("/") && input.repository !== input.fullName)) throw new Error("INVALID_REPOSITORY");
  return name;
}

function issueNumberOf(input) {
  const number = Number(input.issueNumber);
  if (!Number.isSafeInteger(number) || number <= 0) throw new Error("INVALID_ISSUE_NUMBER");
  return number;
}

function envelopeData(input, kind, envelope) {
  const response = JSON.stringify(envelope);
  if (Buffer.byteLength(response, "utf8") > RESPONSE_SIZE) throw new Error(kind === "patch" ? "PATCH_PAYLOAD_TOO_LARGE" : "PLAN_PAYLOAD_TOO_LARGE");
  const repository = canonicalRepository(input);
  const data = dataFor(STORED_ISSUE_FIELDS, { repository, fullName: repository, issueNumber: issueNumberOf(input), issueTitle: input.issueTitle, summary: envelope[kind]?.summary || input.summary, response, provider: envelope[kind]?.provider, model: envelope[kind]?.model, deliveryId: input.deliveryId, status: envelope[kind]?.status || input.status, createdAt: envelope[kind]?.createdAt || input.createdAt || new Date().toISOString(), command: kind });
  for (const field of ["repository", "fullName", "issueTitle", "summary", "response", "provider", "model", "deliveryId", "status", "createdAt", "command"]) {
    const limits = { repository: 256, fullName: 256, issueTitle: 1000, summary: 20000, response: 20000, provider: 64, model: 256, deliveryId: 256, status: 64, createdAt: 64, command: 128 };
    if (typeof data[field] === "string" && Buffer.byteLength(data[field], "utf8") > limits[field]) throw new Error(kind === "patch" ? "PATCH_PAYLOAD_TOO_LARGE" : "PLAN_PAYLOAD_TOO_LARGE");
  }
  return data;
}

function parsedDocument(document, kind) {
  const parsed = typeof document.response === "string" ? JSON.parse(document.response) : document.response;
  if (parsed?.kind === kind && parsed[kind] && typeof parsed[kind] === "object") return { ...document, ...parsed };
  if (kind === "plan") {
    const plan = document.plan ? (typeof document.plan === "string" ? JSON.parse(document.plan) : document.plan) : parsed;
    if (plan && typeof plan === "object" && !Array.isArray(plan)) return { ...document, plan };
  }
  throw new Error("INVALID_STORED_RECORD");
}

function safeValidation(value) {
  if (!value || typeof value !== "object") return undefined;
  const result = {};
  if (typeof value.status === "string" && /^(?:passed|failed|validated|validation_failed|test_failed|validation_unavailable|not_run)$/.test(value.status)) result.status = value.status;
  if (typeof value.passed === "boolean") result.passed = value.passed;
  if (typeof value.testsRun === "boolean") result.testsRun = value.testsRun;
  if (typeof value.error === "string" && /^(?:TRUSTED_RUNNER_UNAVAILABLE|EMPTY_PATCH|APPROVAL_REQUIRED|INVALID_WORKSPACE_PATCH|INVALID_RUNNER_RESULT|TEST_TIMEOUT|VALIDATION_FAILED|INVALID_PATCH|INVALID_SUMMARY|INVALID_METADATA|INVALID_LIST|INVALID_STATUS|PATCH_REVISION_MISMATCH|INVALID_DIFF|INVALID_FILES|UNSAFE_PATCH_PATH|UNSUPPORTED_OPERATION|FILE_NOT_IN_SNAPSHOT|DIFF_TARGET_MISMATCH|TEST_COMMAND_NOT_ALLOWED|SNAPSHOT_REVISION_MISMATCH)$/.test(value.error)) result.error = value.error;
  if (Number.isSafeInteger(value.exitCode) && value.exitCode >= 0 && value.exitCode <= 255) result.exitCode = value.exitCode;
  if (Number.isFinite(value.durationMs) && value.durationMs >= 0) result.durationMs = Math.min(value.durationMs, 3600000);
  return result;
}

function config(env = process.env) {
  // Dashboard runs in its own project. These values deliberately point at the
  // Github project that owns the database and collections.
  const endpoint = env.APPWRITE_DATA_ENDPOINT || env.APPWRITE_FUNCTION_API_ENDPOINT || env.APPWRITE_ENDPOINT;
  const project = env.APPWRITE_DATA_PROJECT_ID || env.APPWRITE_FUNCTION_PROJECT_ID || env.APPWRITE_PROJECT_ID;
  const key = env.APPWRITE_DATA_API_KEY || env.APPWRITE_FUNCTION_API_KEY || env.APPWRITE_API_KEY;
  const database = env.WEBHOOK_DATABASE_ID;
  if (!endpoint || !project || !key || !database) return null;
  return { endpoint: endpoint.replace(/\/$/, ""), project, key, database };
}

function clean(value, max = 20000) {
  if (value === undefined || value === null) return null;
  if (typeof value === "string") return value.slice(0, max);
  if (typeof value === "number" || typeof value === "boolean") return value;
  const serialized = JSON.stringify(value);
  return serialized.slice(0, max);
}

function dataFor(fields, input = {}) {
  const result = {};
  for (const field of fields) if (input[field] !== undefined) result[field] = clean(input[field]);
  return result;
}

function urlFor(c, collection, suffix = "") {
  return `${c.endpoint}/databases/${encodeURIComponent(c.database)}/collections/${encodeURIComponent(collection)}/documents${suffix}`;
}

async function request(c, url, options = {}) {
  const response = await boundedFetchText(url, { ...options, timeoutMs: 2500, headers: { "X-Appwrite-Project": c.project, "X-Appwrite-Key": c.key, "Content-Type": "application/json", ...(options.headers || {}) } });
  return response ? JSON.parse(response) : {};
}

export function dashboardMetadata() {
  const configured = (provider) => Boolean(provider === "nvidia" ? process.env.NVIDIA_API_KEY : process.env.OPENROUTER_API_KEY);
  return { providers: { nvidia: { configured: configured("nvidia"), available: configured("nvidia"), status: configured("nvidia") ? "ready" : "offline" }, openrouter: { configured: configured("openrouter"), available: configured("openrouter"), status: configured("openrouter") ? "ready" : "offline" } }, generatedAt: new Date().toISOString() };
}

export function createDashboardStore(env = process.env, logger = () => {}) {
  const c = config(env);
  const collections = { reviews: env.DASHBOARD_REVIEW_COLLECTION_ID, findings: env.DASHBOARD_FINDING_COLLECTION_ID, issues: env.DASHBOARD_ISSUE_COLLECTION_ID || env.APPWRITE_DASHBOARD_ISSUE_COLLECTION_ID || "dashboard-issues" };
  const bestEffort = async (kind, collection, input) => {
    if (!c || !collection) return null;
    try {
      const fields = dataFor(kind === "issue" ? ISSUE_FIELDS : REVIEW_FIELDS, input);
      return await request(c, urlFor(c, collection), { method: "POST", body: JSON.stringify({ documentId: randomUUID(), data: fields }) });
    }
    catch { try { logger(`Dashboard ${kind} persistence unavailable`); } catch { /* logging is best effort too */ } return null; }
  };
  const list = async (kind, collection, query = {}, strict = false) => {
    if (!c || !collection) { if (strict) throw new Error("PATCH_LOOKUP_UNAVAILABLE"); return []; }
    try {
      const limit = Number.isInteger(query.limit) && query.limit > 0 && query.limit <= 100 ? query.limit : 100;
      const queries = Object.entries(query).filter(([attribute, value]) => !["limit", "offset"].includes(attribute) && value !== undefined && value !== "").map(([attribute, value]) => ({ method: "equal", attribute, values: [attribute === "issueNumber" ? Number(value) : String(value)] }));
      queries.push({ method: "orderDesc", attribute: "$createdAt" }, { method: "limit", values: [limit] });
      if (Number.isSafeInteger(query.offset) && query.offset > 0) queries.push({ method: "offset", values: [query.offset] });
      const suffix = queries.map((value) => `queries%5B%5D=${encodeURIComponent(JSON.stringify(value))}`).join("&");
      const payload = await request(c, `${urlFor(c, collection)}?${suffix}`);
      return Array.isArray(payload.documents) ? payload.documents : [];
    } catch { if (strict) throw new Error("PATCH_LOOKUP_UNAVAILABLE"); logger(`Dashboard ${kind} read unavailable`); return []; }
  };
  const persistEnvelope = async (kind, input, envelope) => {
    if (!c || !collections.issues) throw new Error(`${kind.toUpperCase()}_PERSISTENCE_UNAVAILABLE`);
    try {
      const data = envelopeData(input, kind, envelope);
      const documentId = randomUUID();
      const document = await request(c, urlFor(c, collections.issues), { method: "POST", body: JSON.stringify({ documentId, data }) });
      if (document.$id !== documentId || document.command !== kind || document.response !== data.response) throw new Error("INCOMPLETE_WRITE_ACKNOWLEDGEMENT");
      return parsedDocument(document, kind);
    } catch (error) {
      if (error.message === `${kind.toUpperCase()}_PAYLOAD_TOO_LARGE`) throw error;
      throw new Error(`${kind.toUpperCase()}_PERSISTENCE_UNAVAILABLE`);
    }
  };
  const patchIdentity = (query) => ({ fullName: canonicalRepository(query), issueNumber: issueNumberOf(query), command: "patch" });
  return {
    collections,
    persistReview: (input) => bestEffort("review", collections.reviews, input),
    persistFinding: (input) => bestEffort("finding", collections.findings, input),
    persistIssue: (input) => bestEffort("issue", collections.issues, input),
    persistPlan: async (input) => {
      const source = input.plan || input;
      const plan = normalizeIssuePlan(source, { ...source, ...input });
      return persistEnvelope("plan", input, { kind: "plan", plan });
    },
    persistPatch: (input) => persistEnvelope("patch", input, { kind: "patch", patch: input.patch, ...(input.snapshot === undefined ? {} : { snapshot: input.snapshot }), ...(input.validation === undefined ? {} : { validation: safeValidation(input.validation) }) }),
    listReviews: (query) => list("reviews", collections.reviews, query),
    listIssues: (query) => list("issues", collections.issues, query),
    listPlans: async (query = {}) => (await list("plans", collections.issues, { ...query, command: "plan" }, true)).map((document) => parsedDocument(document, "plan")),
    listPatches: async (query) => {
      const { patchRevision, limit, ...filters } = query;
      const identity = patchIdentity(filters);
      const pageSize = Number.isInteger(limit) && limit > 0 && limit <= 100 ? limit : 100;
      const matches = [];
      for (let offset = 0; offset < 1000; offset += pageSize) {
        const documents = await list("patches", collections.issues, { ...identity, limit: pageSize, offset }, true);
        for (const document of documents) {
          try { const parsed = parsedDocument(document, "patch"); if (parsed.fullName === identity.fullName && Number(parsed.issueNumber) === identity.issueNumber && parsed.command === "patch" && (!patchRevision || parsed.patch.patchRevision === patchRevision)) matches.push(parsed); } catch { /* malformed stored record */ }
        }
        if (matches.length >= pageSize || documents.length < pageSize || !patchRevision) break;
      }
      return matches.slice(0, pageSize);
    },
    getPatch: async (query) => {
      try {
        const { fullName, issueNumber } = patchIdentity(query);
        if (!c || !collections.issues || typeof query.id !== "string" || !/^[A-Za-z0-9._-]{1,36}$/.test(query.id)) throw new Error("INVALID_PATCH_ID");
        const document = await request(c, urlFor(c, collections.issues, `/${encodeURIComponent(query.id)}`));
        const parsed = parsedDocument(document, "patch");
        if (parsed.$id !== query.id || parsed.command !== "patch" || parsed.fullName !== fullName || Number(parsed.issueNumber) !== issueNumber || (query.patchRevision && parsed.patch.patchRevision !== query.patchRevision)) throw new Error("PATCH_IDENTITY_MISMATCH");
        return parsed;
      } catch { throw new Error("PATCH_LOOKUP_UNAVAILABLE"); }
    },
    listFindings: (query) => list("findings", collections.findings, query),
    listDeliveries: (query) => list("deliveries", env.WEBHOOK_DELIVERY_COLLECTION_ID, query),
  };
}
