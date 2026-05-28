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
const btnClearCache = document.querySelector('#btn-clear-cache'); // <-- Add this line

const globalDomainEl = document.querySelector('#global-domain');
const globalSignatureEl = document.querySelector('#global-signature');
const globalGameCodeEl = document.querySelector('#global-gamecode');
const healthStatusEl = document.querySelector('#healthcheck-status');

const envRadios = document.querySelectorAll('input[name="envType"]');

// Map environments to default configuration values
// Map environments to default configuration values
const ENV_CONFIG = {
  LOCAL: { url: 'http://localhost:19080', sig: 'rgs-local-signature', gc: 'LGS-006' },
  CIT: { url: 'https://letsgo-rgs-gs1.iki-cit.cc', sig: 'rgs-local-signature', gc: 'LGS-006' },
  QAT: { url: 'https://letsgo-rgs-gs1.iki-qat.cc', sig: 'rgs-local-signature', gc: 'LGS-006' },
};

const wsTabs = document.querySelectorAll('.ws-tab');
const wsPanels = {
  result: document.querySelector('#ws-result'),
  trace: document.querySelector('#ws-trace'),
};
const panels = {
  bet: document.querySelector('#bet-panel'),
  lobby: document.querySelector('#lobby-panel'),
  maintenance: document.querySelector('#maintenance-panel'),
};

let activeTab = 'bet';
const tabState = {
  bet: { result: '{}', trace: '[]', meta: '', statusText: 'Idle', statusClass: 'idle' },
  maintenance: { result: '{}', trace: '[]', meta: '', statusText: 'Idle', statusClass: 'idle' },
  lobby: { result: '{}', trace: '[]', meta: '', statusText: 'Idle', statusClass: 'idle' },
};

function saveActiveTabState() {
  const currentClass = statusEl.className.replace('status badge ', '');
  tabState[activeTab] = {
    result: resultEl.textContent,
    trace: traceEl.textContent,
    meta: resultFileEl.textContent,
    statusText: statusEl.textContent,
    statusClass: currentClass,
  };
}

function restoreTabState(tabName) {
  const state = tabState[tabName];
  resultEl.textContent = state.result;
  traceEl.textContent = state.trace;
  resultFileEl.textContent = state.meta;
  setStatus(state.statusText, state.statusClass);
}

// Caching System
function saveAllInputs() {
  const cache = {};
  document
    .querySelectorAll('input:not([type="file"]):not([name="envType"]), textarea')
    .forEach((el) => {
      const key = el.id || el.name;
      if (key && !['global-domain', 'global-signature', 'global-gamecode'].includes(key)) {
        if (el.type === 'radio') {
          if (el.checked) cache[el.name] = el.value;
        } else if (el.type === 'checkbox') cache[key] = el.checked;
        else cache[key] = el.value;
      }
    });
  localStorage.setItem('console_input_cache', JSON.stringify(cache));
}

function restoreCachedInputs() {
  const raw = localStorage.getItem('console_input_cache');
  if (!raw) return false;
  const cache = JSON.parse(raw);
  document
    .querySelectorAll('input:not([type="file"]):not([name="envType"]), textarea')
    .forEach((el) => {
      const key = el.id || el.name;
      if (
        cache[key] !== undefined &&
        !['global-domain', 'global-signature', 'global-gamecode'].includes(key)
      ) {
        if (el.type === 'checkbox') el.checked = cache[key];
        else if (el.type === 'radio') {
          if (el.value === cache[el.name]) el.checked = true;
        } else el.value = cache[key];
      }
    });
  return true;
}

// Dedicated Environment Setting Cache
function saveEnvSpecificCache() {
  const currentEnv = document.querySelector('input[name="envType"]:checked').value;
  const cache = JSON.parse(localStorage.getItem('console_env_cache') || '{}');
  cache[currentEnv] = {
    domain: globalDomainEl.value,
    signature: globalSignatureEl.value,
    gameCode: globalGameCodeEl.value,
  };
  localStorage.setItem('console_env_cache', JSON.stringify(cache));
}

