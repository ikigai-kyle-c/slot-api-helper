const statusEl = document.querySelector('#status');
const resultEl = document.querySelector('#result-output');
const traceEl = document.querySelector('#trace-output');
const resultFileEl = document.querySelector('#result-file');
const recordsListEl = document.querySelector('#records-list');
const betForm = document.querySelector('#bet-form');
const lobbyForm = document.querySelector('#lobby-form');
const maintenanceForm = document.querySelector('#maintenance-form');
const tabs = document.querySelectorAll('.tab');

const modal = document.querySelector('#settings-modal');
const btnOpenSettings = document.querySelector('#btn-open-settings');
const btnCloseSettings = document.querySelector('#btn-close-settings');

const globalDomainEl = document.querySelector('#global-domain');
const globalSignatureEl = document.querySelector('#global-signature');
const globalGameCodeEl = document.querySelector('#global-gamecode');
const healthStatusEl = document.querySelector('#healthcheck-status');

const envRadios = document.querySelectorAll('input[name="envType"]');

// Map environments to default URLs
const ENV_URLS = {
  LOCAL: 'http://localhost:19080',
  CIT: 'https://letsgo-game-gs1.iki-cit.cc',
  QAT: 'https://letsgo-game-gs1.iki-qat.cc'
};

const wsTabs = document.querySelectorAll('.ws-tab');
const wsPanels = { result: document.querySelector('#ws-result'), trace: document.querySelector('#ws-trace') };
const panels = { bet: document.querySelector('#bet-panel'), lobby: document.querySelector('#lobby-panel'), maintenance: document.querySelector('#maintenance-panel') };

let activeTab = 'bet';

// Caching & Restoration
function saveAllInputs() {
  const cache = {};
  document.querySelectorAll('input:not([type="file"]), textarea').forEach((el) => {
    const key = el.id || el.name;
    if (key) {
      if (el.type === 'radio') { if (el.checked) cache[el.name] = el.value; } 
      else if (el.type === 'checkbox') cache[key] = el.checked;
      else cache[key] = el.value;
    }
  });
  localStorage.setItem('console_input_cache', JSON.stringify(cache));
}

function restoreCachedInputs() {
  const raw = localStorage.getItem('console_input_cache');
  if (!raw) return false;
  const cache = JSON.parse(raw);
  document.querySelectorAll('input:not([type="file"]), textarea').forEach((el) => {
    const key = el.id || el.name;
    if (cache[key] !== undefined) {
      if (el.type === 'checkbox') el.checked = cache[key];
      else if (el.type === 'radio') { if (el.value === cache[el.name]) el.checked = true; } 
      else el.value = cache[key];
    }
  });
  return true;
}

// Ensure cache is updated on input OR blur (fixing the JSON formatter issue)
document.addEventListener('input', () => {
  clearTimeout(window.saveTimeout);
  window.saveTimeout = setTimeout(saveAllInputs, 300);
});
document.addEventListener('change', saveAllInputs);

// Modal Logic
btnOpenSettings.addEventListener('click', () => modal.classList.add('is-active'));
btnCloseSettings.addEventListener('click', () => modal.classList.remove('is-active'));
modal.addEventListener('click', (e) => { if (e.target === modal) modal.classList.remove('is-active'); });

// Workspace Tab Logic
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
function resultMeta(data) {
  const timeRange = [data.requestedAt, data.respondedAt].filter(Boolean).join(' -> ');
  return [timeRange, data.resultFile].filter(Boolean).join('  |  ');
}
function resultPayload(payload, fallbackMessage) {
  if (!payload) return { error: fallbackMessage };
  const { logs, ...rest } = payload;
  return rest;
}

function setBusy(isBusy) {
  document.querySelectorAll('.flow-form button[type="submit"]').forEach((button) => {
    button.disabled = isBusy;
    if (isBusy) button.textContent = '⏳ Processing...';
  });
}
function restoreButtonText() {
  betForm.querySelector('button[type="submit"]').textContent = '🚀 Execute Bet Flow';
  lobbyForm.querySelector('button[type="submit"]').textContent = '🚀 Execute Lobby Flow';
  maintenanceForm.querySelector('button[type="submit"]').textContent = '🛡️ Run Maintenance Command';
}

