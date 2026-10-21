import { Client, Account, Functions } from 'https://cdn.jsdelivr.net/npm/appwrite@17.0.0/+esm';
import { pingAppwrite } from './appwrite.js';
import { issueLink, patchIdentity, renderPatch } from './patch-ui.js';
import { providerPresentation, resetOverviewState } from './render-state.js';

const config = window.__APPWRITE_CONFIG__ || {};
const $ = (id) => document.getElementById(id);
const state = { account: null, overview: null, reviews: [], findings: [], issues: [], drawerReview: null, lastFocus: null, epoch: 0, drawerEpoch: 0, patchBusy: false };
let account, functions;
const els = { loginView: $('loginView'), appView: $('appView'), loginForm: $('loginForm'), loginMessage: $('loginMessage'), connectionStatus: $('connectionStatus'), logout: $('logoutButton'), refresh: $('refreshButton'), globalMessage: $('globalMessage'), providerList: $('providerList'), overviewReviews: $('overviewReviews'), reviewsTable: $('reviewsTable'), issuesTable: $('issuesTable'), drawer: $('detailDrawer'), drawerContent: $('drawerContent'), drawerTitle: $('drawerTitle'), backdrop: $('drawerBackdrop'), closeDrawer: $('closeDrawer'), reviewsRefresh: $('reviewsRefresh'), reviewCount: $('reviewCount'), findingCount: $('findingCount'), issueCount: $('issueCount'), deliveryHealth: $('deliveryHealth'), deliveryDetail: $('deliveryDetail'), riskScore: $('riskScore'), riskSummary: $('riskSummary'), lastUpdated: $('lastUpdated') };
els.drawer.setAttribute('role', 'dialog'); els.drawer.setAttribute('aria-modal', 'true'); els.drawer.setAttribute('aria-labelledby', 'drawerTitle');

