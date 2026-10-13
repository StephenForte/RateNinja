'use strict';

const crypto = require('node:crypto');
const { db, transaction } = require('./db');
const {
    CONFIG_VERSION,
    FIELDS,
    PAGE_SIZES,
    QUERY_KEYS,
    catalog,
    fieldById
} = require('./view-fields');
const { MAX_GROUP_FIELDS, MAX_SORT_RULES } = require('./limits');

const QUERY_KEY_SET = new Set(QUERY_KEYS);
const NAME_MAX = 80;
const TEXT_MAX = 200;

class PreferenceError extends Error {
    constructor(status, message) {
        super(message);
        this.status = status;
    }
}

function now() {
    return new Date().toISOString();
}

function fail(status, message) {
    throw new PreferenceError(status, message);
}

function ownerId(userId) {
    if (!userId) fail(401, 'Please sign in to continue.');
    return userId;
}

function cleanName(name) {
    if (typeof name !== 'string') fail(400, 'Name is required.');
    const trimmed = name.trim();
    if (!trimmed) fail(400, 'Name is required.');
    if (trimmed.length > NAME_MAX) fail(400, 'Name is too long.');
    return trimmed;
}

function nameTaken(table, userId, name, exceptId) {
    const row = db.prepare(`
        SELECT id FROM ${table}
        WHERE user_id = ? AND name = ? COLLATE NOCASE AND id IS NOT ?
    `).get(userId, name, exceptId || '');
    return Boolean(row);
}

function parsePayload(text) {
    try {
        const value = JSON.parse(text);
        if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
        return value;
    } catch {
        return null;
    }
}

function validateCriteria(input) {
    if (!input || typeof input !== 'object' || Array.isArray(input)) fail(400, 'Criteria must be an object.');
    for (const key of Object.keys(input)) {
        if (!QUERY_KEY_SET.has(key)) fail(400, `Criteria cannot include ${key}.`);
    }
    const criteria = {};
    for (const key of QUERY_KEYS) {
        const value = input[key];
        if (value === undefined || value === null || value === '') {
            criteria[key] = '';
            continue;
        }
        if (typeof value !== 'string') fail(400, `${key} must be text.`);
        if (value.length > TEXT_MAX) fail(400, `${key} is too long.`);
        criteria[key] = value;
    }
    return criteria;
}

function stringList(value, label) {
    if (!Array.isArray(value)) fail(400, `${label} must be a list.`);
    return value;
}

function knownField(id, label) {
    if (typeof id !== 'string' || !fieldById(id)) fail(400, `${label} includes an unknown column.`);
    return fieldById(id);
}

function validateView(input) {
    if (!input || typeof input !== 'object' || Array.isArray(input)) fail(400, 'View must be an object.');
    const allowed = new Set(['columnOrder', 'hiddenColumns', 'groupBy', 'sort', 'pageSize']);
    for (const key of Object.keys(input)) {
        if (!allowed.has(key)) fail(400, `View cannot include ${key}.`);
    }

    const columnOrder = [];
    const seen = new Set();
    for (const id of stringList(input.columnOrder === undefined ? FIELDS.map(field => field.id) : input.columnOrder, 'columnOrder')) {
        knownField(id, 'columnOrder');
        if (seen.has(id)) fail(400, 'columnOrder lists a column more than once.');
        seen.add(id);
        columnOrder.push(id);
    }

    const hiddenColumns = [];
    for (const id of stringList(input.hiddenColumns || [], 'hiddenColumns')) {
        knownField(id, 'hiddenColumns');
        if (!hiddenColumns.includes(id)) hiddenColumns.push(id);
    }

    const groupBy = stringList(input.groupBy || [], 'groupBy');
    if (groupBy.length > MAX_GROUP_FIELDS) fail(400, `A view can group by at most ${MAX_GROUP_FIELDS} fields.`);
    const grouped = [];
    for (const id of groupBy) {
        const field = knownField(id, 'groupBy');
        if (!field.groupable) fail(400, `${field.label} cannot be used for grouping.`);
        if (grouped.includes(id)) fail(400, 'groupBy lists a column more than once.');
        grouped.push(id);
    }

    const sortInput = stringList(input.sort || [], 'sort');
    if (sortInput.length > MAX_SORT_RULES) fail(400, `A view can sort by at most ${MAX_SORT_RULES} rules.`);
    const sort = [];
    const sorted = new Set();
    for (const rule of sortInput) {
        if (!rule || typeof rule !== 'object' || Array.isArray(rule)) fail(400, 'Each sort rule needs a field and a direction.');
        if (rule.direction !== 'asc' && rule.direction !== 'desc') fail(400, 'Each sort rule needs a direction.');
        const field = knownField(rule.field, 'sort');
        if (!field.sortable) fail(400, `${field.label} cannot be used for sorting.`);
        if (sorted.has(field.id)) fail(400, 'sort lists a column more than once.');
        sorted.add(field.id);
        sort.push({ field: field.id, direction: rule.direction });
    }

    if (!PAGE_SIZES.includes(input.pageSize)) fail(400, 'Page size must be 20, 50, or 100.');

    return { columnOrder, hiddenColumns, groupBy: grouped, sort, pageSize: input.pageSize };
}

