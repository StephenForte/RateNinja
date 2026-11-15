'use strict';

const crypto = require('node:crypto');
const { db } = require('./db');
const { recordAudit, EVENT_PORT_CREATED, EVENT_PORT_UPDATED, EVENT_PORT_DELETED } = require('./audit');

function nowIso() {
    return new Date().toISOString();
}

function isBlank(value) {
    return value == null || String(value).trim() === '';
}

function normalizeCode(raw) {
    if (typeof raw !== 'string') return '';
    return raw.trim().toUpperCase();
}

function normalizeName(raw) {
    if (typeof raw !== 'string') return '';
    return raw.trim();
}

function publicPort(row) {
    return {
        id: row.id,
        code: row.code,
        name: row.name,
        createdAt: row.created_at,
        updatedAt: row.updated_at
    };
}

function createPortResolver(database = db) {
    const rows = database.prepare('SELECT code, name FROM ports').all();
    const byCode = new Map();
    const byName = new Map();
    for (const row of rows) {
        byCode.set(String(row.code).trim().toLowerCase(), row);
        const nameKey = String(row.name).trim().toLowerCase();
        if (!byName.has(nameKey)) byName.set(nameKey, row);
    }

    return {
        resolve(storedValue) {
            if (isBlank(storedValue)) {
                return { value: null, code: null, name: null };
            }
            const value = storedValue;
            const key = String(storedValue).trim().toLowerCase();
            const codeHit = byCode.get(key);
            if (codeHit) {
                return { value, code: codeHit.code, name: codeHit.name };
            }
            const nameHit = byName.get(key);
            if (nameHit) {
                return { value, code: nameHit.code, name: nameHit.name };
            }
            return { value, code: null, name: value };
        }
    };
}

function listPorts(database = db) {
    return database.prepare(`
        SELECT id, code, name, created_at, updated_at
        FROM ports
        ORDER BY code COLLATE NOCASE, name COLLATE NOCASE, id
    `).all().map(publicPort);
}

function findPortById(id, database = db) {
    return database.prepare(`
        SELECT id, code, name, created_at, updated_at FROM ports WHERE id = ?
    `).get(id) || null;
}

function findPortByCode(code, database = db) {
    const normalized = normalizeCode(code);
    if (!normalized) return null;
    return database.prepare(`
        SELECT id, code, name, created_at, updated_at FROM ports WHERE lower(code) = lower(?)
    `).get(normalized) || null;
}

function collectStoredPortValues(database = db) {
    const values = new Set();
    const rateRows = database.prepare(`
        SELECT origin_port AS value FROM rates WHERE deleted_at IS NULL
        UNION ALL
        SELECT destination_port AS value FROM rates WHERE deleted_at IS NULL
    `).all();
    const sailingRows = database.prepare(`
        SELECT departure_port AS value FROM sailings WHERE deleted_at IS NULL
        UNION ALL
        SELECT arrival_port AS value FROM sailings WHERE deleted_at IS NULL
    `).all();
    for (const row of [...rateRows, ...sailingRows]) {
        if (isBlank(row.value)) continue;
        values.add(row.value);
    }
    return [...values].sort((left, right) => String(left).localeCompare(String(right)));
}

function listUnmatchedStoredPorts(database = db) {
    const resolver = createPortResolver(database);
    return collectStoredPortValues(database).filter(value => resolver.resolve(value).code == null);
}

function createPort({ code, name }, actorUserId, database = db) {
    const normalizedCode = normalizeCode(code);
    const normalizedName = normalizeName(name);
    if (!normalizedCode || !normalizedName) {
        return { ok: false, status: 400, error: 'Code and name are required.' };
    }
    if (findPortByCode(normalizedCode, database)) {
        return { ok: false, status: 409, error: 'A port with that code already exists.' };
    }
    const id = crypto.randomUUID();
    const now = nowIso();
    database.prepare(`
        INSERT INTO ports (id, code, name, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?)
    `).run(id, normalizedCode, normalizedName, now, now);
    recordAudit(EVENT_PORT_CREATED, {
        actorUserId,
        detail: { portId: id, portKey: normalizedCode, name: normalizedName }
    });
    return { ok: true, port: publicPort(findPortById(id, database)) };
}

function updatePort(id, { code, name }, actorUserId, database = db) {
    const existing = findPortById(id, database);
    if (!existing) {
        return { ok: false, status: 404, error: 'Port was not found.' };
    }
    const nextCode = code === undefined ? existing.code : normalizeCode(code);
    const nextName = name === undefined ? existing.name : normalizeName(name);
    if (!nextCode || !nextName) {
        return { ok: false, status: 400, error: 'Code and name are required.' };
    }
    const collision = findPortByCode(nextCode, database);
    if (collision && collision.id !== id) {
        return { ok: false, status: 409, error: 'A port with that code already exists.' };
    }
    const now = nowIso();
    database.prepare(`
        UPDATE ports SET code = ?, name = ?, updated_at = ? WHERE id = ?
    `).run(nextCode, nextName, now, id);
    recordAudit(EVENT_PORT_UPDATED, {
        actorUserId,
        detail: { portId: id, portKey: nextCode, name: nextName }
    });
    return { ok: true, port: publicPort(findPortById(id, database)) };
}

function deletePort(id, actorUserId, database = db) {
    const existing = findPortById(id, database);
    if (!existing) {
        return { ok: false, status: 404, error: 'Port was not found.' };
    }
    database.prepare('DELETE FROM ports WHERE id = ?').run(id);
    recordAudit(EVENT_PORT_DELETED, {
        actorUserId,
        detail: { portId: id, portKey: existing.code, name: existing.name }
    });
    return { ok: true };
}

module.exports = {
    createPortResolver,
    listPorts,
    listUnmatchedStoredPorts,
    createPort,
    updatePort,
    deletePort,
    normalizeCode,
    normalizeName,
    publicPort
};
