import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync, existsSync} from 'node:fs';

const plist = readFileSync(new URL('../../Pastel/Info.plist', import.meta.url), 'utf8');
const appcast = readFileSync(new URL('../../appcast.xml', import.meta.url), 'utf8');

test('SUFeedURL 指向本仓库 main 分支的 appcast', () => {
    const feed = plist.match(/<key>SUFeedURL<\/key>\s*<string>([^<]+)<\/string>/)?.[1] || '';
    assert.equal(feed, 'https://raw.githubusercontent.com/junchan0412/Pastel-for-macOS/main/appcast.xml');
});

test('嵌入的 EdDSA 公钥为 32 字节 base64（与签名私钥配对）', () => {
    const key = plist.match(/<key>SUPublicEDKey<\/key>\s*<string>([^<]+)<\/string>/)?.[1] || '';
    assert.equal(Buffer.from(key, 'base64').length, 32);
    // 不再使用上游仓库的公钥：本仓库没有上游私钥，无法为自己的安装包签名。
    assert.notEqual(key, 'igtEvMP+w7+IDjXogB1ajorx89zR0t5BFgHw6PPcy/Y=');
});

test('appcast 最新条目指向本仓库下载地址且带 edSignature', () => {
    const first = appcast.match(/<item>([\s\S]*?)<\/item>/)?.[1] || '';
    assert.notEqual(first, '');
    assert.match(first, /https:\/\/github\.com\/junchan0412\/Pastel-for-macOS\/releases\/download\//);
    assert.match(first, /sparkle:edSignature="[A-Za-z0-9+/=]{80,}"/);
    assert.match(first, /<sparkle:version>\d+<\/sparkle:version>/);
});

test('自动检查与手动检查入口存在', () => {
    assert.match(plist, /<key>SUEnableAutomaticChecks<\/key>\s*<true\/>/);
    const app = readFileSync(new URL('../../Pastel/PastelApp.swift', import.meta.url), 'utf8');
    assert.match(app, /SPUStandardUpdaterController\(startingUpdater: true/);
    assert.match(app, /String\(localized: "检查更新…"\)/);
    assert.match(app, /String\(localized: "检查更新"\)/);
});

test('appcast 签名脚本可用（定位 sign_update、签名后校验、按 build 更新条目）', () => {
    const script = readFileSync(new URL('../../Scripts/UpdateAppcast.sh', import.meta.url), 'utf8');
    assert.match(script, /sign_update" -p "\$dmg"|sign_update -p/);
    assert.match(script, /--verify/);
    assert.match(script, /sparkle:edSignature/);
    assert.match(script, /<sparkle:version>\{html\.escape\(build\)\}<\/sparkle:version>/);
    assert.ok(existsSync(new URL('../../Scripts/BuildAdHocDMG.sh', import.meta.url)));
});