function keepKnown(id, dropped) {
    if (fieldById(id)) return true;
    dropped.yes = true;
    return false;
}

function presentView(row) {
    const parsed = parsePayload(row.payload);
    const stored = parsed || {};
    const dropped = { yes: !parsed };
    const columnOrder = [];
    const seen = new Set();
    for (const id of Array.isArray(stored.columnOrder) ? stored.columnOrder : []) {
        if (!keepKnown(id, dropped) || seen.has(id)) {
            if (seen.has(id)) dropped.yes = true;
            continue;
        }
        seen.add(id);
        columnOrder.push(id);
    }
    for (const field of FIELDS) {
        if (!seen.has(field.id)) columnOrder.push(field.id);
    }

    const hiddenColumns = [];
    for (const id of Array.isArray(stored.hiddenColumns) ? stored.hiddenColumns : []) {
        if (!keepKnown(id, dropped)) continue;
        if (!hiddenColumns.includes(id)) hiddenColumns.push(id);
    }

    const groupBy = [];
    for (const id of Array.isArray(stored.groupBy) ? stored.groupBy : []) {
        if (!keepKnown(id, dropped)) continue;
        const field = fieldById(id);
        if (!field.groupable || groupBy.includes(id) || groupBy.length >= MAX_GROUP_FIELDS) {
            dropped.yes = true;
            continue;
        }
        groupBy.push(id);
    }

    const sort = [];
    const sorted = new Set();
    for (const rule of Array.isArray(stored.sort) ? stored.sort : []) {
        const fieldId = rule && typeof rule === 'object' ? rule.field : '';
        if (!keepKnown(fieldId, dropped)) continue;
        const field = fieldById(fieldId);
        const direction = rule.direction === 'desc' ? 'desc' : rule.direction === 'asc' ? 'asc' : '';
        if (!field.sortable || !direction || sorted.has(field.id) || sort.length >= MAX_SORT_RULES) {
            dropped.yes = true;
            continue;
        }
        sorted.add(field.id);
        sort.push({ field: field.id, direction });
    }

    let pageSize = stored.pageSize;
    if (!PAGE_SIZES.includes(pageSize)) {
        pageSize = 20;
        dropped.yes = true;
    }
    if (Number(row.config_version) !== CONFIG_VERSION) dropped.yes = true;

    return {
        id: row.id,
        name: row.name,
        view: { columnOrder, hiddenColumns, groupBy, sort, pageSize },
        isDefault: Number(row.is_default) === 1,
        needsAttention: dropped.yes,
        configVersion: Number(row.config_version),
        createdAt: row.created_at,
        updatedAt: row.updated_at
    };
}

