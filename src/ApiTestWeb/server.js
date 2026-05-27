#!/usr/bin/env node
const http = require('http');
const fs = require('fs');
const path = require('path');
const { URL } = require('url');

const ROOT = path.resolve(__dirname, '..');
const PUBLIC_DIR = path.join(__dirname, 'public');
const RGS_DIR = path.join(ROOT, 'RGSBetFlow');
const LOBBY_DIR = path.join(ROOT, 'RGSLobby');
const MAINTENANCE_DIR = path.join(ROOT, 'InternalMaintenanceApi');
const RGS_CACHE = path.join(RGS_DIR, '.token-cache.json');
const LOBBY_CACHE = path.join(LOBBY_DIR, '.lobby-token-cache.json');
const AM_CACHE = path.join(MAINTENANCE_DIR, '.am-token-cache.json');
const RESULT_DIR = path.join(RGS_DIR, 'result');
const TRACE_DIR = path.join(RESULT_DIR, '.traces');
const LOBBY_RESULT_DIR = path.join(LOBBY_DIR, 'result');
const LOBBY_TRACE_DIR = path.join(LOBBY_RESULT_DIR, '.traces');
const MAINTENANCE_RESULT_DIR = path.join(MAINTENANCE_DIR, 'result');
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
  const body = JSON.stringify(data, null, 2);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  });
  res.end(body);
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
      if (!body) {
        resolve({});
        return;
      }
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
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = text;
  }
  return { status: response.status, ok: response.ok, body: json };
}

function isInvalidToken(status, body) {
  const text = typeof body === 'string' ? body : JSON.stringify(body ?? {});
  return status === 401 || /invalid|expired|unauthorized/i.test(text);
}

function jwtPayload(token) {
  if (!token || typeof token !== 'string') return null;
  const parts = token.split('.');
  if (parts.length < 2) return null;

  try {
    const base64 = parts[1].replace(/-/g, '+').replace(/_/g, '/');
    const padded = base64.padEnd(Math.ceil(base64.length / 4) * 4, '=');
    return JSON.parse(Buffer.from(padded, 'base64').toString('utf8'));
  } catch {
    return null;
  }
}

function tokenExpiresSoon(token, skewSeconds = 60) {
  const exp = jwtPayload(token)?.exp;
  if (!Number.isFinite(Number(exp))) return false;
  return Number(exp) <= Math.floor(Date.now() / 1000) + skewSeconds;
}

function cacheMiss(reason) {
  return { cache: null, reason };
}

function httpError(message, details, logs = null) {
  const error = new Error(message);
  error.details = details;
  error.logs = logs;
  return error;
}