function formValues(form) {
  const data = { apiDomain: globalDomainEl.value, signature: globalSignatureEl.value, gameCode: globalGameCodeEl.value };
  for (const element of form.elements) {
    if (!element.name) continue;
    const val = element.type === 'checkbox' ? element.checked : element.value;
    if (['apiDomain', 'signature', 'gameCode'].includes(element.name) && val === '') continue;
    data[element.name] = val;
  }
  return data;
}

async function postJson(url, body) {
  const response = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const data = await response.json();
  if (!response.ok || data.error) {
    const error = new Error(data.error || `HTTP ${response.status}`);
    error.payload = data;
    throw error;
  }
  return data;
}

async function getJson(url) {
  const response = await fetch(url);
  const data = await response.json();
  if (!response.ok || data.error) {
    const error = new Error(data.error || `HTTP ${response.status}`);
    error.payload = data;
    throw error;
  }
  return data;
}

function fillForm(form, values) {
  for (const [key, value] of Object.entries(values)) {
    if (['apiDomain', 'signature', 'gameCode'].includes(key)) continue;
    const element = form.elements[key];
    if (!element) continue;
    if (element.type === 'checkbox') element.checked = Boolean(value);
    else element.value = value;
  }
}

document.addEventListener('blur', (event) => {
  if (event.target.tagName !== 'TEXTAREA') return;
  const raw = event.target.value.trim();
  if (!raw) return;
  try {
    event.target.value = JSON.stringify(JSON.parse(raw), null, 2);
    saveAllInputs(); // CRITICAL: Save explicitly after formatting
  } catch {}
}, true);

async function loadConfig() {
  const config = await getJson('/api/config');
  if (config.global) {
    globalDomainEl.value = config.global.apiDomain || '';
    globalSignatureEl.value = config.global.signature || '';
    globalGameCodeEl.value = config.global.gameCode || '';
  }
  fillForm(betForm, config.rgs);
  fillForm(lobbyForm, config.lobby);
  fillForm(maintenanceForm, config.maintenance);

  restoreCachedInputs();
  triggerHealthCheck(); // Check initial env
}

// Orchestrator Actions
window.runProcess = async function (type) {
  const pathMoney = document.querySelector('#path-money').value;
  const pathQueue = document.querySelector('#path-queue').value;
  const pathApihub = document.querySelector('#path-apihub').value;
  const pathSlot = document.querySelector('#path-slot').value;
  const pathRemote = document.querySelector('#path-remote').value;
  const restartPolicy = document.querySelector('input[name="restartPolicy"]:checked').value;

  try {
    await postJson('/api/run-server', { type, paths: { money: pathMoney, queue: pathQueue, apihub: pathApihub, slot: pathSlot, remote: pathRemote }, restartPolicy });
  } catch (e) {
    console.error(`Failed to trigger ${type}`, e);
  }
};

window.deployAll = async function() {
  const btn = document.querySelector('.btn-large[onclick="deployAll()"]');
  btn.textContent = "⏳ Deploying All...";
  btn.disabled = true;
  const services = ['money', 'queue', 'apihub', 'remote', 'slot'];
  for (const s of services) {
    await window.runProcess(s);
    await new Promise(r => setTimeout(r, 1000)); // stagger starts
  }
  btn.textContent = "🚀 MASTER ALL-IN-ONE DEPLOY";
  btn.disabled = false;
};

// Healthcheck & Environment Selector
async function triggerHealthCheck() {
  const url = globalDomainEl.value;
  healthStatusEl.className = 'health-status checking';
  healthStatusEl.innerHTML = 'Checking...';
  
  // Hide settings if not Localhost
  const isLocal = document.querySelector('input[name="envType"]:checked').value === 'LOCAL';
  btnOpenSettings.style.display = isLocal ? 'block' : 'none';

  try {
    const res = await postJson('/api/ping', { url });
    if (res.ok) {
      healthStatusEl.className = 'health-status reachable';
      healthStatusEl.innerHTML = '✓ Reachable';
    } else {
      healthStatusEl.className = 'health-status unreachable';
      healthStatusEl.innerHTML = '✗ Unreachable';
    }
  } catch (e) {
    healthStatusEl.className = 'health-status unreachable';
    healthStatusEl.innerHTML = '✗ Unreachable';
  }
}

