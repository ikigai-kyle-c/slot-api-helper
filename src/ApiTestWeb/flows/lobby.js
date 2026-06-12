// RGS Lobby Flow — start → activate → tokenActivate → tokenRefresh.
const {
  SESSION_START_HEADERS, SESSION_START_BODY, JSON_HEADERS, SESSION_ACTIVATE_BODY,
  EXTRACT_SESSION_TOKEN, EXTRACT_ACCESS_TOKEN, EXTRACT_SESSION_ID, RTP_VARS,
} = require('./_shared');

module.exports = {
  key: 'lobby',
  order: 2,
  label: 'RGS Lobby Flow',
  icon: '🏠',
  executeIcon: '🚀',
  defaultDomain: 'localhost:19080',
  domainField: null,
  fields: [],
  vars: RTP_VARS,
  steps: [
    {
      key: 'start', label: '1. Session Start', method: 'POST', path: '/v2/service/session/start',
      logName: 'session.start', failLabel: 'Start',
      baseHeaders: SESSION_START_HEADERS, headersKey: 'sessionStartHeadersJson', bodyKey: 'sessionStartBodyJson',
      defaultHeaders: SESSION_START_HEADERS, defaultBody: SESSION_START_BODY,
      extract: { SESSION_TOKEN: EXTRACT_SESSION_TOKEN, SESSION_ID: EXTRACT_SESSION_ID },
    },
    {
      key: 'activate', label: '2. Session Activate', method: 'POST', path: '/v2/exp/session/activate',
      logName: 'session.activate', failLabel: 'Activate',
      baseHeaders: JSON_HEADERS, headersKey: 'sessionActivateHeadersJson', bodyKey: 'sessionActivateBodyJson',
      defaultHeaders: JSON_HEADERS, defaultBody: SESSION_ACTIVATE_BODY,
      extract: { GAME_ACCESS_TOKEN: EXTRACT_ACCESS_TOKEN },
    },
    {
      key: 'tokenActivate', label: '3. Token Activate', method: 'POST', path: '/v1/exp/session-token/activate',
      logName: 'token.activate', failLabel: 'Token Activate', allowNullBody: true,
      baseHeaders: {}, headersKey: 'tokenActivateHeadersJson', bodyKey: 'tokenActivateBodyJson',
      defaultHeaders: { authorization: 'Bearer $GAME_ACCESS_TOKEN' }, defaultBody: null,
      extract: { LOBBY_ACCESS_TOKEN: 'data.accessToken', LOBBY_REFRESH_TOKEN: 'data.refreshToken' },
    },
    {
      key: 'tokenRefresh', label: '4. Token Refresh', method: 'POST', path: '/v1/exp/session-token/refresh',
      logName: 'token.refresh', failLabel: 'Token Refresh',
      baseHeaders: JSON_HEADERS, headersKey: 'tokenRefreshHeadersJson', bodyKey: 'tokenRefreshBodyJson',
      defaultHeaders: { authorization: 'Bearer $LOBBY_ACCESS_TOKEN' }, defaultBody: { refreshToken: '$LOBBY_REFRESH_TOKEN' },
      extract: { REFRESHED_ACCESS_TOKEN: 'data.accessToken' },
    },
  ],
};
