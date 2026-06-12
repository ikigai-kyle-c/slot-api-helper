// Maintenance Flow — amToken → patch. AM service lives on a different host
// than the game RGS, so domainField selects the per-env AM url.
const { JSON_HEADERS } = require('./_shared');

module.exports = {
  key: 'maintenance',
  order: 3,
  label: 'Maintenance',
  icon: '🛡️',
  executeIcon: '🛡️',
  defaultDomain: 'localhost:8080',
  domainField: 'amUrl',
  fields: [
    { name: 'userId', label: 'User ID', type: 'text', default: 0, env: 'AM_USER_ID' },
    { name: 'account', label: 'Account', type: 'text', default: 'kyle.c', env: 'AM_ACCOUNT' },
    { name: 'code', label: 'Code', type: 'text', default: '*', env: 'AM_CODE' },
    { name: 'routeKey', label: 'Route key', type: 'text', default: '*', env: 'AM_ROUTE_KEY' },
    { name: 'isMaintenance', label: 'Is Maintenance?', type: 'checkbox', default: false },
  ],
  vars: (c) => ({
    IS_MAINTENANCE: c.isMaintenance,
    USER_ID: Number(c.userId),
    ACCOUNT: c.account,
    CODE: c.code,
    ROUTE_KEY: c.routeKey,
  }),
  steps: [
    {
      key: 'amToken', label: '1. AM Token Request', method: 'POST', path: '/v1/service/am/token',
      logName: 'am.token', failLabel: 'AM token',
      baseHeaders: JSON_HEADERS, headersKey: 'amTokenHeadersJson', bodyKey: 'amTokenBodyJson',
      defaultHeaders: { accept: 'application/json', 'x-signature': '$SIGNATURE' },
      defaultBody: {
        userId: '$USER_ID', account: '$ACCOUNT', code: '$CODE',
        permission: [{ routeKey: '$ROUTE_KEY', methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', '*'] }],
      },
      extract: { AM_TOKEN: 'data.token' },
    },
    {
      key: 'patch', label: '2. Maintenance Patch', method: 'PATCH',
      path: (c) => `/v1/internal/game/${encodeURIComponent(c.gameCode)}/maintenance`,
      logName: 'maintenance.patch', failLabel: 'Maintenance patch',
      baseHeaders: JSON_HEADERS, headersKey: 'maintenanceHeadersJson', bodyKey: 'maintenanceBodyJson',
      defaultHeaders: { accept: 'application/json', 'x-access-token': '$AM_TOKEN' },
      defaultBody: { isMaintenance: '$IS_MAINTENANCE' },
    },
  ],
};
