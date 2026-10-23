import crypto from "node:crypto";

const USERNAME_PATTERN = /^[A-Za-z0-9-]{1,39}$/;
const REPOSITORY_PATTERN = /^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/;
const TASKS = new Set(["review", "improve", "weekly", "optimize", "debug"]);

export function validateProfileInput(input = {}) {
  const username = typeof input.username === "string" ? input.username.trim() : "";
  const repositoryValue = input.repository ?? input.repo ?? "";
  const repository = typeof repositoryValue === "string" ? repositoryValue.trim() : "";
  const task = typeof input.task === "string" ? input.task.trim() : "review";

  if (!USERNAME_PATTERN.test(username)) {
    return { ok: false, error: "username must be 1-39 letters, numbers, or hyphens" };
  }
  if (!TASKS.has(task)) return { ok: false, error: "unsupported task" };
  if (repository && !REPOSITORY_PATTERN.test(repository)) {
    return { ok: false, error: "repository must be in owner/name format" };
  }
  return { ok: true, value: { username, repository, task } };
}

function getHeader(headers, name) {
  if (!headers) return "";
  if (typeof headers.get === "function") return headers.get(name) || headers.get(name.toLowerCase()) || "";
  if (typeof headers !== "object") return "";
  const wanted = name.toLowerCase();
  const entry = Object.entries(headers).find(([key]) => key.toLowerCase() === wanted);
  return entry?.[1] ?? "";
}

function isNonEmpty(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function hasExactSecret(expected, actual) {
  if (!isNonEmpty(expected) || typeof actual !== "string") return false;
  const expectedBytes = Buffer.from(expected, "utf8");
  const actualBytes = Buffer.from(actual, "utf8");
  return expectedBytes.length === actualBytes.length && crypto.timingSafeEqual(expectedBytes, actualBytes);
}

// Appwrite marks Console-created HTTP executions with its server-side trigger
// (`console` in some runtimes, `http` in others). A caller-supplied body or
// identity field is never sufficient for this path.
export function hasProfileTestAuthorization(req = {}) {
  const trigger = getHeader(req.headers, "x-appwrite-trigger").trim().toLowerCase();
  return (trigger === "console" || trigger === "http") && hasExactSecret(
    process.env.PROFILE_TEST_TOKEN || "",
    getHeader(req.headers, "x-profile-test-token")
  );
}

// Appwrite supplies these headers only for authenticated function executions.
// Keep the adapter fields for runtimes that have already normalized Appwrite
// identity, but never infer identity from arbitrary headers or request bodies.
export function hasAppwriteIdentity(req = {}) {
  const adapterCandidates = [
    req.appwrite?.user?.$id,
    req.appwrite?.user?.id,
    req.appwrite?.userId,
  ];
  if (adapterCandidates.some(isNonEmpty)) return true;

  const userId = getHeader(req.headers, "x-appwrite-user-id");
  const userJwt = getHeader(req.headers, "x-appwrite-user-jwt");
  return isNonEmpty(userId) && isNonEmpty(userJwt);
}
