import { Client } from 'https://cdn.jsdelivr.net/npm/appwrite@17.0.0/+esm';

// Existing Appwrite project used by the dashboard backend.
const APPWRITE_ENDPOINT = 'https://fra.cloud.appwrite.io/v1';
const APPWRITE_PROJECT_ID = '69f2e19a00218fea645f';

export const client = new Client()
  .setEndpoint(APPWRITE_ENDPOINT)
  .setProject(APPWRITE_PROJECT_ID);

export function pingAppwrite() {
  return client.ping();
}
