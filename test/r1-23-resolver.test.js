'use strict';

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { startApp } = require('./helpers/app');

describe('r1-23 createPortResolver', { concurrency: 1 }, () => {
    let app;
    let createPortResolver;

    before(async () => {
        app = await startApp({ companyType: 'Contract Owner', role: 'admin', username: 'r123-resolver' });
        createPortResolver = require('../lib/ports').createPortResolver;
        app.db.prepare(`
            INSERT INTO ports (id, code, name, created_at, updated_at)
            VALUES
                ('p-lalb', 'LALB', 'Los Angeles / Long Beach', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z'),
                ('p-pkg', 'PKG', 'Port Klang', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z'),
                ('p-collision', 'SEA', 'LALB', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')
        `).run();
    });

    after(async () => {
        if (app) await app.close();
    });

    it('prefers a code match over a name match for the same stored text', () => {
        const { resolve } = createPortResolver(app.db);
        // "LALB" is both one port's code and another port's name.
        assert.deepEqual(resolve('LALB'), {
            value: 'LALB',
            code: 'LALB',
            name: 'Los Angeles / Long Beach'
        });
        assert.deepEqual(resolve('lalb'), {
            value: 'lalb',
            code: 'LALB',
            name: 'Los Angeles / Long Beach'
        });
        assert.deepEqual(resolve('  LALB  '), {
            value: '  LALB  ',
            code: 'LALB',
            name: 'Los Angeles / Long Beach'
        });
    });

    it('matches names case-insensitively when no code matches', () => {
        const { resolve } = createPortResolver(app.db);
        assert.deepEqual(resolve('port klang'), {
            value: 'port klang',
            code: 'PKG',
            name: 'Port Klang'
        });
        assert.deepEqual(resolve('Port Klang'), {
            value: 'Port Klang',
            code: 'PKG',
            name: 'Port Klang'
        });
    });

    it('returns unmatched and blank shapes', () => {
        const { resolve } = createPortResolver(app.db);
        assert.deepEqual(resolve('Seattle'), {
            value: 'Seattle',
            code: null,
            name: 'Seattle'
        });
        assert.deepEqual(resolve(null), { value: null, code: null, name: null });
        assert.deepEqual(resolve(''), { value: null, code: null, name: null });
        assert.deepEqual(resolve('   '), { value: null, code: null, name: null });
    });

    it('reads the ports table once', () => {
        let selectCount = 0;
        const realPrepare = app.db.prepare.bind(app.db);
        app.db.prepare = sql => {
            if (typeof sql === 'string' && /FROM\s+ports\b/i.test(sql) && /^\s*SELECT/i.test(sql.trim())) {
                selectCount += 1;
            }
            return realPrepare(sql);
        };
        try {
            const { resolve } = createPortResolver(app.db);
            assert.equal(selectCount, 1);
            resolve('LALB');
            resolve('Seattle');
            resolve(null);
            assert.equal(selectCount, 1);
        } finally {
            app.db.prepare = realPrepare;
        }
    });
});
