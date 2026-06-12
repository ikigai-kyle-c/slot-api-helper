const statusEl = document.querySelector('#status');
const resultEl = document.querySelector('#result-output');
const wsTrace = document.querySelector('#ws-trace');
const resultFileEl = document.querySelector('#result-file');
const recordsListEl = document.querySelector('#records-list');
const runtimeStateEl = document.querySelector('#runtime-state');
// Flow registries — populated by renderFlows() after fetching /api/flows.
let FLOW_DEFS = [];
let FLOW_BY_KEY = {};
const FORMS = {}; // flowKey -> <form>
const PANELS = {}; // flowKey -> <section>

const btnClearCache = document.querySelector('#btn-clear-cache');
const globalDomainEl = document.querySelector('#global-domain');
const globalSignatureEl = document.querySelector('#global-signature');
const globalGameCodeEl = document.querySelector('#global-gamecode');
const healthStatusEl = document.querySelector('#healthcheck-status');
const envRadios = document.querySelectorAll('input[name="envType"]');

const ENV_CONFIG = {
  LOCAL: { url: 'http://localhost:19080', sig: 'rgs-local-signature', gc: 'LGS-006', amUrl: 'http://localhost:8080' },
  CIT: { url: 'https://letsgo-rgs-gs1.iki-cit.cc', sig: 'rgs-local-signature', gc: 'LGS-006', amUrl: 'https://letsgo-rgs.iki-cit.cc' },
  QAT: { url: 'https://letsgo-rgs-gs1.iki-qat.cc', sig: 'rgs-local-signature', gc: 'LGS-006', amUrl: 'https://letsgo-rgs.iki-qat.cc' },
};

const SPLITTER_DEFAULTS = {
  'json-splitter-0': 'calc(29.7403% - 3px)',
  'main-splitter': 'calc(57.4705% - 3px)',
};
// Stacked (column) layout: controls' height fraction of the viewport.
const SPLITTER_DEFAULTS_V = {
  'main-splitter': 'calc(45% - 3px)',
};

function currentEnvType() {
  const r = document.querySelector('input[name="envType"]:checked');
  return r ? r.value : 'LOCAL';
}