function loadEnvSpecificCache(envType) {
  const cache = JSON.parse(localStorage.getItem('console_env_cache') || '{}');
  const envData = cache[envType] || {};
  globalDomainEl.value = envData.domain !== undefined ? envData.domain : ENV_CONFIG[envType].url;
  globalSignatureEl.value =
    envData.signature !== undefined ? envData.signature : ENV_CONFIG[envType].sig;
  globalGameCodeEl.value =
    envData.gameCode !== undefined ? envData.gameCode : ENV_CONFIG[envType].gc;
  triggerHealthCheck();
}

// Bind Events
document.addEventListener('input', (e) => {
  if (['global-domain', 'global-signature', 'global-gamecode'].includes(e.target.id)) {
    clearTimeout(window.saveEnvTimeout);
    window.saveEnvTimeout = setTimeout(saveEnvSpecificCache, 300);
  } else {
    clearTimeout(window.saveTimeout);
    window.saveTimeout = setTimeout(saveAllInputs, 300);
  }
});
document.addEventListener('change', (e) => {
  if (!['global-domain', 'global-signature', 'global-gamecode'].includes(e.target.id))
    saveAllInputs();
});

envRadios.forEach((radio) => {
  radio.addEventListener('change', (e) => {
    loadEnvSpecificCache(e.target.value);
  });
});

// Modal Logic
btnOpenSettings.addEventListener('click', () => modal.classList.add('is-active'));
btnCloseSettings.addEventListener('click', () => modal.classList.remove('is-active'));
modal.addEventListener('click', (e) => {
  if (e.target === modal) modal.classList.remove('is-active');
});

// Clear Cache Logic
btnClearCache.addEventListener('click', () => {
  if (confirm('Are you sure you want to clear all cached inputs? This will reload the page and reset everything to defaults.')) {
    localStorage.clear();
    window.location.reload();
  }
});

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

function showJson(target, data) {
  target.textContent = JSON.stringify(data, null, 2);
}
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

function startLobbyRefreshCountdown() {
  let remaining = 5;
  setStatus(`Waiting: ${remaining}s`, 'running');
  const intervalId = setInterval(() => {
    remaining -= 1;
    if (remaining > 0) {
      setStatus(`Waiting: ${remaining}s`, 'running');
      return;
    }
    clearInterval(intervalId);
    setStatus('Refreshing...', 'running');
  }, 1000);
  return () => clearInterval(intervalId);
}

function formValues(form) {
  // Always start by injecting the Global Environments
  const data = {
    apiDomain: globalDomainEl.value,
    signature: globalSignatureEl.value,
    gameCode: globalGameCodeEl.value,
  };
  for (const element of form.elements) {
    if (!element.name) continue;
    const val = element.type === 'checkbox' ? element.checked : element.value;
    if (['apiDomain', 'signature', 'gameCode'].includes(element.name) && val === '') continue; // fall back to global
    data[element.name] = val;
  }
  return data;
}

