#!/usr/bin/env node
const http = require('http');
const fs = require('fs');
const path = require('path');
const { URL } = require('url');

const ROOT = path.resolve(__dirname, '..');
const REPO_ROOT = path.resolve(ROOT, '..');
const PUBLIC_DIR = path.join(__dirname, 'public');
const RGS_DIR = path.join(ROOT, 'RGSBetFlow');
const LOBBY_DIR = path.join(ROOT, 'RGSLobby');
const MAINTENANCE_DIR = path.join(ROOT, 'InternalMaintenanceApi');

const RESULT_DIR = path.join(REPO_ROOT, 'result', 'bet');
const TRACE_DIR = path.join(RESULT_DIR, '.traces');
const LOBBY_RESULT_DIR = path.join(REPO_ROOT, 'result', 'lobby');
const LOBBY_TRACE_DIR = path.join(LOBBY_RESULT_DIR, '.traces');
const MAINTENANCE_RESULT_DIR = path.join(REPO_ROOT, 'result', 'maintenance');
const MAINTENANCE_TRACE_DIR = path.join(MAINTENANCE_RESULT_DIR, '.traces');
const MAX_RESULT_FILES = 10;

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
};

function readEnv(filePath) {
  if (!fs.existsSync(filePath)) return {};
  const env = {};
  for (const line of fs.readFileSync(filePath, 'utf8').split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const index = trimmed.indexOf('=');
    if (index === -1) continue;
    env[trimmed.slice(0, index)] = trimmed.slice(index + 1);
  }
  return env;
}

function normalizeBaseUrl(value) {
  let baseUrl = value || 'localhost:19080';
  if (!/^https?:\/\//.test(baseUrl)) baseUrl = `http://${baseUrl}`;
  return baseUrl.replace(/\/$/, '');
}

function jsonResponse(res, status, data) {
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  });
  res.end(JSON.stringify(data, null, 2));
}

function parseJsonBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', (chunk) => {
      body += chunk;
      if (body.length > 2_000_000) {
        reject(new Error('Request body is too large.'));
        req.destroy();
      }
    });
    req.on('end', () => {
      if (!body) return resolve({});
      try {
        resolve(JSON.parse(body));
      } catch {
        reject(new Error('Request body must be valid JSON.'));
      }
    });
    req.on('error', reject);
  });
}

async function requestJson({ method, url, headers = {}, body }) {
  const response = await fetch(url, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  const getParsedBody = () => {
    if (!text) return null;
    try {
      return JSON.parse(text);
    } catch {
      return text;
    }
  };
  return { status: response.status, ok: response.ok, body: getParsedBody() };
}

function httpError(message, details, logs = null) {
  const error = new Error(message);
  error.details = details;
  error.logs = logs;
  return error;
}

function detectMaintenanceBlock(step, status, body) {
  const message = typeof body === 'object' && body ? body.error?.message || body.message || '' : '';
  const code = typeof body === 'object' && body ? (body.error?.code ?? body.code ?? '') : '';
  const text = typeof body === 'string' ? body : JSON.stringify(body ?? {});
  if (!/maintenance|maintain/i.test(`${text} ${message} ${code}`)) return null;
  return {
    step,
    status,
    message: message || 'maintenance block detected',
    code: code === undefined || code === null ? '' : String(code),
  };
}

function readJsonFile(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return null;
  }
}

function parseOptionalJson(value, fieldName) {
  if (value === undefined || value === null || String(value).trim() === '') return null;
  try {
    return JSON.parse(String(value));
  } catch {
    throw new Error(`${fieldName} must be valid JSON.`);
  }
}

function objectOrNull(value, fieldName) {
  if (value === null) return null;
  if (typeof value !== 'object' || Array.isArray(value))
    throw new Error(`${fieldName} must be a JSON object.`);
  return value;
}

function optionalObjectJson(config, key, label) {
  return objectOrNull(parseOptionalJson(config[key], label), label);
}

function prettyJson(value) {
  return JSON.stringify(value, null, 2);
}