// ---- Dynamic flow UI (built from /api/flows) ----
function esc(s) { return String(s).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;'); }

function stepGroupHtml(step) {
  return `
    <details class="step-group" open>
      <summary class="step-summary"><label class="step-checkbox"><input type="checkbox" name="run_${esc(step.key)}" checked> ${esc(step.label)}</label></summary>
      <div class="control-grid json-grid">
        <label class="json-field">Headers <textarea name="${esc(step.headersKey)}"></textarea></label>
        <label class="json-field">Body <textarea name="${esc(step.bodyKey)}"></textarea></label>
      </div>
    </details>`;
}

function fieldsCardHtml(flow) {
  if (!flow.fields || !flow.fields.length) return '';
  const rows = flow.fields.map((f) => f.type === 'checkbox'
    ? `<label class="toggle-row"><span>${esc(f.label)}</span><input name="${esc(f.name)}" type="checkbox"></label>`
    : `<label>${esc(f.label)} <input name="${esc(f.name)}" autocomplete="off"></label>`).join('');
  return `<div class="card mb-4" style="flex-shrink:0;"><h3>Admin Target</h3><div class="control-grid maintenance-grid">${rows}</div></div>`;
}

function panelHtml(flow) {
  return `
    <section id="${esc(flow.key)}-panel" class="panel">
      <form id="${esc(flow.key)}-form" class="flow-form">
        ${fieldsCardHtml(flow)}
        <details class="card local-overrides">
          <summary><h3>🔧 Execution Overrides (Target Environment)</h3></summary>
          <div class="control-grid mt-4">
            <div class="json-field span-full">
              <label>State Extraction Mapping (JSON) <span class="text-xs" style="color:var(--muted); font-weight:normal">(e.g. {"SESSION_TOKEN": "start.data.token"})</span></label>
              <textarea name="stateExtractMapping" placeholder='{"SESSION_TOKEN": "start.data.token"}' style="min-height: 50px"></textarea>
            </div>
            <label>API domain <input name="apiDomain" placeholder="Override global..." autocomplete="off"></label>
            <label>Signature <input name="signature" placeholder="Override global..." autocomplete="off"></label>
            <label>Game code <input name="gameCode" placeholder="Override global..." autocomplete="off"></label>
          </div>
        </details>
        <div class="card steps-container layout-horizontal">
          ${flow.steps.map(stepGroupHtml).join('')}
        </div>
        <div class="form-actions flex-between" id="${esc(flow.key)}-actions">
          <button class="primary btn-large" type="submit" style="flex: 1;">${esc(flow.executeIcon || '🚀')} Execute Checked Steps</button>
        </div>
      </form>
    </section>`;
}

function renderFlows(flows) {
  FLOW_DEFS = flows;
  FLOW_BY_KEY = Object.fromEntries(flows.map((f) => [f.key, f]));
  const tabsNav = document.querySelector('#flow-tabs');
  const controls = document.querySelector('#controls-column');
  tabsNav.innerHTML = `<select id="flow-select" class="flow-select" aria-label="Active flow">${
    flows.map((f) => `<option value="${esc(f.key)}">${esc(f.icon || '')} ${esc(f.label)}</option>`).join('')
  }</select>`;
  controls.innerHTML = flows.map(panelHtml).join('');
  flows.forEach((f, i) => {
    FORMS[f.key] = controls.querySelector(`#${f.key}-form`);
    PANELS[f.key] = controls.querySelector(`#${f.key}-panel`);
    if (i === 0) PANELS[f.key].classList.add('is-active');
    tabState[f.key] = { result: '{}', traceHtml: '', meta: '', statusText: 'Idle', statusClass: 'idle' };
  });
  activeTab = flows[0]?.key || '';
}

// Pre-fill each flow's form with the manifest defaults (step header/body + fields).
function fillFlowDefaults(flow) {
  const form = FORMS[flow.key];
  if (!form) return;
  for (const step of flow.steps) {
    const h = form.elements[step.headersKey];
    const b = form.elements[step.bodyKey];
    if (h) h.value = step.defaultHeadersJson || '';
    if (b) b.value = step.defaultBodyJson || '';
  }
  for (const f of flow.fields || []) {
    const el = form.elements[f.name];
    if (!el) continue;
    if (f.type === 'checkbox') el.checked = Boolean(f.default);
    else el.value = f.default ?? '';
  }
}

const wsTabs = document.querySelectorAll('.ws-tab');
const wsPanels = { result: document.querySelector('#ws-result'), trace: wsTrace };
let activeTab = '';
const tabState = {}; // flowKey -> snapshot, seeded in renderFlows()

function saveActiveTabState() {
  const currentClass = statusEl.className.replace('status badge ', '');
  tabState[activeTab] = { result: resultEl.textContent, traceHtml: wsTrace.innerHTML, meta: resultFileEl.textContent, statusText: statusEl.textContent, statusClass: currentClass };
}

function restoreTabState(tabName) {
  const state = tabState[tabName];
  resultEl.textContent = state.result;
  wsTrace.innerHTML = state.traceHtml;
  resultFileEl.textContent = state.meta;
  setStatus(state.statusText, state.statusClass);
  applyLayoutMode(localStorage.getItem('console_layout_mode') || 'horizontal');
}

// -------------------------------------------------------------
// AGGRESSIVE CACHING SYSTEM
// -------------------------------------------------------------
function saveAllInputs() {
  const cache = {};
  document.querySelectorAll('.flow-form').forEach((form) => {
    form.querySelectorAll('input:not([type="file"]), textarea').forEach((el) => {
      if (!el.name) return;
      const key = `${form.id}_${el.name}`;
      if (el.type === 'radio') { if (el.checked) cache[key] = el.value; }
      else if (el.type === 'checkbox') cache[key] = el.checked;
      else cache[key] = el.value;
    });
  });
  cache['runtime_state_editor'] = runtimeStateEl.value;
  localStorage.setItem('console_input_cache', JSON.stringify(cache));
}

function restoreCachedInputs() {
  const raw = localStorage.getItem('console_input_cache');
  if (!raw) return false;
  const cache = JSON.parse(raw);
  
  document.querySelectorAll('.flow-form').forEach((form) => {
    form.querySelectorAll('input:not([type="file"]), textarea').forEach((el) => {
      if (!el.name) return;
      const key = `${form.id}_${el.name}`;
      if (cache[key] !== undefined) {
        if (el.type === 'checkbox') el.checked = cache[key];
        else if (el.type === 'radio') { if (el.value === cache[key]) el.checked = true; }
        else el.value = cache[key];
      }
    });
  });
  
  if (cache['runtime_state_editor'] !== undefined) {
    runtimeStateEl.value = cache['runtime_state_editor'];
  }
  return true;
}

function saveEnvSpecificCache() {
  const currentEnv = document.querySelector('input[name="envType"]:checked').value;
  const cache = JSON.parse(localStorage.getItem('console_env_cache') || '{}');
  cache[currentEnv] = { domain: globalDomainEl.value, signature: globalSignatureEl.value, gameCode: globalGameCodeEl.value };
  localStorage.setItem('console_env_cache', JSON.stringify(cache));
}

function loadEnvSpecificCache(envType) {
  const cache = JSON.parse(localStorage.getItem('console_env_cache') || '{}');
  const envData = cache[envType] || {};
  globalDomainEl.value = envData.domain !== undefined ? envData.domain : ENV_CONFIG[envType].url;
  globalSignatureEl.value = envData.signature !== undefined ? envData.signature : ENV_CONFIG[envType].sig;
  globalGameCodeEl.value = envData.gameCode !== undefined ? envData.gameCode : ENV_CONFIG[envType].gc;
  triggerHealthCheck();
}

document.addEventListener('input', (e) => {
  if (['global-domain', 'global-signature', 'global-gamecode'].includes(e.target.id)) {
    clearTimeout(window.saveEnvTimeout); window.saveEnvTimeout = setTimeout(saveEnvSpecificCache, 200);
  } else {
    clearTimeout(window.saveTimeout); window.saveTimeout = setTimeout(saveAllInputs, 200);
  }
});
document.addEventListener('change', (e) => {
  if (!['global-domain', 'global-signature', 'global-gamecode'].includes(e.target.id)) saveAllInputs();
});
envRadios.forEach((radio) => radio.addEventListener('change', (e) => loadEnvSpecificCache(e.target.value)));

const stateModal = document.querySelector('#state-modal');
document.querySelector('#btn-open-state').addEventListener('click', () => stateModal.classList.add('is-active'));
document.querySelector('#btn-close-state').addEventListener('click', () => stateModal.classList.remove('is-active'));
stateModal.addEventListener('click', (e) => { if (e.target === stateModal) stateModal.classList.remove('is-active'); });

btnClearCache.addEventListener('click', () => {
  if (confirm('Are you sure you want to clear all cached inputs? This will reload the page and reset everything.')) {
    localStorage.clear(); window.location.reload();
  }
});

wsTabs.forEach((tab) => {
  tab.addEventListener('click', () => {
    const target = tab.dataset.ws;
    wsTabs.forEach((t) => t.classList.toggle('is-active', t === tab));
    Object.entries(wsPanels).forEach(([key, p]) => p.classList.toggle('is-active', key === target));
  });
});

function forceResultTab() {
  const resultTab = document.querySelector('.ws-tab[data-ws="result"]');
  if (resultTab) resultTab.click();
}

function setStatus(text, stateClass = 'idle') {
  statusEl.textContent = text;
  statusEl.className = `status badge ${stateClass}`;
}

function showJson(target, data) { target.textContent = JSON.stringify(data, null, 2); }
function resultMeta(data) { return [data.requestedAt ? `${data.requestedAt} -> ${data.respondedAt}` : null, data.resultFile].filter(Boolean).join('  |  '); }
function resultPayload(payload, fallback) { if (!payload) return { error: fallback }; const { logs, ...rest } = payload; return rest; }

function setBusy(isBusy) {
  document.querySelectorAll('.flow-form button[type="submit"]').forEach((b) => {
    b.disabled = isBusy;
    if (isBusy) b.textContent = '⏳ Processing...';
  });
}

function restoreButtonText() {
  FLOW_DEFS.forEach((flow) => {
    const btn = FORMS[flow.key]?.querySelector('button[type="submit"]');
    if (btn) btn.textContent = `${flow.executeIcon || '🚀'} Execute Checked Steps`;
  });
}

function formValues(form, flowName) {
  // A flow may live on a different host (e.g. maintenance AM service). domainField
  // names which ENV_CONFIG url to use; otherwise the global env domain.
  const flow = FLOW_BY_KEY[flowName];
  const apiDomain = flow && flow.domainField
    ? (ENV_CONFIG[currentEnvType()]?.[flow.domainField] || flow.defaultDomain || '')
    : globalDomainEl.value;
  const data = { apiDomain, signature: globalSignatureEl.value, gameCode: globalGameCodeEl.value, steps: [] };
  
  for (const element of form.elements) {
    if (!element.name) continue;
    if (element.type === 'checkbox' && element.name.startsWith('run_')) {
      if (element.checked) data.steps.push(element.name.replace('run_', ''));
    } else if (element.type === 'checkbox') {
      data[element.name] = element.checked;
    } else if (!['apiDomain', 'signature', 'gameCode'].includes(element.name) || element.value !== '') {
      data[element.name] = element.value;
    }
  }

  try { data.state = JSON.parse(runtimeStateEl.value || '{}'); } catch { data.state = {}; }
  return data;
}

async function postJson(url, body) {
  const response = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const data = await response.json();
  if (!response.ok || data.error) { const error = new Error(data.error || `HTTP ${response.status}`); error.payload = data; throw error; }
  return data;
}

async function getJson(url) {
  const response = await fetch(url);
  const data = await response.json();
  if (!response.ok || data.error) { const error = new Error(data.error || `HTTP ${response.status}`); error.payload = data; throw error; }
  return data;
}

document.addEventListener('blur', (event) => {
  if (event.target.tagName !== 'TEXTAREA') return;
  const raw = event.target.value.trim();
  if (!raw) return;
  try { event.target.value = JSON.stringify(JSON.parse(raw), null, 2); saveAllInputs(); } catch {}
}, true);

async function loadConfig() {
  const limitInput = document.getElementById('setting-history-limit');
  if (limitInput) {
    limitInput.value = localStorage.getItem('console_history_limit') || '100';
    limitInput.addEventListener('change', (e) => {
      localStorage.setItem('console_history_limit', e.target.value);
    });
  }

  // Build the entire flow UI from the declarative manifest.
  const flows = await getJson('/api/flows');
  renderFlows(flows);
  wireFlowEvents();
  flows.forEach(fillFlowDefaults);

  restoreCachedInputs();
  const activeRadio = document.querySelector('input[name="envType"]:checked');
  if (activeRadio) loadEnvSpecificCache(activeRadio.value);
  // Re-render mapping rows from restored textarea values (must run AFTER restoreCachedInputs).
  initStateMappers();
  initJsonSplitters();
  applyLayoutMode(localStorage.getItem('console_layout_mode') || 'horizontal');
}

// Healthcheck
async function triggerHealthCheck() {
  const url = globalDomainEl.value;
  healthStatusEl.className = 'health-status checking'; healthStatusEl.innerHTML = 'Checking...';
  try {
    const res = await postJson('/api/ping', { url });
    if (res.ok) { healthStatusEl.className = 'health-status reachable'; healthStatusEl.innerHTML = '✓ Reachable'; } 
    else { healthStatusEl.className = 'health-status unreachable'; healthStatusEl.innerHTML = '✗ Unreachable'; }
  } catch (e) { healthStatusEl.className = 'health-status unreachable'; healthStatusEl.innerHTML = '✗ Unreachable'; }
}

let pingTimeout;
globalDomainEl.addEventListener('input', () => { clearTimeout(pingTimeout); pingTimeout = setTimeout(triggerHealthCheck, 500); });

// Recent Executions Dropdown
const btnToggleRecent = document.querySelector('#btn-toggle-recent');
const recentDropdown = document.querySelector('#recent-dropdown');
btnToggleRecent.addEventListener('click', () => recentDropdown.classList.toggle('is-active'));
document.addEventListener('click', (e) => {
  // Keep open when switching flow tabs; only close on genuine outside clicks.
  if (!e.target.closest('.recent-wrapper') && !e.target.closest('#flow-select')) recentDropdown.classList.remove('is-active');
});

function renderRecords(records) {
  recordsListEl.textContent = '';
  if (!records.length) return recordsListEl.innerHTML = '<div class="text-xs">No records yet</div>';
  records.forEach((record) => {
    const btn = document.createElement('button'); btn.className = 'record-button'; btn.type = 'button'; btn.dataset.id = record.id;
    const nameRow = document.createElement('div'); nameRow.className = 'record-name-row';
    const name = document.createElement('span'); name.className = 'record-name'; name.textContent = record.file;
    nameRow.append(name);
    const st = record.status;
    if (st) {
      const badge = document.createElement('span');
      badge.className = 'record-status ' + (st.ok ? 'is-ok' : st.warn ? 'is-warn' : 'is-err');
      badge.textContent = st.ok ? `${st.code} OK` : String(st.code);
      badge.title = st.msg || '';
      nameRow.append(badge);
    }
    const time = document.createElement('span'); time.className = 'record-time'; time.textContent = `${record.updatedAt}${record.hasTrace ? ' | Trace' : ''}`;
    btn.append(nameRow, time);
    if (st && !st.ok && st.msg) {
      const err = document.createElement('span'); err.className = 'record-error'; err.textContent = midTrim(st.msg); err.title = st.msg;
      btn.append(err);
    }
    btn.addEventListener('click', () => { loadRecord(record.id, btn); recentDropdown.classList.remove('is-active'); });
    recordsListEl.append(btn);
  });
}

// Middle-trim long strings so they fit the record row: "Activate fai…required token".
function midTrim(str, max = 42) {
  const s = String(str || '');
  if (s.length <= max) return s;
  const head = Math.ceil((max - 1) * 0.65);
  const tail = max - 1 - head;
  return s.slice(0, head) + '…' + s.slice(s.length - tail);
}

function saveRecordToFlow(flow, recordData, statusInfo = null) {
  const key = `api_records_${flow}`;
  let records = [];
  try { records = JSON.parse(localStorage.getItem(key)) || []; } catch(e) { records = []; }

  const id = Date.now().toString();
  const fileLabel = `Flow Record ${new Date().toLocaleTimeString()}`;
  const newRecord = {
    id, file: fileLabel, updatedAt: new Date().toLocaleString(),
    hasTrace: !!(recordData.logs && recordData.logs.length),
    status: statusInfo,
    ...recordData
  };
  records.unshift(newRecord);
  let limit = 100;
  try {
    const limitInput = document.getElementById('setting-history-limit');
    limit = parseInt(limitInput ? limitInput.value : localStorage.getItem('console_history_limit'), 10) || 100;
  } catch(e) {}
  if (records.length > limit) records = records.slice(0, limit);
  
  try { localStorage.setItem(key, JSON.stringify(records)); } 
  catch(e) {
    try { localStorage.setItem(key, JSON.stringify(records.slice(0, 10))); } catch(err) {} 
  }
  return newRecord;
}

async function loadRecords() {
  const key = `api_records_${activeTab}`;
  let records = [];
  try { records = JSON.parse(localStorage.getItem(key)) || []; } catch(e) {}
  renderRecords(records || []);
}

async function loadRecord(id, button) {
  setStatus('Loading record', 'running');
  try {
    const key = `api_records_${activeTab}`;
    let records = [];
    try { records = JSON.parse(localStorage.getItem(key)) || []; } catch(e) {}
    
    const data = records.find(r => r.id === id || r.file === id);
    if (!data) throw new Error("Record not found");

    showJson(resultEl, data.result); renderTraceLogs(data.logs || []); resultFileEl.textContent = resultMeta(data);
    document.querySelectorAll('.record-button').forEach((item) => item.classList.toggle('is-active', item === button));
    setStatus('Record Loaded', 'success'); forceResultTab();
  } catch (error) {
    showJson(resultEl, resultPayload(error.payload, error.message)); renderTraceLogs([]);
    setStatus('Error', 'error'); forceResultTab();
  }
}

function renderTraceLogs(logs) {
  if (!logs || !logs.length) {
    wsTrace.innerHTML = '<pre style="padding:16px; color:var(--muted);">[]</pre>';
    return;
  }

  let html = `<div class="steps-container">`;
  logs.forEach((log, i) => {
    const isError = log.status >= 400;
    const badgeHtml = log.status ? `<span class="badge ${isError ? 'error' : 'success'} ml-auto" style="padding:2px 6px; font-size:10px;">${log.status}</span>` : '';
    html += `
      <details class="step-group" ${i === 0 ? 'open' : ''}>
        <summary class="step-summary">
          <span style="font-family:ui-monospace, monospace; font-size:12px; color:#38bdf8; text-transform:uppercase;">${log.step}</span>
          ${badgeHtml}
        </summary>
        <div class="trace-content">
          <pre>${JSON.stringify(log, null, 2)}</pre>
        </div>
      </details>
    `;
  });
  html += `</div>`;
  wsTrace.innerHTML = html;
  
  applyLayoutMode(localStorage.getItem('console_layout_mode') || 'horizontal');
}



// Wire flow tabs + submit handlers. Called after renderFlows() builds the DOM.
function wireFlowEvents() {
  const sel = document.querySelector('#flow-select');
  sel.addEventListener('change', () => {
    saveActiveTabState();
    activeTab = sel.value;
    Object.entries(PANELS).forEach(([key, panel]) => panel.classList.toggle('is-active', key === activeTab));
    restoreTabState(activeTab); loadRecords();
    switchFlowCacheTo(activeTab);
  });
  FLOW_DEFS.forEach((flow) => {
    FORMS[flow.key].addEventListener('submit', (e) => {
      e.preventDefault();
      executeFlow(FORMS[flow.key], `/api/flow/${flow.key}`, flow.key);
    });
  });
}

function extractPaths(obj, prefix = "") {
  let paths = [];
  try {
    if (!obj || typeof obj !== 'object') return paths;
    for (const k in obj) {
      if (obj[k] !== null && typeof obj[k] === 'object' && !Array.isArray(obj[k])) {
        paths.push(...extractPaths(obj[k], prefix + k + '.'));
      } else if (Array.isArray(obj[k])) {
        paths.push(prefix + k);
        // optionally extract paths for first element of array
        if (obj[k].length > 0 && typeof obj[k][0] === 'object' && obj[k][0] !== null) {
          paths.push(...extractPaths(obj[k][0], prefix + k + '[0].'));
        }
      } else {
        paths.push(prefix + k);
      }
    }
  } catch (e) {
    console.error("extractPaths Error on prefix", prefix, ":", e);
  }
  return paths;
}

async function executeFlow(form, apiPath, flowName) {
  setBusy(true); setStatus('Running', 'running'); resultFileEl.textContent = '';
  try {
    const data = await postJson(apiPath, formValues(form, flowName));
    const statusInfo = data.maintenanceBlock
      ? { ok: false, warn: true, code: 'BLOCK', msg: data.maintenanceBlock.step || 'maintenance' }
      : { ok: true, code: 200, msg: '' };
    const saved = saveRecordToFlow(flowName, data, statusInfo);
    localStorage.setItem(`api_cache_${flowName}`, JSON.stringify(data.state || {}));
    refreshFlowCacheIfOpen(flowName);

    try {
      console.log("Extracting paths for flow", flowName, data.result);
      const newlyExtracted = extractPaths(data.result || {});
      console.log("Extracted paths:", newlyExtracted);
      let existingPaths = [];
      try { existingPaths = JSON.parse(localStorage.getItem('schema_cache_' + flowName) || '[]'); } catch(e) {}
      const combined = newlyExtracted;
      
      console.log("Saving dynamic schema cache for", flowName, combined);
      localStorage.setItem('schema_cache_' + flowName, JSON.stringify(combined));
      window.dispatchEvent(new CustomEvent('schema_updated', { detail: { flow: flowName, changed: JSON.stringify(existingPaths) !== JSON.stringify(combined) } }));
    } catch(e) {
      console.error("Error updating schema cache for", flowName, e);
    }
    showJson(resultEl, data.result); renderTraceLogs(data.logs); resultFileEl.textContent = resultMeta(saved);
    runtimeStateEl.value = JSON.stringify(data.state, null, 2);
    saveAllInputs(); 

    const finalState = data.maintenanceBlock ? 'warning' : 'success';
    setStatus(data.maintenanceBlock ? `Maintenance: ${data.maintenanceBlock.step}` : 'Done', finalState);
    await loadRecords();
  } catch (error) {
    const errData = error.payload || {};
    const isBlock = (error.message || '').includes('MAINTENANCE');
    const eMsg = errData.details?.response?.error?.message
      || errData.details?.response?.message
      || errData.error || error.message || 'Error';
    const statusInfo = {
      ok: false,
      warn: isBlock,
      code: errData.details?.status || (isBlock ? 'BLOCK' : 'ERR'),
      msg: errData.error && errData.error !== eMsg ? `${errData.error}: ${eMsg}` : eMsg,
    };
    const saved = saveRecordToFlow(flowName, { result: errData, logs: errData.logs, state: errData.state }, statusInfo);
    if (errData.state) { localStorage.setItem(`api_cache_${flowName}`, JSON.stringify(errData.state)); refreshFlowCacheIfOpen(flowName); }
    showJson(resultEl, resultPayload(error.payload, error.message)); renderTraceLogs(errData.logs || []);
    resultFileEl.textContent = resultMeta(saved);
    setStatus(error.message.includes('MAINTENANCE BLOCKED') ? 'Maintenance Block' : 'Error', error.message.includes('MAINTENANCE BLOCKED') ? 'warning' : 'error');
    await loadRecords();
  } finally { setBusy(false); restoreButtonText(); forceResultTab(); }
}

// Boot: loadConfig() fetches /api/flows, renders the whole UI, then wires events.
loadConfig().then(() => loadRecords()).catch(() => setStatus('Error', 'error'));

document.querySelectorAll('pre[tabindex="0"]').forEach((pre) => {
  pre.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'a') {
      e.preventDefault();
      const selection = window.getSelection(); const range = document.createRange();
      range.selectNodeContents(pre); selection.removeAllRanges(); selection.addRange(range);
    }
  });
});

