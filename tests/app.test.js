import { GlobalRegistrator } from '@happy-dom/global-registrator';
import { beforeAll, beforeEach, describe, expect, mock, test } from 'bun:test';
import fs from 'fs';
import path from 'path';

GlobalRegistrator.register();

// Extracted the base fetch mock so it can be reliably reset between tests
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
    // Crucial: Reset fetch to the successful base mock before every single test
    window.fetch = mock(baseFetchMock);

    const status = document.querySelector('#status');
    status.textContent = 'Idle';
    status.className = 'status badge idle';
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

    ta.value = '{invalid}';
    ta.dispatchEvent(new window.Event('blur', { bubbles: true }));
    expect(ta.value).toBe('{invalid}');
  });

  test('Bet form submission (Success & Warning)', async () => {
    const form = document.querySelector('#bet-form');
    form.querySelector('input[name="gameCode"]').value = 'LGS-006';
    form.dispatchEvent(new window.Event('submit', { cancelable: true }));
    await Bun.sleep(50);
    expect(document.querySelector('#status').textContent).toBe('Done');

    form.querySelector('input[name="gameCode"]').value = 'WARN';
    form.dispatchEvent(new window.Event('submit', { cancelable: true }));
    await Bun.sleep(50);
    expect(document.querySelector('#status').textContent).toContain('Maintenance');
  });

  test('Form submissions with Errors', async () => {
    const form = document.querySelector('#bet-form');
    form.querySelector('input[name="gameCode"]').value = 'ERROR';
    form.dispatchEvent(new window.Event('submit', { cancelable: true }));
    await Bun.sleep(50);
    expect(document.querySelector('#status').textContent).toBe('Error');

    form.querySelector('input[name="gameCode"]').value = 'MAINT';
    form.dispatchEvent(new window.Event('submit', { cancelable: true }));
    await Bun.sleep(50);
    expect(document.querySelector('#status').textContent).toBe('Maintenance Block');
  });

  test('Lobby form submission and interval countdown', async () => {
    // FIX: Execute asynchronously with an ultra-short 1ms timeout so intervalId initializes correctly
    const origInterval = window.setInterval;
    window.setInterval = (cb) => origInterval(cb, 1);

    const form = document.querySelector('#lobby-form');
    form.querySelector('input[name="gameCode"]').value = 'LGS-006';
    form.dispatchEvent(new window.Event('submit', { cancelable: true }));

    await Bun.sleep(60);
    expect(document.querySelector('#status').textContent).toBe('Done');
    window.setInterval = origInterval;
  });

  test('Lobby form with error', async () => {
    const form = document.querySelector('#lobby-form');
    form.querySelector('input[name="gameCode"]').value = 'ERROR';
    form.dispatchEvent(new window.Event('submit', { cancelable: true }));
    await Bun.sleep(50);
    expect(document.querySelector('#status').textContent).toBe('Error');
  });

  test('Maintenance form submission flow', async () => {
    const form = document.querySelector('#maintenance-form');
    form.querySelector('input[name="gameCode"]').value = 'LGS-006';
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

    // Dynamically override fetch to fail for the second click
    window.fetch = mock(async () => ({
      ok: false,
      status: 500,
      json: async () => ({ error: 'fetch error' }),
    }));

    btns[0].click();
    await Bun.sleep(50);
    expect(document.querySelector('#status').textContent).toBe('Error');
  });
});
