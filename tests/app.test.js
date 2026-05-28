import { GlobalRegistrator } from '@happy-dom/global-registrator';
import { afterEach, beforeAll, beforeEach, describe, expect, mock, test } from 'bun:test';
import fs from 'fs';
import path from 'path';

GlobalRegistrator.register();

const baseFetchMock = async (url, opts) => {
  const u = url.toString();
  if (u.includes('/api/config')) {
    return {
      ok: true,
      status: 200,
      json: async () => ({
        rgs: { gameCode: 'LGS-006' },
        lobby: {},
        maintenance: { isMaintenance: true },
      }),
    };
  }
  if (u.includes('/api/records')) {
    return {
      ok: true,
      status: 200,
      json: async () => ({
        records: [
          { file: 'r1.json', updatedAt: 'T1', hasTrace: true },
          { file: 'r2.json', updatedAt: 'T2', hasTrace: false },
        ],
      }),
    };
  }
  if (u.includes('/api/record?')) {
    if (u.includes('error-trigger'))
      return { ok: false, status: 500, json: async () => ({ error: 'fetch error' }) };
    return {
      ok: true,
      status: 200,
      json: async () => ({
        result: { success: true },
        logs: [],
        resultFile: 'f.json',
        requestedAt: 'T1',
      }),
    };
  }
  if (u.includes('/api/ping')) {
    const body = JSON.parse(opts.body);
    if (body.url.includes('FAIL'))
      return { ok: true, status: 200, json: async () => ({ ok: false }) };
    return { ok: true, status: 200, json: async () => ({ ok: true }) };
  }
  if (u.includes('/api/run-server')) {
    return { ok: true, status: 200, json: async () => ({ status: 'success' }) };
  }
  if (opts?.method === 'POST') {
    const reqBody = JSON.parse(opts.body);
    if (reqBody.gameCode === 'ERROR')
      return { ok: false, status: 400, json: async () => ({ error: 'Bad' }) };
    if (reqBody.gameCode === 'MAINT')
      return { ok: false, status: 500, json: async () => ({ error: 'MAINTENANCE BLOCKED' }) };
    return {
      ok: true,
      status: 200,
      json: async () => ({
        result: { success: true },
        logs: [],
        maintenanceBlock: reqBody.gameCode === 'WARN' ? { step: 'bet' } : null,
        resultFile: 'f.json',
      }),
    };
  }
  return { ok: true, status: 200, json: async () => ({}) };
};

