// =============================================================
// Shared flow building blocks + the declarative extraction engine.
// Flow files may import these fragments. Flows must NEVER import
// each other — keep them decoupled. Common pieces live here.
// =============================================================

// ---- reusable request template fragments ----
const SESSION_START_HEADERS = { 'x-signature': '$SIGNATURE', 'content-type': 'application/json' };
const SESSION_START_BODY = {
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
};
const JSON_HEADERS = { 'content-type': 'application/json' };
const SESSION_ACTIVATE_BODY = {
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
const PLAY_HEADERS = {
  'cloudfront-viewer-country': 'JP',
  'cloudfront-viewer-address': '1.2.3.4',
  'x-access-token': '$ACCESS_TOKEN',
  authorization: 'Bearer $ACCESS_TOKEN',
};

// ---- reusable extraction expressions ----
const EXTRACT_SESSION_TOKEN = 'token || sessionToken || data.token || data.sessionToken || launch:data.launchUrl';
const EXTRACT_ACCESS_TOKEN = 'token || accessToken || data.token || data.accessToken';
const EXTRACT_SESSION_ID = 'sessionId || session || data.sessionId || data.session';

// vars helper shared by game flows
const RTP_VARS = (c) => ({ RTP_CONFIG_CODE: c.gameCode === 'LGS-001' ? 'highRTP' : 'RTP_97' });

// ---- declarative extraction resolver ----
function getByPath(obj, p) {
  if (obj == null || typeof p !== 'string') return undefined;
  const parts = p.replace(/\[(\d+)\]/g, '.$1').split('.').filter(Boolean);
  let cur = obj;
  for (const k of parts) {
    if (cur == null) return undefined;
    cur = cur[k];
  }
  return cur;
}

function launchToken(url) {
  if (!url) return '';
  try {
    return new URL(url).searchParams.get('token') || '';
  } catch {
    const m = String(url).match(/[?&]token=([^&]+)/);
    return m ? decodeURIComponent(m[1]) : '';
  }
}

function resolveExtract(body, expr) {
  const nullish = expr.includes('??');
  const cands = expr.split(nullish ? '??' : '||').map((s) => s.trim()).filter(Boolean);
  for (const c of cands) {
    const v = c.startsWith('launch:') ? launchToken(getByPath(body, c.slice(7))) : getByPath(body, c);
    if (nullish ? v !== undefined && v !== null : v) return v;
  }
  return undefined;
}

function applyExtract(extractDef, body, state) {
  if (!extractDef) return;
  for (const [rawKey, expr] of Object.entries(extractDef)) {
    const fillOnly = rawKey.endsWith('?');
    const key = fillOnly ? rawKey.slice(0, -1) : rawKey;
    if (fillOnly && state[key]) continue;
    const v = resolveExtract(body, expr);
    if (v !== undefined) state[key] = v;
  }
}

module.exports = {
  SESSION_START_HEADERS,
  SESSION_START_BODY,
  JSON_HEADERS,
  SESSION_ACTIVATE_BODY,
  PLAY_HEADERS,
  EXTRACT_SESSION_TOKEN,
  EXTRACT_ACCESS_TOKEN,
  EXTRACT_SESSION_ID,
  RTP_VARS,
  getByPath,
  launchToken,
  resolveExtract,
  applyExtract,
};
