#!/usr/bin/env node
const http = require('http');
const fs = require('fs');
const path = require('path');
const { URL } = require('url');
const { FLOWS, FLOW_MAP, applyExtract } = require('./flows');

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
function nowMs() {
  return Date.now();
}

// -------------------------------------------------------------
// GENERIC FLOW ENGINE — runs any flow defined in flows.js
// -------------------------------------------------------------
async function runFlow(flowKey, input) {
  const flow = FLOW_MAP[flowKey];
  if (!flow) throw httpError(`Unknown flow: ${flowKey}`, { status: 404 });

  const requestedAt = displayTime();
  const config = {
    apiDomain: resolveDomain(input.apiDomain, flow.defaultDomain),
    signature: input.signature || 'rgs-local-signature',
    gameCode: input.gameCode || 'LGS-006',
  };
  for (const f of flow.fields || []) {
    const raw = input[f.name];
    if (f.type === 'checkbox') config[f.name] = Boolean(raw);
    else config[f.name] = raw === undefined || raw === null || raw === '' ? f.default : raw;
  }
  for (const step of flow.steps) {
    config[step.headersKey] = input[step.headersKey] || '';
    config[step.bodyKey] = input[step.bodyKey] || '';
  }

  const baseUrl = normalizeBaseUrl(config.apiDomain);
  const logs = [];
  const result = {};
  const state = typeof input.state === 'object' && input.state ? input.state : {};
  const steps = Array.isArray(input.steps) ? input.steps : flow.steps.map((s) => s.key);

  const vars = () => ({
    ...state,
    GAME_CODE: config.gameCode,
    SIGNATURE: config.signature,
    NOW_MS: nowMs(),
    ...(flow.vars ? flow.vars(config) : {}),
  });

  for (const step of flow.steps) {
    if (!steps.includes(step.key)) continue;
    if (step.runIf && !step.runIf(state)) continue;

    const v = vars();
    const headers = {
      ...resolveTemplates(step.baseHeaders || {}, v),
      ...resolveTemplates(optionalObjectJson(config, step.headersKey, `${step.label} Headers`) || {}, v),
    };
    const parsedBody = optionalObjectJson(config, step.bodyKey, `${step.label} Body`);
    const payload = resolveTemplates(step.allowNullBody ? parsedBody : parsedBody || {}, v);
    const url = `${baseUrl}${typeof step.path === 'function' ? step.path(config) : step.path}`;

    logs.push({ step: `${step.logName}.request`, headers, payload });
    const res = await requestJson({ method: step.method, url, headers, body: payload == null ? undefined : payload });
    logs.push({ step: `${step.logName}.response`, status: res.status, body: res.body });

    if (step.maintenanceCheck) {
      const block = detectMaintenanceBlock(step.logName, res.status, res.body);
      if (block) throw httpError('MAINTENANCE BLOCKED', block, logs, state);
    }
    if (res.status !== 200)
      throw httpError(`${step.failLabel} failed`, { status: res.status, response: res.body }, logs, state);

    applyExtract(step.extract, res.body, state);
    result[step.key] = res.body;
    processStateExtraction(input.stateExtractMapping, result, state, res.body);
  }

  processStateExtraction(input.stateExtractMapping, result, state);
  return { result, state, logs, requestedAt, respondedAt: displayTime() };
}

// Sanitized flow definitions for the frontend (no functions). Drives all
// dynamic UI: tabs, forms, default header/body JSON, Flow Cache, extraction.
function flowsManifest() {
  const envByFlow = { maintenance: readEnv(path.join(MAINTENANCE_DIR, '.env')) };
  return FLOWS.map((flow) => {
    const env = envByFlow[flow.key] || {};
    return {
      key: flow.key,
      label: flow.label,
      icon: flow.icon,
      executeIcon: flow.executeIcon,
      defaultDomain: flow.defaultDomain,
      domainField: flow.domainField || null,
      fields: (flow.fields || []).map((f) => ({
        name: f.name,
        label: f.label,
        type: f.type || 'text',
        default: f.env && env[f.env] !== undefined ? env[f.env] : f.default,
      })),
      steps: flow.steps.map((s) => ({
        key: s.key,
        label: s.label,
        headersKey: s.headersKey,
        bodyKey: s.bodyKey,
        defaultHeadersJson: JSON.stringify(s.defaultHeaders || {}, null, 2),
        defaultBodyJson: s.defaultBody === undefined ? '' : JSON.stringify(s.defaultBody, null, 2),
      })),
    };
  });
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

    if (req.method === 'GET' && pathname === '/api/flows')
      return jsonResponse(res, 200, flowsManifest());

    if (req.method === 'POST' && pathname.startsWith('/api/flow/')) {
      const key = decodeURIComponent(pathname.slice('/api/flow/'.length));
      return jsonResponse(res, 200, await runFlow(key, await parseJsonBody(req)));
    }

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
