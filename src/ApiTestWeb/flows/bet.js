// RGS Bet Flow — start → activate → bet → action → finish.
// Self-contained: only depends on shared fragments, never on other flows.
const {
  SESSION_START_HEADERS, SESSION_START_BODY, JSON_HEADERS, SESSION_ACTIVATE_BODY, PLAY_HEADERS,
  EXTRACT_SESSION_TOKEN, EXTRACT_ACCESS_TOKEN, EXTRACT_SESSION_ID, RTP_VARS,
} = require('./_shared');

module.exports = {
  key: 'bet',
  order: 1,
  label: 'RGS Bet Flow',
  icon: '🎰',
  executeIcon: '🚀',
  defaultDomain: 'localhost:19080',
  domainField: null,
  fields: [],
  vars: RTP_VARS,
  steps: [
    {
      key: 'start', label: '1. Session Start', method: 'POST', path: '/v2/service/session/start',
      logName: 'session.start', failLabel: 'Start', maintenanceCheck: true,
      baseHeaders: SESSION_START_HEADERS, headersKey: 'sessionStartHeadersJson', bodyKey: 'sessionStartBodyJson',
      defaultHeaders: SESSION_START_HEADERS, defaultBody: SESSION_START_BODY,
      extract: { SESSION_TOKEN: EXTRACT_SESSION_TOKEN, SESSION_ID: EXTRACT_SESSION_ID },
    },
    {
      key: 'activate', label: '2. Session Activate', method: 'POST', path: '/v2/exp/session/activate',
      logName: 'session.activate', failLabel: 'Activate', maintenanceCheck: true,
      baseHeaders: JSON_HEADERS, headersKey: 'sessionActivateHeadersJson', bodyKey: 'sessionActivateBodyJson',
      defaultHeaders: JSON_HEADERS, defaultBody: SESSION_ACTIVATE_BODY,
      extract: { ACCESS_TOKEN: EXTRACT_ACCESS_TOKEN, 'SESSION_ID?': EXTRACT_SESSION_ID },
    },
    {
      key: 'bet', label: '3. Play Bet', method: 'POST', path: '/v2/exp/play/bet',
      logName: 'play.bet', failLabel: 'Bet', maintenanceCheck: true,
      baseHeaders: JSON_HEADERS, headersKey: 'betHeadersJson', bodyKey: 'betBodyJson',
      defaultHeaders: PLAY_HEADERS,
      defaultBody: {
        session: '$SESSION_ID',
        bet: { type: 'regular', value: '2' },
        stakeMode: { type: 'commonGame', multiplier: 1, name: 'regular bet', rtp: 96.56 },
        ts: 177445520478,
      },
      extract: { ROUND_ID: 'data.roundId', ACTION: 'data.action ?? data.actions[0].action ?? data.actions[0]' },
    },
    {
      key: 'action', label: '4. Play Action', method: 'POST', path: '/v2/exp/play/action',
      logName: 'play.action', failLabel: 'Action', runIf: (s) => s.ACTION !== undefined,
      baseHeaders: JSON_HEADERS, headersKey: 'actionHeadersJson', bodyKey: 'actionBodyJson',
      defaultHeaders: PLAY_HEADERS,
      defaultBody: { session: '$SESSION_ID', roundId: '$ROUND_ID', action: '$ACTION', ts: '$NOW_MS' },
    },
    {
      key: 'finish', label: '5. Play Finish', method: 'POST', path: '/v2/exp/play/finish',
      logName: 'play.finish', failLabel: 'Finish',
      baseHeaders: JSON_HEADERS, headersKey: 'finishHeadersJson', bodyKey: 'finishBodyJson',
      defaultHeaders: PLAY_HEADERS,
      defaultBody: { session: '$SESSION_ID', roundId: '$ROUND_ID', ts: '$NOW_MS' },
    },
  ],
};
