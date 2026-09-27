import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';

const catalog = readFileSync(new URL('../src/catalog.js', import.meta.url), 'utf8');

test('mac platform maps to the macSoftware search entity (ipatool lookupEntity)', () => {
    assert.match(catalog, /if \(platform === 'mac'\) return 'macSoftware'/);
});

test('mac lookup strictly filters to mac-compatible results', () => {
    assert.match(catalog, /cleanPlatform === 'mac'/);
    assert.match(catalog, /isMacCompatibleItem/);
});

test('mac featured list uses the mac RSS feeds', () => {
    assert.match(catalog, /topfreemacapps/);
    assert.match(catalog, /toppaidmacapps/);
});
