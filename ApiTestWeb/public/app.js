const statusEl = document.querySelector("#status");
const resultEl = document.querySelector("#result-output");
const traceEl = document.querySelector("#trace-output");
const resultFileEl = document.querySelector("#result-file");
const recordsListEl = document.querySelector("#records-list");
const betForm = document.querySelector("#bet-form");
const lobbyForm = document.querySelector("#lobby-form");
const maintenanceForm = document.querySelector("#maintenance-form");
const tabs = document.querySelectorAll(".tab");
const panels = {
  bet: document.querySelector("#bet-panel"),
  lobby: document.querySelector("#lobby-panel"),
  maintenance: document.querySelector("#maintenance-panel"),
};
let activeTab = "bet";
const tabState = {
  bet: {
    result: "{}",
    trace: "[]",
    meta: "",
    status: "Idle",
    isError: false,
  },
  maintenance: {
    result: "{}",
    trace: "[]",
    meta: "",
    status: "Idle",
    isError: false,
  },
  lobby: {
    result: "{}",
    trace: "[]",
    meta: "",
    status: "Idle",
    isError: false,
  },
};

function setStatus(text, isError = false) {
  statusEl.textContent = text;
  statusEl.classList.toggle("is-error", isError);
}

function showJson(target, data) {
  target.textContent = JSON.stringify(data, null, 2);
}

function resultMeta(data) {
  const timeRange = [data.requestedAt, data.respondedAt].filter(Boolean).join(" -> ");
  return [timeRange, data.resultFile].filter(Boolean).join("  |  ");
}

function resultPayload(payload, fallbackMessage) {
  if (!payload) return { error: fallbackMessage };
  const { logs, ...rest } = payload;
  return rest;
}

function saveActiveTabState() {
  tabState[activeTab] = {
    result: resultEl.textContent,
    trace: traceEl.textContent,
    meta: resultFileEl.textContent,
    status: statusEl.textContent,
    isError: statusEl.classList.contains("is-error"),
  };
}

function restoreTabState(tabName) {
  const state = tabState[tabName];
  resultEl.textContent = state.result;
  traceEl.textContent = state.trace;
  resultFileEl.textContent = state.meta;
  setStatus(state.status, state.isError);
}

function rememberTabState(tabName, data) {
  tabState[tabName] = {
    result: resultEl.textContent,
    trace: traceEl.textContent,
    meta: resultFileEl.textContent,
    status: data.status || statusEl.textContent,
    isError: Boolean(data.isError),
  };
}

function setBusy(isBusy) {
  document.querySelectorAll("button").forEach((button) => {
    button.disabled = isBusy;
  });
}

function startLobbyRefreshCountdown() {
  let remaining = 5;
  setStatus(`Waiting before refresh: ${remaining}s`);

  const intervalId = setInterval(() => {
    remaining -= 1;
    if (remaining > 0) {
      setStatus(`Waiting before refresh: ${remaining}s`);
      return;
    }

    clearInterval(intervalId);
    setStatus("Refreshing...");
  }, 1000);

  return () => {
    clearInterval(intervalId);
  };
}

function formValues(form) {
  const data = {};
  for (const element of form.elements) {
    if (!element.name) continue;
    data[element.name] = element.type === "checkbox" ? element.checked : element.value;
  }
  return data;
}

async function postJson(url, body) {
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
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
    if (element.type === "checkbox") {
      element.checked = Boolean(value);
    } else {
      element.value = value;
    }
  }
}

document.addEventListener("blur", (event) => {
  if (event.target.tagName !== "TEXTAREA") return;
  const raw = event.target.value.trim();
  if (!raw) return;

  try {
    event.target.value = JSON.stringify(JSON.parse(raw), null, 2);
  } catch {
    // Keep the user's text intact so the server can show the JSON error.
  }
}, true);

async function loadConfig() {
  const config = await getJson("/api/config");
  fillForm(betForm, config.rgs);
  fillForm(lobbyForm, config.lobby);
  fillForm(maintenanceForm, config.maintenance);
}

function renderRecords(records) {
  recordsListEl.textContent = "";
  if (!records.length) {
    const empty = document.createElement("div");
    empty.className = "record-time";
    empty.textContent = "No records yet";
    recordsListEl.append(empty);
    return;
  }

  records.forEach((record) => {
    const button = document.createElement("button");
    button.className = "record-button";
    button.type = "button";
    button.dataset.file = record.file;

    const name = document.createElement("span");
    name.className = "record-name";
    name.textContent = record.file;

    const time = document.createElement("span");
    time.className = "record-time";
    time.textContent = `${record.updatedAt}${record.hasTrace ? " | trace" : ""}`;

    button.append(name, time);
    button.addEventListener("click", () => loadRecord(record.file, button));
    recordsListEl.append(button);
  });
}