// --- DYNAMIC TABS & LAYOUT LOGIC ---
const settingsModal = document.querySelector('#settings-modal');
document.querySelector('#btn-open-settings').addEventListener('click', () => settingsModal.classList.add('is-active'));
document.querySelector('#btn-close-settings').addEventListener('click', () => settingsModal.classList.remove('is-active'));
settingsModal.addEventListener('click', (e) => { if (e.target === settingsModal) settingsModal.classList.remove('is-active'); });

function applyLayoutMode(mode) {
  document.querySelectorAll('.steps-container').forEach(container => {
    // Check if we already have an active tab index
    let activeIndex = 0;
    const groups = container.querySelectorAll('.step-group');
    groups.forEach((g, i) => {
      if (g.classList.contains('is-active')) {
        activeIndex = i;
      }
    });

    // FIX: Only toggle layout modes, do not overwrite other classes
    container.classList.remove('layout-showall', 'layout-horizontal', 'layout-vertical');
    container.classList.add(`layout-${mode}`);
    
    let tabsDiv = container.querySelector('.steps-tabs');
    if (tabsDiv) tabsDiv.remove();
    let oldSplitter = container.querySelector('.vertical-splitter');
    if (oldSplitter) oldSplitter.remove();

    tabsDiv = document.createElement('div');
    tabsDiv.className = 'steps-tabs';
    
    const isTrace = container.closest('#ws-trace') !== null;
    if (!isTrace) { 
      const toggleAllBtn = document.createElement('button');
      toggleAllBtn.type = 'button';
      toggleAllBtn.className = 'tab-master-btn';
      toggleAllBtn.textContent = 'Toggle All';
      let allTicked = true;
      toggleAllBtn.addEventListener('click', () => {
        allTicked = !allTicked;
        tabsDiv.querySelectorAll('input[type="checkbox"]').forEach(cb => { cb.checked = allTicked; cb.dispatchEvent(new Event('change')); });
      });
      tabsDiv.appendChild(toggleAllBtn);
    }

    groups.forEach((group, index) => {
      const summaryTag = group.querySelector('summary');
      if (!summaryTag) return;
      
      const title = summaryTag.textContent.replace(/[0-9]+\.\s*/, '');
      const hiddenCheckbox = group.querySelector('.step-checkbox input[type="checkbox"]');
      
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = `step-tab ${index === activeIndex ? 'is-active' : ''}`;
      btn.title = title;

      if (hiddenCheckbox && !isTrace) {
        btn.innerHTML = `<input type="checkbox" ${hiddenCheckbox.checked ? 'checked' : ''}> <span>${title}</span>`;
        const tabCb = btn.querySelector('input');
        tabCb.addEventListener('change', (e) => {
          hiddenCheckbox.checked = e.target.checked;
          saveAllInputs(); 
        });
      } else {
        btn.innerHTML = `<span>${title}</span>`;
      }

      if (index === activeIndex) {
        group.classList.add('is-active');
        group.setAttribute('open', '');
      } else {
        group.classList.remove('is-active');
        if (mode !== 'showall') group.removeAttribute('open');
      }

      btn.addEventListener('click', (e) => {
        if (e.target.tagName.toLowerCase() === 'input') return;
        tabsDiv.querySelectorAll('.step-tab').forEach(t => t.classList.remove('is-active'));
        groups.forEach(g => {
          g.classList.remove('is-active');
          if (mode !== 'showall') g.removeAttribute('open');
        });
        btn.classList.add('is-active');
        group.classList.add('is-active');
        group.setAttribute('open', '');
        if (mode === 'showall') group.scrollIntoView({ behavior: 'smooth', block: 'start' });
      });
      tabsDiv.appendChild(btn);
    });
    container.prepend(tabsDiv);
    if (mode === 'vertical' && groups.length > 0) {
      const splitter = document.createElement('div');
      splitter.className = 'vertical-splitter';
      splitter.id = `vertical-splitter-${container.closest('.panel')?.id || container.id || Math.random().toString(36).substring(7)}`;
      splitter.style.width = '6px';
      splitter.style.background = 'var(--line)';
      splitter.style.cursor = 'col-resize';
      splitter.style.flexShrink = '0';
      splitter.style.borderRadius = '4px';
      splitter.style.marginLeft = '8px';
      splitter.style.marginRight = '8px';
      
      container.insertBefore(splitter, groups[0]);
      initSplitter(splitter, tabsDiv, groups[0], false);
      const savedWidth = localStorage.getItem(`splitter_${splitter.id}`) || SPLITTER_DEFAULTS[splitter.id];
      if (savedWidth) tabsDiv.style.width = savedWidth;
    }

  });
}

