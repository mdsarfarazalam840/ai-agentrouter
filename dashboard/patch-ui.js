export function issueLink(repository, issueNumber) {
  if (typeof repository !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9-]{0,38}\/[A-Za-z0-9][A-Za-z0-9_.-]{0,99}$/.test(repository)) return '';
  const number = Number(issueNumber);
  if (!Number.isSafeInteger(number) || number < 1 || number > 1_000_000_000) return '';
  return `https://github.com/${repository}/issues/${number}`;
}

export function patchIdentity(patch, patchId) {
  return typeof patchId === 'string' && patchId.length > 0 && typeof patch?.patchRevision === 'string' && patch.patchRevision.length > 0
    ? { patchId, patchRevision: patch.patchRevision } : null;
}

export function canApprovePatch(patch, patchId) {
  return Boolean(patchIdentity(patch, patchId) && patch.status === 'proposed');
}

export function validationMessage(validation) {
  if (!validation) return 'No isolated validation has been run.';
  if (validation.status === 'validation_unavailable' || validation.testsRun === false) {
    return `Trusted isolated runner unavailable or validation could not run; tests not run. Status: ${validation.status || 'not_run'}.`;
  }
  if (validation.status === 'validated' && validation.testsRun === true) return 'Isolated tests passed.';
  return `Isolated validation status: ${validation.status || 'unknown'}; tests ${validation.testsRun === true ? 'ran' : 'not confirmed'}.`;
}

const display = (value) => value === undefined || value === null || value === '' ? '—' : String(value);
function node(parent, tag, value, className) {
  const element = document.createElement(tag);
  if (className) element.className = className;
  element.textContent = display(value);
  parent.append(element);
  return element;
}
function field(parent, label, value) { node(parent, 'label', label); node(parent, 'p', value); }
function list(parent, label, values) {
  node(parent, 'label', label);
  const ul = document.createElement('ul');
  const entries = Array.isArray(values) ? values : [];
  for (const value of entries) node(ul, 'li', value);
  if (!entries.length) node(ul, 'li', 'None reported.');
  parent.append(ul);
}
export function renderPatch(container, patch, { patchId, cached, validation, busy = false, onApprove, onReject, onRegenerate, onCopy } = {}) {
  container.replaceChildren();
  if (!patch || typeof patch !== 'object') return field(container, 'PATCH', 'No patch proposal available.');
  field(container, 'PATCH SUMMARY', patch.summary);
  field(container, 'STATUS', `${display(patch.status)}${cached ? ' · cached' : ''}`);
  field(container, 'PROVIDER / MODEL', `${display(patch.provider)} / ${display(patch.model)}`);
  field(container, 'REVISIONS', `Issue: ${display(patch.issueRevision)}\nPlan: ${display(patch.planRevision)}\nSnapshot: ${display(patch.snapshotRevision)}\nPatch: ${display(patch.patchRevision)}\nProposal ID: ${display(patchId)}`);
  field(container, 'CREATED', patch.createdAt);
  list(container, 'CHANGED FILES', (Array.isArray(patch.files) ? patch.files : []).map((file) => `${display(file.path)} · ${display(file.operation)} · +${display(file.additions)} / -${display(file.deletions)} · ${display(file.reason)}`));
  list(container, 'IMPLEMENTATION NOTES', patch.implementationNotes);
  list(container, 'RISKS', patch.risks);
  field(container, 'TEST COMMAND (SERVER-ALLOWLISTED)', patch.testCommand);
  node(container, 'label', 'FULL UNIFIED DIFF');
  const pre = document.createElement('pre'); pre.className = 'patch-diff';
  node(pre, 'code', typeof patch.diff === 'string' ? patch.diff : 'No diff reported.'); container.append(pre);
  field(container, 'ISOLATED VALIDATION', validationMessage(validation));
  const outputText = typeof validation?.output === 'string' ? validation.output : [validation?.stdout, validation?.stderr].filter((part) => typeof part === 'string' && part).join('\n');
  if (outputText) {
    node(container, 'label', 'BOUNDED TEST OUTPUT');
    const output = document.createElement('pre'); output.className = 'patch-diff'; node(output, 'code', outputText); container.append(output);
  }
  field(container, 'SCOPE', 'Approval applies only in an isolated workspace. It does not change GitHub or your live checkout.');
  const controls = document.createElement('div'); controls.className = 'patch-actions';
  const button = (label, callback, disabled) => { const item = node(controls, 'button', label, 'ghost-button'); item.type = 'button'; item.disabled = disabled; item.addEventListener('click', callback); };
  button('Approve and apply in isolated workspace', onApprove, busy || !canApprovePatch(patch, patchId));
  button('Reject patch', onReject, busy || !canApprovePatch(patch, patchId));
  button('Regenerate patch', onRegenerate, busy);
  button('Copy diff', onCopy, busy || typeof patch.diff !== 'string');
  container.append(controls);
}