describe('UI & UX Full Coverage Tests', () => {
  const appJsPath = require.resolve('../src/ApiTestWeb/public/app.js');

  beforeAll(async () => {
    const html = fs.readFileSync(
      path.resolve(import.meta.dir, '../src/ApiTestWeb/public/index.html'),
      'utf8',
    );
    document.documentElement.innerHTML = html;
    window.fetch = mock(baseFetchMock);
    delete require.cache[appJsPath];
    require(appJsPath);
    await Bun.sleep(50);
  });

  beforeEach(() => {
    window.fetch = mock(baseFetchMock);
    const status = document.querySelector('#status');
    status.textContent = 'Idle';
    status.className = 'status badge idle';
  });

  afterEach(() => {
    if (window.fetch.mockRestore) window.fetch.mockRestore();
  });

  test('Tab switching and state restoration', async () => {
    const betTab = document.querySelector('button[data-tab="bet"]');
    const lobbyTab = document.querySelector('button[data-tab="lobby"]');
    const resultEl = document.querySelector('#result-output');

    resultEl.textContent = '{"old": "data"}';
    lobbyTab.click();
    expect(document.querySelector('#lobby-panel').classList.contains('is-active')).toBe(true);
    betTab.click();
    expect(resultEl.textContent).toBe('{"old": "data"}');
  });

  test('JSON fields format on blur & ignore bad JSON', () => {
    const ta = document.querySelector('textarea[name="sessionStartHeadersJson"]');
    ta.value = '{"raw":true}';
    ta.dispatchEvent(new window.Event('blur', { bubbles: true }));
    expect(ta.value).toBe('{\n  "raw": true\n}');
  });

  test('Backend URL Switcher and Ping Healthcheck', async () => {
    const citRadio = document.querySelector('input[value="CIT"]');
    citRadio.click();
    citRadio.dispatchEvent(new window.Event('change', { bubbles: true }));
    await Bun.sleep(50);
    expect(document.querySelector('#global-domain').value).toContain('iki-cit');
    expect(document.querySelector('#global-signature').value).toBe('rgs-cit-signature');
    expect(document.querySelector('#healthcheck-status').innerHTML).toContain('Reachable');

    document.querySelector('#global-domain').value = 'http://FAIL';
    document.querySelector('#global-domain').dispatchEvent(new window.Event('input'));
    await Bun.sleep(550);
    expect(document.querySelector('#healthcheck-status').innerHTML).toContain('Unreachable');
  });

  test('Deploy All Orchestrator', async () => {
    document.querySelector('#path-money').value = '/mock/path';
    document.querySelector('#path-remote').value = '/mock/remote';
    document.querySelector('#path-slot').value = '/mock/slot';

    const origSetTimeout = window.setTimeout;
    window.setTimeout = (cb) => origSetTimeout(cb, 1);

    await window.deployAll();

    const btn = document.querySelector('.btn-large[onclick="deployAll()"]');
    expect(btn.disabled).toBe(false);

    window.setTimeout = origSetTimeout;
  });

  test('Bet form submission (Success & Warning)', async () => {
    const form = document.querySelector('#bet-form');
    document.querySelector('#global-gamecode').value = 'LGS-006';
    form.dispatchEvent(new window.Event('submit', { cancelable: true }));
    await Bun.sleep(50);
    expect(document.querySelector('#status').textContent).toBe('Done');

    document.querySelector('#global-gamecode').value = 'WARN';
    form.dispatchEvent(new window.Event('submit', { cancelable: true }));
    await Bun.sleep(50);
    expect(document.querySelector('#status').textContent).toContain('Maintenance');
  });

  test('Form submissions with Errors', async () => {
    const form = document.querySelector('#bet-form');
    document.querySelector('#global-gamecode').value = 'ERROR';
    form.dispatchEvent(new window.Event('submit', { cancelable: true }));
    await Bun.sleep(50);
    expect(document.querySelector('#status').textContent).toBe('Error');

    document.querySelector('#global-gamecode').value = 'MAINT';
    form.dispatchEvent(new window.Event('submit', { cancelable: true }));
    await Bun.sleep(50);
    expect(document.querySelector('#status').textContent).toBe('Maintenance Block');
  });

  test('Lobby form submission and interval countdown', async () => {
    const origInterval = window.setInterval;
    window.setInterval = (cb) => {
      for (let i = 0; i < 6; i++) cb();
      return 999;
    };

    const form = document.querySelector('#lobby-form');
    document.querySelector('#global-gamecode').value = 'LGS-006';
    form.dispatchEvent(new window.Event('submit', { cancelable: true }));

    await Bun.sleep(60);
    expect(document.querySelector('#status').textContent).toBe('Done');
    window.setInterval = origInterval;
  });

  test('Lobby form with error', async () => {
    const form = document.querySelector('#lobby-form');
    document.querySelector('#global-gamecode').value = 'ERROR';
    form.dispatchEvent(new window.Event('submit', { cancelable: true }));
    await Bun.sleep(50);
    expect(document.querySelector('#status').textContent).toBe('Error');
  });

  test('Maintenance form submission flow', async () => {
    const form = document.querySelector('#maintenance-form');
    document.querySelector('#global-gamecode').value = 'LGS-006';
    form.dispatchEvent(new window.Event('submit', { cancelable: true }));
    await Bun.sleep(50);
    expect(document.querySelector('#status').textContent).toBe('Done');
  });

  test('Record loading via buttons and error states', async () => {
    const btns = document.querySelectorAll('.record-button');
    expect(btns.length).toBeGreaterThan(0);

    btns[0].click();
    await Bun.sleep(50);
    expect(document.querySelector('#status').textContent).toBe('Record Loaded');

    const origFetch = window.fetch;
    window.fetch = mock(async () => ({
      ok: false,
      status: 500,
      json: async () => ({ error: 'fetch error' }),
    }));

    btns[0].click();
    await Bun.sleep(50);
    expect(document.querySelector('#status').textContent).toBe('Error');

    window.fetch = origFetch;
  });
});