const savedLayout = localStorage.getItem('console_layout_mode') || 'horizontal';
const layoutRadio = document.querySelector(`input[name="layoutMode"][value="${savedLayout}"]`);
if (layoutRadio) layoutRadio.checked = true;
applyLayoutMode(savedLayout);

document.querySelectorAll('input[name="layoutMode"]').forEach(radio => {
  radio.addEventListener('change', (e) => {
    localStorage.setItem('console_layout_mode', e.target.value);
    applyLayoutMode(e.target.value);
  });
});

function applyTrimTabs(enabled) {
  document.body.classList.toggle('no-trim', !enabled);
}
const trimToggle = document.getElementById('setting-trim-tabs');
const savedTrim = localStorage.getItem('console_trim_tabs');
const trimEnabled = savedTrim === null ? false : savedTrim === 'true';
if (trimToggle) trimToggle.checked = trimEnabled;
applyTrimTabs(trimEnabled);
if (trimToggle) {
  trimToggle.addEventListener('change', (e) => {
    localStorage.setItem('console_trim_tabs', String(e.target.checked));
    applyTrimTabs(e.target.checked);
  });
}

// --- FLOW CACHE DROPDOWN (mirrors Recent Executions) ---
const cacheDropdown = document.querySelector('#cache-dropdown');
const cacheContentEl = document.querySelector('#backend-cache-content');

