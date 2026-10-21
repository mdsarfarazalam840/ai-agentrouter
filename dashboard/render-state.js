const safeCategory = (value) => {
  const category = typeof value === 'string' ? value.trim() : '';
  return /^[a-z0-9][a-z0-9._-]{0,63}$/i.test(category) ? category : '';
};

function providerName(provider) {
  const name = String(provider.name || provider.provider || '').toLowerCase();
  return name === 'nvidia' || name === 'nvidia nim' ? 'NVIDIA NIM' : name === 'openrouter' ? 'OpenRouter fallback' : String(provider.name || provider.provider || 'Provider');
}

export function providerPresentation(provider = {}) {
  const name = String(provider.name || provider.provider || '').toLowerCase();
  const usable = provider.configured !== false && provider.available === true;
  const status = String(provider.status || '').toLowerCase();
  const category = safeCategory(provider.lastFailureCategory || provider.failureCategory)
    || (provider.available === false && provider.configured !== false ? 'unavailable' : 'none reported');
  const fallback = name === 'openrouter' || provider.freeOnly === true;
  return {
    usable,
    label: providerName(provider),
    statusLabel: usable ? (status === 'degraded' ? 'DEGRADED' : 'READY') : provider.configured === false ? 'OFFLINE' : 'UNAVAILABLE',
    failureLabel: `${fallback ? 'free-only fallback · ' : ''}Failure: ${category}`,
  };
}

export function resetOverviewState(state, values, els) {
  state.overview = null;
  state.reviews = [];
  state.findings = [];
  state.issues = [];
  for (const [id, value] of Object.entries({
    reviewCount: '—',
    findingCount: '—',
    issueCount: '—',
    deliveryHealth: '—',
    deliveryDetail: 'No delivery telemetry',
    riskScore: '—',
    riskSummary: 'No findings have been loaded.',
  })) {
    if (values?.[id]) values[id].textContent = value;
  }
  for (const target of [els.providerList, els.overviewReviews, els.reviewsTable, els.issuesTable]) target?.replaceChildren();
}
