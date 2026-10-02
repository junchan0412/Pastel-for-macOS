import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {Ipa} from '../src/ipa.js';
import {Store} from '../src/client.js';

const ipa = readFileSync(new URL('../src/ipa.js', import.meta.url), 'utf8');
const main = readFileSync(new URL('../main.js', import.meta.url), 'utf8');

const appId = '123456789';
const versionId = '987654321';
const appInfo = {songList: [{URL: 'https://example.invalid/app.ipa', metadata: {softwareVersionExternalIdentifier: versionId}}]};
const purchaseResponse = {jingleDocType: 'purchaseSuccess', status: 0, _state: 'success', _existing: false};
const failure = (code, message = code) => Object.assign(new Error(message), {code});

function purchaseFixture(t, responses, {free = true, purchaseError} = {}) {
    const client = new Ipa({APPLE_ID: 'purchase-test@example.invalid', PASSWORD: ''});
    client.user = {accountInfo: {appleId: 'purchase-test@example.invalid'}};
    const output = [];
    const delays = [];
    let index = 0;
    const info = t.mock.method(Store, 'AppInfo', async () => {
        assert.ok(index < responses.length, 'unexpected AppInfo request');
        const response = responses[index++];
        if (response instanceof Error) throw response;
        return response;
    });
    const purchase = t.mock.method(Store, 'purchase', async () => {
        if (purchaseError) throw purchaseError;
        return purchaseResponse;
    });
    const price = t.mock.method(client, 'isFreeApp', async () => free);
    t.mock.method(client, 'persistCurrentSession', async () => {});
    t.mock.method(console, 'log', () => {});
    t.mock.method(process.stdout, 'write', value => { output.push(JSON.parse(value)); return true; });
    t.mock.method(globalThis, 'setTimeout', (callback, delay) => { delays.push(delay); callback(); });
    return {client, info, purchase, price, output, delays};
}

for (const missingCode of ['LICENSE_NOT_FOUND', 'APPINFO_EMPTY']) {
    test(`缺许可 ${missingCode} 时首购保留指定版本，按原版本重试验证`, async t => {
        const {client, info, purchase, output, delays} = purchaseFixture(t, [
            failure(missingCode), failure('LICENSE_NOT_FOUND'), appInfo,
        ]);
        assert.equal(await client.purchaseOnly(appId, versionId), appInfo);
        assert.deepEqual(info.mock.calls.map(call => call.arguments), [
            [appId, '', client.auth, {listVersions: true}],
            [appId, versionId, client.auth],
            [appId, versionId, client.auth],
        ]);
        assert.deepEqual(purchase.mock.calls.map(call => call.arguments), [[appId, versionId, client.auth]]);
        assert.deepEqual(delays, [350, 800]);
        assert.deepEqual(output, [{ok: true, state: 'new', appId, versionId, verified: true}]);
    });
}

test('未指定版本时传空版本 ID，购买后不探测历史版本', async t => {
    const {client, info, purchase, output, delays} = purchaseFixture(t, [failure('LICENSE_NOT_FOUND')]);
    assert.equal(await client.purchaseOnly(appId), purchaseResponse);
    assert.deepEqual(purchase.mock.calls.map(call => call.arguments), [[appId, '', client.auth]]);
    assert.equal(info.mock.callCount(), 1);
    assert.deepEqual(delays, []);
    assert.deepEqual(output, [{ok: true, state: 'new', appId, versionId: '', verified: true}]);
});

for (const selectedVersion of ['', versionId]) {
    test(`已拥有${selectedVersion ? '指定版本' : '应用'}时不重复购买`, async t => {
        const {client, purchase, price, output} = purchaseFixture(t, [appInfo, appInfo]);
        assert.equal(await client.purchaseOnly(appId, selectedVersion), appInfo);
        assert.equal(purchase.mock.callCount(), 0);
        assert.equal(price.mock.callCount(), 0);
        assert.deepEqual(output, [{ok: true, state: 'existing', appId, versionId: selectedVersion, verified: true}]);
    });
}

for (const code of ['LICENSE_NOT_FOUND', 'APPINFO_EMPTY', 'APPINFO_FAIL']) {
    test(`已有许可但指定版本返回 ${code} 时报告不可用，不重复购买`, async t => {
        const {client, purchase, price, output, delays} = purchaseFixture(t, [appInfo, failure(code)]);
        assert.equal(await client.purchaseOnly(appId, versionId), appInfo);
        assert.equal(purchase.mock.callCount(), 0);
        assert.equal(price.mock.callCount(), 0);
        assert.deepEqual(delays, []);
        assert.deepEqual(output, [{ok: true, state: 'existing', appId, versionId, verified: false}]);
    });
}

for (const label of ['付费', '价格未知']) {
    test(`${label}应用未确认免费时不购买`, async t => {
        const {client, purchase, price, output} = purchaseFixture(t, [failure('LICENSE_NOT_FOUND')], {free: false});
        await assert.rejects(client.purchaseOnly(appId, versionId));
        assert.deepEqual(price.mock.calls.map(call => call.arguments), [[appId]]);
        assert.equal(purchase.mock.callCount(), 0);
        assert.deepEqual(output, []);
    });
}

test('购买失败时原样上抛，不回退购买最新版本', async t => {
    const error = failure('LICENSE_FAIL');
    const {client, purchase, info, output, delays} = purchaseFixture(t, [failure('LICENSE_NOT_FOUND')], {purchaseError: error});
    await assert.rejects(client.purchaseOnly(appId, versionId), actual => actual === error);
    assert.deepEqual(purchase.mock.calls.map(call => call.arguments), [[appId, versionId, client.auth]]);
    assert.equal(info.mock.callCount(), 1);
    assert.deepEqual(delays, []);
    assert.deepEqual(output, []);
});

test('购买后指定版本明确不可用时立即报告，保留原始版本 ID', async t => {
    const {client, purchase, output, delays} = purchaseFixture(t, [
        failure('LICENSE_NOT_FOUND'), failure('APPINFO_FAIL', 'This item is no longer available'),
    ]);
    assert.equal(await client.purchaseOnly(appId, versionId), purchaseResponse);
    assert.deepEqual(purchase.mock.calls.map(call => call.arguments), [[appId, versionId, client.auth]]);
    assert.deepEqual(delays, [350]);
    assert.deepEqual(output, [{ok: true, state: 'new', appId, versionId, verified: false}]);
});

for (const phase of ['许可探测', '已有许可的指定版本探测', '购买后的指定版本探测']) {
    test(`${phase} TOKEN_EXPIRED 原样上抛`, async t => {
        const error = failure('TOKEN_EXPIRED');
        const responses = phase === '许可探测' ? [error]
            : [phase === '已有许可的指定版本探测' ? appInfo : failure('LICENSE_NOT_FOUND'), error];
        const {client, purchase, output} = purchaseFixture(t, responses);
        await assert.rejects(client.purchaseOnly(appId, versionId), actual => actual === error);
        assert.equal(purchase.mock.callCount(), phase === '购买后的指定版本探测' ? 1 : 0);
        assert.deepEqual(output, []);
    });
}

test('purchase mode never downloads files', () => {
    const purchaseOnly = ipa.match(/async purchaseOnly\([\s\S]*?\n    \}/)?.[0] || '';
    assert.notEqual(purchaseOnly, '');
    assert.doesNotMatch(purchaseOnly, /runDownload|download\(song/);
    assert.match(main, /IPA_PURCHASE_ONLY/);
});