function renderFlowCache(flow) {
  if (!cacheContentEl) return;
  const val = localStorage.getItem(`api_cache_${flow}`);
  try {
    const obj = JSON.parse(val || "{}");
    let htmlStr = '<table class="cache-table" style="width:100%; border-collapse: collapse;">';
    for (const [k, v] of Object.entries(obj)) {
      htmlStr += `<tr>
        <td style="padding: 12px 8px; border-bottom: 1px solid var(--line); font-weight: bold; width: 30%; word-break: break-all; vertical-align: top; color: var(--accent);">${k}</td>
        <td style="padding: 12px 8px; border-bottom: 1px solid var(--line); word-break: break-all; font-family: monospace; cursor: text; vertical-align: top; line-height: 1.4;"
            ondblclick="const s=window.getSelection(); const r=document.createRange(); r.selectNodeContents(this); s.removeAllRanges(); s.addRange(r);">${v}</td>
      </tr>`;
    }
    htmlStr += '</table>';
    if (Object.keys(obj).length === 0) htmlStr = '<div style="padding:16px; color:var(--muted)">{}</div>';
    cacheContentEl.innerHTML = htmlStr;
  } catch(e) {
    cacheContentEl.innerHTML = '<div style="padding:16px; color:var(--muted)">{}</div>';
  }
}

