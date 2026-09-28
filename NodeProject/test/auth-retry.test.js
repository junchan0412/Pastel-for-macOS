import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {retryableAuthenticationStatus, isRetryableAuthResponse, parseLoginResponse} from '../src/gsa.js';
import {t} from '../src/i18n.js';

const gsa = readFileSync(new URL('../src/gsa.js', import.meta.url), 'utf8');
const i18n = readFileSync(new URL('../src/i18n.js', import.meta.url), 'utf8');

const plistResponse = (status, body, headers = 'HTTP/2 ' + status + '\r\n') => ({status, headers, body: Buffer.from(body)});

test('瞬时响应判定与 ipatool 的 retryableAuthenticationError 一致', () => {
    // ipatool：204 / 404 / 429 / 5xx 才重试
    for (const status of [204, 404, 429, 500, 502, 503, 0]) {
        assert.equal(retryableAuthenticationStatus(status), true, `HTTP ${status} 应重试`);
    }
    for (const status of [200, 201, 400, 401, 403, 302]) {
        assert.equal(retryableAuthenticationStatus(status), false, `HTTP ${status} 不应按瞬时故障重试`);
    }
});

test('只有缺少 Location 的 302/301 才算异常响应', () => {
    assert.equal(isRetryableAuthResponse({status: 302, headers: ''}), true);
    assert.equal(isRetryableAuthResponse({status: 302, headers: 'HTTP/2 302\r\nlocation: https://p25-buy.itunes.apple.com/x\r\n'}), false);
    assert.equal(isRetryableAuthResponse({status: 301, headers: ''}), true);
    assert.equal(isRetryableAuthResponse({status: 204, headers: ''}), true);
    assert.equal(isRetryableAuthResponse({status: 200, headers: ''}), false);
});

test('正常 pod 跳转仍按 redirect 处理', () => {
    const parsed = parseLoginResponse(
        plistResponse(302, '', 'HTTP/2 302\r\nlocation: https://p25-buy.itunes.apple.com/WebObjects/MZFinance.woa/wa/x\r\n'),
        1, '');
    assert.equal(parsed.error, null);
    assert.equal(parsed.retry, true);
    assert.match(parsed.redirect, /^https:\/\//);
});

test('空响应/非 plist 响应提示切换网络或走代理，而不是含糊的令牌换取失败', () => {
    const html = parseLoginResponse(plistResponse(302, '<html><body>302 Found</body></html>', 'HTTP/2 302\r\n'), 1, '');
    assert.ok(html.error);
    assert.match(html.error.message, /HTTP 302/);
    assert.match(html.error.message, /网络|代理/);
    assert.notEqual(html.error.message, t('store_token_failed'));

    const empty204 = parseLoginResponse(plistResponse(204, ''), 1, '');
    assert.ok(empty204.error);
    assert.match(empty204.error.message, /HTTP 204/);

    const noToken = parseLoginResponse(plistResponse(200, '<plist version="1.0"><dict></dict></plist>'), 1, '');
    assert.ok(noToken.error);
    assert.match(noToken.error.message, /HTTP 200/);
});

test('凭据与 2FA 分支保持原语义', () => {
    const bad = parseLoginResponse(plistResponse(200,
        '<plist version="1.0"><dict><key>failureType</key><string>-5000</string></dict></plist>'), 1, '');
    assert.equal(bad.retry, true, 'attempt=1 且 -5000 才重试');

    const ambiguous = parseLoginResponse(plistResponse(200,
        '<plist version="1.0"><dict><key>customerMessage</key><string>MZFinance.BadLogin.Configurator_message</string></dict></plist>'), 1, '');
    assert.equal(ambiguous.error?.code, 'AUTH_OR_2FA');
});

test('登录重试节奏对齐 ipatool：最多 3 次、10s 起步、上限 30s', () => {
    assert.match(gsa, /AUTH_RETRY_MAX_ATTEMPTS = 3/);
    assert.match(gsa, /AUTH_RETRY_BASE_DELAY_MS = 10_000/);
    assert.match(gsa, /AUTH_RETRY_MAX_DELAY_MS = 30_000/);
    assert.match(gsa, /parseRetryAfter\(/);
    assert.match(gsa, /postAuthenticationWithRetry\(/);
});

test('七种语言都有重试与网络提示文案', () => {
    assert.equal((i18n.match(/auth_no_usable_response:/g) || []).length, 7);
    assert.equal((i18n.match(/auth_retrying:/g) || []).length, 7);
    const zh = t('auth_no_usable_response', {status: 204});
    assert.match(zh, /HTTP 204/);
    assert.match(zh, /代理/);
    const retry = t('auth_retrying', {status: 204, attempt: 1, seconds: 10});
    assert.match(retry, /HTTP 204/);
    assert.match(retry, /10/);
});

test('重试循环按 ipatool 节奏退避，并优先遵循 Retry-After', async () => {
    const {postAuthenticationWithRetry} = await import('../src/gsa.js');
    const sleeps = [];
    const logs = [];

    // 1) 两次 204 后拿到正常响应
    const statuses = [204, 204, 200];
    let index = 0;
    const ok = postAuthenticationWithRetry('https://example.invalid/auth', 'body', null, {
        send: () => plistResponse(statuses[index++] ?? 200, '<plist version="1.0"></plist>'),
        sleep: (ms) => sleeps.push(ms),
        log: (msg) => logs.push(msg),
    });
    assert.equal(ok.status, 200);
    assert.deepEqual(sleeps, [10_000, 20_000], '10s → 20s 退避');
    assert.equal(logs.length, 2);
    assert.match(logs[0], /HTTP 204/);

    // 2) Retry-After 优先于退避
    const sleeps2 = [];
    postAuthenticationWithRetry('https://example.invalid/auth', 'body', null, {
        send: () => ({status: 429, headers: 'HTTP/2 429\r\nretry-after: 1\r\n', body: Buffer.alloc(0)}),
        sleep: (ms) => sleeps2.push(ms),
        log: () => {},
    });
    // 两次响应都带 retry-after:1，说明 Retry-After 每次都优先于指数退避
    assert.deepEqual(sleeps2, [1_000, 1_000], 'Retry-After:1 优先于退避');

    // 3) 用尽 3 次后把最后一次响应交回上层，不再无限等待
    let calls = 0;
    const sleeps3 = [];
    const exhausted = postAuthenticationWithRetry('https://example.invalid/auth', 'body', null, {
        send: () => (calls += 1, {status: 204, headers: '', body: Buffer.alloc(0)}),
        sleep: (ms) => sleeps3.push(ms),
        log: () => {},
    });
    assert.equal(calls, 3);
    assert.equal(exhausted.status, 204);
    assert.equal(sleeps3.length, 2);

    // 4) 正常 pod 跳转立即返回，不消耗重试
    let calls4 = 0;
    const result = postAuthenticationWithRetry('https://example.invalid/auth', 'body', null, {
        send: () => (calls4 += 1, {status: 302, headers: 'location: https://p25-buy.itunes.apple.com/x', body: Buffer.alloc(0)}),
        sleep: () => { throw new Error('不应重试'); },
        log: () => {},
    });
    assert.equal(calls4, 1);
    assert.equal(result.status, 302);
});
