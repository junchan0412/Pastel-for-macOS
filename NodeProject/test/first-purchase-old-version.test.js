import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';

const ipa = readFileSync(new URL('../src/ipa.js', import.meta.url), 'utf8');
const app = readFileSync(new URL('../../Pastel/PastelApp.swift', import.meta.url), 'utf8');

test('首购：许可探测不固定版本且空 songList 视为缺许可，已拥有则绝不下单', () => {
    const block = ipa.match(/async _purchaseOnce\([\s\S]*?\n    \}/)?.[0] || '';
    assert.notEqual(block, '');
    // 许可是账户级的：不固定版本；listVersions 让 Apple 的“status=0 + 空 songList”按缺许可处理
    assert.match(block, /Store\.AppInfo\(appId, '', this\.auth, \{listVersions: true\}\)/);
    // 指定版本的可用性用固定版本的请求单独确认
    assert.match(block, /Store\.AppInfo\(appId, vid, this\.auth\)/);
    // 探测失败但不是“缺许可”（如认证过期、服务器错误）必须原样上抛，不能误判成缺许可
    assert.match(block, /if \(!owned && !isLicenseMissing\(license\._error\)\) throw license\._error/);
    // 已拥有 → 直接发布结果，不进入 buyProduct
    assert.match(block, /if \(owned && !versionId\)/);
    // 免费才买、付费一律拒绝
    assert.match(block, /isFreeApp\(appId\)/);
    assert.match(block, /paid_not_purchased/);
    // 下单固定当前版本（历史 versionId 不传给 buyProduct）
    assert.match(block, /Store\.purchase\(appId, '', this\.auth\)/);
    // 购买语义来自 successKind，而不是本地化文案关键词
    assert.match(block, /purchaseResponse\?\._existing \? 'existing' : 'new'/);
    assert.doesNotMatch(block, /资料库\|library/);
    // 顺序：先探测许可，再决定是否购买
    const probeAt = block.indexOf('await probeLicense()');
    const purchaseAt = block.indexOf('Store.purchase(appId');
    assert.ok(probeAt > -1 && purchaseAt > probeAt, '必须先探测许可再购买');
});

test('首购后轮询指定历史版本，验证其真正可下载', () => {
    const block = ipa.match(/async _purchaseOnce\([\s\S]*?\n    \}/)?.[0] || '';
    assert.match(block, /for \(const delayMs of \[350, 800, 1600, 3000\]\)/);
    assert.match(block, /await probeVersion\(versionId\)/);
    assert.match(block, /purchase_version_ok/);
    assert.match(block, /purchase_version_unavailable/);
    // 购买成功但版本取不到时如实报告（verified=false → 界面显示橙色提示）
    assert.match(block, /publish\(state, false\)/);
    assert.match(block, /@@IPA:purchase-state=unavailable/);
    // 已拥有却取不到该版本（版本已下架）同样如实报告，且不重复购买
    assert.match(block, /if \(!isLicenseMissing\(pinned\._error\)\)/);
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

test('购买后校验：认证过期上抛、明确“版本不可用”才提前结束，其余继续轮询', () => {
    const block = ipa.match(/async _purchaseOnce\([\s\S]*?\n    \}/)?.[0] || '';
    assert.notEqual(block, '');
    // 认证过期 → 交给 _withReauth 整体重试
    assert.match(block, /lastError\.code === 'TOKEN_EXPIRED'\) throw lastError/);
    // 只有 Apple 明确说 “No longer available” 才提前结束（对齐 ipatool isUnavailableDownloadProductResponse）
    assert.match(block, /\/no longer available\/i\.test\(lastError\.message \|\| ''\)\) break/);
    // 许可尚未生效 / 端点空响应都应继续轮询，不能在首次失败就放弃
    assert.doesNotMatch(block, /if \(!isLicenseMissing\(lastError\)\)/);
});
