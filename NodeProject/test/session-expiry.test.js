import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import childProcess from 'node:child_process';
import {syncBuiltinESMExports} from 'node:module';
import {fileURLToPath} from 'node:url';
import plist from 'plist';
import {appInfoFailureCode, isAuthFailureResponse, purchaseSuccessKind} from '../src/client.js';
import {
    buildLoginBody,
    buildSignedAuthenticationHeaders,
    parseLoginResponse,
    shouldRetryWithLegacyAuthenticate,
} from '../src/gsa.js';

test('recognizes StoreServices HTTP authentication failures', () => {
    assert.equal(isAuthFailureResponse('', '', 401), true);
    assert.equal(isAuthFailureResponse('', '', 403), true);
    assert.equal(isAuthFailureResponse('', '', 500), false);
});

test('recognizes ipaverse session-expiry failure types', () => {
    for (const failureType of ['-5000', '1008', '2002', '2034', '2042']) {
        assert.equal(isAuthFailureResponse(failureType, '', 200), true, failureType);
    }
    assert.equal(isAuthFailureResponse('5002', 'License already exists', 200), false);
});

test('recognizes legacy password-token messages', () => {
    assert.equal(isAuthFailureResponse('', 'Your password has changed.', 200), true);
    assert.equal(isAuthFailureResponse('', 'password token is expired', 200), true);
    assert.equal(isAuthFailureResponse('', 'temporarily unavailable', 200), false);
});

test('does not mistake Apple busy responses for a missing license', () => {
    assert.equal(appInfoFailureCode('9610', ''), 'LICENSE_NOT_FOUND');
    assert.equal(appInfoFailureCode('2059', ''), 'APPINFO_BUSY');
    assert.equal(appInfoFailureCode('5002', ''), 'APPINFO_FAIL');
    assert.equal(appInfoFailureCode('', 'License not found'), 'LICENSE_NOT_FOUND');
    assert.equal(appInfoFailureCode('', 'Redownload Unavailable with This Apple Account'), 'LICENSE_NOT_FOUND');
    assert.equal(appInfoFailureCode('', 'Redownload Unavailable with This Apple\u00a0Account'), 'LICENSE_NOT_FOUND');
    assert.equal(appInfoFailureCode('', 'Temporarily unavailable'), 'APPINFO_FAIL');
});

test('accepts only explicit buyProduct success or an existing license', () => {
    assert.equal(purchaseSuccessKind({
        _httpStatus: 200,
        jingleDocType: 'purchaseSuccess',
        status: 0,
    }), 'new');
    assert.equal(purchaseSuccessKind({
        _httpStatus: 500,
        status: 0,
    }), '');
    assert.equal(purchaseSuccessKind({
        _httpStatus: 200,
        status: 0,
    }), '');
    assert.equal(purchaseSuccessKind({
        _httpStatus: 500,
        failureType: '5002',
        customerMessage: 'An unknown error has occurred.',
    }), '');
    assert.equal(purchaseSuccessKind({
        _httpStatus: 500,
        failureType: '5002',
        customerMessage: 'License already exists',
    }), 'existing');
});

test('keeps the missing-license and Apple-busy states distinct in source', () => {
    const clientSource = readFileSync(new URL('../src/client.js', import.meta.url), 'utf8');
    assert.match(clientSource, /serialNumber: '0'/);
    assert.match(clientSource, /downloaddispatch\.itunes\.apple\.com\/r\/redownload/);
    assert.match(clientSource, /failureType \|\| ''\) === '5002' \|\| !parsedResp\.songList/);
    assert.match(clientSource, /if \(!parsedResp\.songList\?\.\[0\]\)[\s\S]*e\.code = listVersions \? 'APPINFO_EMPTY' : 'APPINFO_FAIL'/);
    assert.match(clientSource, /failureCode === 'APPINFO_BUSY'/);
});

test('active Store login path does not invoke GSA or Anisette', () => {
    const clientSource = readFileSync(new URL('../src/client.js', import.meta.url), 'utf8');
    const mainSource = readFileSync(new URL('../main.js', import.meta.url), 'utf8');
    assert.doesNotMatch(clientSource, /\bgsaLogin\b|fetchAnisette|IPA_NATIVE_ANISETTE/);
    assert.doesNotMatch(mainSource, /request-2fa|IPA_NATIVE_ANISETTE/);
});

test('falls back from native authentication statuses used by ipatool', () => {
    for (const status of [204, 403, 404, 503]) {
        assert.equal(shouldRetryWithLegacyAuthenticate('https://auth.itunes.apple.com/auth/v1/native/fast/', status), true, String(status));
    }
    for (const status of [0, 200, 302, 401, 429, 500]) {
        assert.equal(shouldRetryWithLegacyAuthenticate('https://auth.itunes.apple.com/auth/v1/native/fast/', status), false, String(status));
    }
    assert.equal(shouldRetryWithLegacyAuthenticate('https://buy.itunes.apple.com/WebObjects/MZFinance.woa/wa/authenticate', 403), false);
});

test('signs the exact Store authentication plist bytes for Apple', () => {
    const body = Buffer.from('<?xml version="1.0"?><plist><string>secret</string></plist>');
    let signedBody;
    const headers = buildSignedAuthenticationHeaders(
        {'Content-Type': 'application/x-apple-plist'},
        body,
        (input) => {
            signedBody = Buffer.from(input);
            return Buffer.from([0xfb, 0xef]);
        }
    );

    assert.deepEqual(signedBody, body);
    assert.equal(headers['X-Apple-ActionSignature'], '++8=');
    assert.equal(headers['Content-Type'], 'application/x-apple-plist');
});