function configured() { return Boolean(config.endpoint && config.projectId && config.dashboardFunctionId); }
function message(text, error = false) { els.globalMessage.textContent = text || ''; els.globalMessage.classList.toggle('hidden', !text); els.globalMessage.classList.toggle('error', error); }
function formatDate(value) { if (!value) return '—'; const date = new Date(value); return Number.isNaN(date.valueOf()) ? String(value) : date.toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' }); }
function text(value, fallback = '—') { return value === undefined || value === null || value === '' ? fallback : String(value); }
function setOnline(online) { els.connectionStatus.textContent = online ? '● ONLINE' : '● OFFLINE'; els.connectionStatus.classList.toggle('is-online', online); els.connectionStatus.classList.toggle('is-offline', !online); }
function initSdk() { const client = new Client().setEndpoint(config.endpoint).setProject(config.projectId); account = new Account(client); functions = new Functions(client); }
async function callDashboard(action, extra = {}) { if (!configured()) throw new Error('Dashboard is unconfigured. Set endpoint, projectId, and dashboardFunctionId in window.__APPWRITE_CONFIG__.'); const execution = await functions.createExecution(config.dashboardFunctionId, JSON.stringify({ action, ...extra }), false); let payload; try { payload = JSON.parse(execution.responseBody || '{}'); } catch { throw new Error('Dashboard returned an invalid response.'); } if (execution.responseStatusCode >= 400 || payload.error) throw new Error(payload.error || `Dashboard request failed (${execution.responseStatusCode}).`); return payload; }
function normalizeFinding(value, context = {}) { let item = value; if (typeof item === 'string') { try { const parsed = JSON.parse(item.slice(0, 12000)); item = parsed && typeof parsed === 'object' ? parsed : { summary: item }; } catch { item = { summary: item }; } } item = item && typeof item === 'object' ? item : {}; return { reviewId: item.reviewId || context.reviewId, repository: item.repository || context.repository, prNumber: item.prNumber || context.prNumber, headSha: item.headSha || context.headSha, file: text(item.file || item.path), line: text(item.line), severity: text(item.severity || item.type || item.priority), title: text(item.title || item.summary || item.finding), explanation: text(item.explanation || item.description || item.details), impact: text(item.impact), suggestion: text(item.suggestion || item.recommendation), example: text(item.example || item.code) }; }
function flattenFindings(values = []) { return values.flatMap((value) => { const item = value && typeof value === 'object' ? value : {}; const context = { reviewId: item.reviewId || item.$id, repository: item.repository || item.fullName, prNumber: item.prNumber, headSha: item.headSha }; return Array.isArray(item.findings) ? item.findings.map((finding) => normalizeFinding(finding, context)) : [normalizeFinding(value, context)]; }); }
function append(parent, tag, value, className) { const node = document.createElement(tag); if (className) node.className = className; node.textContent = text(value); parent.append(node); return node; }
function emptyRow(target, label) { target.replaceChildren(); const row = document.createElement('tr'); const cell = append(row, 'td', label, 'empty-cell'); cell.colSpan = target === els.issuesTable ? 6 : 4; target.append(row); }
function renderProviders(providers = {}) { els.providerList.replaceChildren(); const entries = Array.isArray(providers) ? providers : Object.entries(providers).map(([name, value]) => ({ name, ...(value || {}) })); if (!entries.length) return append(els.providerList, 'div', 'No provider status reported.', 'empty-cell'); entries.forEach((provider) => { const presentation = providerPresentation(provider); const item = document.createElement('div'); item.className = 'provider'; const dot = document.createElement('span'); dot.className = `provider-dot ${presentation.usable ? '' : 'offline'}`; item.append(dot); const details = document.createElement('div'); append(details, 'strong', presentation.label); append(details, 'small', provider.selectedModel || provider.model || (provider.configured === false ? 'Not configured' : 'Model unavailable')); append(details, 'small', presentation.failureLabel); item.append(details); append(item, 'span', presentation.statusLabel, `provider-status ${presentation.usable ? '' : 'offline'}`); els.providerList.append(item); }); }
function reviewRow(review, index) { const row = document.createElement('tr'); row.tabIndex = 0; row.setAttribute('role', 'button'); row.dataset.reviewIndex = index; const repo = review.repository || review.fullName || 'Unknown repository'; const pr = review.prNumber ? `PR #${review.prNumber} · ${text(review.prTitle)}` : text(review.prTitle); const first = row.insertCell(); first.className = 'repo-cell'; append(first, 'strong', repo); append(first, 'small', pr); append(row.insertCell(), 'code', text(review.headSha)); const provider = row.insertCell(); append(provider, 'span', review.provider); append(provider, 'small', review.model); append(row.insertCell(), 'span', text(review.status || review.verdict || 'RECORDED').toUpperCase(), 'badge'); row.addEventListener('click', () => { state.drawerEpoch++; openReview(review); }); row.addEventListener('keydown', (event) => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); state.drawerEpoch++; openReview(review); } }); return row; }
function renderReviews() { for (const target of [els.overviewReviews, els.reviewsTable]) { target.replaceChildren(); if (!state.reviews.length) { emptyRow(target, 'No reviews found for this account.'); continue; } state.reviews.forEach((review, index) => target.append(reviewRow(review, index))); } }
function storedPlan(issue) { if (String(issue.command || '').toLowerCase() !== 'plan' || !issue.plan) return null; try { const plan = typeof issue.plan === 'string' ? JSON.parse(issue.plan) : issue.plan; return plan && typeof plan === 'object' && !Array.isArray(plan) ? plan : null; } catch { return null; } }
function renderIssues() { els.issuesTable.replaceChildren(); if (!state.issues.length) return emptyRow(els.issuesTable, 'No issue plans loaded.'); state.issues.forEach((issue) => { const plan = storedPlan(issue); const row = document.createElement('tr'); const first = row.insertCell(); first.className = 'repo-cell'; append(first, 'strong', issue.repository || issue.fullName); append(first, 'small', `Issue #${text(issue.issueNumber)} · ${text(issue.issueTitle)}`); append(row.insertCell(), 'span', issue.command); append(row.insertCell(), 'span', `${text(plan?.provider || issue.provider, 'unavailable')} / ${text(plan?.model || issue.model, 'unavailable')}`); append(row.insertCell(), 'span', plan?.summary || issue.response || issue.summary || 'No response recorded.'); append(row.insertCell(), 'span', formatDate(issue.createdAt)); const action = row.insertCell(); if (issue.issueNumber) { const button = document.createElement('button'); button.className = 'ghost-button'; button.type = 'button'; button.textContent = plan ? 'View stored plan' : issue.command === 'patch' ? 'View patches' : 'Generate plan'; button.addEventListener('click', () => plan ? renderPlan({ ...plan, repository: issue.fullName || issue.repository, issueNumber: issue.issueNumber, issueTitle: issue.issueTitle, planId: issue.planId, stored: true }) : issue.command === 'patch' ? renderPlan({ repository: issue.fullName || issue.repository, issueNumber: issue.issueNumber, historyOnly: true }) : generatePlan(issue)); action.append(button); } els.issuesTable.append(row); }); }
function renderPlan(plan) {
  state.lastFocus = document.activeElement;
  const target = ++state.drawerEpoch;
  els.drawerTitle.textContent = `${text(plan.repository)} · Issue #${text(plan.issueNumber)}`;
  els.drawerContent.replaceChildren();
  const addList = (label, items) => { append(els.drawerContent, 'label', label); const list = document.createElement('ul'); (Array.isArray(items) ? items : []).forEach((item) => append(list, 'li', item)); if (!list.childNodes.length) append(list, 'li', 'None reported.'); els.drawerContent.append(list); };
  append(els.drawerContent, 'label', 'SUMMARY'); append(els.drawerContent, 'p', plan.summary);
  append(els.drawerContent, 'label', 'UNDERSTANDING'); append(els.drawerContent, 'p', plan.understanding);
  append(els.drawerContent, 'label', 'CONFIDENCE / MODEL'); append(els.drawerContent, 'p', `${plan.confidence || 'low'} · ${plan.provider || 'unavailable'} / ${plan.model || 'unavailable'}`);
  addList('AFFECTED FILES', (Array.isArray(plan.affectedFiles) ? plan.affectedFiles : []).map((file) => `${file.path} — ${file.reason}${file.plannedChange ? `; ${file.plannedChange}` : ''}`));
  addList('IMPLEMENTATION STEPS', plan.implementationSteps); addList('TEST PLAN', plan.testPlan); addList('RISKS', plan.risks); addList('ASSUMPTIONS', plan.assumptions);
  const linkUrl = issueLink(plan.repository, plan.issueNumber);
  if (linkUrl) { const link = document.createElement('a'); link.href = linkUrl; link.target = '_blank'; link.rel = 'noopener noreferrer'; link.textContent = 'Open issue on GitHub'; els.drawerContent.append(link); }
  const copy = document.createElement('button'); copy.className = 'ghost-button'; copy.type = 'button'; copy.textContent = 'Copy plan';
  copy.addEventListener('click', async () => { try { await navigator.clipboard.writeText(JSON.stringify(plan, null, 2)); copy.textContent = 'Copied'; } catch { copy.textContent = 'Copy unavailable'; } }); els.drawerContent.append(copy);
  if ((plan.stored || plan.historyOnly) && linkUrl) {
    const create = document.createElement('button'); create.className = 'primary-button'; create.type = 'button'; create.textContent = 'Create patch';
    if (plan.historyOnly) create.classList.add('hidden');
    const patchArea = document.createElement('section'); patchArea.className = 'patch-section'; patchArea.setAttribute('aria-live', 'polite');
    const history = document.createElement('div'); history.className = 'patch-history';
    append(history, 'label', 'STORED PATCH HISTORY');
    const historyItems = document.createElement('div'); history.append(historyItems);
    els.drawerContent.append(create, history, patchArea);
    const repository = plan.repository, issueNumber = Number(plan.issueNumber), accountEpoch = state.epoch;
    const current = () => state.account && accountEpoch === state.epoch && target === state.drawerEpoch && els.drawer.classList.contains('open');
    let proposal = null, patchId = null, cached = false, validation = null, busy = false;
    const redraw = () => { historyItems.querySelectorAll('button').forEach((item) => { item.disabled = busy; }); renderPatch(patchArea, proposal, { patchId, cached, validation, busy,
      onApprove: () => transition('patch-validate'), onReject: () => transition('patch-reject'), onRegenerate: () => generate(true),
      onCopy: async () => { try { await navigator.clipboard.writeText(proposal.diff); if (current()) message('Diff copied.'); } catch { if (current()) message('Copy unavailable. Use the diff text to copy manually.', true); } },
    }); };
    async function loadHistory(selectLatest = false) {
      try {
        const data = await callDashboard('patch-history', { repository, issueNumber });
        if (!current()) return;
        historyItems.replaceChildren();
        const patches = Array.isArray(data.patches) ? data.patches : [];
        if (!patches.length) append(historyItems, 'p', 'No stored patches.');
        for (const entry of patches) {
          const item = document.createElement('button'); item.type = 'button'; item.className = 'ghost-button';
          item.textContent = `${text(entry.patch?.status)} · ${formatDate(entry.createdAt)} · ${text(entry.patchId)}`;
          item.disabled = busy;
          item.addEventListener('click', () => { if (!current() || busy) return; proposal = entry.patch; patchId = entry.patchId; validation = entry.validation || null; cached = true; create.disabled = true; create.textContent = 'Patch proposal'; redraw(); });
          historyItems.append(item);
        }
        if (selectLatest && patches.length && !proposal && !busy) historyItems.firstChild.click();
      } catch (error) { if (current()) append(historyItems, 'p', error.message || 'Patch history unavailable.'); }
    }
    async function generate(refresh = false) {
      if (!current() || busy) return;
      busy = true; create.disabled = true; create.textContent = refresh ? 'Regenerating patch…' : 'Creating patch…'; redraw();
      try {
        const data = await callDashboard('patch', { repository, issueNumber, ...(refresh ? { refresh: true } : {}) });
        if (!current()) return;
        proposal = data.patch || null; patchId = data.patchId || null; cached = Boolean(data.cached); validation = data.validation || proposal?.validation || null;
        if (!proposal || !patchIdentity(proposal, patchId)) message('Server did not return a stored patch identity; approval unavailable.', true);
        redraw();
        await loadHistory();
      } catch (error) { if (current()) message(error.message || 'Patch generation failed.', true); }
      finally { busy = false; if (current()) { create.disabled = Boolean(proposal); create.textContent = proposal ? 'Patch proposal' : 'Create patch'; redraw(); } }
    }
    async function transition(action) {
      if (!current() || busy || proposal?.status !== 'proposed') return;
      const identity = patchIdentity(proposal, patchId); if (!identity) return;
      busy = true; redraw(); message(action === 'patch-validate' ? 'Applying patch in isolated workspace; awaiting server validation…' : 'Rejecting patch…');
      try {
        const data = await callDashboard(action, { repository, issueNumber, ...identity, ...(action === 'patch-validate' ? { approved: true } : {}) });
        if (!current() || patchId !== identity.patchId || proposal?.patchRevision !== identity.patchRevision) return;
        proposal = data.patch || { ...proposal, status: data.status || (action === 'patch-reject' ? 'rejected' : 'validation_unavailable') };
        patchId = data.patchId || patchId;
        validation = data.validation || proposal.validation || (action === 'patch-validate' ? { status: proposal.status, testsRun: false } : null);
        message('');
        await loadHistory();
      } catch (error) { if (current()) { if (/PATCH_STALE|PATCH_REVISION_MISMATCH/.test(error.message || '')) proposal = { ...proposal, status: 'expired' }; message(error.message || 'Patch action failed.', true); } }
      finally { busy = false; if (current()) redraw(); }
    }
    create.addEventListener('click', () => generate());
    loadHistory(true);
  }
  els.drawer.classList.add('open'); els.drawer.setAttribute('aria-hidden', 'false'); els.backdrop.classList.remove('hidden'); els.closeDrawer.focus();
}
async function generatePlan(issue) { const repository = issue.fullName || issue.repository; const issueNumber = Number(issue.issueNumber); if (!issueLink(repository, issueNumber)) return message('Issue record is missing valid repository metadata.', true); const epoch = state.epoch, target = state.drawerEpoch; message('Loading stored plan or generating plan…'); try { const data = await callDashboard('plan', { repository, issueNumber }); if (epoch !== state.epoch || target !== state.drawerEpoch || !state.account) return; renderPlan({ ...data.plan, repository, issueNumber, issueTitle: issue.issueTitle, stored: Boolean(data.plan) }); message(''); } catch (error) { if (epoch === state.epoch && target === state.drawerEpoch) message(error.message || 'Plan generation failed.', true); } }
function renderOverview(data = {}) { state.overview = data; state.reviews = Array.isArray(data.reviews) ? data.reviews : []; state.findings = (Array.isArray(data.findings) ? data.findings : []).flatMap((item) => Array.isArray(item.findings) ? item.findings.map((finding) => ({ ...finding, repository: finding.repository || item.repository, prNumber: finding.prNumber || item.prNumber, headSha: finding.headSha || item.headSha })) : [item]).map(normalizeFinding); state.issues = Array.isArray(data.issues) ? data.issues : []; els.reviewCount.textContent = state.reviews.length; els.findingCount.textContent = state.findings.length; els.issueCount.textContent = state.issues.length; const delivery = data.deliveryStats || {}; els.deliveryHealth.textContent = delivery.total ? `${Math.round(((delivery.completed || 0) / delivery.total) * 100)}%` : '—'; els.deliveryDetail.textContent = delivery.total ? `${delivery.completed || 0} completed / ${delivery.total} total` : 'No delivery telemetry'; const score = state.findings.length ? Math.min(99, Math.round((state.findings.filter((item) => /critical|high/i.test(`${item.severity} ${item.impact}`)).length / state.findings.length) * 100)) : 0; els.riskScore.textContent = state.findings.length ? score : '—'; els.riskSummary.textContent = state.findings.length ? `${state.findings.length} finding(s) mapped across the current review surface.` : 'No findings have been loaded.'; renderProviders(data.providers); renderReviews(); renderIssues(); }
function validHttpsUrl(value) { try { const url = new URL(value); return url.protocol === 'https:' ? url.href : ''; } catch { return ''; } }
function openReview(review = {}) { state.lastFocus = document.activeElement; state.drawerReview = review; els.drawerTitle.textContent = `${text(review.repository || review.fullName)} · PR #${text(review.prNumber)}`; const findings = state.findings.filter((finding) => (!review.prNumber || String(finding.prNumber) === String(review.prNumber)) && (!review.repository || finding.repository === review.repository)); const items = findings.length ? findings : [review]; els.drawerContent.replaceChildren(); const meta = document.createElement('div'); meta.className = 'trace-item'; append(meta, 'label', 'REVIEW'); append(meta, 'p', `Head SHA: ${text(review.headSha)}\nBase SHA: ${text(review.baseSha)}\nDelivery ID: ${text(review.deliveryId)}\nScore: ${text(review.score)}\nVerdict: ${text(review.verdict)}\nSummary: ${text(review.summary)}\nProvider / model: ${text(review.provider)} / ${text(review.model)}`); const url = validHttpsUrl(review.commitUrl); append(meta, 'label', 'COMMIT URL'); if (url) { const link = document.createElement('a'); link.href = url; link.target = '_blank'; link.rel = 'noreferrer'; link.textContent = url; meta.append(link); } else append(meta, 'p', 'No valid HTTPS commit URL recorded.'); els.drawerContent.append(meta); items.forEach((raw) => { const item = normalizeFinding(raw); const block = document.createElement('div'); block.className = 'trace-item'; append(block, 'label', 'FILE / LINE'); append(block, 'p', `${item.file}${item.line !== '—' ? `:${item.line}` : ''}`); append(block, 'label', `${item.severity} / ${item.title}`); append(block, 'p', item.explanation); append(block, 'label', 'IMPACT'); append(block, 'p', item.impact); append(block, 'label', 'SUGGESTION'); append(block, 'p', item.suggestion); append(block, 'label', 'EXAMPLE'); append(block, 'p', item.example); els.drawerContent.append(block); }); els.drawer.classList.add('open'); els.drawer.setAttribute('aria-hidden', 'false'); els.backdrop.classList.remove('hidden'); els.closeDrawer.focus(); if (review.prNumber) callDashboard('review', { repository: review.repository || review.fullName, prNumber: review.prNumber }).catch(() => {}); }
function closeDrawer() { state.drawerEpoch++; els.drawer.classList.remove('open'); els.drawer.setAttribute('aria-hidden', 'true'); els.backdrop.classList.add('hidden'); if (state.lastFocus?.focus) state.lastFocus.focus(); }
function showView(view) { document.querySelectorAll('.view').forEach((item) => item.classList.toggle('hidden', item.id !== `${view}View`)); document.querySelectorAll('[data-view]').forEach((item) => item.classList.toggle('is-active', item.dataset.view === view)); if (view === 'reviews') loadReviews(); if (view === 'issues') loadIssues(); }
async function loadReviews() { try { const data = await callDashboard('reviews'); state.reviews = data.reviews || []; state.findings = (data.findings || []).map(normalizeFinding); renderReviews(); } catch (error) { emptyRow(els.reviewsTable, `Reviews unavailable: ${error.message}`); } }
async function loadIssues() { try { const data = await callDashboard('issues'); state.issues = data.issues || []; renderIssues(); } catch (error) { emptyRow(els.issuesTable, `Issues unavailable: ${error.message}`); } }
async function refresh() { if (!state.account) return; message('Loading dashboard…'); els.refresh.disabled = true; try { const [overview, health] = await Promise.all([callDashboard('overview'), callDashboard('health')]); const overviewProviders = overview.providers || {}; const healthProviders = health.providers || {}; const providers = Object.fromEntries([...new Set([...Object.keys(overviewProviders), ...Object.keys(healthProviders)])].map((name) => [name, { ...(overviewProviders[name] || {}), ...(healthProviders[name] || {}) }])); renderOverview({ ...overview, providers }); setOnline(true); message(''); els.lastUpdated.textContent = new Date().toLocaleTimeString(); } catch (error) { setOnline(false); resetOverviewState(state, els, els); renderReviews(); renderIssues(); message(`Dashboard unavailable: ${error.message || 'request failed'}`, true); } finally { els.refresh.disabled = false; } }
function showApp(user) { state.epoch++; state.account = user; els.loginView.classList.add('hidden'); els.appView.classList.remove('hidden'); els.logout.classList.remove('hidden'); $('operatorLabel').textContent = user.email || user.name || user.$id; refresh(); }
async function boot() {
  // Run exactly once at application startup so the deployment can confirm
  // that the configured Appwrite endpoint and project are reachable.
  try {
    await pingAppwrite();
    console.info('Appwrite ping succeeded');
  } catch (error) {
    console.warn('Appwrite ping failed', error);
  }
  if (!configured()) { setOnline(false); return; }
  initSdk();
  try { showApp(await account.get()); } catch { setOnline(false); }
}
els.loginForm.addEventListener('submit', async (event) => { event.preventDefault(); els.loginMessage.textContent = ''; if (!configured()) { els.loginMessage.textContent = 'Configure Appwrite before authenticating.'; return; } try { initSdk(); await account.createEmailPasswordSession($('emailInput').value, $('passwordInput').value); showApp(await account.get()); } catch (error) { els.loginMessage.textContent = error.message || 'Authentication failed.'; } });
els.refresh.addEventListener('click', refresh); els.reviewsRefresh.addEventListener('click', loadReviews); els.logout.addEventListener('click', async () => { state.epoch++; state.account = null; closeDrawer(); els.appView.classList.add('hidden'); els.loginView.classList.remove('hidden'); els.logout.classList.add('hidden'); setOnline(false); try { await account.deleteSession('current'); } catch { els.loginMessage.textContent = 'Sign-out request failed; verify your session before signing in again.'; } });
document.querySelectorAll('[data-view]').forEach((button) => button.addEventListener('click', () => showView(button.dataset.view))); els.closeDrawer.addEventListener('click', closeDrawer); els.backdrop.addEventListener('click', closeDrawer); document.addEventListener('keydown', (event) => { if (event.key === 'Escape' && els.drawer.classList.contains('open')) closeDrawer(); });
boot();
