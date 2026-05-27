const statusEl = document.querySelector('#status');
const resultEl = document.querySelector('#result-output');
const traceEl = document.querySelector('#trace-output');
const resultFileEl = document.querySelector('#result-file');
const recordsListEl = document.querySelector('#records-list');
const betForm = document.querySelector('#bet-form');
const lobbyForm = document.querySelector('#lobby-form');
const maintenanceForm = document.querySelector('#maintenance-form');
const tabs = document.querySelectorAll('.tab');
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

function rememberTabState(tabName, statusText, statusClass) {
  tabState[tabName] = {
    result: resultEl.textContent,
    trace: traceEl.textContent,
    meta: resultFileEl.textContent,
    statusText: statusText || statusEl.textContent,
    statusClass: statusClass || 'idle',
  };
}

function setBusy(isBusy) {
  document.querySelectorAll('button[type="submit"]').forEach((button) => {
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
  const data = {};
  for (const element of form.elements) {
    if (!element.name) continue;
    data[element.name] = element.type === 'checkbox' ? element.checked : element.value;
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
    const element = form.elements[key];
    if (!element) continue;
    if (element.type === 'checkbox') {
      element.checked = Boolean(value);
    } else {
      element.value = value;
    }
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
    } catch {
      // Keep raw format if JSON is invalid
    }
  },
  true,
);

async function loadConfig() {
  const config = await getJson('/api/config');
  fillForm(betForm, config.rgs);
  fillForm(lobbyForm, config.lobby);
  fillForm(maintenanceForm, config.maintenance);
}

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

    document.querySelectorAll('.record-button').forEach((item) => {
      item.classList.toggle('is-active', item === button);
    });

    setStatus('Record Loaded', 'success');
    rememberTabState(activeTab, 'Record Loaded', 'success');
  } catch (error) {
    showJson(resultEl, resultPayload(error.payload, error.message));
    showJson(traceEl, []);
    setStatus('Error', 'error');
    rememberTabState(activeTab, 'Error', 'error');
  }
}

tabs.forEach((tab) => {
  tab.addEventListener('click', () => {
    saveActiveTabState();
    activeTab = tab.dataset.tab;
    tabs.forEach((item) => item.classList.toggle('is-active', item === tab));
    Object.entries(panels).forEach(([key, panel]) => {
      panel.classList.toggle('is-active', key === activeTab);
    });
    restoreTabState(activeTab);
    loadRecords().catch((error) => {
      showJson(traceEl, [{ step: 'records.load.error', error: error.message }]);
    });
  });
});

betForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  setBusy(true);
  setStatus('Running', 'running');
  resultFileEl.textContent = '';
  try {
    const data = await postJson('/api/rgs-bet', formValues(betForm));
    showJson(resultEl, data.result);
    showJson(traceEl, data.logs);
    resultFileEl.textContent = resultMeta(data);

    const isMaintenance = Boolean(data.maintenanceBlock);
    const finalState = isMaintenance ? 'warning' : 'success';
    const finalText = isMaintenance ? `Maintenance: ${data.maintenanceBlock.step}` : 'Done';

    setStatus(finalText, finalState);
    rememberTabState('bet', finalText, finalState);
    await loadRecords();
  } catch (error) {
    showJson(resultEl, resultPayload(error.payload, error.message));
    showJson(traceEl, error.payload?.logs || []);
    resultFileEl.textContent = resultMeta(error.payload || {});

    const isMaintenance = error.message.includes('MAINTENANCE BLOCKED');
    setStatus(isMaintenance ? 'Maintenance Block' : 'Error', isMaintenance ? 'warning' : 'error');
    rememberTabState('bet', statusEl.textContent, statusEl.className.split(' ').pop());
    await loadRecords();
  } finally {
    setBusy(false);
    restoreButtonText();
  }
});

lobbyForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  setBusy(true);
  const stopCountdown = startLobbyRefreshCountdown();
  resultFileEl.textContent = '';
  try {
    const data = await postJson('/api/rgs-lobby', formValues(lobbyForm));
    stopCountdown();
    showJson(resultEl, data.result);
    showJson(traceEl, data.logs);
    resultFileEl.textContent = resultMeta(data);
    setStatus('Done', 'success');
    rememberTabState('lobby', 'Done', 'success');
    await loadRecords();
  } catch (error) {
    stopCountdown();
    showJson(resultEl, resultPayload(error.payload, error.message));
    showJson(traceEl, error.payload?.logs || []);
    resultFileEl.textContent = resultMeta(error.payload || {});
    setStatus('Error', 'error');
    rememberTabState('lobby', 'Error', 'error');
    await loadRecords();
  } finally {
    setBusy(false);
    restoreButtonText();
  }
});

maintenanceForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  setBusy(true);
  setStatus('Running', 'running');
  resultFileEl.textContent = '';
  try {
    const data = await postJson('/api/maintenance', formValues(maintenanceForm));
    showJson(resultEl, data.result);
    showJson(traceEl, data.logs);
    resultFileEl.textContent = resultMeta(data);
    setStatus('Done', 'success');
    rememberTabState('maintenance', 'Done', 'success');
    await loadRecords();
  } catch (error) {
    showJson(resultEl, resultPayload(error.payload, error.message));
    showJson(traceEl, error.payload?.logs || []);
    resultFileEl.textContent = resultMeta(error.payload || {});
    setStatus('Error', 'error');
    rememberTabState('maintenance', 'Error', 'error');
    await loadRecords();
  } finally {
    setBusy(false);
    restoreButtonText();
  }
});

Promise.all([loadConfig(), loadRecords()]).catch((error) => {
  showJson(resultEl, { error: error.message });
  setStatus('Error', 'error');
});
