import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync, writeFileSync} from 'node:fs';
import childProcess from 'node:child_process';
import {syncBuiltinESMExports} from 'node:module';
import plist from 'plist';
import {Store} from '../src/client.js';
import {Ipa} from '../src/ipa.js';

const ipa = readFileSync(new URL('../src/ipa.js', import.meta.url), 'utf8');
const app = readFileSync(new URL('../../Pastel/PastelApp.swift', import.meta.url), 'utf8');
const auth = {authHeaders: {'X-Dsid': 'test-dsid'}, pod: '25'};
const success = {jingleDocType: 'purchaseSuccess', status: 0};
const song = (versionId) => ({URL: 'https://example.invalid/app.ipa', metadata: {
    softwareVersionExternalIdentifier: versionId,
    softwareVersionExternalIdentifiers: ['100', '200'],
}});

function storeResponses(t, responses) {
    const requests = [];
    t.mock.getter(Store, 'guid', () => 'AABBCCDDEEFF');
    const exec = t.mock.method(childProcess, 'execFileSync', (file, args) => {
        if (file === '/usr/sbin/scutil') return Buffer.from('');
        assert.equal(file, '/usr/bin/curl');
        const bodyPath = args[args.indexOf('--data-binary') + 1].slice(1);
        requests.push({url: args[args.indexOf('-X') + 2], body: plist.parse(readFileSync(bodyPath, 'utf8'))});
        assert.ok(responses.length, 'unexpected Store request');
        writeFileSync(args[args.indexOf('-o') + 1], plist.build(responses.shift()));
        return Buffer.from('200');
    });
    syncBuiltinESMExports();
    t.after(() => {
        exec.mock.restore();
        syncBuiltinESMExports();
        Store.cleanup();
    });
    return requests;
}

test('buyProduct 序列化指定版本，未指定时才使用 0', async t => {
    const requests = storeResponses(t, [{...success, songList: [song('100')]}, success]);
    await Store.purchase('42', '100', auth);
    await Store.purchase('42', '', auth);
    assert.deepEqual(requests.map(r => r.body.appExtVrsId), ['100', '0']);
    assert.ok(requests.every(r => r.url.endsWith('/buyProduct') && r.body.salableAdamId === '42'));
});

test('GAME 重试仍购买相同指定版本', async t => {
    const requests = storeResponses(t, [{failureType: '2059'}, {...success, songList: [song('100')]}]);
    await Store.purchase('42', '100', auth);
    assert.deepEqual(requests.map(r => [r.body.pricingParameters, r.body.appExtVrsId]), [
        ['STDQ', '100'], ['GAME', '100'],
    ]);
});

test('购买失败不得回退到最新版本', async t => {
    const requests = storeResponses(t, [{failureType: '5002', customerMessage: 'Not available'}]);
    await assert.rejects(Store.purchase('42', '100', auth), {code: 'LICENSE_FAIL'});
    assert.deepEqual(requests.map(r => r.body.appExtVrsId), ['100']);
});

test('通用购买成功但无版本字段时，不得认定为指定版本首购成功', async t => {
    const requests = storeResponses(t, [success]);
    await assert.rejects(Store.purchase('42', '100', auth), {code: 'APPINFO_VERSION_MISMATCH'});
    assert.deepEqual(requests.map(r => r.body.appExtVrsId), ['100']);
});

test('购买响应必须匹配指定版本，历史 ID 列表不能证明当前返回的就是该版本', async t => {
    const requests = storeResponses(t, [
        {...success, songList: [song('200')]},
        {...success, songList: [{metadata: {softwareVersionExternalIdentifiers: ['100']}}]},
        {...success, songList: [{metadata: {softwareVersionExternalIdentifier: 100}}]},
    ]);
    await assert.rejects(Store.purchase('42', '100', auth), {code: 'APPINFO_VERSION_MISMATCH'});
    await assert.rejects(Store.purchase('42', '100', auth), {code: 'APPINFO_VERSION_MISMATCH'});
    assert.equal((await Store.purchase('42', '100', auth))._existing, false);
    assert.equal(requests.length, 3);
});