function presentQuery(row) {
    const criteria = parsePayload(row.payload) || {};
    const clean = {};
    let needsAttention = Number(row.config_version) !== CONFIG_VERSION;
    for (const key of Object.keys(criteria)) {
        if (!QUERY_KEY_SET.has(key)) needsAttention = true;
    }
    for (const key of QUERY_KEYS) {
        clean[key] = typeof criteria[key] === 'string' ? criteria[key] : '';
        if (criteria[key] !== undefined && typeof criteria[key] !== 'string') needsAttention = true;
    }
    return {
        id: row.id,
        name: row.name,
        criteria: clean,
        needsAttention,
        configVersion: Number(row.config_version),
        createdAt: row.created_at,
        updatedAt: row.updated_at
    };
}

function queryRow(userId, id) {
    return db.prepare('SELECT * FROM saved_queries WHERE id = ? AND user_id = ?').get(id, userId) || null;
}

function viewRow(userId, id) {
    return db.prepare('SELECT * FROM saved_views WHERE id = ? AND user_id = ?').get(id, userId) || null;
}

function requireQuery(userId, id) {
    const row = queryRow(userId, id);
    if (!row) fail(404, 'Saved query was not found.');
    return row;
}

function requireView(userId, id) {
    const row = viewRow(userId, id);
    if (!row) fail(404, 'Saved view was not found.');
    return row;
}

function listQueries(userId) {
    ownerId(userId);
    return db.prepare(`
        SELECT * FROM saved_queries WHERE user_id = ? ORDER BY name COLLATE NOCASE, id
    `).all(userId).map(presentQuery);
}

function listViews(userId) {
    ownerId(userId);
    return db.prepare(`
        SELECT * FROM saved_views WHERE user_id = ? ORDER BY name COLLATE NOCASE, id
    `).all(userId).map(presentView);
}

function getQuery(userId, id) {
    return presentQuery(requireQuery(ownerId(userId), id));
}

function getView(userId, id) {
    return presentView(requireView(ownerId(userId), id));
}

function insertOwned(table, userId, name, payload, extra) {
    const id = crypto.randomUUID();
    const stamp = now();
    if (nameTaken(table, userId, name)) fail(409, 'You already have one with that name.');
    const columns = ['id', 'user_id', 'name', 'payload', 'config_version', 'created_at', 'updated_at'];
    const values = [id, userId, name, JSON.stringify(payload), CONFIG_VERSION, stamp, stamp];
    if (extra) {
        columns.push(extra.column);
        values.push(extra.value);
    }
    db.prepare(`
        INSERT INTO ${table} (${columns.join(', ')})
        VALUES (${columns.map(() => '?').join(', ')})
    `).run(...values);
    return id;
}

function createQuery(userId, input) {
    const owner = ownerId(userId);
    const name = cleanName(input && input.name);
    const criteria = validateCriteria(input && input.criteria);
    const id = transaction(() => insertOwned('saved_queries', owner, name, criteria));
    return getQuery(owner, id);
}

function createView(userId, input) {
    const owner = ownerId(userId);
    const name = cleanName(input && input.name);
    const view = validateView(input && input.view);
    if (input.isDefault !== undefined && input.isDefault !== true && input.isDefault !== false) {
        fail(400, 'isDefault must be true or false.');
    }
    const makeDefault = input.isDefault === true;
    const id = transaction(() => {
        const created = insertOwned('saved_views', owner, name, view, { column: 'is_default', value: 0 });
        if (makeDefault) assignDefault(owner, created);
        return created;
    });
    return getView(owner, id);
}

