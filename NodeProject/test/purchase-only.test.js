import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';

const ipa = readFileSync(new URL('../src/ipa.js', import.meta.url), 'utf8');
const main = readFileSync(new URL('../main.js', import.meta.url), 'utf8');

test('purchaseOnly checks the existing license before calling buyProduct', () => {
    const block = ipa.match(/async _purchaseOnce\([\s\S]*?\n    \/\/ Download sources only/)?.[0] || '';
    assert.notEqual(block, '');
    // 先查许可（不固定版本 + listVersions，覆盖 Apple 的“空 songList”缺许可形态）：
    // AppInfo 成功即已拥有，直接返回 existing，不触碰 buyProduct。
    assert.match(block, /Store\.AppInfo\(appId, '', this\.auth, \{listVersions: true\}\)/);
    assert.match(block, /publish\('existing', true\)/);
    // 缺许可才买，且买免费 App、历史版本不传给 buyProduct。
    assert.match(block, /isFreeApp\(appId\)/);
    assert.match(block, /paid_not_purchased/);
    assert.match(block, /Store\.purchase\(appId, '', this\.auth\)/);
});

test('purchase mode never downloads files', () => {
    const purchaseOnly = ipa.match(/async purchaseOnly\([\s\S]*?\n    \}/)?.[0] || '';
    assert.notEqual(purchaseOnly, '');
    assert.doesNotMatch(purchaseOnly, /runDownload|download\(song/);
    assert.match(main, /IPA_PURCHASE_ONLY/);
});