test('下载端点返回最新版本时继续查找指定版本，所有请求保持版本 ID', async t => {
    const requests = storeResponses(t, [
        {songList: [song('200')]}, {songList: [song('200')]}, {songList: [song(100)]},
    ]);
    const response = await Store.AppInfo('42', '100', auth);
    assert.equal(response.songList[0].metadata.softwareVersionExternalIdentifier, 100);
    assert.deepEqual(requests.map(r => r.body.externalVersionId ?? r.body.appExtVrsId), ['100', '100', '100']);
    assert.match(requests[2].url, /updateProduct/);
});

test('所有端点返回最新版本、缺少版本标识或下载 URL 时不得验证成功', async t => {
    for (const [name, entry, code] of [
        ['latest', song('200'), 'APPINFO_VERSION_MISMATCH'],
        ['missing ID', {URL: 'https://example.invalid/app.ipa', metadata: {softwareVersionExternalIdentifiers: ['100']}}, 'APPINFO_VERSION_MISMATCH'],
        ['missing URL', {metadata: {softwareVersionExternalIdentifier: '100'}}, 'APPINFO_FAIL'],
    ]) {
        await t.test(name, async sub => {
            const requests = storeResponses(sub, Array.from({length: 4}, () => ({songList: [entry]})));
            await assert.rejects(Store.AppInfo('42', '100', auth), {code});
            assert.equal(requests.length, 4);
            assert.ok(requests.every(r => (r.body.externalVersionId ?? r.body.appExtVrsId) === '100'));
        });
    }
});

test('下载时首次补购也将指定版本写入实际 buyProduct 请求', async t => {
    const requests = storeResponses(t, [
        {failureType: '9610'}, {...success, songList: [song('100')]}, {songList: [song('100')]},
    ]);
    const client = new Ipa({APPLE_ID: 'test@example.invalid', PASSWORD: 'unused'});
    client.auth = auth;
    t.mock.method(client, 'isFreeApp', async () => true);
    t.mock.method(console, 'log', () => {});
    t.mock.method(globalThis, 'setTimeout', callback => queueMicrotask(callback));
    const old = process.env.IPA_ALLOW_APP_ACQUIRE;
    process.env.IPA_ALLOW_APP_ACQUIRE = '1';
    t.after(() => {
        if (old === undefined) delete process.env.IPA_ALLOW_APP_ACQUIRE;
        else process.env.IPA_ALLOW_APP_ACQUIRE = old;
    });
    const result = await client.downloadInfo('42', '100');
    assert.equal(result.metadata.softwareVersionExternalIdentifier, '100');
    assert.equal(requests.length, 3);
    assert.match(requests[1].url, /buyProduct$/);
    assert.equal(requests[1].body.appExtVrsId, '100');
});

test('购买结果机器标记供界面区分已购买/该版本不可取', () => {
    assert.match(ipa, /@@IPA:purchase-state=verified/);
    assert.match(ipa, /@@IPA:purchase-state=unavailable/);
    assert.match(app, /purchase-state=verified/);
    assert.match(app, /purchase-state=unavailable/);
    assert.match(app, /purchaseState: PurchaseOutcome\?/);
    assert.doesNotMatch(app, /purchaseState \?\? \.verified/);
});

test('左侧平台选择器只显示设备图标（无文字）', () => {
    const picker = app.match(/private var sidebarPlatformPicker: some View \{[\s\S]*?\n    private var sidebarCountryMenu/)?.[0] || '';
    assert.notEqual(picker, '');
    assert.doesNotMatch(picker, /Text\(platform\.title\)/);
    assert.match(picker, /Image\(systemName: platform\.symbolName\)/);
    // 图标仍带可访问标签与悬停提示，不丢失设备含义
    assert.match(picker, /\.accessibilityLabel\(platform\.title\)/);
    assert.match(picker, /\.help\(platform\.title\)/);
});

test('App ID 搜索支持平台严格匹配落空后的全平台回退', () => {
    const catalog = readFileSync(new URL('../src/catalog.js', import.meta.url), 'utf8');
    assert.match(catalog, /App ID lookup 返回的才是权威平台/);
    assert.match(catalog, /params: \{id: appId, country\}/);
    assert.match(catalog, /appPlatformFromResult/);
});