function cacheIsOpen() {
  return cacheDropdown && cacheDropdown.classList.contains('is-active');
}

// Live re-render while open + active flow (no refresh).
function refreshFlowCacheIfOpen(flow) {
  if (cacheIsOpen() && flow === activeTab) renderFlowCache(flow);
}

// On flow-tab switch, keep dropdown open and show the new flow's cache.
function switchFlowCacheTo(flow) {
  if (cacheIsOpen()) renderFlowCache(flow);
}

if (cacheDropdown && cacheContentEl) {
  const btnToggleCache = document.querySelector('#btn-toggle-cache');
  btnToggleCache.addEventListener('click', () => {
    const open = cacheDropdown.classList.toggle('is-active');
    if (open) renderFlowCache(activeTab);
  });
  // Stay open across flow-tab switches; close only on genuine outside clicks.
  document.addEventListener('click', (e) => {
    if (!e.target.closest('#cache-wrapper') && !e.target.closest('#flow-select')) {
      cacheDropdown.classList.remove('is-active');
    }
  });

}



// Splitter Logic — orientation-aware: resizes width in side-by-side (row) layouts,
// height in stacked (column) layouts (vertical/portrait monitors).
function initSplitter(splitter, leftEl, rightEl, isPercent = false) {
  let isDragging = false;
  const splitterKey = splitter.id || Array.from(splitter.parentNode.children).indexOf(splitter);
  const isColumn = () => getComputedStyle(splitter.parentElement).flexDirection === 'column';

  const applySaved = () => {
    if (isColumn()) {
      const s = localStorage.getItem(`splitter_${splitterKey}_v`) || SPLITTER_DEFAULTS_V[splitterKey];
      if (s) { leftEl.style.height = s; leftEl.style.minHeight = '0'; leftEl.style.flex = 'none'; leftEl.style.width = ''; }
    } else {
      const s = localStorage.getItem(`splitter_${splitterKey}`) || SPLITTER_DEFAULTS[splitterKey];
      if (s) { leftEl.style.width = s; leftEl.style.minWidth = '0'; leftEl.style.flex = 'none'; leftEl.style.height = ''; }
    }
  };
  splitter._applySaved = applySaved; // allow re-apply on orientation change

  splitter.addEventListener('mousedown', (e) => {
    isDragging = true;
    splitter.classList.add('is-dragging');
    document.body.style.cursor = isColumn() ? 'row-resize' : 'col-resize';
    e.preventDefault();
  });
  document.addEventListener('mousemove', (e) => {
    if (!isDragging) return;
    const rect = splitter.parentElement.getBoundingClientRect();
    if (isColumn()) {
      const y = e.clientY - rect.top;
      leftEl.style.height = `calc(${(y / rect.height) * 100}% - ${splitter.offsetHeight / 2}px)`;
      leftEl.style.minHeight = '0'; leftEl.style.flex = 'none'; leftEl.style.width = '';
    } else {
      const x = e.clientX - rect.left;
      leftEl.style.width = isPercent
        ? `calc(${(x / rect.width) * 100}% - ${splitter.offsetWidth / 2}px)`
        : `${Math.max(40, Math.min(x, rect.width - 200))}px`;
      leftEl.style.minWidth = '0'; leftEl.style.flex = 'none'; leftEl.style.height = '';
    }
  });
  document.addEventListener('mouseup', () => {
    if (!isDragging) return;
    isDragging = false;
    splitter.classList.remove('is-dragging');
    document.body.style.cursor = 'default';
    if (isColumn()) localStorage.setItem(`splitter_${splitterKey}_v`, leftEl.style.height);
    else localStorage.setItem(`splitter_${splitterKey}`, leftEl.style.width);
  });

  applySaved();
}