function blockedLog(step, status, response) {
  return {
    step: 'flow.blocked',
    blockedStep: step,
    status,
    response,
  };
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
  if (typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${fieldName} must be a JSON object.`);
  }
  return value;
}

function optionalObjectJson(config, key, label) {
  return objectOrNull(parseOptionalJson(config[key], label), label);
}

function hasAnyConfig(config, keys) {
  return keys.some((key) => String(config[key] || '').trim() !== '');
}

function prettyJson(value) {
  return JSON.stringify(value, null, 2);
}

function sameJson(value, expected) {
  const parsed = parseOptionalJson(value, 'JSON');
  return JSON.stringify(parsed) === JSON.stringify(expected);
}

function hasCustomJson(config, entries) {
  return entries.some(([key, defaultValue]) => {
    const raw = String(config[key] || '').trim();
    return raw !== '' && !sameJson(raw, defaultValue);
  });
}

function resolveTemplates(value, vars) {
  if (Array.isArray(value)) {
    return value.map((item) => resolveTemplates(item, vars));
  }

  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, resolveTemplates(item, vars)]),
    );
  }

  if (typeof value !== 'string') return value;

  const exact = value.match(/^\$([A-Z0-9_]+)$/);
  if (exact && Object.prototype.hasOwnProperty.call(vars, exact[1])) {
    return vars[exact[1]];
  }

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
      const stat = fs.statSync(filePath);
      return {
        file: name,
        resultFile: path.relative(ROOT, filePath),
        updatedAt: displayTimeFromDate(stat.mtime),
        hasTrace: fs.existsSync(path.join(config.traceDir, `${name}.trace.json`)),
      };
    });
}

function timestamp() {
  const date = new Date();
  const pad = (value) => String(value).padStart(2, '0');
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
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function rtpConfigCode(gameCode) {
  return sessionStartPayload(gameCode).gameSetting.rtpConfigCode;
}

function sessionStartPayload(gameCode) {
  return {
    gameCode,
    lang: 'en',
    gameSetting: {
      rtpConfigCode: gameCode === 'LGS-001' ? 'highRTP' : 'RTP_97',
      isGeoBlocking: true,
    },
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
    callback: 'http://localhost',
  };
}

function sessionStartPayloadTemplate() {
  return {
    ...sessionStartPayload('$GAME_CODE'),
    gameSetting: {
      rtpConfigCode: '$RTP_CONFIG_CODE',
      isGeoBlocking: true,
    },
  };
}

function sessionActivatePayloadTemplate() {
  return {
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
  };
}

function betPayload(sessionId) {
  return {
    session: sessionId || '',
    bet: {
      type: 'regular',
      value: '2',
    },
    stakeMode: {
      type: 'commonGame',
      multiplier: 1,
      name: 'regular bet',
      rtp: 96.56,
    },
    ts: 177445520478,
  };
}

function betPayloadTemplate() {
  return betPayload('$SESSION_ID');
}

function actionPayloadTemplate() {
  return {
    session: '$SESSION_ID',
    roundId: '$ROUND_ID',
    action: '$ACTION',
    ts: '$NOW_MS',
  };
}

function finishPayloadTemplate() {
  return {
    session: '$SESSION_ID',
    roundId: '$ROUND_ID',
    ts: '$NOW_MS',
  };
}

function sessionStartHeadersTemplate(signature = '$SIGNATURE') {
  return {
    'x-signature': signature,
    'content-type': 'application/json',
  };
}

function sessionActivateHeadersTemplate() {
  return {
    'content-type': 'application/json',
  };
}

function playHeadersTemplate() {
  return {
    'cloudfront-viewer-country': 'JP',
    'cloudfront-viewer-address': '1.2.3.4',
    'x-access-token': '$ACCESS_TOKEN',
    authorization: 'Bearer $ACCESS_TOKEN',
    'content-type': 'application/json',
  };
}

function amTokenHeadersTemplate() {
  return {
    accept: 'application/json',
    'x-signature': '$SIGNATURE',
    'content-type': 'application/json',
  };
}

function amTokenPayloadTemplate() {
  return {
    userId: '$USER_ID',
    account: '$ACCOUNT',
    code: '$CODE',
    permission: [
      {
        routeKey: '$ROUTE_KEY',
        methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', '*'],
      },
    ],
  };
}

function maintenanceHeadersTemplate() {
  return {
    accept: 'application/json',
    'x-access-token': '$AM_TOKEN',
    'content-type': 'application/json',
  };
}

function maintenanceBodyTemplate() {
  return {
    isMaintenance: '$IS_MAINTENANCE',
  };
}

function lobbyTokenActivateHeadersTemplate() {
  return {
    authorization: 'Bearer $GAME_ACCESS_TOKEN',
  };
}

function lobbyTokenRefreshHeadersTemplate() {
  return {
    authorization: 'Bearer $LOBBY_ACCESS_TOKEN',
    'content-type': 'application/json',
  };
}

function lobbyTokenRefreshBodyTemplate() {
  return {
    refreshToken: '$LOBBY_REFRESH_TOKEN',
  };
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

async function refreshRgsTokens(config, logs) {
  const baseUrl = normalizeBaseUrl(config.apiDomain);
  const startHeadersOverride = optionalObjectJson(
    config,
    'sessionStartHeadersJson',
    'Session start headers JSON',
  );
  const startBodyOverride = optionalObjectJson(
    config,
    'sessionStartBodyJson',
    'Session start body JSON',
  );
  const startPayload = resolveTemplates(startBodyOverride || sessionStartPayload(config.gameCode), {
    GAME_CODE: config.gameCode,
    RTP_CONFIG_CODE: rtpConfigCode(config.gameCode),
    SIGNATURE: config.signature,
  });
  const startHeaders = {
    'x-signature': config.signature,
    'content-type': 'application/json',
    ...resolveTemplates(startHeadersOverride || {}, {
      GAME_CODE: config.gameCode,
      RTP_CONFIG_CODE: rtpConfigCode(config.gameCode),
      SIGNATURE: config.signature,
    }),
  };

  logs.push({ step: 'session.start.request', headers: startHeaders, payload: startPayload });

  const start = await requestJson({
    method: 'POST',
    url: `${baseUrl}/v2/service/session/start`,
    headers: startHeaders,
    body: startPayload,
  });
  logs.push({ step: 'session.start.response', status: start.status, body: start.body });
  const startMaintenanceBlock = detectMaintenanceBlock('session.start', start.status, start.body);
  if (startMaintenanceBlock) {
    logs.push({ step: 'maintenance.block', ...startMaintenanceBlock });
    throw httpError(
      `MAINTENANCE BLOCKED at ${startMaintenanceBlock.step}: ${startMaintenanceBlock.message}`,
      startMaintenanceBlock,
      logs,
    );
  }
  if (start.status !== 200) {
    logs.push(blockedLog('session.start', start.status, start.body));
    throw httpError(
      `Session start failed with HTTP ${start.status}.`,
      {
        step: 'session.start',
        status: start.status,
        response: start.body,
      },
      logs,
    );
  }

  const sessionToken = extractSessionToken(start.body);
  const sessionId = extractSessionId(start.body);
  if (!sessionToken) throw new Error('Cannot extract session token from session start response.');

  const activateHeadersOverride = optionalObjectJson(
    config,
    'sessionActivateHeadersJson',
    'Session activate headers JSON',
  );
  const activateBodyOverride = optionalObjectJson(
    config,
    'sessionActivateBodyJson',
    'Session activate body JSON',
  );
  const activatePayload = resolveTemplates(
    activateBodyOverride || {
      token: sessionToken,
      ts: 0,
      timezone: 'us',
      analytics: {
        language: 'us',
        device: 'mobile',
        resolution: { w: 0, h: 0 },
        orientation: 'landscape',
        connection: 'slow-2g',
      },
    },
    { SESSION_TOKEN: sessionToken },
  );
  const activateHeaders = {
    'content-type': 'application/json',
    ...resolveTemplates(activateHeadersOverride || {}, { SESSION_TOKEN: sessionToken }),
  };

  logs.push({
    step: 'session.activate.request',
    headers: activateHeaders,
    payload: activatePayload,
  });

  const activate = await requestJson({
    method: 'POST',
    url: `${baseUrl}/v2/exp/session/activate`,
    headers: activateHeaders,
    body: activatePayload,
  });
  logs.push({ step: 'session.activate.response', status: activate.status, body: activate.body });
  const activateMaintenanceBlock = detectMaintenanceBlock(
    'session.activate',
    activate.status,
    activate.body,
  );
  if (activateMaintenanceBlock) {
    logs.push({ step: 'maintenance.block', ...activateMaintenanceBlock });
    throw httpError(
      `MAINTENANCE BLOCKED at ${activateMaintenanceBlock.step}: ${activateMaintenanceBlock.message}`,
      activateMaintenanceBlock,
      logs,
    );
  }
  if (activate.status !== 200) {
    logs.push(blockedLog('session.activate', activate.status, activate.body));
    throw httpError(
      `Session activate failed with HTTP ${activate.status}.`,
      {
        step: 'session.activate',
        status: activate.status,
        response: activate.body,
      },
      logs,
    );
  }

  const accessToken = extractAccessToken(activate.body);
  if (!accessToken) throw new Error('Cannot extract access token from activate response.');

  const cache = {
    baseUrl,
    gameCode: config.gameCode,
    sessionToken,
    accessToken,
    sessionId,
    savedAt: Date.now() / 1000,
  };
  writeJsonFile(RGS_CACHE, cache);
  return cache;
}

function getRgsCache(config) {
  const cache = readJsonFile(RGS_CACHE);
  if (!cache) return cacheMiss('No cached RGS token found.');
  if (cache.baseUrl !== normalizeBaseUrl(config.apiDomain))
    return cacheMiss('Cached RGS token baseUrl does not match.');
  if (cache.gameCode !== config.gameCode)
    return cacheMiss('Cached RGS token gameCode does not match.');
  if (!cache.accessToken || !cache.sessionToken)
    return cacheMiss('Cached RGS token is missing token fields.');
  if (tokenExpiresSoon(cache.accessToken))
    return cacheMiss('Cached RGS access token expired by JWT exp. Refreshing.');
  return { cache, reason: '' };
}

function playHeaders(accessToken) {
  return {
    'cloudfront-viewer-country': 'JP',
    'cloudfront-viewer-address': '1.2.3.4',
    'x-access-token': accessToken,
    authorization: `Bearer ${accessToken}`,
    'content-type': 'application/json',
  };
}

function extractActionValue(body) {
  if (body?.data?.action !== undefined && body.data.action !== null) return body.data.action;
  const actions = body?.data?.actions;
  if (!Array.isArray(actions) || actions.length === 0) return undefined;
  const first = actions[0];
  if (first && typeof first === 'object' && first.action !== undefined) return first.action;
  return first;
}

function extractSummaryCoins(body) {
  const raw = body?.data?.results?.gameResponse?.step?.summary?.coins;
  if (raw === undefined || raw === null || raw === '') return null;
  const value = Number(raw);
  return Number.isFinite(value) ? value : null;
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

  logs.push({
    step: 'token.refresh',
    message: 'Starting RGS session and activating game access token.',
  });
  const rgsToken = await refreshRgsTokens(config, logs);

  const tokenActivateHeadersOverride = optionalObjectJson(
    config,
    'tokenActivateHeadersJson',
    'Token activate headers JSON',
  );
  const tokenActivateBodyRaw = parseOptionalJson(
    config.tokenActivateBodyJson,
    'Token activate body JSON',
  );
  const tokenActivateVars = { GAME_ACCESS_TOKEN: rgsToken.accessToken };
  const tokenActivateBody =
    tokenActivateBodyRaw === null
      ? null
      : resolveTemplates(tokenActivateBodyRaw, tokenActivateVars);
  const tokenActivateHeaders = {
    authorization: `Bearer ${rgsToken.accessToken}`,
    ...(tokenActivateBody === null ? {} : { 'content-type': 'application/json' }),
    ...resolveTemplates(tokenActivateHeadersOverride || {}, tokenActivateVars),
  };

  logs.push({
    step: 'session-token.activate.request',
    headers: tokenActivateHeaders,
    payload: tokenActivateBody,
  });
  const activate = await requestJson({
    method: 'POST',
    url: `${baseUrl}/v1/exp/session-token/activate`,
    headers: tokenActivateHeaders,
    body: tokenActivateBody === null ? undefined : tokenActivateBody,
  });
  logs.push({
    step: 'session-token.activate.response',
    status: activate.status,
    body: activate.body,
  });
  if (activate.status !== 200) {
    logs.push(blockedLog('session-token.activate', activate.status, activate.body));
    throw httpError(
      `Session-token activate failed with HTTP ${activate.status}.`,
      {
        step: 'session-token.activate',
        status: activate.status,
        response: activate.body,
      },
      logs,
    );
  }

  const lobbyAccessToken = activate.body?.data?.accessToken || '';
  const lobbyRefreshToken = activate.body?.data?.refreshToken || '';
  if (!lobbyAccessToken)
    throw httpError(
      'Cannot extract lobby access token from data.accessToken.',
      { step: 'session-token.activate', response: activate.body },
      logs,
    );
  if (!lobbyRefreshToken)
    throw httpError(
      'Cannot extract lobby refresh token from data.refreshToken.',
      { step: 'session-token.activate', response: activate.body },
      logs,
    );

  const tokenRefreshHeadersOverride = optionalObjectJson(
    config,
    'tokenRefreshHeadersJson',
    'Token refresh headers JSON',
  );
  const tokenRefreshBodyOverride = objectOrNull(
    parseOptionalJson(config.tokenRefreshBodyJson, 'Token refresh body JSON'),
    'Token refresh body JSON',
  );
  const tokenRefreshVars = {
    LOBBY_ACCESS_TOKEN: lobbyAccessToken,
    LOBBY_REFRESH_TOKEN: lobbyRefreshToken,
    NOW_MS: nowMs(),
  };
  const refreshPayload = resolveTemplates(
    tokenRefreshBodyOverride || { refreshToken: lobbyRefreshToken },
    tokenRefreshVars,
  );
  const refreshHeaders = {
    authorization: `Bearer ${lobbyAccessToken}`,
    'content-type': 'application/json',
    ...resolveTemplates(tokenRefreshHeadersOverride || {}, tokenRefreshVars),
  };

  logs.push({
    step: 'session-token.refresh.wait',
    seconds: 5,
    message: 'Waiting 5 seconds before refresh.',
  });
  await delay(5000);

  logs.push({
    step: 'session-token.refresh.request',
    headers: refreshHeaders,
    refreshTokenSource: 'session-token.activate.data.refreshToken',
    payload: refreshPayload,
  });
  const refresh = await requestJson({
    method: 'POST',
    url: `${baseUrl}/v1/exp/session-token/refresh`,
    headers: refreshHeaders,
    body: refreshPayload,
  });
  logs.push({ step: 'session-token.refresh.response', status: refresh.status, body: refresh.body });
  if (refresh.status !== 200) {
    logs.push(blockedLog('session-token.refresh', refresh.status, refresh.body));
    throw httpError(
      `Session-token refresh failed with HTTP ${refresh.status}.`,
      {
        step: 'session-token.refresh',
        status: refresh.status,
        response: refresh.body,
      },
      logs,
    );
  }

  const result = {
    rgsSession: {
      sessionId: rgsToken.sessionId,
      sessionToken: rgsToken.sessionToken,
      accessToken: rgsToken.accessToken,
    },
    sessionTokenActivate: activate.body,
    sessionTokenRefresh: refresh.body,
  };

  writeJsonFile(LOBBY_CACHE, {
    baseUrl,
    gameCode: config.gameCode,
    sessionId: rgsToken.sessionId,
    sessionToken: rgsToken.sessionToken,
    gameAccessToken: rgsToken.accessToken,
    lobby: activate.body?.data || null,
    refresh: refresh.body?.data || null,
    savedAt: Date.now() / 1000,
  });

  return {
    result,
    logs,
    resultFile: saveFlowResult('lobby', config.gameCode, result, logs),
    requestedAt,
    respondedAt: displayTime(),
  };
}

function saveRgsResult(config, result, logs = []) {
  const filename = `${timestamp()}-bet-${config.gameCode}.json`;
  const outputPath = path.join(recordConfig('bet').resultDir, filename);
  const tracePath = path.join(recordConfig('bet').traceDir, `${filename}.trace.json`);
  writeJsonFile(outputPath, result);
  writeJsonFile(tracePath, logs);
  cleanupOldResults('bet');
  return path.relative(ROOT, outputPath);
}

function saveFlowResult(flow, suffixValue, result, logs = []) {
  const config = recordConfig(flow);
  const filename = `${timestamp()}-${config.suffix}-${suffixValue || 'result'}.json`;
  const outputPath = path.join(config.resultDir, filename);
  const tracePath = path.join(config.traceDir, `${filename}.trace.json`);
  writeJsonFile(outputPath, result);
  writeJsonFile(tracePath, logs);
  cleanupOldResults(flow);
  return path.relative(ROOT, outputPath);
}

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
  const hasCustomTokenRequest = hasCustomJson(config, [
    ['sessionStartHeadersJson', sessionStartHeadersTemplate()],
    ['sessionStartBodyJson', sessionStartPayloadTemplate()],
    ['sessionActivateHeadersJson', sessionActivateHeadersTemplate()],
    ['sessionActivateBodyJson', sessionActivatePayloadTemplate()],
  ]);
  const cacheStatus = hasCustomTokenRequest ? cacheMiss('') : getRgsCache(config);
  let cache = cacheStatus.cache;
  if (!cache) {
    logs.push({
      step: 'token.cache',
      message: hasCustomTokenRequest
        ? 'Custom session start/activate headers or body provided. Refreshing.'
        : cacheStatus.reason || 'No matching cached RGS token. Refreshing.',
    });
    cache = await refreshRgsTokens(config, logs);
  } else {
    logs.push({
      step: 'token.cache',
      message: 'Using cached RGS token.',
      sessionId: cache.sessionId,
    });
  }

  async function sendBet() {
    const headersOverride = optionalObjectJson(config, 'betHeadersJson', 'Bet headers JSON');
    const bodyOverride = optionalObjectJson(config, 'betBodyJson', 'Bet body JSON');
    const vars = {
      ACCESS_TOKEN: cache.accessToken,
      SESSION_ID: cache.sessionId,
      NOW_MS: nowMs(),
    };
    const payload = resolveTemplates(bodyOverride || betPayload(cache.sessionId), vars);
    const headers = {
      ...playHeaders(cache.accessToken),
      ...resolveTemplates(headersOverride || {}, vars),
    };

    logs.push({ step: 'play.bet.request', headers, payload });
    const response = await requestJson({
      method: 'POST',
      url: `${baseUrl}/v2/exp/play/bet`,
      headers,
      body: payload,
    });
    logs.push({ step: 'play.bet.response', status: response.status, body: response.body });
    return response;
  }

  let bet = await sendBet();
  if (isInvalidToken(bet.status, bet.body)) {
    logs.push({
      step: 'token.refresh',
      message: 'Cached RGS token is invalid. Refreshing and retrying bet.',
    });
    cache = await refreshRgsTokens(config, logs);
    bet = await sendBet();
  }
  if (bet.status !== 200) {
    logs.push(blockedLog('play.bet', bet.status, bet.body));
    throw httpError(
      `Bet failed with HTTP ${bet.status}.`,
      {
        step: 'play.bet',
        status: bet.status,
        response: bet.body,
      },
      logs,
    );
  }

  const result = { bet: bet.body };
  const betMaintenanceBlock = detectMaintenanceBlock('play.bet', bet.status, bet.body);
  if (betMaintenanceBlock) {
    logs.push({ step: 'maintenance.block', ...betMaintenanceBlock });
    result.maintenanceBlock = betMaintenanceBlock;
    return {
      result,
      logs,
      resultFile: saveRgsResult(config, result, logs),
      requestedAt,
      respondedAt: displayTime(),
      maintenanceBlock: betMaintenanceBlock,
    };
  }

  const action = extractActionValue(bet.body);
  if (action !== undefined && action !== null && action !== '') {
    const actionHeadersOverride = optionalObjectJson(
      config,
      'actionHeadersJson',
      'Action headers JSON',
    );
    const actionBodyOverride = optionalObjectJson(config, 'actionBodyJson', 'Action body JSON');
    const actionVars = {
      ACCESS_TOKEN: cache.accessToken,
      SESSION_ID: cache.sessionId || '',
      ROUND_ID: bet.body?.data?.roundId || '',
      ACTION: action,
      NOW_MS: nowMs(),
    };
    const actionPayload = resolveTemplates(
      actionBodyOverride || {
        session: cache.sessionId || '',
        roundId: bet.body?.data?.roundId || '',
        action,
        ts: nowMs(),
      },
      actionVars,
    );
    if (!actionPayload.roundId) throw new Error('Bet response has action but no data.roundId.');
    const actionHeaders = {
      ...playHeaders(cache.accessToken),
      ...resolveTemplates(actionHeadersOverride || {}, actionVars),
    };

    logs.push({ step: 'play.action.request', headers: actionHeaders, payload: actionPayload });
    const actionResponse = await requestJson({
      method: 'POST',
      url: `${baseUrl}/v2/exp/play/action`,
      headers: actionHeaders,
      body: actionPayload,
    });
    logs.push({
      step: 'play.action.response',
      status: actionResponse.status,
      body: actionResponse.body,
    });
    result.action = actionResponse.body;
    const actionMaintenanceBlock = detectMaintenanceBlock(
      'play.action',
      actionResponse.status,
      actionResponse.body,
    );
    if (actionMaintenanceBlock) {
      logs.push({ step: 'maintenance.block', ...actionMaintenanceBlock });
      result.maintenanceBlock = actionMaintenanceBlock;
      return {
        result,
        logs,
        resultFile: saveRgsResult(config, result, logs),
        requestedAt,
        respondedAt: displayTime(),
        maintenanceBlock: actionMaintenanceBlock,
      };
    }
    if (actionResponse.status !== 200) {
      logs.push(blockedLog('play.action', actionResponse.status, actionResponse.body));
      throw httpError(
        `Action failed with HTTP ${actionResponse.status}.`,
        {
          step: 'play.action',
          status: actionResponse.status,
          response: actionResponse.body,
        },
        logs,
      );
    }
  }

  const lastPlay = result.action || result.bet;
  const coins = extractSummaryCoins(lastPlay);
  if (coins !== null && coins > 0) {
    const finishHeadersOverride = optionalObjectJson(
      config,
      'finishHeadersJson',
      'Finish headers JSON',
    );
    const finishBodyOverride = optionalObjectJson(config, 'finishBodyJson', 'Finish body JSON');
    const finishVars = {
      ACCESS_TOKEN: cache.accessToken,
      SESSION_ID: cache.sessionId || '',
      ROUND_ID: lastPlay?.data?.roundId || '',
      NOW_MS: nowMs(),
    };
    const finishPayload = resolveTemplates(
      finishBodyOverride || {
        session: cache.sessionId || '',
        roundId: lastPlay?.data?.roundId || '',
        ts: nowMs(),
      },
      finishVars,
    );
    if (!finishPayload.roundId)
      throw new Error('Play response has summary.coins > 0 but no data.roundId.');
    const finishHeaders = {
      ...playHeaders(cache.accessToken),
      ...resolveTemplates(finishHeadersOverride || {}, finishVars),
    };

    logs.push({ step: 'play.finish.request', headers: finishHeaders, payload: finishPayload });
    const finish = await requestJson({
      method: 'POST',
      url: `${baseUrl}/v2/exp/play/finish`,
      headers: finishHeaders,
      body: finishPayload,
    });
    logs.push({ step: 'play.finish.response', status: finish.status, body: finish.body });
    result.finish = finish.body;
    const finishMaintenanceBlock = detectMaintenanceBlock(
      'play.finish',
      finish.status,
      finish.body,
    );
    if (finishMaintenanceBlock) {
      logs.push({ step: 'maintenance.block', ...finishMaintenanceBlock });
      result.maintenanceBlock = finishMaintenanceBlock;
      return {
        result,
        logs,
        resultFile: saveRgsResult(config, result, logs),
        requestedAt,
        respondedAt: displayTime(),
        maintenanceBlock: finishMaintenanceBlock,
      };
    }
    if (finish.status !== 200) {
      logs.push(blockedLog('play.finish', finish.status, finish.body));
      throw httpError(
        `Finish failed with HTTP ${finish.status}.`,
        {
          step: 'play.finish',
          status: finish.status,
          response: finish.body,
        },
        logs,
      );
    }
  } else {
    logs.push({
      step: 'play.finish.skip',
      message: `summary.coins=${coins ?? 'missing'}, finish not sent.`,
    });
  }

  return {
    result,
    logs,
    resultFile: saveRgsResult(config, result, logs),
    requestedAt,
    respondedAt: displayTime(),
  };
}

function amTokenPayload(config) {
  return {
    userId: Number(config.userId),
    account: config.account,
    code: config.code,
    permission: [
      {
        routeKey: config.routeKey,
        methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', '*'],
      },
    ],
  };
}

function getAmCache(config) {
  const cache = readJsonFile(AM_CACHE);
  if (!cache) return cacheMiss('No cached AM token found.');
  if (cache.baseUrl !== normalizeBaseUrl(config.apiDomain))
    return cacheMiss('Cached AM token baseUrl does not match.');
  if (cache.account !== config.account) return cacheMiss('Cached AM token account does not match.');
  if (cache.code !== config.code) return cacheMiss('Cached AM token code does not match.');
  if (cache.routeKey !== config.routeKey)
    return cacheMiss('Cached AM token routeKey does not match.');
  if (String(cache.userId) !== String(config.userId))
    return cacheMiss('Cached AM token userId does not match.');
  if (!cache.token || !cache.sessionId)
    return cacheMiss('Cached AM token is missing token fields.');
  if (tokenExpiresSoon(cache.token))
    return cacheMiss('Cached AM token expired by JWT exp. Refreshing.');
  return { cache, reason: '' };
}

async function refreshAmToken(config, logs) {
  const baseUrl = normalizeBaseUrl(config.apiDomain);
  const customHeaders = objectOrNull(
    parseOptionalJson(config.amTokenHeadersJson, 'AM token headers JSON'),
    'AM token headers JSON',
  );
  const customBody = objectOrNull(
    parseOptionalJson(config.amTokenBodyJson, 'AM token body JSON'),
    'AM token body JSON',
  );
  const vars = {
    SIGNATURE: config.signature,
    USER_ID: Number(config.userId),
    ACCOUNT: config.account,
    CODE: config.code,
    ROUTE_KEY: config.routeKey,
  };
  const payload = resolveTemplates(customBody || amTokenPayload(config), vars);
  const headers = {
    accept: 'application/json',
    'x-signature': config.signature,
    'content-type': 'application/json',
    ...resolveTemplates(customHeaders || {}, vars),
  };

  logs.push({ step: 'am.token.request', headers, payload });
  const response = await requestJson({
    method: 'POST',
    url: `${baseUrl}/v1/service/am/token`,
    headers,
    body: payload,
  });
  logs.push({ step: 'am.token.response', status: response.status, body: response.body });
  if (response.status !== 200) {
    throw httpError(
      `AM token failed with HTTP ${response.status}.`,
      {
        step: 'am.token',
        status: response.status,
        response: response.body,
      },
      logs,
    );
  }

  const token = response.body?.data?.token || '';
  const sessionId = response.body?.data?.sessionId || '';
  if (!token) throw new Error('Cannot extract AM token from data.token.');
  if (!sessionId) throw new Error('Cannot extract AM sessionId from data.sessionId.');

  const cache = {
    baseUrl,
    account: config.account,
    code: config.code,
    routeKey: config.routeKey,
    userId: String(config.userId),
    token,
    sessionId,
    savedAt: Date.now() / 1000,
  };
  writeJsonFile(AM_CACHE, cache);
  return cache;
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
  const hasCustomAmTokenRequest = hasCustomJson(config, [
    ['amTokenHeadersJson', amTokenHeadersTemplate()],
    ['amTokenBodyJson', amTokenPayloadTemplate()],
  ]);
  const cacheStatus = hasCustomAmTokenRequest ? cacheMiss('') : getAmCache(config);
  let cache = cacheStatus.cache;
  if (!cache) {
    logs.push({
      step: 'token.cache',
      message: hasCustomAmTokenRequest
        ? 'Custom AM token headers/body provided. Refreshing token.'
        : cacheStatus.reason || 'No matching cached AM token. Refreshing.',
    });
    cache = await refreshAmToken(config, logs);
  } else {
    logs.push({
      step: 'token.cache',
      message: 'Using cached AM token.',
      sessionId: cache.sessionId,
    });
  }

  async function sendPatch() {
    const customHeaders = objectOrNull(
      parseOptionalJson(config.maintenanceHeadersJson, 'Maintenance headers JSON'),
      'Maintenance headers JSON',
    );
    const customBody = objectOrNull(
      parseOptionalJson(config.maintenanceBodyJson, 'Maintenance body JSON'),
      'Maintenance body JSON',
    );
    const vars = {
      AM_TOKEN: cache.token,
      IS_MAINTENANCE: config.isMaintenance,
    };
    const payload = resolveTemplates(customBody || { isMaintenance: config.isMaintenance }, vars);
    const headers = {
      accept: 'application/json',
      'x-access-token': cache.token,
      'content-type': 'application/json',
      ...resolveTemplates(customHeaders || {}, vars),
    };

    logs.push({ step: 'maintenance.patch.request', headers, payload });
    const response = await requestJson({
      method: 'PATCH',
      url: `${baseUrl}/v1/internal/game/${encodeURIComponent(config.gameCode)}/maintenance`,
      headers,
      body: payload,
    });
    logs.push({ step: 'maintenance.patch.response', status: response.status, body: response.body });
    return response;
  }

  let patch = await sendPatch();
  if (isInvalidToken(patch.status, patch.body)) {
    logs.push({
      step: 'token.refresh',
      message: 'Cached AM token is invalid. Refreshing and retrying patch.',
    });
    cache = await refreshAmToken(config, logs);
    patch = await sendPatch();
  }
  if (patch.status !== 200) {
    throw httpError(
      `Maintenance patch failed with HTTP ${patch.status}.`,
      {
        step: 'maintenance.patch',
        status: patch.status,
        response: patch.body,
      },
      logs,
    );
  }
  const result = patch.body;
  return {
    result,
    logs,
    resultFile: saveFlowResult('maintenance', config.gameCode, result, logs),
    requestedAt,
    respondedAt: displayTime(),
  };
}

function defaultConfig() {
  const rgs = readEnv(path.join(RGS_DIR, '.env'));
  const lobby = readEnv(path.join(LOBBY_DIR, '.env'));
  const maintenance = readEnv(path.join(MAINTENANCE_DIR, '.env'));
  const rgsConfig = {
    apiDomain: rgs.API_DOMAIN || 'localhost:19080',
    signature: rgs.API_SIGNATURE || 'rgs-local-signature',
    gameCode: rgs.GAME_CODE || 'LGS-006',
  };
  const lobbyConfig = {
    apiDomain: lobby.API_DOMAIN || rgs.API_DOMAIN || 'localhost:19080',
    signature: lobby.API_SIGNATURE || rgs.API_SIGNATURE || 'rgs-local-signature',
    gameCode: lobby.GAME_CODE || rgs.GAME_CODE || 'LGS-006',
  };
  const maintenanceConfig = {
    apiDomain: maintenance.MAINTENANCE_API_DOMAIN || 'localhost:8080',
    signature: maintenance.API_SIGNATURE || 'rgs-local-signature',
    userId: maintenance.AM_USER_ID || '0',
    account: maintenance.AM_ACCOUNT || 'kyle.c',
    code: maintenance.AM_CODE || 'SLT',
    routeKey: maintenance.AM_ROUTE_KEY || 'V1_INTERNAL_GAME_MAINTENANCE',
    gameCode: maintenance.MAINTENANCE_GAME_CODE || 'LGS-006',
    isMaintenance: maintenance.IS_MAINTENANCE === 'true',
  };
  return {
    rgs: {
      ...rgsConfig,
      sessionStartHeadersJson: prettyJson(sessionStartHeadersTemplate()),
      sessionStartBodyJson: prettyJson(sessionStartPayloadTemplate()),
      sessionActivateHeadersJson: prettyJson(sessionActivateHeadersTemplate()),
      sessionActivateBodyJson: prettyJson(sessionActivatePayloadTemplate()),
      betHeadersJson: prettyJson(playHeadersTemplate()),
      betBodyJson: prettyJson(betPayloadTemplate()),
      actionHeadersJson: prettyJson(playHeadersTemplate()),
      actionBodyJson: prettyJson(actionPayloadTemplate()),
      finishHeadersJson: prettyJson(playHeadersTemplate()),
      finishBodyJson: prettyJson(finishPayloadTemplate()),
    },
    lobby: {
      ...lobbyConfig,
      sessionStartHeadersJson: prettyJson(sessionStartHeadersTemplate()),
      sessionStartBodyJson: prettyJson(sessionStartPayloadTemplate()),
      sessionActivateHeadersJson: prettyJson(sessionActivateHeadersTemplate()),
      sessionActivateBodyJson: prettyJson(sessionActivatePayloadTemplate()),
      tokenActivateHeadersJson: prettyJson(lobbyTokenActivateHeadersTemplate()),
      tokenActivateBodyJson: 'null',
      tokenRefreshHeadersJson: prettyJson(lobbyTokenRefreshHeadersTemplate()),
      tokenRefreshBodyJson: prettyJson(lobbyTokenRefreshBodyTemplate()),
    },
    maintenance: {
      ...maintenanceConfig,
      amTokenHeadersJson: prettyJson(amTokenHeadersTemplate()),
      amTokenBodyJson: prettyJson(amTokenPayloadTemplate()),
      maintenanceHeadersJson: prettyJson(maintenanceHeadersTemplate()),
      maintenanceBodyJson: prettyJson(maintenanceBodyTemplate()),
    },
  };
}

async function handleApi(req, res, pathname) {
  try {
    if (req.method === 'GET' && pathname === '/api/config') {
      jsonResponse(res, 200, defaultConfig());
      return;
    }

    if (req.method === 'GET' && pathname === '/api/records') {
      const url = new URL(req.url, 'http://localhost');
      jsonResponse(res, 200, { records: listRecords(url.searchParams.get('flow') || 'bet') });
      return;
    }

    if (req.method === 'GET' && pathname === '/api/record') {
      const url = new URL(req.url, 'http://localhost');
      const flow = url.searchParams.get('flow') || 'bet';
      const config = recordConfig(flow);
      const file = path.basename(url.searchParams.get('file') || '');
      if (!config.pattern.test(file)) {
        jsonResponse(res, 400, { error: 'Invalid record file.' });
        return;
      }

      const resultPath = path.join(config.resultDir, file);
      if (!fs.existsSync(resultPath)) {
        jsonResponse(res, 404, { error: 'Record not found.' });
        return;
      }

      jsonResponse(res, 200, {
        result: readJsonFile(resultPath),
        logs: readJsonFile(path.join(config.traceDir, `${file}.trace.json`)) || [],
        resultFile: path.relative(ROOT, resultPath),
        requestedAt: displayTimeFromDate(fs.statSync(resultPath).mtime),
      });
      return;
    }

    if (req.method === 'POST' && pathname === '/api/rgs-bet') {
      const body = await parseJsonBody(req);
      jsonResponse(res, 200, await runBetFlow(body));
      return;
    }

    if (req.method === 'POST' && pathname === '/api/rgs-lobby') {
      const body = await parseJsonBody(req);
      jsonResponse(res, 200, await runLobbyFlow(body));
      return;
    }

    if (req.method === 'POST' && pathname === '/api/maintenance') {
      const body = await parseJsonBody(req);
      jsonResponse(res, 200, await runMaintenanceFlow(body));
      return;
    }

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
  const relativePath = pathname === '/' ? 'index.html' : pathname.slice(1);
  const filePath = path.resolve(PUBLIC_DIR, relativePath);
  if (!filePath.startsWith(PUBLIC_DIR)) {
    res.writeHead(403);
    res.end('Forbidden');
    return;
  }
  if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
    res.writeHead(404);
    res.end('Not found');
    return;
  }
  const ext = path.extname(filePath);
  res.writeHead(200, {
    'content-type': MIME_TYPES[ext] || 'application/octet-stream',
    'cache-control': 'no-store',
  });
  fs.createReadStream(filePath).pipe(res);
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');
  if (url.pathname.startsWith('/api/')) {
    handleApi(req, res, url.pathname);
    return;
  }
  serveStatic(req, res, url.pathname);
});

// Only listen on a port if run directly, keeping tests clean
if (require.main === module) {
  const port = Number(process.env.PORT || 3000);
  server.listen(port, '127.0.0.1', () => {
    console.log(`API test web is running at http://localhost:${port}`);
  });
}

module.exports = server;