test('rejects an empty Apple action signature', () => {
    assert.throws(
        () => buildSignedAuthenticationHeaders({}, Buffer.from('plist'), () => Buffer.alloc(0)),
        /SAP 签名为空/
    );
});

function mockNativeSigner(t, run) {
    const previousSigner = process.env.IPA_SAP_SIGNER;
    const signerPath = fileURLToPath(import.meta.url);
    process.env.IPA_SAP_SIGNER = signerPath;
    const clock = {now: 1_000};
    t.mock.method(Date, 'now', () => clock.now);
    const wait = t.mock.method(Atomics, 'wait', (_state, _index, _value, delay) => {
        clock.now += delay;
        return 'timed-out';
    });
    const exec = t.mock.method(childProcess, 'execFileSync', (file, args, options) => {
        assert.equal(file, signerPath);
        assert.deepEqual(args, []);
        return run(options, clock);
    });
    syncBuiltinESMExports();
    t.after(() => {
        exec.mock.restore();
        syncBuiltinESMExports();
        if (previousSigner === undefined) delete process.env.IPA_SAP_SIGNER;
        else process.env.IPA_SAP_SIGNER = previousSigner;
    });
    return {exec, wait};
}

test('restarts native SAP initialization twice while preserving signed body bytes', t => {
    const body = Buffer.from('<?xml version="1.0"?>\n<plist><string>测试 &amp; data</string></plist>');
    let attempts = 0;
    const {exec, wait} = mockNativeSigner(t, options => {
        assert.deepEqual(options.input, body);
        if (++attempts < 3) {
            throw Object.assign(new Error('process failed'), {
                status: 4,
                stderr: Buffer.from('Apple SAP signing session did not open'),
            });
        }
        return '++8=\n';
    });
    const headers = buildSignedAuthenticationHeaders({'Content-Type': 'application/x-apple-plist'}, body);

    assert.equal(headers['X-Apple-ActionSignature'], '++8=');
    assert.equal(headers['Content-Type'], 'application/x-apple-plist');
    assert.equal(exec.mock.callCount(), 3);
    assert.deepEqual(exec.mock.calls.map(call => call.arguments[2].timeout), [35_000, 34_500, 33_500]);
    assert.deepEqual(wait.mock.calls.map(call => call.arguments[3]), [500, 1_000]);
});

test('stops after three native SAP initialization failures and preserves the final stderr', t => {
    let attempts = 0;
    const {exec, wait} = mockNativeSigner(t, () => {
        throw Object.assign(new Error('process failed'), {
            status: 4,
            stderr: Buffer.from(`CommerceKit initialization failed ${++attempts}: NSURLErrorDomain -1009\n`),
        });
    });

    assert.throws(() => buildSignedAuthenticationHeaders({}, Buffer.from('plist')), {
        message: 'Apple SAP 签名失败：CommerceKit initialization failed 3: NSURLErrorDomain -1009',
    });
    assert.equal(exec.mock.callCount(), 3);
    assert.equal(wait.mock.callCount(), 2);
});

for (const [label, result, message] of [
    ['framework failure', Object.assign(new Error('process failed'), {status: 3, stderr: 'CommerceKit missing'}), 'CommerceKit missing'],
    ['signing failure', Object.assign(new Error('process failed'), {status: 5, stderr: 'SAP signing rejected'}), 'SAP signing rejected'],
    ['invalid output', 'not a signature', '签名组件返回了无效数据'],
    ['empty output', '\n', '签名组件返回了无效数据'],
]) {
    test(`does not retry native SAP ${label}`, t => {
        const {exec, wait} = mockNativeSigner(t, () => {
            if (result instanceof Error) throw result;
            return result;
        });

        assert.throws(() => buildSignedAuthenticationHeaders({}, Buffer.from('plist')), {
            message: `Apple SAP 签名失败：${message}`,
        });
        assert.equal(exec.mock.callCount(), 1);
        assert.equal(wait.mock.callCount(), 0);
    });
}

test('does not restart native SAP initialization after the total 35-second budget expires', t => {
    const {exec, wait} = mockNativeSigner(t, (options, clock) => {
        clock.now += options.timeout;
        throw Object.assign(new Error('process failed'), {status: 4, stderr: 'Apple SAP setup timed out'});
    });

    assert.throws(() => buildSignedAuthenticationHeaders({}, Buffer.from('plist')), {
        message: 'Apple SAP 签名失败：Apple SAP setup timed out',
    });
    assert.equal(exec.mock.callCount(), 1);
    assert.equal(exec.mock.calls[0].arguments[2].timeout, 35_000);
    assert.equal(wait.mock.callCount(), 0);
});

test('builds the signed Store login plist with attempt 1 and an appended auth code', () => {
    const withoutCode = plist.parse(buildLoginBody('user@example.com', 'password', '', 'GUID', 1));
    const withCode = plist.parse(buildLoginBody('user@example.com', 'password', '12 34 56', 'GUID', 1));

    assert.equal(withoutCode.attempt, '1');
    assert.equal(withoutCode.password, 'password');
    assert.equal(withCode.attempt, '1');
    assert.equal(withCode.password, 'password123456');
});

test('does not misclassify Apple Configurator bad-login response as definite 2FA', () => {
    const body = Buffer.from(plist.build({
        failureType: '',
        customerMessage: 'MZFinance.BadLogin.Configurator_message',
        'm-allowed': false,
    }));
    const result = parseLoginResponse({status: 200, headers: '', body}, 1, '');

    assert.equal(result.error?.code, 'AUTH_OR_2FA');
    assert.notEqual(result.error?.code, 'NEEDS_2FA');
});