function resolveTemplates(value, vars) {
  if (Array.isArray(value)) return value.map((item) => resolveTemplates(item, vars));
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, resolveTemplates(item, vars)]),
    );
  }
  if (typeof value !== 'string') return value;
  const exact = value.match(/^\$([A-Z0-9_]+)$/);
  if (exact && Object.prototype.hasOwnProperty.call(vars, exact[1])) return vars[exact[1]];
  return value.replace(/\$([A-Z0-9_]+)/g, (match, key) =>
    Object.prototype.hasOwnProperty.call(vars, key) ? String(vars[key]) : match,
  );
}

function writeJsonFile(filePath, data) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(data, null, 2)}\n`);
}

const RECORD_CONFIGS = {
  bet: { resultDir: RESULT_DIR, traceDir: TRACE_DIR, pattern: /-bet-.*\.json$/, suffix: 'bet' },
  lobby: {
    resultDir: LOBBY_RESULT_DIR,
    traceDir: LOBBY_TRACE_DIR,
    pattern: /-lobby-.*\.json$/,
    suffix: 'lobby',
  },
  maintenance: {
    resultDir: MAINTENANCE_RESULT_DIR,
    traceDir: MAINTENANCE_TRACE_DIR,
    pattern: /-maintenance-.*\.json$/,
    suffix: 'maintenance',
  },
};

function recordConfig(flow) {
  return RECORD_CONFIGS[flow] || RECORD_CONFIGS.bet;
}

function cleanupOldResults(flow = 'bet') {
  const config = recordConfig(flow);
  if (!fs.existsSync(config.resultDir)) return;
  const files = fs
    .readdirSync(config.resultDir)
    .filter((name) => config.pattern.test(name))
    .sort()
    .reverse();
  for (const name of files.slice(MAX_RESULT_FILES)) {
    fs.rmSync(path.join(config.resultDir, name), { force: true });
    fs.rmSync(path.join(config.traceDir, `${name}.trace.json`), { force: true });
  }
}

function listRecords(flow = 'bet') {
  const config = recordConfig(flow);
  if (!fs.existsSync(config.resultDir)) return [];
  return fs
    .readdirSync(config.resultDir)
    .filter((name) => config.pattern.test(name))
    .sort()
    .reverse()
    .slice(0, MAX_RESULT_FILES)
    .map((name) => {
      const filePath = path.join(config.resultDir, name);
      return {
        file: name,
        resultFile: path.relative(REPO_ROOT, filePath),
        updatedAt: displayTimeFromDate(fs.statSync(filePath).mtime),
        hasTrace: fs.existsSync(path.join(config.traceDir, `${name}.trace.json`)),
      };
    });
}

function timestamp() {
  const date = new Date(),
    pad = (value) => String(value).padStart(2, '0');
  return [
    date.getFullYear(),
    pad(date.getMonth() + 1),
    pad(date.getDate()),
    pad(date.getHours()),
    pad(date.getMinutes()),
    pad(date.getSeconds()),
  ].join('');
}

function displayTime() {
  return displayTimeFromDate(new Date());
}
function displayTimeFromDate(date) {
  const pad = (value) => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}
function nowMs() {
  return Date.now();
}
function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function extractLaunchToken(launchUrl) {
  if (!launchUrl) return '';
  try {
    return new URL(launchUrl).searchParams.get('token') || '';
  } catch {
    const match = launchUrl.match(/[?&]token=([^&]+)/);
    return match ? decodeURIComponent(match[1]) : '';
  }
}
function extractSessionToken(body) {
  return (
    body?.token ||
    body?.sessionToken ||
    body?.data?.token ||
    extractLaunchToken(body?.data?.launchUrl)
  );
}
function extractSessionId(body) {
  return body?.session || body?.sessionId || body?.data?.session || body?.data?.sessionId || '';
}
function extractAccessToken(body) {
  return body?.token || body?.accessToken || body?.data?.token || body?.data?.accessToken || '';
}

function saveFlowResult(flow, suffixValue, result, logs = []) {
  const config = recordConfig(flow);
  const filename = `${timestamp()}-${config.suffix}-${suffixValue || 'result'}.json`;
  writeJsonFile(path.join(config.resultDir, filename), result);
  writeJsonFile(path.join(config.traceDir, `${filename}.trace.json`), logs);
  cleanupOldResults(flow);
  return path.relative(REPO_ROOT, path.join(config.resultDir, filename));
}

// -------------------------------------------------------------
// FLOW RUNNERS (Stateless)
// -------------------------------------------------------------

async function runBetFlow(input) {
  const requestedAt = displayTime();
  const config = {
    apiDomain: input.apiDomain || 'localhost:19080',
    signature: input.signature || 'rgs-local-signature',
    gameCode: input.gameCode || 'LGS-006',
    sessionStartHeadersJson: input.sessionStartHeadersJson || '',
    sessionStartBodyJson: input.sessionStartBodyJson || '',
    sessionActivateHeadersJson: input.sessionActivateHeadersJson || '',
    sessionActivateBodyJson: input.sessionActivateBodyJson || '',
    betHeadersJson: input.betHeadersJson || '',
    betBodyJson: input.betBodyJson || '',
    actionHeadersJson: input.actionHeadersJson || '',
    actionBodyJson: input.actionBodyJson || '',
    finishHeadersJson: input.finishHeadersJson || '',
    finishBodyJson: input.finishBodyJson || '',
  };
  const baseUrl = normalizeBaseUrl(config.apiDomain);
  const logs = [];
  const result = {};

  // State provided by UI IDE Context
  const state = typeof input.state === 'object' && input.state ? input.state : {};
  const steps = Array.isArray(input.steps)
    ? input.steps
    : ['start', 'activate', 'bet', 'action', 'finish'];

  const vars = () => ({
    ...state,
    GAME_CODE: config.gameCode,
    RTP_CONFIG_CODE: config.gameCode === 'LGS-001' ? 'highRTP' : 'RTP_97',
    SIGNATURE: config.signature,
    NOW_MS: nowMs(),
  });

  if (steps.includes('start')) {
    const headers = {
      'x-signature': config.signature,
      'content-type': 'application/json',
      ...resolveTemplates(
        optionalObjectJson(config, 'sessionStartHeadersJson', 'Start Headers') || {},
        vars(),
      ),
    };
    const payload = resolveTemplates(
      optionalObjectJson(config, 'sessionStartBodyJson', 'Start Body') || {},
      vars(),
    );
    logs.push({ step: 'session.start.request', headers, payload });
    const res = await requestJson({
      method: 'POST',
      url: `${baseUrl}/v2/service/session/start`,
      headers,
      body: payload,
    });
    logs.push({ step: 'session.start.response', status: res.status, body: res.body });
    const block = detectMaintenanceBlock('session.start', res.status, res.body);
    if (block) throw httpError(`MAINTENANCE BLOCKED`, block, logs);
    if (res.status !== 200)
      throw httpError(`Start failed`, { status: res.status, response: res.body }, logs);

    state.SESSION_TOKEN = extractSessionToken(res.body) || state.SESSION_TOKEN;
    state.SESSION_ID = extractSessionId(res.body) || state.SESSION_ID;
    result.start = res.body;
  }

  if (steps.includes('activate')) {
    const headers = {
      'content-type': 'application/json',
      ...resolveTemplates(
        optionalObjectJson(config, 'sessionActivateHeadersJson', 'Activate Headers') || {},
        vars(),
      ),
    };
    const payload = resolveTemplates(
      optionalObjectJson(config, 'sessionActivateBodyJson', 'Activate Body') || {},
      vars(),
    );
    logs.push({ step: 'session.activate.request', headers, payload });
    const res = await requestJson({
      method: 'POST',
      url: `${baseUrl}/v2/exp/session/activate`,
      headers,
      body: payload,
    });
    logs.push({ step: 'session.activate.response', status: res.status, body: res.body });
    const block = detectMaintenanceBlock('session.activate', res.status, res.body);
    if (block) throw httpError(`MAINTENANCE BLOCKED`, block, logs);
    if (res.status !== 200)
      throw httpError(`Activate failed`, { status: res.status, response: res.body }, logs);

    state.ACCESS_TOKEN = extractAccessToken(res.body) || state.ACCESS_TOKEN;
    if (!state.SESSION_ID) state.SESSION_ID = extractSessionId(res.body) || state.SESSION_ID;
    result.activate = res.body;
  }

  if (steps.includes('bet')) {
    const headers = {
      'content-type': 'application/json',
      ...resolveTemplates(
        optionalObjectJson(config, 'betHeadersJson', 'Bet Headers') || {},
        vars(),
      ),
    };
    const payload = resolveTemplates(
      optionalObjectJson(config, 'betBodyJson', 'Bet Body') || {},
      vars(),
    );
    logs.push({ step: 'play.bet.request', headers, payload });
    const res = await requestJson({
      method: 'POST',
      url: `${baseUrl}/v2/exp/play/bet`,
      headers,
      body: payload,
    });
    logs.push({ step: 'play.bet.response', status: res.status, body: res.body });
    const block = detectMaintenanceBlock('play.bet', res.status, res.body);
    if (block) throw httpError(`MAINTENANCE BLOCKED`, block, logs);
    if (res.status !== 200)
      throw httpError(`Bet failed`, { status: res.status, response: res.body }, logs);

    state.ROUND_ID = res.body?.data?.roundId || state.ROUND_ID;
    const actionVal =
      res.body?.data?.action ??
      res.body?.data?.actions?.[0]?.action ??
      res.body?.data?.actions?.[0];
    if (actionVal !== undefined) state.ACTION = actionVal;
    result.bet = res.body;
  }

  if (steps.includes('action')) {
    if (state.ACTION !== undefined) {
      const headers = {
        'content-type': 'application/json',
        ...resolveTemplates(
          optionalObjectJson(config, 'actionHeadersJson', 'Action Headers') || {},
          vars(),
        ),
      };
      const payload = resolveTemplates(
        optionalObjectJson(config, 'actionBodyJson', 'Action Body') || {},
        vars(),
      );
      logs.push({ step: 'play.action.request', headers, payload });
      const res = await requestJson({
        method: 'POST',
        url: `${baseUrl}/v2/exp/play/action`,
        headers,
        body: payload,
      });
      logs.push({ step: 'play.action.response', status: res.status, body: res.body });
      if (res.status !== 200)
        throw httpError(`Action failed`, { status: res.status, response: res.body }, logs);
      result.action = res.body;
    }
  }

  if (steps.includes('finish')) {
    const headers = {
      'content-type': 'application/json',
      ...resolveTemplates(
        optionalObjectJson(config, 'finishHeadersJson', 'Finish Headers') || {},
        vars(),
      ),
    };
    const payload = resolveTemplates(
      optionalObjectJson(config, 'finishBodyJson', 'Finish Body') || {},
      vars(),
    );
    logs.push({ step: 'play.finish.request', headers, payload });
    const res = await requestJson({
      method: 'POST',
      url: `${baseUrl}/v2/exp/play/finish`,
      headers,
      body: payload,
    });
    logs.push({ step: 'play.finish.response', status: res.status, body: res.body });
    if (res.status !== 200)
      throw httpError(`Finish failed`, { status: res.status, response: res.body }, logs);
    result.finish = res.body;
  }

  return {
    result,
    state,
    logs,
    resultFile: saveFlowResult('bet', config.gameCode, result, logs),
    requestedAt,
    respondedAt: displayTime(),
  };
}

async function runLobbyFlow(input) {
  const requestedAt = displayTime();
  const config = {
    apiDomain: input.apiDomain || 'localhost:19080',
    signature: input.signature || 'rgs-local-signature',
    gameCode: input.gameCode || 'LGS-006',
    sessionStartHeadersJson: input.sessionStartHeadersJson || '',
    sessionStartBodyJson: input.sessionStartBodyJson || '',
    sessionActivateHeadersJson: input.sessionActivateHeadersJson || '',
    sessionActivateBodyJson: input.sessionActivateBodyJson || '',
    tokenActivateHeadersJson: input.tokenActivateHeadersJson || '',
    tokenActivateBodyJson: input.tokenActivateBodyJson || '',
    tokenRefreshHeadersJson: input.tokenRefreshHeadersJson || '',
    tokenRefreshBodyJson: input.tokenRefreshBodyJson || '',
  };
  const baseUrl = normalizeBaseUrl(config.apiDomain);
  const logs = [];
  const result = {};

  const state = typeof input.state === 'object' && input.state ? input.state : {};
  const steps = Array.isArray(input.steps)
    ? input.steps
    : ['start', 'activate', 'tokenActivate', 'tokenRefresh'];
  const vars = () => ({
    ...state,
    GAME_CODE: config.gameCode,
    RTP_CONFIG_CODE: config.gameCode === 'LGS-001' ? 'highRTP' : 'RTP_97',
    SIGNATURE: config.signature,
    NOW_MS: nowMs(),
  });

  if (steps.includes('start')) {
    const headers = {
      'x-signature': config.signature,
      'content-type': 'application/json',
      ...resolveTemplates(
        optionalObjectJson(config, 'sessionStartHeadersJson', 'Start Headers') || {},
        vars(),
      ),
    };
    const payload = resolveTemplates(
      optionalObjectJson(config, 'sessionStartBodyJson', 'Start Body') || {},
      vars(),
    );
    logs.push({ step: 'session.start.request', headers, payload });
    const res = await requestJson({
      method: 'POST',
      url: `${baseUrl}/v2/service/session/start`,
      headers,
      body: payload,
    });
    logs.push({ step: 'session.start.response', status: res.status, body: res.body });
    if (res.status !== 200)
      throw httpError(`Start failed`, { status: res.status, response: res.body }, logs);
    state.SESSION_TOKEN = extractSessionToken(res.body) || state.SESSION_TOKEN;
    state.SESSION_ID = extractSessionId(res.body) || state.SESSION_ID;
    result.start = res.body;
  }

  if (steps.includes('activate')) {
    const headers = {
      'content-type': 'application/json',
      ...resolveTemplates(
        optionalObjectJson(config, 'sessionActivateHeadersJson', 'Activate Headers') || {},
        vars(),
      ),
    };
    const payload = resolveTemplates(
      optionalObjectJson(config, 'sessionActivateBodyJson', 'Activate Body') || {},
      vars(),
    );
    logs.push({ step: 'session.activate.request', headers, payload });
    const res = await requestJson({
      method: 'POST',
      url: `${baseUrl}/v2/exp/session/activate`,
      headers,
      body: payload,
    });
    logs.push({ step: 'session.activate.response', status: res.status, body: res.body });
    if (res.status !== 200)
      throw httpError(`Activate failed`, { status: res.status, response: res.body }, logs);
    state.GAME_ACCESS_TOKEN = extractAccessToken(res.body) || state.GAME_ACCESS_TOKEN;
    result.activate = res.body;
  }

  if (steps.includes('tokenActivate')) {
    const headers = resolveTemplates(
      optionalObjectJson(config, 'tokenActivateHeadersJson', 'Token Activate Headers') || {},
      vars(),
    );
    const payload = resolveTemplates(
      optionalObjectJson(config, 'tokenActivateBodyJson', 'Token Activate Body'),
      vars(),
    );
    logs.push({ step: 'token.activate.request', headers, payload });
    const res = await requestJson({
      method: 'POST',
      url: `${baseUrl}/v1/exp/session-token/activate`,
      headers,
      body: payload || undefined,
    });
    logs.push({ step: 'token.activate.response', status: res.status, body: res.body });
    if (res.status !== 200)
      throw httpError(`Token Activate failed`, { status: res.status, response: res.body }, logs);
    state.LOBBY_ACCESS_TOKEN = res.body?.data?.accessToken || state.LOBBY_ACCESS_TOKEN;
    state.LOBBY_REFRESH_TOKEN = res.body?.data?.refreshToken || state.LOBBY_REFRESH_TOKEN;
    result.tokenActivate = res.body;
  }

  if (steps.includes('tokenRefresh')) {
    const headers = {
      'content-type': 'application/json',
      ...resolveTemplates(
        optionalObjectJson(config, 'tokenRefreshHeadersJson', 'Token Refresh Headers') || {},
        vars(),
      ),
    };
    const payload = resolveTemplates(
      optionalObjectJson(config, 'tokenRefreshBodyJson', 'Token Refresh Body') || {},
      vars(),
    );
    logs.push({ step: 'token.refresh.request', headers, payload });
    const res = await requestJson({
      method: 'POST',
      url: `${baseUrl}/v1/exp/session-token/refresh`,
      headers,
      body: payload,
    });
    logs.push({ step: 'token.refresh.response', status: res.status, body: res.body });
    if (res.status !== 200)
      throw httpError(`Token Refresh failed`, { status: res.status, response: res.body }, logs);
    state.REFRESHED_ACCESS_TOKEN = res.body?.data?.accessToken || state.REFRESHED_ACCESS_TOKEN;
    result.tokenRefresh = res.body;
  }

  return {
    result,
    state,
    logs,
    resultFile: saveFlowResult('lobby', config.gameCode, result, logs),
    requestedAt,
    respondedAt: displayTime(),
  };
}

async function runMaintenanceFlow(input) {
  const requestedAt = displayTime();
  const config = {
    apiDomain: input.apiDomain || 'localhost:8080',
    signature: input.signature || 'rgs-local-signature',
    userId: input.userId ?? 0,
    account: input.account || 'kyle.c',
    code: input.code || 'SLT',
    routeKey: input.routeKey || 'V1_INTERNAL_GAME_MAINTENANCE',
    gameCode: input.gameCode || 'LGS-006',
    isMaintenance: Boolean(input.isMaintenance),
    amTokenHeadersJson: input.amTokenHeadersJson || '',
    amTokenBodyJson: input.amTokenBodyJson || '',
    maintenanceHeadersJson: input.maintenanceHeadersJson || '',
    maintenanceBodyJson: input.maintenanceBodyJson || '',
  };
  const baseUrl = normalizeBaseUrl(config.apiDomain);
  const logs = [];
  const result = {};

  const state = typeof input.state === 'object' && input.state ? input.state : {};
  const steps = Array.isArray(input.steps) ? input.steps : ['amToken', 'patch'];
  const vars = () => ({
    ...state,
    GAME_CODE: config.gameCode,
    SIGNATURE: config.signature,
    IS_MAINTENANCE: config.isMaintenance,
    USER_ID: Number(config.userId),
    ACCOUNT: config.account,
    CODE: config.code,
    ROUTE_KEY: config.routeKey,
  });

  if (steps.includes('amToken')) {
    const headers = {
      'content-type': 'application/json',
      ...resolveTemplates(
        optionalObjectJson(config, 'amTokenHeadersJson', 'AM Token Headers') || {},
        vars(),
      ),
    };
    const payload = resolveTemplates(
      optionalObjectJson(config, 'amTokenBodyJson', 'AM Token Body') || {},
      vars(),
    );
    logs.push({ step: 'am.token.request', headers, payload });
    const res = await requestJson({
      method: 'POST',
      url: `${baseUrl}/v1/service/am/token`,
      headers,
      body: payload,
    });
    logs.push({ step: 'am.token.response', status: res.status, body: res.body });
    if (res.status !== 200)
      throw httpError(`AM token failed`, { status: res.status, response: res.body }, logs);
    state.AM_TOKEN = res.body?.data?.token || state.AM_TOKEN;
    result.amToken = res.body;
  }

  if (steps.includes('patch')) {
    const headers = {
      'content-type': 'application/json',
      ...resolveTemplates(
        optionalObjectJson(config, 'maintenanceHeadersJson', 'Maintenance Headers') || {},
        vars(),
      ),
    };
    const payload = resolveTemplates(
      optionalObjectJson(config, 'maintenanceBodyJson', 'Maintenance Body') || {},
      vars(),
    );
    logs.push({ step: 'maintenance.patch.request', headers, payload });
    const res = await requestJson({
      method: 'PATCH',
      url: `${baseUrl}/v1/internal/game/${encodeURIComponent(config.gameCode)}/maintenance`,
      headers,
      body: payload,
    });
    logs.push({ step: 'maintenance.patch.response', status: res.status, body: res.body });
    if (res.status !== 200)
      throw httpError(`Maintenance patch failed`, { status: res.status, response: res.body }, logs);
    result.patch = res.body;
  }

  return {
    result,
    state,
    logs,
    resultFile: saveFlowResult('maintenance', config.gameCode, result, logs),
    requestedAt,
    respondedAt: displayTime(),
  };
}

// -------------------------------------------------------------
// DEFAULT TEMPLATES CONFIG GENERATOR
// -------------------------------------------------------------
function defaultConfig() {
  const rgs = readEnv(path.join(RGS_DIR, '.env'));
  const lobby = readEnv(path.join(LOBBY_DIR, '.env'));
  const maintenance = readEnv(path.join(MAINTENANCE_DIR, '.env'));
  return {
    rgs: {
      sessionStartHeadersJson: prettyJson({
        'x-signature': '$SIGNATURE',
        'content-type': 'application/json',
      }),
      sessionStartBodyJson: prettyJson({
        gameCode: '$GAME_CODE',
        lang: 'en',
        gameSetting: { rtpConfigCode: '$RTP_CONFIG_CODE', isGeoBlocking: true },
        country: 'GB',
        isTestingPlayer: false,
        mode: 'real',
        operator: 'QARealGameOperator',
        brand: 'QARealGameBrand',
        playerId: 'QARealGameOperator:QARealGameBrand:kyle0c',
        currency: 'EUR',
        currencyId: 1,
        externalPlayerId: 'kyle0c',
        balance: '10000',
        maxExposure: 0,
        licenseConfig: {},
        callback: 'https://httpbin.org/status/200',
      }),
      sessionActivateHeadersJson: prettyJson({ 'content-type': 'application/json' }),
      sessionActivateBodyJson: prettyJson({
        token: '$SESSION_TOKEN',
        ts: 0,
        timezone: 'us',
        analytics: {
          language: 'us',
          device: 'mobile',
          resolution: { w: 0, h: 0 },
          orientation: 'landscape',
          connection: 'slow-2g',
        },
      }),
      betHeadersJson: prettyJson({
        'cloudfront-viewer-country': 'JP',
        'cloudfront-viewer-address': '1.2.3.4',
        'x-access-token': '$ACCESS_TOKEN',
        authorization: 'Bearer $ACCESS_TOKEN',
      }),
      betBodyJson: prettyJson({
        session: '$SESSION_ID',
        bet: { type: 'regular', value: '2' },
        stakeMode: { type: 'commonGame', multiplier: 1, name: 'regular bet', rtp: 96.56 },
        ts: 177445520478,
      }),
      actionHeadersJson: prettyJson({
        'cloudfront-viewer-country': 'JP',
        'cloudfront-viewer-address': '1.2.3.4',
        'x-access-token': '$ACCESS_TOKEN',
        authorization: 'Bearer $ACCESS_TOKEN',
      }),
      actionBodyJson: prettyJson({
        session: '$SESSION_ID',
        roundId: '$ROUND_ID',
        action: '$ACTION',
        ts: '$NOW_MS',
      }),
      finishHeadersJson: prettyJson({
        'cloudfront-viewer-country': 'JP',
        'cloudfront-viewer-address': '1.2.3.4',
        'x-access-token': '$ACCESS_TOKEN',
        authorization: 'Bearer $ACCESS_TOKEN',
      }),
      finishBodyJson: prettyJson({ session: '$SESSION_ID', roundId: '$ROUND_ID', ts: '$NOW_MS' }),
    },
    lobby: {
      tokenActivateHeadersJson: prettyJson({ authorization: 'Bearer $GAME_ACCESS_TOKEN' }),
      tokenActivateBodyJson: 'null',
      tokenRefreshHeadersJson: prettyJson({ authorization: 'Bearer $LOBBY_ACCESS_TOKEN' }),
      tokenRefreshBodyJson: prettyJson({ refreshToken: '$LOBBY_REFRESH_TOKEN' }),
    },
    maintenance: {
      userId: maintenance.AM_USER_ID || '0',
      account: maintenance.AM_ACCOUNT || 'kyle.c',
      code: maintenance.AM_CODE || 'SLT',
      routeKey: maintenance.AM_ROUTE_KEY || '*',
      amTokenHeadersJson: prettyJson({ accept: 'application/json', 'x-signature': '$SIGNATURE' }),
      amTokenBodyJson: prettyJson({
        userId: '$USER_ID',
        account: '$ACCOUNT',
        code: '$CODE',
        permission: [
          { routeKey: '$ROUTE_KEY', methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', '*'] },
        ],
      }),
      maintenanceHeadersJson: prettyJson({
        accept: 'application/json',
        'x-access-token': '$AM_TOKEN',
      }),
      maintenanceBodyJson: prettyJson({ isMaintenance: '$IS_MAINTENANCE' }),
    },
  };
}

async function handleApi(req, res, pathname) {
  try {
    if (req.method === 'POST' && pathname === '/api/ping') {
      const { url } = await parseJsonBody(req);
      try {
        const pingUrl = url.replace(/\/$/, '') + '/v2/service/healthcheck';
        const ping2Url = url.replace(/\/$/, '') + '/v1/service/healthcheck';
        const r1 = await fetch(pingUrl).catch(() => null);
        if (r1?.ok) return jsonResponse(res, 200, { ok: true });
        const r2 = await fetch(ping2Url).catch(() => null);
        return jsonResponse(res, 200, { ok: r2?.ok || false });
      } catch {
        return jsonResponse(res, 200, { ok: false });
      }
    }

    if (req.method === 'GET' && pathname === '/api/cache') {
      const url = new URL(req.url, 'http://localhost');
      const flow = url.searchParams.get('flow');
      let cacheFile = '';
      if (flow === 'bet') cacheFile = path.join(RGS_DIR, '.token-cache.json');
      else if (flow === 'lobby') cacheFile = path.join(LOBBY_DIR, '.lobby-token-cache.json');
      else if (flow === 'maintenance')
        cacheFile = path.join(MAINTENANCE_DIR, '.am-token-cache.json');

      if (cacheFile && fs.existsSync(cacheFile))
        return jsonResponse(res, 200, { cache: readJsonFile(cacheFile) });
      return jsonResponse(res, 200, { cache: null });
    }

    if (req.method === 'GET' && pathname === '/api/config')
      return jsonResponse(res, 200, defaultConfig());
    if (req.method === 'GET' && pathname === '/api/records') {
      const url = new URL(req.url, 'http://localhost');
      return jsonResponse(res, 200, {
        records: listRecords(url.searchParams.get('flow') || 'bet'),
      });
    }
    if (req.method === 'GET' && pathname === '/api/record') {
      const url = new URL(req.url, 'http://localhost');
      const flow = url.searchParams.get('flow') || 'bet';
      const file = path.basename(url.searchParams.get('file') || '');
      const resultPath = path.join(recordConfig(flow).resultDir, file);
      if (!fs.existsSync(resultPath)) return jsonResponse(res, 404, { error: 'Not found.' });
      return jsonResponse(res, 200, {
        result: readJsonFile(resultPath),
        logs: readJsonFile(path.join(recordConfig(flow).traceDir, `${file}.trace.json`)) || [],
        resultFile: path.relative(REPO_ROOT, resultPath),
        requestedAt: displayTimeFromDate(fs.statSync(resultPath).mtime),
      });
    }

    if (req.method === 'POST' && pathname === '/api/rgs-bet')
      return jsonResponse(res, 200, await runBetFlow(await parseJsonBody(req)));
    if (req.method === 'POST' && pathname === '/api/rgs-lobby')
      return jsonResponse(res, 200, await runLobbyFlow(await parseJsonBody(req)));
    if (req.method === 'POST' && pathname === '/api/maintenance')
      return jsonResponse(res, 200, await runMaintenanceFlow(await parseJsonBody(req)));

    jsonResponse(res, 404, { error: 'Not found' });
  } catch (error) {
    jsonResponse(res, 500, {
      error: error.message,
      details: error.details || null,
      logs: error.logs || null,
      requestedAt: error.requestedAt || displayTime(),
      respondedAt: displayTime(),
    });
  }
}

function serveStatic(req, res, pathname) {
  const filePath = path.resolve(PUBLIC_DIR, pathname === '/' ? 'index.html' : pathname.slice(1));
  if (
    !filePath.startsWith(PUBLIC_DIR) ||
    !fs.existsSync(filePath) ||
    !fs.statSync(filePath).isFile()
  ) {
    res.writeHead(404);
    res.end('Not found');
    return;
  }
  res.writeHead(200, {
    'content-type': MIME_TYPES[path.extname(filePath)] || 'application/octet-stream',
    'cache-control': 'no-store',
  });
  fs.createReadStream(filePath).pipe(res);
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');
  if (url.pathname.startsWith('/api/')) return handleApi(req, res, url.pathname);
  serveStatic(req, res, url.pathname);
});

if (require.main === module) {
  const port = Number(process.env.PORT || 3000);
  server.listen(port, '127.0.0.1', () =>
    console.log(`API test web is running at http://localhost:${port}`),
  );
}
module.exports = server;
