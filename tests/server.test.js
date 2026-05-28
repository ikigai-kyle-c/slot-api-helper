import { afterAll, beforeAll, describe, expect, mock, test } from 'bun:test';
import fs from 'fs';
import path from 'path';
import request from 'supertest';

const srcDir = path.join(__dirname, '../src');
const rgsDir = path.join(srcDir, 'RGSBetFlow');
const lobbyDir = path.join(srcDir, 'RGSLobby');
const maintDir = path.join(srcDir, 'InternalMaintenanceApi');

beforeAll(() => {
  fs.mkdirSync(rgsDir, { recursive: true });
  fs.mkdirSync(lobbyDir, { recursive: true });
  fs.mkdirSync(maintDir, { recursive: true });
  const validJwt = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJleHAiOjMzMzMzMzMzMzN9.sig';
  fs.writeFileSync(
    path.join(rgsDir, '.token-cache.json'),
    JSON.stringify({
      baseUrl: 'http://localhost:19080',
      gameCode: 'LGS-006',
      sessionToken: 't1',
      accessToken: validJwt,
      sessionId: 's1',
      savedAt: 1000,
    }),
  );
  fs.writeFileSync(
    path.join(maintDir, '.am-token-cache.json'),
    JSON.stringify({
      baseUrl: 'http://localhost:8080',
      account: 'kyle.c',
      code: 'SLT',
      routeKey: 'V1_INTERNAL_GAME_MAINTENANCE',
      userId: '0',
      token: validJwt,
      sessionId: 's1',
      savedAt: 1000,
    }),
  );

  global.fetch = mock(async (url, opts) => {
    const u = url.toString();
    const bodyStr = opts?.body || '';
    let body = {};
    let status = 200;

    if (u.includes('FAIL')) throw new Error('Network Error');
    if (u.includes('/healthcheck')) return { ok: true, status: 200, text: async () => 'ok' };

    if (bodyStr.includes('INVALID_TOKEN'))
      return { ok: false, status: 401, text: async () => 'unauth' };
    if (bodyStr.includes('MAINT_START')) body = { error: { message: 'maintain' } };
    else if (u.includes('/session/start')) body = { data: { token: 't1', sessionId: 's1' } };
    else if (u.includes('/session/activate')) body = { data: { token: 't2', sessionId: 's1' } };
    else if (u.includes('/play/bet')) {
      if (bodyStr.includes('NO_ACTION')) body = { data: { roundId: 'r1' } };
      else if (bodyStr.includes('NO_COINS'))
        body = {
          data: {
            action: null,
            roundId: 'r1',
            results: { gameResponse: { step: { summary: { coins: 0 } } } },
          },
        };
      else
        body = {
          data: {
            action: 1,
            roundId: 'r1',
            results: { gameResponse: { step: { summary: { coins: 10 } } } },
          },
        };
    } else if (u.includes('/play/action'))
      body = {
        data: { roundId: 'r1', results: { gameResponse: { step: { summary: { coins: 10 } } } } },
      };
    else if (u.includes('/play/finish')) body = { data: { success: true } };
    else if (u.includes('/session-token/activate')) {
      if (opts.headers?.authorization?.includes('FAIL'))
        return { ok: false, status: 500, text: async () => 'err' };
      body = { data: { accessToken: 'lat1', refreshToken: 'lrt1' } };
    } else if (u.includes('/session-token/refresh'))
      body = { data: { accessToken: 'lat2', refreshToken: 'lrt2' } };
    else if (u.includes('/service/am/token')) {
      if (bodyStr.includes('AM_FAIL')) return { ok: false, status: 500, text: async () => 'err' };
      body = { data: { token: 'amt1', sessionId: 'ams1' } };
    } else if (u.includes('/maintenance')) {
      if (opts.headers?.['x-access-token'] === 'FAIL')
        return { ok: false, status: 401, text: async () => 'err' };
      body = { success: true };
    }

    return { ok: status === 200, status, text: async () => JSON.stringify(body) };
  });
});

const server = require('../src/ApiTestWeb/server.js');