async function postJson(url, body) {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
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

document.addEventListener(
  'blur',
  (event) => {
    if (event.target.tagName !== 'TEXTAREA') return;
    const raw = event.target.value.trim();
    if (!raw) return;
    try {
      event.target.value = JSON.stringify(JSON.parse(raw), null, 2);
      saveAllInputs();
    } catch {}
  },
  true,
);

async function loadConfig() {
  const config = await getJson('/api/config');
  fillForm(betForm, config.rgs);
  fillForm(lobbyForm, config.lobby);
  fillForm(maintenanceForm, config.maintenance);

  restoreCachedInputs();
  const currentEnv = document.querySelector('input[name="envType"]:checked').value;
  loadEnvSpecificCache(currentEnv);
}

// Orchestrator Actions
window.runProcess = async function (type) {
  const restartPolicy = document.querySelector('input[name="restartPolicy"]:checked').value;
  const paths = {
    money: document.querySelector('#path-money').value,
    queue: document.querySelector('#path-queue').value,
    apihub: document.querySelector('#path-apihub').value,
    slot: document.querySelector('#path-slot').value,
    remote: document.querySelector('#path-remote').value,
  };

  // Find the specific button that was clicked to show a loading state
  const btn = Array.from(document.querySelectorAll('.btn-run')).find((b) =>
    b.getAttribute('onclick')?.includes(`'${type}'`),
  );
  const originalText = btn ? btn.textContent : 'Start';
  if (btn) {
    btn.textContent = '⏳...';
    btn.disabled = true;
  }

  try {
    await postJson('/api/run-server', { type, paths, restartPolicy });
  } catch (e) {
    console.error(`Failed to trigger ${type}`, e);
    alert(`Failed to trigger ${type}. Check terminal logs.`);
  } finally {
    if (btn) {
      btn.textContent = originalText;
      btn.disabled = false;
    }
  }
};

window.deployAll = async function () {
  const btn = document.querySelector('.btn-large[onclick="deployAll()"]');
  btn.textContent = '⏳ Deploying All...';
  btn.disabled = true;
  const services = ['money', 'queue', 'apihub', 'remote', 'slot'];
  for (const s of services) {
    await window.runProcess(s);
    await new Promise((r) => setTimeout(r, 1000));
  }
  btn.textContent = '🚀 MASTER ALL-IN-ONE DEPLOY';
  btn.disabled = false;
};

// Healthcheck
async function triggerHealthCheck() {
  const url = globalDomainEl.value;
  healthStatusEl.className = 'health-status checking';
  healthStatusEl.innerHTML = 'Checking...';

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

let pingTimeout;
globalDomainEl.addEventListener('input', () => {
  clearTimeout(pingTimeout);
  pingTimeout = setTimeout(triggerHealthCheck, 500);
});

// Records rendering
function renderRecords(records) {
  recordsListEl.textContent = '';
  if (!records.length) {
    recordsListEl.innerHTML = '<div class="text-xs">No records yet</div>';
    return;
  }
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
    const data = await getJson(
      `/api/record?flow=${encodeURIComponent(activeTab)}&file=${encodeURIComponent(file)}`,
    );
    showJson(resultEl, data.result);
    showJson(traceEl, data.logs || []);
    resultFileEl.textContent = resultMeta(data);
    document
      .querySelectorAll('.record-button')
      .forEach((item) => item.classList.toggle('is-active', item === button));
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
    Object.entries(panels).forEach(([key, panel]) =>
      panel.classList.toggle('is-active', key === activeTab),
    );
    restoreTabState(activeTab);
    loadRecords();
  });
});

async function executeFlow(form, apiPath, flowName) {
  setBusy(true);
  setStatus('Running', 'running');
  resultFileEl.textContent = '';
  try {
    const data = await postJson(apiPath, formValues(form));
    showJson(resultEl, data.result);
    showJson(traceEl, data.logs);
    resultFileEl.textContent = resultMeta(data);
    const finalState = data.maintenanceBlock ? 'warning' : 'success';
    setStatus(
      data.maintenanceBlock ? `Maintenance: ${data.maintenanceBlock.step}` : 'Done',
      finalState,
    );
    await loadRecords();
  } catch (error) {
    showJson(resultEl, resultPayload(error.payload, error.message));
    showJson(traceEl, error.payload?.logs || []);
    resultFileEl.textContent = resultMeta(error.payload || {});
    setStatus(
      error.message.includes('MAINTENANCE BLOCKED') ? 'Maintenance Block' : 'Error',
      error.message.includes('MAINTENANCE BLOCKED') ? 'warning' : 'error',
    );
    await loadRecords();
  } finally {
    setBusy(false);
    restoreButtonText();
    forceResultTab();
  }
}

betForm.addEventListener('submit', (e) => {
  e.preventDefault();
  executeFlow(betForm, '/api/rgs-bet', 'bet');
});
lobbyForm.addEventListener('submit', (e) => {
  e.preventDefault();
  executeFlow(lobbyForm, '/api/rgs-lobby', 'lobby');
});
maintenanceForm.addEventListener('submit', (e) => {
  e.preventDefault();
  executeFlow(maintenanceForm, '/api/maintenance', 'maintenance');
});

Promise.all([loadConfig(), loadRecords()]).catch(() => setStatus('Error', 'error'));

// Smart Ctrl+A Trapping for Code Blocks
document.querySelectorAll('pre[tabindex="0"]').forEach((pre) => {
  pre.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'a') {
      e.preventDefault(); // Stop whole page selection
      const selection = window.getSelection();
      const range = document.createRange();
      range.selectNodeContents(pre);
      selection.removeAllRanges();
      selection.addRange(range);
    }
  });
});