// Inject JSON splitters — runs after the flow forms are rendered.
function initJsonSplitters() {
  document.querySelectorAll('.json-grid').forEach((grid, idx) => {
    if (grid.querySelector('.json-splitter')) return; // already injected
    const splitter = document.createElement('div');
    splitter.className = 'json-splitter';
    splitter.id = `json-splitter-${idx}`;
    const firstChild = grid.children[0];
    const secondChild = grid.children[1];
    grid.insertBefore(splitter, secondChild);
    initSplitter(splitter, firstChild, secondChild, true);
  });
}

// Init Main Splitter
const mainSplitter = document.getElementById('main-splitter');
const controlsColumn = document.getElementById('controls-column');
const workspaceColumn = document.getElementById('workspace-column');
if (mainSplitter && controlsColumn && workspaceColumn) {
  initSplitter(mainSplitter, controlsColumn, workspaceColumn, true);
  // Re-apply the correct (width vs height) saved size when orientation/layout flips.
  let reapplyTimer;
  window.addEventListener('resize', () => {
    clearTimeout(reapplyTimer);
    reapplyTimer = setTimeout(() => {
      document.querySelectorAll('.main-splitter, .json-splitter').forEach(s => s._applySaved && s._applySaved());
    }, 150);
  });
}

function initStateMappers() {
  document.querySelectorAll('textarea[name="stateExtractMapping"]').forEach(textarea => {
    textarea.style.display = 'none';
    
    let oldContainer = textarea.nextElementSibling;
    if (oldContainer && oldContainer.classList.contains('state-mapper')) {
      oldContainer.remove();
    }
    
    const container = document.createElement('div');
    container.className = 'state-mapper';
    textarea.parentNode.insertBefore(container, textarea.nextSibling);
    
    const formId = textarea.closest('form').id;
    const flowName = formId.replace('-form', '');
    
    const datalistId = 'schema-list-' + flowName;
    let datalist = document.getElementById(datalistId);
    if (!datalist) {
      datalist = document.createElement('datalist');
      datalist.id = datalistId;
      document.body.appendChild(datalist);
    }
    
    const updateDatalist = (isChanged) => {
      let paths = [];
      try { paths = JSON.parse(localStorage.getItem('schema_cache_' + flowName) || '[]'); } catch(e) {}
      console.log("Updating datalist for", flowName, "with paths:", paths);
      datalist.innerHTML = paths.map(p => {
        const step = String(p).split('.')[0];
        return `<option value="${p}" label="[${step.toUpperCase()}] ${p}"></option>`;
      }).join('');
      
      if (isChanged) {
         const notice = document.createElement('div');
         notice.style.cssText = 'font-size:10px; color:#fbbf24; margin-top:4px; padding:4px; border:1px solid #fbbf2433; border-radius:4px; background:#fbbf2411;';
         notice.innerHTML = '⚠️ Schema updated. Field paths may have changed. Check existing mappings.';
         container.querySelector('strong').after(notice);
         setTimeout(() => notice.remove(), 8000);
      }
    };
    updateDatalist();
    window.__schemaBound = window.__schemaBound || {};
    if (!window.__schemaBound[flowName]) {
      window.__schemaBound[flowName] = true;
      window.addEventListener('schema_updated', (e) => {
        if (e.detail.flow === flowName) updateDatalist(e.detail.changed);
      });
    }
    
    const renderRows = () => {
      let mapping = {};
      try { mapping = JSON.parse(textarea.value); } catch(e) {}
      
            container.innerHTML = `<div style="font-size:13px; color:var(--text); margin-bottom:12px; display:flex; justify-content:space-between; align-items:center;">
        <strong>🎯 Extract to Flow Cache</strong>
        <span style="font-size:10px; color:var(--muted); font-weight:normal;" title="Tracks response structure to suggest paths">✨ Auto-suggests based on Responses</span>
      </div>`;
      
      Object.entries(mapping).forEach(([key, path]) => {
        const row = document.createElement('div');
        row.className = 'state-mapper-row';
        
        const pathInput = document.createElement('input');
        pathInput.placeholder = 'e.g. start.data.token';
        pathInput.value = path;
        pathInput.setAttribute('list', datalistId);
        
        const keyInput = document.createElement('input');
        keyInput.placeholder = 'e.g. SESSION_TOKEN';
        keyInput.value = key;
        
        const delBtn = document.createElement('button');
        delBtn.type = 'button';
        delBtn.textContent = '❌';
        delBtn.title = 'Delete Mapping';
        delBtn.onclick = () => {
          let m = {};
          try { m = JSON.parse(textarea.value); } catch(e) {}
          delete m[key];
          textarea.value = JSON.stringify(m);
          textarea.dispatchEvent(new Event('change'));
          renderRows();
        };
        
        const updateMapping = () => {
          const newMapping = {};
          container.querySelectorAll('.state-mapper-row').forEach(r => {
             const p = r.children[0].value.trim();
             const k = r.children[2].value.trim();
             if (k && p) newMapping[k] = p;
          });
          textarea.value = JSON.stringify(newMapping);
        };
        
        pathInput.addEventListener('input', updateMapping);
        keyInput.addEventListener('input', updateMapping);
        pathInput.addEventListener('change', () => textarea.dispatchEvent(new Event('change')));
        keyInput.addEventListener('change', () => textarea.dispatchEvent(new Event('change')));
        
        // visual icon emoji
        const arr = document.createElement('span');
        arr.textContent = '➡️';
        arr.style.fontSize = '12px';
        
        row.append(pathInput, arr, keyInput, delBtn);
        container.appendChild(row);
      });
      
      const addBtn = document.createElement('button');
      addBtn.type = 'button';
      addBtn.className = 'state-mapper-add';
      addBtn.textContent = '➕ Add New Mapping';
      addBtn.onclick = () => {
        const newMapping = {};
        container.querySelectorAll('.state-mapper-row').forEach(r => {
           const p = r.children[0].value.trim();
           const k = r.children[2].value.trim();
           if (k && p) newMapping[k] = p;
        });
        newMapping['NEW_KEY_' + Date.now().toString().slice(-4)] = 'step.data.field';
        textarea.value = JSON.stringify(newMapping);
        textarea.dispatchEvent(new Event('change'));
        renderRows();
      };
      container.appendChild(addBtn);
    };
    
    renderRows();
  });
}
if (!window.stateMappersInitDone) {
  window.stateMappersInitDone = true;
  document.addEventListener('DOMContentLoaded', initStateMappers);
  // also run immediately if DOMContentLoaded already fired
  if (document.readyState === 'complete' || document.readyState === 'interactive') {
    initStateMappers();
  }
}