async function loadRecords() {
  const data = await getJson(`/api/records?flow=${encodeURIComponent(activeTab)}`);
  renderRecords(data.records || []);
}

async function loadRecord(file, button) {
  setStatus("Loading record");
  try {
    const data = await getJson(`/api/record?flow=${encodeURIComponent(activeTab)}&file=${encodeURIComponent(file)}`);
    showJson(resultEl, data.result);
    showJson(traceEl, data.logs || []);
    resultFileEl.textContent = resultMeta(data);
    document.querySelectorAll(".record-button").forEach((item) => {
      item.classList.toggle("is-active", item === button);
    });
    setStatus("Record Loaded");
    rememberTabState(activeTab, {
      status: "Record Loaded",
      isError: false,
    });
  } catch (error) {
    showJson(resultEl, resultPayload(error.payload, error.message));
    showJson(traceEl, []);
    setStatus("Error", true);
    rememberTabState(activeTab, {
      status: "Error",
      isError: true,
    });
  }
}

tabs.forEach((tab) => {
  tab.addEventListener("click", () => {
    const active = tab.dataset.tab;
    saveActiveTabState();
    activeTab = active;
    tabs.forEach((item) => item.classList.toggle("is-active", item === tab));
    Object.entries(panels).forEach(([key, panel]) => {
      panel.classList.toggle("is-active", key === active);
    });
    restoreTabState(activeTab);
    loadRecords().catch((error) => {
      showJson(traceEl, [{ step: "records.load.error", error: error.message }]);
    });
  });
});

betForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  setBusy(true);
  setStatus("Running");
  resultFileEl.textContent = "";
  try {
    const data = await postJson("/api/rgs-bet", formValues(betForm));
    showJson(resultEl, data.result);
    showJson(traceEl, data.logs);
    resultFileEl.textContent = resultMeta(data);
    setStatus(data.maintenanceBlock ? `Maintenance Block: ${data.maintenanceBlock.step}` : "Done", Boolean(data.maintenanceBlock));
    rememberTabState("bet", {
      status: statusEl.textContent,
      isError: Boolean(data.maintenanceBlock),
    });
    await loadRecords();
  } catch (error) {
    showJson(resultEl, resultPayload(error.payload, error.message));
    showJson(traceEl, error.payload?.logs || []);
    resultFileEl.textContent = resultMeta(error.payload || {});
    setStatus(error.message.includes("MAINTENANCE BLOCKED") ? "Maintenance Block" : "Error", true);
    rememberTabState("bet", {
      status: statusEl.textContent,
      isError: true,
    });
    await loadRecords();
  } finally {
    setBusy(false);
  }
});

lobbyForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  setBusy(true);
  const stopCountdown = startLobbyRefreshCountdown();
  resultFileEl.textContent = "";
  try {
    const data = await postJson("/api/rgs-lobby", formValues(lobbyForm));
    stopCountdown();
    showJson(resultEl, data.result);
    showJson(traceEl, data.logs);
    resultFileEl.textContent = resultMeta(data);
    setStatus("Done");
    rememberTabState("lobby", {
      status: "Done",
      isError: false,
    });
    await loadRecords();
  } catch (error) {
    stopCountdown();
    showJson(resultEl, resultPayload(error.payload, error.message));
    showJson(traceEl, error.payload?.logs || []);
    resultFileEl.textContent = resultMeta(error.payload || {});
    setStatus("Error", true);
    rememberTabState("lobby", {
      status: "Error",
      isError: true,
    });
    await loadRecords();
  } finally {
    setBusy(false);
  }
});

maintenanceForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  setBusy(true);
  setStatus("Running");
  resultFileEl.textContent = "";
  try {
    const data = await postJson("/api/maintenance", formValues(maintenanceForm));
    showJson(resultEl, data.result);
    showJson(traceEl, data.logs);
    resultFileEl.textContent = resultMeta(data);
    setStatus("Done");
    rememberTabState("maintenance", {
      status: "Done",
      isError: false,
    });
    await loadRecords();
  } catch (error) {
    showJson(resultEl, resultPayload(error.payload, error.message));
    showJson(traceEl, error.payload?.logs || []);
    resultFileEl.textContent = resultMeta(error.payload || {});
    setStatus("Error", true);
    rememberTabState("maintenance", {
      status: "Error",
      isError: true,
    });
    await loadRecords();
  } finally {
    setBusy(false);
  }
});

Promise.all([loadConfig(), loadRecords()]).catch((error) => {
  showJson(resultEl, { error: error.message });
  setStatus("Error", true);
});