function updateQuery(userId, id, input) {
    const owner = ownerId(userId);
    if (!input || typeof input !== 'object' || Array.isArray(input)) fail(400, 'Request body must be an object.');
    const hasName = Object.prototype.hasOwnProperty.call(input, 'name');
    const hasCriteria = Object.prototype.hasOwnProperty.call(input, 'criteria');
    if (!hasName && !hasCriteria) fail(400, 'Nothing to update.');
    transaction(() => {
        const row = requireQuery(owner, id);
        const name = hasName ? cleanName(input.name) : row.name;
        if (nameTaken('saved_queries', owner, name, id)) fail(409, 'You already have one with that name.');
        if (hasCriteria) {
            const criteria = validateCriteria(input.criteria);
            db.prepare(`
                UPDATE saved_queries
                SET name = ?, payload = ?, config_version = ?, updated_at = ?
                WHERE id = ? AND user_id = ?
            `).run(name, JSON.stringify(criteria), CONFIG_VERSION, now(), id, owner);
        } else {
            db.prepare(`
                UPDATE saved_queries SET name = ?, updated_at = ? WHERE id = ? AND user_id = ?
            `).run(name, now(), id, owner);
        }
    });
    return getQuery(owner, id);
}

function updateView(userId, id, input) {
    const owner = ownerId(userId);
    if (!input || typeof input !== 'object' || Array.isArray(input)) fail(400, 'Request body must be an object.');
    const hasName = Object.prototype.hasOwnProperty.call(input, 'name');
    const hasView = Object.prototype.hasOwnProperty.call(input, 'view');
    const hasDefault = Object.prototype.hasOwnProperty.call(input, 'isDefault');
    if (!hasName && !hasView && !hasDefault) fail(400, 'Nothing to update.');
    if (hasDefault && input.isDefault !== true && input.isDefault !== false) {
        fail(400, 'isDefault must be true or false.');
    }
    transaction(() => {
        const row = requireView(owner, id);
        const name = hasName ? cleanName(input.name) : row.name;
        if (nameTaken('saved_views', owner, name, id)) fail(409, 'You already have one with that name.');
        if (hasView) {
            const view = validateView(input.view);
            db.prepare(`
                UPDATE saved_views
                SET name = ?, payload = ?, config_version = ?, updated_at = ?
                WHERE id = ? AND user_id = ?
            `).run(name, JSON.stringify(view), CONFIG_VERSION, now(), id, owner);
        } else if (hasName) {
            db.prepare(`
                UPDATE saved_views SET name = ?, updated_at = ? WHERE id = ? AND user_id = ?
            `).run(name, now(), id, owner);
        }
        if (hasDefault) {
            if (input.isDefault) assignDefault(owner, id);
            else if (Number(row.is_default) === 1) clearDefault(owner);
        }
    });
    return getView(owner, id);
}

function deleteQuery(userId, id) {
    const owner = ownerId(userId);
    const result = db.prepare('DELETE FROM saved_queries WHERE id = ? AND user_id = ?').run(id, owner);
    if (Number(result.changes) !== 1) fail(404, 'Saved query was not found.');
}

function deleteView(userId, id) {
    const owner = ownerId(userId);
    const result = db.prepare('DELETE FROM saved_views WHERE id = ? AND user_id = ?').run(id, owner);
    if (Number(result.changes) !== 1) fail(404, 'Saved view was not found.');
}

function clearDefault(userId) {
    db.prepare(`
        UPDATE saved_views SET is_default = 0, updated_at = ?
        WHERE user_id = ? AND is_default = 1
    `).run(now(), userId);
}

function assignDefault(userId, id) {
    requireView(userId, id);
    clearDefault(userId);
    const result = db.prepare(`
        UPDATE saved_views SET is_default = 1, updated_at = ?
        WHERE id = ? AND user_id = ?
    `).run(now(), id, userId);
    if (Number(result.changes) !== 1) fail(404, 'Saved view was not found.');
}

function setDefaultView(userId, viewId) {
    const owner = ownerId(userId);
    if (viewId === null) {
        transaction(() => clearDefault(owner));
        return null;
    }
    if (typeof viewId !== 'string' || !viewId) fail(400, 'id must be a saved view id or null.');
    return transaction(() => {
        assignDefault(owner, viewId);
        return getView(owner, viewId);
    });
}

module.exports = {
    PreferenceError,
    catalog,
    listQueries,
    listViews,
    getQuery,
    getView,
    createQuery,
    createView,
    updateQuery,
    updateView,
    deleteQuery,
    deleteView,
    setDefaultView
};
