import { createHash, randomUUID } from "node:crypto";
import { boundedFetchText } from "./bounded.js";

// Delivery attempts are immutable identities: every retry gets a new Appwrite
// document ID. This is intentional because Appwrite document updates do not
// provide a compare-and-swap predicate.
export function createDeliveryStore(env = process.env, options = {}) {
  const endpoint = env.APPWRITE_FUNCTION_API_ENDPOINT || env.APPWRITE_ENDPOINT;
  const project = env.APPWRITE_FUNCTION_PROJECT_ID || env.APPWRITE_PROJECT_ID;
  const key = env.APPWRITE_FUNCTION_API_KEY || env.APPWRITE_API_KEY;
  const database = env.WEBHOOK_DATABASE_ID;
  const collection = env.WEBHOOK_DELIVERY_COLLECTION_ID;
  if (!endpoint || !project || !key || !database || !collection) {
    const error = new Error("DELIVERY_STORE_NOT_CONFIGURED");
    error.statusCode = 503;
    throw error;
  }

  const base = `${endpoint.replace(/\/$/, "")}/databases/${encodeURIComponent(database)}/collections/${encodeURIComponent(collection)}/documents`;
  const headers = { "X-Appwrite-Project": project, "X-Appwrite-Key": key, "Content-Type": "application/json" };
  const leaseMs = Number.isFinite(Number(env.WEBHOOK_CLAIM_LEASE_MS)) ? Math.max(1000, Number(env.WEBHOOK_CLAIM_LEASE_MS)) : 120000;
  const clock = typeof options.clock === "function" ? options.clock : () => Date.now();
  const pageSize = Number.isInteger(options.pageSize) && options.pageSize > 0 && options.pageSize <= 100 ? options.pageSize : 100;
  const maxPages = Number.isInteger(options.maxPages) && options.maxPages > 0 && options.maxPages <= 10 ? options.maxPages : 10;

  return {
    async claim(delivery) {
      const deliveryKey = createHash("sha256").update(`${project}:${String(delivery)}`).digest("hex");
      const existing = await listAttempts(base, headers, deliveryKey, { pageSize, maxPages });
      const completed = existing.find(({ state }) => state === "completed");
      const active = existing.find((attempt) => attempt.state === "processing" && activeLease(attempt.leaseExpiresAt, clock()));
      const malformed = existing.find((attempt) => attempt.state === "processing" && !activeLease(attempt.leaseExpiresAt, clock()) && !expiredLease(attempt.leaseExpiresAt, clock()));
      const duplicate = completed || active || malformed;
      if (duplicate) {
        return { id: duplicate.$id || duplicate.id, attemptId: duplicate.$id || duplicate.id, deliveryKey, state: duplicate.state === "completed" ? "completed" : "blocked", reason: duplicate.state === "processing" ? (malformed ? "invalid_lease" : "active_claim") : undefined };
      }

      const attemptId = randomUUID();
      const ownerToken = randomUUID();
      const leaseExpiresAt = new Date(clock() + leaseMs).toISOString();
      await boundedFetchText(base, {
        method: "POST",
        headers,
        body: JSON.stringify({ documentId: attemptId, data: { deliveryKey, state: "processing", ownerToken, leaseExpiresAt } }),
        timeoutMs: 2000,
      });
      return { id: attemptId, attemptId, deliveryKey, state: "claimed", ownerToken };
    },

    async complete(attemptId, ownerToken) {
      const url = `${base}/${encodeURIComponent(attemptId)}`;
      await assertOwner(url, headers, ownerToken);
      await boundedFetchText(url, { method: "PATCH", headers, timeoutMs: 2000, body: JSON.stringify({ data: { state: "completed", ownerToken, leaseExpiresAt: null } }) });
    },

    async release(attemptId, ownerToken) {
      const url = `${base}/${encodeURIComponent(attemptId)}`;
      await assertOwner(url, headers, ownerToken);
      // Keep the attempt document as an audit record. A retry creates another
      // random ID; no old worker can ever address that newer document.
      await boundedFetchText(url, { method: "PATCH", headers, timeoutMs: 2000, body: JSON.stringify({ data: { state: "released", ownerToken, leaseExpiresAt: null } }) });
    },
  };
}

function activeLease(value, now) {
  const time = Date.parse(String(value || ""));
  return Number.isFinite(time) && time > now;
}

function expiredLease(value, now) {
  const time = Date.parse(String(value || ""));
  return Number.isFinite(time) && time <= now;
}

async function listAttempts(base, headers, deliveryKey, options = {}) {
  const pageSize = options.pageSize || 100;
  const maxPages = options.maxPages || 10;
  const documents = [];
  for (let page = 0; page < maxPages; page++) {
    const queries = [
      { method: "equal", attribute: "deliveryKey", values: [deliveryKey] },
      { method: "orderDesc", attribute: "$createdAt" },
      { method: "limit", values: [pageSize] },
      ...(page ? [{ method: "offset", values: [page * pageSize] }] : []),
    ].map((value) => `queries[]=${encodeURIComponent(JSON.stringify(value))}`).join("&");
    const payload = JSON.parse(await boundedFetchText(`${base}?${queries}`, { headers, timeoutMs: 2000 }));
    const rows = Array.isArray(payload.documents) ? payload.documents : [];
    documents.push(...rows);
    if (rows.length < pageSize) return documents;
  }
  const error = new Error("DELIVERY_HISTORY_TOO_LARGE");
  error.code = "DELIVERY_HISTORY_TOO_LARGE";
  error.statusCode = 503;
  throw error;
}

async function assertOwner(url, headers, ownerToken) {
  const stored = JSON.parse(await boundedFetchText(url, { headers, timeoutMs: 2000 }));
  const data = stored.data || stored;
  if (!ownerToken || data.ownerToken !== ownerToken || data.state !== "processing") {
    const error = new Error("CLAIM_NOT_OWNER");
    error.code = "CLAIM_NOT_OWNER";
    error.statusCode = 409;
    throw error;
  }
}
