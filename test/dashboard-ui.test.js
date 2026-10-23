import test from 'node:test';
import assert from 'node:assert/strict';
import { providerPresentation, resetOverviewState } from '../dashboard/render-state.js';

test('available degraded providers remain usable and render DEGRADED', () => {
  assert.deepEqual(providerPresentation({ provider: 'nvidia', available: true, status: 'degraded' }), {
    usable: true,
    label: 'NVIDIA NIM',
    statusLabel: 'DEGRADED',
    failureLabel: 'Failure: none reported',
  });
});

test('OpenRouter always exposes free-only fallback and safe failure category', () => {
  assert.equal(
    providerPresentation({ provider: 'openrouter', available: false, status: 'unavailable', freeOnly: true, lastFailureCategory: 'upstream_http' }).failureLabel,
    'free-only fallback · Failure: upstream_http',
  );
  assert.equal(
    providerPresentation({ provider: 'openrouter', available: false, status: 'unavailable', freeOnly: true, lastFailureCategory: '<script>alert(1)</script>' }).failureLabel,
    'free-only fallback · Failure: unavailable',
  );
});

test('refresh failure resets every overview-derived collection and metric', () => {
  const state = { overview: { stale: true }, reviews: [{ id: 1 }], findings: [{ id: 2 }], issues: [{ id: 3 }] };
  const values = Object.fromEntries(['reviewCount', 'findingCount', 'issueCount', 'deliveryHealth', 'deliveryDetail', 'riskScore', 'riskSummary'].map((id) => [id, { textContent: 'stale' }]));
  const cleared = () => ({ replaceChildren() {} });
  const els = { providerList: { replaceChildren() { this.cleared = true; } }, overviewReviews: cleared(), reviewsTable: cleared(), issuesTable: cleared() };
  resetOverviewState(state, values, els);
  assert.deepEqual(state, { overview: null, reviews: [], findings: [], issues: [] });
  assert.deepEqual(Object.fromEntries(Object.entries(values).map(([id, node]) => [id, node.textContent])), {
    reviewCount: '—', findingCount: '—', issueCount: '—', deliveryHealth: '—', deliveryDetail: 'No delivery telemetry', riskScore: '—', riskSummary: 'No findings have been loaded.',
  });
  assert.equal(els.providerList.cleared, true);
});
