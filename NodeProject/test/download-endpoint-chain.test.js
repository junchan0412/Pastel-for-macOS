import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {downloadInfoCandidates} from '../src/client.js';

const client = readFileSync(new URL('../src/client.js', import.meta.url), 'utf8');

test('取下载信息按 ipatool 的端点顺序重试，指定版本才请求 updateProduct', () => {
    const pinned = downloadInfoCandidates({appIdentifier: '1', appVerId: '891582003', guid: 'G', pod: '25'})
        .map(c => c.name);
    assert.deepEqual(pinned, ['volumeStore', 'redownload', 'updateProduct', 'backgroundUpdate']);

    // 与 ipatool 一致：没固定版本就不调用 updateProduct
    const unpinned = downloadInfoCandidates({appIdentifier: '1', guid: 'G'}).map(c => c.name);
    assert.deepEqual(unpinned, ['volumeStore', 'redownload', 'backgroundUpdate']);
});

test('指定历史版本的键位：volumeStore 用 externalVersionId，其余端点用 appExtVrsId', () => {
    const [volume, redownload, update, background] = downloadInfoCandidates({
        appIdentifier: '1', appVerId: '891582003', guid: 'G',
    });
    assert.equal(volume.body.externalVersionId, '891582003');
    assert.ok(!('appExtVrsId' in volume.body), 'volumeStore 不应带 appExtVrsId');
    for (const candidate of [redownload, update, background]) {
        assert.equal(candidate.body.appExtVrsId, '891582003');
        assert.ok(!('externalVersionId' in candidate.body));
    }
});

test('主端点带 pod 前缀，兜底端点走 downloaddispatch', () => {
    const [volume, redownload, update, background] = downloadInfoCandidates({
        appIdentifier: '1', appVerId: '9', guid: 'G', pod: '25',
    });
    assert.match(volume.url, /^https:\/\/p25-buy\.itunes\.apple\.com\/WebObjects\/MZFinance\.woa\/wa\/volumeStoreDownloadProduct\?guid=G$/);
    assert.match(redownload.url, /https:\/\/downloaddispatch\.itunes\.apple\.com\/r\/redownload\?guid=G$/);
    assert.match(update.url, /https:\/\/downloaddispatch\.itunes\.apple\.com\/up\/updateProduct\?guid=G$/);
    assert.match(background.url, /https:\/\/downloaddispatch\.itunes\.apple\.com\/up\/backgroundUpdateProduct\?guid=G$/);
    assert.equal(volume.body.guid, 'G');
    assert.equal(volume.body.serialNumber, '0');
});

test('只有末个候选的错误才对外抛出，认证与繁忙信号立即停止', () => {
    // 5002 / 空 songList → 换端点（保留既有契约的字面量）
    assert.match(client, /function needsDownloadFallback\(parsedResp\) \{\n\s*return String\(parsedResp\.failureType \|\| ''\) === '5002' \|\| !parsedResp\.songList\?\.\[0\]/);
    // 认证失效、服务器繁忙、缺许可：立刻 break，不继续打端点
    assert.match(client, /isAuthFailureResponse\(resp\.failureType, resp\.customerMessage\)\) break;/);
    assert.match(client, /failureCode === 'APPINFO_BUSY' \|\| failureCode === 'LICENSE_NOT_FOUND'\) break;/);
    assert.match(client, /error\?\.code === 'TOKEN_EXPIRED' \|\| isLast\) throw error;/);
    // 中间端点的 customerMessage 不吞掉后续兜底，只有末个候选才抛出
    assert.match(client, /if \(isLast\) break;/);
});
