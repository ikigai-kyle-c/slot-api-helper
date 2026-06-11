#!/usr/bin/env node
const http = require('http');
const fs = require('fs');
const path = require('path');
const { URL } = require('url');

function displayTime() {
  const d = new Date();
  return d.toISOString().replace('T', ' ').substring(0, 19) + 'Z';
}

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

function resolveDomain(value, fallback) {
  const trimmed = typeof value === 'string' ? value.trim() : '';
  if (!trimmed || trimmed === 'null' || trimmed === 'undefined') return fallback;
  return trimmed;
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

function httpError(message, details, logs = null, state = null) {
  const error = new Error(message);
  error.details = details;
  error.logs = logs;
  error.state = state;
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

function safeGet(obj, path) {
  if (typeof path !== 'string' || !obj) return undefined;
  const keys = path.split('.');
  let current = obj;
  for (const key of keys) {
    if (current === null || current === undefined) return undefined;
    current = current[key];
  }
  return current;
}

function processStateExtraction(mappingJsonStr, resultObj, stateObj, currentStepResponse = null) {
  if (!mappingJsonStr || typeof mappingJsonStr !== 'string') return;
  try {
    const mapping = JSON.parse(mappingJsonStr);
    for (const [stateKey, path] of Object.entries(mapping)) {
      let val = safeGet(resultObj, path);
      if (val === undefined && currentStepResponse && typeof path === 'string' && path.startsWith('step.')) {
        val = safeGet(currentStepResponse, path.substring(5));
      }
      if (val !== undefined) {
        stateObj[stateKey] = val;
      }
    }
  } catch(e) {
    console.error("Failed to parse state mapping:", e.message);
  }
}
function extractAccessToken(body) {
  return body?.token || body?.accessToken || body?.data?.token || body?.data?.accessToken || '';
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
    body?.data?.sessionToken ||
    extractLaunchToken(body?.data?.launchUrl) ||
    ''
  );
}
function extractSessionId(body) {
  return body?.sessionId || body?.session || body?.data?.sessionId || body?.data?.session || '';
}
function nowMs() {
  return Date.now();
}



// -------------------------------------------------------------
// FLOW RUNNERS (Stateless)
// -------------------------------------------------------------

async function runBetFlow(input) {
  const requestedAt = displayTime();
  const config = {
    apiDomain: resolveDomain(input.apiDomain, 'localhost:19080'),
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
    if (block) throw httpError(`MAINTENANCE BLOCKED`, block, logs, state);
    if (res.status !== 200)
      throw httpError(`Start failed`, { status: res.status, response: res.body }, logs, state);

    state.SESSION_TOKEN = extractSessionToken(res.body) || state.SESSION_TOKEN;
    state.SESSION_ID = extractSessionId(res.body) || state.SESSION_ID;
    result.start = res.body;
    processStateExtraction(input.stateExtractMapping, result, state, res.body);
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
    if (block) throw httpError(`MAINTENANCE BLOCKED`, block, logs, state);
    if (res.status !== 200)
      throw httpError(`Activate failed`, { status: res.status, response: res.body }, logs, state);

    state.ACCESS_TOKEN = extractAccessToken(res.body) || state.ACCESS_TOKEN;
    if (!state.SESSION_ID) state.SESSION_ID = extractSessionId(res.body) || state.SESSION_ID;
    result.activate = res.body;
    processStateExtraction(input.stateExtractMapping, result, state, res.body);
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
    if (block) throw httpError(`MAINTENANCE BLOCKED`, block, logs, state);
    if (res.status !== 200)
      throw httpError(`Bet failed`, { status: res.status, response: res.body }, logs, state);

    state.ROUND_ID = res.body?.data?.roundId || state.ROUND_ID;
    const actionVal =
      res.body?.data?.action ??
      res.body?.data?.actions?.[0]?.action ??
      res.body?.data?.actions?.[0];
    if (actionVal !== undefined) state.ACTION = actionVal;
    result.bet = res.body;
    processStateExtraction(input.stateExtractMapping, result, state, res.body);
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
        throw httpError(`Action failed`, { status: res.status, response: res.body }, logs, state);
      result.action = res.body;
      processStateExtraction(input.stateExtractMapping, result, state, res.body);
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
      throw httpError(`Finish failed`, { status: res.status, response: res.body }, logs, state);
    result.finish = res.body;
    processStateExtraction(input.stateExtractMapping, result, state, res.body);
  }

  processStateExtraction(input.stateExtractMapping, result, state);
  return {
    result,
    state,
    logs,
    
    requestedAt,
    respondedAt: displayTime(),
  };
}

async function runLobbyFlow(input) {
  const requestedAt = displayTime();
  const config = {
    apiDomain: resolveDomain(input.apiDomain, 'localhost:19080'),
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
      throw httpError(`Start failed`, { status: res.status, response: res.body }, logs, state);
    state.SESSION_TOKEN = extractSessionToken(res.body) || state.SESSION_TOKEN;
    state.SESSION_ID = extractSessionId(res.body) || state.SESSION_ID;
    result.start = res.body;
    processStateExtraction(input.stateExtractMapping, result, state, res.body);
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
      throw httpError(`Activate failed`, { status: res.status, response: res.body }, logs, state);
    state.GAME_ACCESS_TOKEN = extractAccessToken(res.body) || state.GAME_ACCESS_TOKEN;
    result.activate = res.body;
    processStateExtraction(input.stateExtractMapping, result, state, res.body);
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
      throw httpError(`Token Activate failed`, { status: res.status, response: res.body }, logs, state);
    state.LOBBY_ACCESS_TOKEN = res.body?.data?.accessToken || state.LOBBY_ACCESS_TOKEN;
    state.LOBBY_REFRESH_TOKEN = res.body?.data?.refreshToken || state.LOBBY_REFRESH_TOKEN;
    result.tokenActivate = res.body;
    processStateExtraction(input.stateExtractMapping, result, state, res.body);
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
      throw httpError(`Token Refresh failed`, { status: res.status, response: res.body }, logs, state);
    state.REFRESHED_ACCESS_TOKEN = res.body?.data?.accessToken || state.REFRESHED_ACCESS_TOKEN;
    result.tokenRefresh = res.body;
    processStateExtraction(input.stateExtractMapping, result, state, res.body);
  }

  processStateExtraction(input.stateExtractMapping, result, state);
  return {
    result,
    state,
    logs,
    
    requestedAt,
    respondedAt: displayTime(),
  };
}

async function runMaintenanceFlow(input) {
  const requestedAt = displayTime();
  const config = {
    apiDomain: resolveDomain(input.apiDomain, 'localhost:8080'),
    signature: input.signature || 'rgs-local-signature',
    userId: input.userId ?? 0,
    account: input.account || 'kyle.c',
    code: input.code || '*',
    routeKey: input.routeKey || '*',
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
      throw httpError(`AM token failed`, { status: res.status, response: res.body }, logs, state);
    state.AM_TOKEN = res.body?.data?.token || state.AM_TOKEN;
    result.amToken = res.body;
    processStateExtraction(input.stateExtractMapping, result, state, res.body);
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
      throw httpError(`Maintenance patch failed`, { status: res.status, response: res.body }, logs, state);
    result.patch = res.body;
    processStateExtraction(input.stateExtractMapping, result, state, res.body);
  }

  processStateExtraction(input.stateExtractMapping, result, state);
  return {
    result,
    state,
    logs,
    
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
      tokenActivateHeadersJson: prettyJson({ authorization: 'Bearer $GAME_ACCESS_TOKEN' }),
      tokenActivateBodyJson: 'null',
      tokenRefreshHeadersJson: prettyJson({ authorization: 'Bearer $LOBBY_ACCESS_TOKEN' }),
      tokenRefreshBodyJson: prettyJson({ refreshToken: '$LOBBY_REFRESH_TOKEN' }),
    },
    maintenance: {
      userId: maintenance.AM_USER_ID || '0',
      account: maintenance.AM_ACCOUNT || 'kyle.c',
      code: maintenance.AM_CODE || '*',
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

    if (req.method === 'GET' && pathname === '/api/config')
      return jsonResponse(res, 200, defaultConfig());

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
      state: error.state || null,
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
  server.listen(port, '0.0.0.0', () =>
    console.log(`API test web is running at http://localhost:${port}`),
  );
}
module.exports = server;