envRadios.forEach(radio => {
  radio.addEventListener('change', (e) => {
    globalDomainEl.value = ENV_URLS[e.target.value] || ENV_URLS.LOCAL;
    saveAllInputs();
    triggerHealthCheck();
  });
});

let pingTimeout;
globalDomainEl.addEventListener('input', () => {
  clearTimeout(pingTimeout);
  pingTimeout = setTimeout(triggerHealthCheck, 500);
});

// Records rendering
function renderRecords(records) {
  recordsListEl.textContent = '';
  if (!records.length) { recordsListEl.innerHTML = '<div class="text-xs">No records yet</div>'; return; }
  records.forEach((record) => {
    const button = document.createElement('button');
    button.className = 'record-button';
    button.type = 'button';
    button.dataset.file = record.file;
    const name = document.createElement('span');
    name.className = 'record-name';
    name.textContent = record.file;
    const time = document.createElement('span');
    time.className = 'record-time';
    time.textContent = `${record.updatedAt}${record.hasTrace ? ' | Trace available' : ''}`;
    button.append(name, time);
    button.addEventListener('click', () => loadRecord(record.file, button));
    recordsListEl.append(button);
  });
}

async function loadRecords() {
  const data = await getJson(`/api/records?flow=${encodeURIComponent(activeTab)}`);
  renderRecords(data.records || []);
}

async function loadRecord(file, button) {
  setStatus('Loading record', 'running');
  try {
    const data = await getJson(`/api/record?flow=${encodeURIComponent(activeTab)}&file=${encodeURIComponent(file)}`);
    showJson(resultEl, data.result);
    showJson(traceEl, data.logs || []);
    resultFileEl.textContent = resultMeta(data);
    document.querySelectorAll('.record-button').forEach((item) => item.classList.toggle('is-active', item === button));
    setStatus('Record Loaded', 'success');
    forceResultTab();
  } catch (error) {
    showJson(resultEl, resultPayload(error.payload, error.message));
    showJson(traceEl, []);
    setStatus('Error', 'error');
    forceResultTab();
  }
}

tabs.forEach((tab) => {
  tab.addEventListener('click', () => {
    saveActiveTabState();
    activeTab = tab.dataset.tab;
    tabs.forEach((item) => item.classList.toggle('is-active', item === tab));
    Object.entries(panels).forEach(([key, panel]) => panel.classList.toggle('is-active', key === activeTab));
    restoreTabState(activeTab);
    loadRecords();
  });
});

async function executeFlow(form, apiPath, flowName) {
  setBusy(true); setStatus('Running', 'running'); resultFileEl.textContent = '';
  try {
    const data = await postJson(apiPath, formValues(form));
    showJson(resultEl, data.result); showJson(traceEl, data.logs);
    resultFileEl.textContent = resultMeta(data);
    const finalState = data.maintenanceBlock ? 'warning' : 'success';
    setStatus(data.maintenanceBlock ? `Maintenance: ${data.maintenanceBlock.step}` : 'Done', finalState);
    await loadRecords();
  } catch (error) {
    showJson(resultEl, resultPayload(error.payload, error.message));
    showJson(traceEl, error.payload?.logs || []);
    resultFileEl.textContent = resultMeta(error.payload || {});
    setStatus(error.message.includes('MAINTENANCE BLOCKED') ? 'Maintenance Block' : 'Error', error.message.includes('MAINTENANCE BLOCKED') ? 'warning' : 'error');
    await loadRecords();
  } finally { setBusy(false); restoreButtonText(); forceResultTab(); }
}

betForm.addEventListener('submit', (e) => { e.preventDefault(); executeFlow(betForm, '/api/rgs-bet', 'bet'); });
lobbyForm.addEventListener('submit', (e) => { e.preventDefault(); executeFlow(lobbyForm, '/api/rgs-lobby', 'lobby'); });
maintenanceForm.addEventListener('submit', (e) => { e.preventDefault(); executeFlow(maintenanceForm, '/api/maintenance', 'maintenance'); });

Promise.all([loadConfig(), loadRecords()]).catch(() => setStatus('Error', 'error'));