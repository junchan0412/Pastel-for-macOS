import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';

const ipa = readFileSync(new URL('../src/ipa.js', import.meta.url), 'utf8');
const app = readFileSync(new URL('../../Pastel/PastelApp.swift', import.meta.url), 'utf8');

test('首购先探测许可、只对免费 App 下单，且下单固定当前版本', () => {
    const block = ipa.match(/async _purchaseOnce\([\s\S]*?\n    \}/)?.[0] || '';
    assert.notEqual(block, '');
    // 1) 已可取（含指定历史版本）→ 不触发 buyProduct
    assert.match(block, /await probe\(\)/);
    assert.match(block, /state: 'existing'/);
    // 2) 付费 App 拒绝购买
    assert.match(block, /isFreeApp\(appId\)/);
    assert.match(block, /paid_not_purchased/);
    // 3) 许可按当前版本创建（历史 versionId 传给 buyProduct 也建不出历史许可）
    assert.match(block, /Store\.purchase\(appId, '', this\.auth\)/);
});

test('首购后轮询指定历史版本，验证其真正可下载', () => {
    const block = ipa.match(/async _purchaseOnce\([\s\S]*?\n    \}/)?.[0] || '';
    assert.match(block, /for \(const delayMs of \[350, 800, 1600, 3000\]\)/);
    assert.match(block, /Store\.AppInfo\(appId, versionId, this\.auth\)/);
    assert.match(block, /purchase_version_ok/);
    assert.match(block, /purchase_version_unavailable/);
    assert.match(block, /verified: false/);
});

test('购买结果机器标记供界面区分已购买/该版本不可取', () => {
    assert.match(ipa, /@@IPA:purchase-state=verified/);
    assert.match(ipa, /@@IPA:purchase-state=unavailable/);
    assert.match(app, /purchase-state=verified/);
    assert.match(app, /purchase-state=unavailable/);
    assert.match(app, /purchaseState: PurchaseOutcome\?/);
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