describe('API Server & Flow Full Coverage Tests', () => {
  afterAll((done) => {
    if (server.close) server.close(done);
    else done();
  });

  test('Static Routes & Errors', async () => {
    expect((await request(server).get('/')).statusCode).toBe(200);
    expect((await request(server).get('/api/config')).statusCode).toBe(200);
    expect((await request(server).get('/api/records?flow=bet')).statusCode).toBe(200);
    expect((await request(server).get('/api/record?flow=bet&file=invalid.txt')).statusCode).toBe(
      400,
    );
  });

  test('POST /api/ping (Proxy Healthcheck)', async () => {
    const resSuccess = await request(server)
      .post('/api/ping')
      .send({ url: 'http://localhost:19080' });
    expect(resSuccess.statusCode).toBe(200);
    expect(resSuccess.body.ok).toBe(true);

    const resFail = await request(server).post('/api/ping').send({ url: 'http://FAIL' });
    expect(resFail.statusCode).toBe(200);
    expect(resFail.body.ok).toBe(false);
  });

  test('POST /api/run-server (Money Service)', async () => {
    // We use __dirname because it is a guaranteed valid path, preventing the posix_spawn crash
    const payload = { type: 'money', paths: { money: __dirname }, restartPolicy: 'ignore' };
    const res = await request(server).post('/api/run-server').send(payload);
    expect(res.statusCode).toBe(200);
  });

  test('POST /api/run-server (API Hub Service)', async () => {
    const payload = { type: 'apihub', paths: { apihub: __dirname }, restartPolicy: 'ignore' };
    const res = await request(server).post('/api/run-server').send(payload);
    expect(res.statusCode).toBe(200);
  });

  test('POST /api/rgs-bet - Normal Cache Hit', async () => {
    const payload = { apiDomain: 'localhost:19080', gameCode: 'LGS-006' };
    const res = await request(server).post('/api/rgs-bet').send(payload);
    expect(res.statusCode).toBe(200);
  });

  test('POST /api/rgs-bet - No Coins Branch', async () => {
    const payload = {
      apiDomain: 'localhost:19080',
      gameCode: 'LGS-006',
      betBodyJson: '{"NO_COINS": true}',
    };
    const res = await request(server).post('/api/rgs-bet').send(payload);
    expect(res.statusCode).toBe(200);
    expect(res.body.result.finish).toBeUndefined();
  });

  test('POST /api/rgs-bet - Cache Miss (Different GameCode)', async () => {
    const payload = { apiDomain: 'localhost:19080', gameCode: 'NEW-001' };
    const res = await request(server).post('/api/rgs-bet').send(payload);
    expect(res.statusCode).toBe(200);
  });

  test('POST /api/rgs-bet - Custom Overrides (Missing Action Branch)', async () => {
    const payload = {
      apiDomain: 'localhost:19080',
      gameCode: 'LGS-006',
      betBodyJson: '{"NO_ACTION": true}',
      betHeadersJson: '{}',
    };
    const res = await request(server).post('/api/rgs-bet').send(payload);
    expect(res.statusCode).toBe(200);
    expect(res.body.result.action).toBeUndefined();
  });

  test('POST /api/rgs-bet - Token Invalid Fallback', async () => {
    const payload = {
      apiDomain: 'localhost:19080',
      gameCode: 'LGS-006',
      betBodyJson: '{"INVALID_TOKEN": true}',
    };
    const res = await request(server).post('/api/rgs-bet').send(payload);
    expect(res.statusCode).toBe(500);
  });

  test('POST /api/rgs-lobby - Fast Execution', async () => {
    const originalSetTimeout = global.setTimeout;
    global.setTimeout = (cb) => originalSetTimeout(cb, 1);
    const payload = { apiDomain: 'localhost:19080', gameCode: 'LGS-006' };
    const res = await request(server).post('/api/rgs-lobby').send(payload);
    expect(res.statusCode).toBe(200);
    global.setTimeout = originalSetTimeout;
  });

  test('POST /api/rgs-lobby - Activation Failure', async () => {
    const payload = {
      apiDomain: 'localhost:19080',
      gameCode: 'LGS-006',
      tokenActivateHeadersJson: '{"authorization": "FAIL"}',
    };
    const res = await request(server).post('/api/rgs-lobby').send(payload);
    expect(res.statusCode).toBe(500);
  });

  test('POST /api/maintenance - Patch Request', async () => {
    const payload = { apiDomain: 'localhost:8080', gameCode: 'LGS-006', isMaintenance: true };
    const res = await request(server).post('/api/maintenance').send(payload);
    expect(res.statusCode).toBe(200);
  });

  test('POST /api/maintenance - Token Failure', async () => {
    const payload = {
      apiDomain: 'localhost:8080',
      gameCode: 'LGS-006',
      amTokenBodyJson: '{"AM_FAIL": true}',
    };
    const res = await request(server).post('/api/maintenance').send(payload);
    expect(res.statusCode).toBe(500);
  });

  test('POST /api/maintenance - Patch Retry on Invalid Token', async () => {
    const payload = {
      apiDomain: 'localhost:8080',
      gameCode: 'LGS-006',
      maintenanceHeadersJson: '{"x-access-token": "FAIL"}',
    };
    const res = await request(server).post('/api/maintenance').send(payload);
    expect(res.statusCode).toBe(500);
  });
});
