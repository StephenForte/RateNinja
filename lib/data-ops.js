'use strict';

const crypto = require('node:crypto');
const { db, transaction } = require('./db');
const { parsePageNumber, parseDateOnly } = require('./domain');
const { RESTORE_WINDOW_DAYS } = require('./limits');
const { RATE_FIELDS, SAILING_FIELDS, validateRate, validateSailing } = require('./record-validation');

const MS_PER_DAY = 24 * 60 * 60 * 1000;
const MAX_PAGE_SIZE = 100;
const DEFAULT_PAGE_SIZE = 50;
const LOCKED_FIELDS = [
    'id',
    'owner_company_id',
    'ownerCompanyId',
    'deleted_at',
    'deletedAt',
    'deleted_operation_id',
    'deletedOperationId',
    'row_version',
    'rowVersion'
];
const RATE_FILTERS = ['origin', 'destination', 'carrier', 'effectiveFrom', 'effectiveTo'];
const SAILING_FILTERS = ['departurePort', 'carrier', 'departureFrom', 'departureTo'];
const RATE_BUSINESS = [
    'rate_type', 'origin_port', 'destination_port', 'inland_delivery_location',
    'commodity_type', 'carrier', 'contract_owner', 'contract_number', 'rate_20d', 'rate_40d', 'rate_40hc',
    'rate_effective_date', 'rate_expiration_date', 'notes_1', 'rate_view'
];
const SAILING_BUSINESS = [
    'departure', 'arrival', 'transit_time', 'vessel', 'voyage', 'service', 'carrier', 'departure_port', 'arrival_port'
];

const previews = new Map();

class DataOpsError extends Error {
    constructor(status, code, message, extra) {
        super(message);
        this.status = status;
        this.code = code;
        this.extra = extra || null;
    }
}

function tableFor(dataset) {
    if (dataset === 'rates') return 'rates';
    if (dataset === 'sailings') return 'sailings';
    throw new DataOpsError(400, 'invalid_dataset', 'Dataset must be rates or sailings.');
}

function likeContains(value) {
    return `%${String(value).toLowerCase().replace(/[\\%_]/g, '\\$&')}%`;
}

function rememberPreview(preview) {
    previews.set(preview.previewId, preview);
    if (previews.size > 200) {
        const oldest = previews.keys().next().value;
        previews.delete(oldest);
    }
}

function isUniqueConstraint(error) {
    const message = String(error && error.message || '');
    return message.includes('UNIQUE') || error?.code === 'SQLITE_CONSTRAINT_UNIQUE';
}

function pageArgs(query) {
    return {
        page: parsePageNumber(query.page, 1, 10_000),
        pageSize: parsePageNumber(query.pageSize, DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE)
    };
}

function optionalDate(value, field) {
    if (value === undefined || value === null || value === '') return '';
    if (typeof value !== 'string' || !parseDateOnly(value)) {
        throw new DataOpsError(400, 'invalid_filter', `${field} must be a valid YYYY-MM-DD date.`);
    }
    return value;
}

function parseFilter(dataset, raw) {
    tableFor(dataset);
    const source = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
    const allowed = dataset === 'rates' ? RATE_FILTERS : SAILING_FILTERS;
    for (const key of Object.keys(source)) {
        if (!allowed.includes(key)) {
            throw new DataOpsError(400, 'invalid_filter', `Unknown filter ${key}.`);
        }
    }
    const text = key => {
        const value = source[key];
        if (value === undefined || value === null || value === '') return '';
        if (typeof value !== 'string') throw new DataOpsError(400, 'invalid_filter', `${key} must be text.`);
        return value.trim();
    };
    if (dataset === 'rates') {
        return {
            origin: text('origin'),
            destination: text('destination'),
            carrier: text('carrier'),
            effectiveFrom: optionalDate(source.effectiveFrom, 'effectiveFrom'),
            effectiveTo: optionalDate(source.effectiveTo, 'effectiveTo')
        };
    }
    return {
        departurePort: text('departurePort'),
        carrier: text('carrier'),
        departureFrom: optionalDate(source.departureFrom, 'departureFrom'),
        departureTo: optionalDate(source.departureTo, 'departureTo')
    };
}

function whereFor(dataset, companyId, filter) {
    const clauses = ['owner_company_id = ?', 'deleted_at IS NULL'];
    const params = [companyId];
    const addLike = (column, value) => {
        if (!value) return;
        clauses.push(`lower(${column}) LIKE ? ESCAPE '\\'`);
        params.push(likeContains(value));
    };
    if (dataset === 'rates') {
        addLike('origin_port', filter.origin);
        addLike('destination_port', filter.destination);
        addLike('carrier', filter.carrier);
        if (filter.effectiveFrom) {
            clauses.push('rate_effective_date >= ?');
            params.push(filter.effectiveFrom);
        }
        if (filter.effectiveTo) {
            clauses.push('rate_effective_date <= ?');
            params.push(filter.effectiveTo);
        }
    } else {
        addLike('departure_port', filter.departurePort);
        addLike('carrier', filter.carrier);
        if (filter.departureFrom) {
            clauses.push('substr(departure, 1, 10) >= ?');
            params.push(filter.departureFrom);
        }
        if (filter.departureTo) {
            clauses.push('substr(departure, 1, 10) <= ?');
            params.push(filter.departureTo);
        }
    }
    return { where: clauses.join(' AND '), params };
}

function rateDto(row) {
    return {
        id: row.id,
        rowVersion: row.row_version,
        rateType: row.rate_type,
        originPort: row.origin_port,
        destinationPort: row.destination_port,
        inlandDeliveryLocation: row.inland_delivery_location,
        commodityType: row.commodity_type,
        carrier: row.carrier,
        contractOwner: row.contract_owner,
        contractNumber: row.contract_number,
        rate20D: row.rate_20d,
        rate40D: row.rate_40d,
        rate40HC: row.rate_40hc,
        rateEffectiveDate: row.rate_effective_date,
        rateExpirationDate: row.rate_expiration_date,
        notes1: row.notes_1,
        rateView: row.rate_view
    };
}

function sailingDto(row) {
    return {
        id: row.id,
        rowVersion: row.row_version,
        departure: row.departure,
        arrival: row.arrival,
        transitTime: row.transit_time,
        vessel: row.vessel,
        voyage: row.voyage,
        service: row.service,
        carrier: row.carrier,
        departurePort: row.departure_port,
        arrivalPort: row.arrival_port
    };
}

function companyPayload(companyId, companyName) {
    return { id: companyId, name: companyName || '' };
}

function recordInput(dataset, row) {
    const dto = dataset === 'rates' ? rateDto(row) : sailingDto(row);
    delete dto.id;
    delete dto.rowVersion;
    return dto;
}

// A PATCH writes the fields it names. Anything absent stays as stored.
function applyPresentFields(base, body, fields) {
    const next = { ...base };
    for (const field of fields) {
        if (Object.prototype.hasOwnProperty.call(body, field)) next[field] = body[field];
    }
    return next;
}

function searchRecords({ dataset, companyId, companyName, filter, page, pageSize }) {
    const table = tableFor(dataset);
    const parsed = parseFilter(dataset, filter);
    const { where, params } = whereFor(dataset, companyId, parsed);
    const paging = pageArgs({ page, pageSize });
    const total = Number(db.prepare(`SELECT COUNT(*) AS count FROM ${table} WHERE ${where}`).get(...params).count);
    const order = dataset === 'rates' ? 'rate_effective_date DESC, id' : 'departure DESC, id';
    const offset = (paging.page - 1) * paging.pageSize;
    const rows = db.prepare(`SELECT * FROM ${table} WHERE ${where} ORDER BY ${order} LIMIT ? OFFSET ?`).all(...params, paging.pageSize, offset);
    return {
        dataset,
        company: companyPayload(companyId, companyName),
        total,
        page: paging.page,
        pageSize: paging.pageSize,
        records: rows.map(dataset === 'rates' ? rateDto : sailingDto)
    };
}

function lockedField(body) {
    if (!body || typeof body !== 'object' || Array.isArray(body)) return null;
    for (const key of LOCKED_FIELDS) {
        if (Object.prototype.hasOwnProperty.call(body, key)) return key;
    }
    return null;
}

function unknownField(dataset, body) {
    const allowed = new Set([
        ...(dataset === 'rates' ? RATE_FIELDS : SAILING_FIELDS),
        'expectedRowVersion',
        'companyId'
    ]);
    for (const key of Object.keys(body || {})) {
        if (!allowed.has(key)) return key;
    }
    return null;
}

function requireVersion(value) {
    if (!Number.isInteger(value) || value < 1) {
        throw new DataOpsError(400, 'invalid_row_version', 'expectedRowVersion must be a positive integer.');
    }
    return value;
}

function requireSubmissionId(value) {
    if (typeof value !== 'string' || !value.trim() || value.trim().length > 200) {
        throw new DataOpsError(400, 'invalid_submission', 'submissionId is required.');
    }
    return value.trim();
}

function replaySubmission(submissionId, companyId) {
    const existing = db.prepare(`
        SELECT owner_company_id, detail_json FROM data_operations WHERE submission_id = ?
    `).get(submissionId);
    if (!existing) return null;
    if (existing.owner_company_id !== companyId) {
        throw new DataOpsError(409, 'submission_conflict', 'That submission was already used.');
    }
    return JSON.parse(existing.detail_json);
}

function insertOperation({ operationId, type, dataset, companyId, actorUserId, affectedCount, submissionId, now, detail }) {
    db.prepare(`
        INSERT INTO data_operations (
            id, type, dataset, owner_company_id, actor_user_id, status, affected_count,
            submission_id, created_at, completed_at, detail_json
        ) VALUES (?, ?, ?, ?, ?, 'completed', ?, ?, ?, ?, ?)
    `).run(
        operationId,
        type,
        dataset,
        companyId,
        actorUserId,
        affectedCount,
        submissionId,
        now,
        now,
        JSON.stringify(detail)
    );
}

function editRecord({ dataset, recordId, companyId, companyName, actorUserId, body }) {
    tableFor(dataset);
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
        throw new DataOpsError(400, 'invalid_body', 'Request body must be an object.');
    }
    const locked = lockedField(body);
    if (locked) {
        throw new DataOpsError(400, 'field_not_editable', `${locked} cannot be edited.`);
    }
    const unknown = unknownField(dataset, body);
    if (unknown) {
        throw new DataOpsError(400, 'validation', `${unknown}: Unknown field.`, { errors: [{ field: unknown, message: 'Unknown field.' }] });
    }
    const expectedRowVersion = requireVersion(body.expectedRowVersion);
    const fields = dataset === 'rates' ? RATE_FIELDS : SAILING_FIELDS;
    return transaction(() => {
        const table = tableFor(dataset);
        const prior = db.prepare(`SELECT * FROM ${table} WHERE id = ? AND owner_company_id = ? AND deleted_at IS NULL`).get(recordId, companyId);
        if (!prior) throw new DataOpsError(404, 'not_found', 'Record was not found.');
        if (prior.row_version !== expectedRowVersion) {
            throw new DataOpsError(409, 'stale_row_version', 'The record changed. Reload it and try again.');
        }
        const merged = applyPresentFields(recordInput(dataset, prior), body, fields);
        const validated = dataset === 'rates' ? validateRate(merged) : validateSailing(merged);
        if (!validated.ok) {
            const message = validated.errors.map(error => `${error.field}: ${error.message}`).join(' ');
            throw new DataOpsError(400, 'validation', message, { errors: validated.errors });
        }
        const value = validated.value;
        const result = dataset === 'rates'
            ? db.prepare(`
                UPDATE rates SET
                    rate_type = ?, origin_port = ?, destination_port = ?, inland_delivery_location = ?,
                    commodity_type = ?, carrier = ?, contract_owner = ?, contract_number = ?,
                    rate_20d = ?, rate_40d = ?, rate_40hc = ?,
                    rate_effective_date = ?, rate_expiration_date = ?, notes_1 = ?, rate_view = ?,
                    row_version = row_version + 1
                WHERE id = ? AND owner_company_id = ? AND deleted_at IS NULL AND row_version = ?
            `).run(
                value.rateType, value.originPort, value.destinationPort, value.inlandDeliveryLocation,
                value.commodityType, value.carrier, value.contractOwner, value.contractNumber,
                value.rate20D, value.rate40D, value.rate40HC,
                value.rateEffectiveDate, value.rateExpirationDate, value.notes1, value.rateView,
                recordId, companyId, expectedRowVersion
            )
            : db.prepare(`
                UPDATE sailings SET
                    carrier = ?, departure_port = ?, arrival_port = ?, departure = ?, arrival = ?,
                    transit_time = ?, vessel = ?, voyage = ?, service = ?,
                    row_version = row_version + 1
                WHERE id = ? AND owner_company_id = ? AND deleted_at IS NULL AND row_version = ?
            `).run(
                value.carrier, value.departurePort, value.arrivalPort, value.departure, value.arrival,
                value.transitTime, value.vessel, value.voyage, value.service,
                recordId, companyId, expectedRowVersion
            );
        if (Number(result.changes) !== 1) {
            throw new DataOpsError(409, 'stale_row_version', 'The record changed. Reload it and try again.');
        }
        const now = new Date().toISOString();
        const operationId = crypto.randomUUID();
        const response = {
            ok: true,
            operationId,
            dataset,
            affectedCount: 1,
            status: 'completed',
            rowVersion: expectedRowVersion + 1,
            company: companyPayload(companyId, companyName)
        };
        insertOperation({
            operationId,
            type: 'edit',
            dataset,
            companyId,
            actorUserId,
            affectedCount: 1,
            submissionId: null,
            now,
            detail: { companyName: companyName || '' }
        });
        db.prepare(`
            INSERT INTO data_operation_items (operation_id, dataset, record_id, action, prior_json)
            VALUES (?, ?, ?, 'edit', ?)
        `).run(operationId, dataset, recordId, JSON.stringify(prior));
        return response;
    });
}

function resolveSelection(dataset, companyId, selection) {
    const table = tableFor(dataset);
    if (!selection || typeof selection !== 'object' || Array.isArray(selection)) {
        throw new DataOpsError(400, 'invalid_selection', 'Selection must be ids or a filter.');
    }
    const hasIds = Object.prototype.hasOwnProperty.call(selection, 'ids');
    const hasFilter = Object.prototype.hasOwnProperty.call(selection, 'filter');
    if (hasIds === hasFilter) {
        throw new DataOpsError(400, 'invalid_selection', 'Send either ids or a filter.');
    }
    if (hasIds) {
        if (!Array.isArray(selection.ids) || selection.ids.some(id => typeof id !== 'string' || !id)) {
            throw new DataOpsError(400, 'invalid_selection', 'ids must be a list of record ids.');
        }
        const ids = [...new Set(selection.ids)];
        if (!ids.length) throw new DataOpsError(400, 'empty_selection', 'Select at least one record.');
        const read = db.prepare(`SELECT id, row_version FROM ${table} WHERE id = ? AND owner_company_id = ? AND deleted_at IS NULL`);
        const rows = [];
        for (const id of ids) {
            const row = read.get(id, companyId);
            if (!row) throw new DataOpsError(404, 'not_found', 'A selected record is not available.');
            rows.push({ id: row.id, rowVersion: row.row_version });
        }
        return rows;
    }
    const filter = parseFilter(dataset, selection.filter);
    const { where, params } = whereFor(dataset, companyId, filter);
    const rows = db.prepare(`SELECT id, row_version FROM ${table} WHERE ${where} ORDER BY id`).all(...params);
    if (!rows.length) throw new DataOpsError(400, 'empty_selection', 'No records match that selection.');
    return rows.map(row => ({ id: row.id, rowVersion: row.row_version }));
}

function previewDelete({ dataset, companyId, companyName, selection }) {
    const rows = resolveSelection(dataset, companyId, selection);
    const previewId = crypto.randomUUID();
    rememberPreview({ previewId, dataset, companyId, rows });
    return {
        previewId,
        dataset,
        count: rows.length,
        company: companyPayload(companyId, companyName),
        records: rows
    };
}

function commitDelete({ previewId, submissionId, companyId, companyName, actorUserId }) {
    const submission = requireSubmissionId(submissionId);
    if (typeof previewId !== 'string' || !previewId) {
        throw new DataOpsError(400, 'invalid_preview', 'previewId is required.');
    }
    const preview = previews.get(previewId);
    if (!preview || preview.companyId !== companyId) {
        throw new DataOpsError(404, 'preview_not_found', 'Delete preview was not found. Preview again.');
    }
    const run = () => transaction(() => {
        const replay = replaySubmission(submission, companyId);
        if (replay) return replay;
        const table = tableFor(preview.dataset);
        const now = new Date().toISOString();
        const operationId = crypto.randomUUID();
        const response = {
            ok: true,
            operationId,
            dataset: preview.dataset,
            affectedCount: preview.rows.length,
            status: 'completed',
            company: companyPayload(companyId, companyName)
        };
        const read = db.prepare(`SELECT * FROM ${table} WHERE id = ? AND owner_company_id = ?`);
        const insertItem = db.prepare(`
            INSERT INTO data_operation_items (operation_id, dataset, record_id, action, prior_json)
            VALUES (?, ?, ?, 'delete', ?)
        `);
        const mark = db.prepare(`
            UPDATE ${table}
            SET deleted_at = ?, deleted_operation_id = ?, row_version = row_version + 1
            WHERE id = ? AND owner_company_id = ? AND deleted_at IS NULL AND row_version = ?
        `);
        const priors = [];
        for (const item of preview.rows) {
            const prior = read.get(item.id, companyId);
            if (!prior || prior.deleted_at || prior.row_version !== item.rowVersion) {
                throw new DataOpsError(409, 'preview_stale', 'The selection changed. Preview again. Nothing was deleted.');
            }
            priors.push(prior);
        }
        insertOperation({
            operationId,
            type: 'delete',
            dataset: preview.dataset,
            companyId,
            actorUserId,
            affectedCount: preview.rows.length,
            submissionId: submission,
            now,
            detail: response
        });
        preview.rows.forEach((item, index) => {
            insertItem.run(operationId, preview.dataset, item.id, JSON.stringify(priors[index]));
            const result = mark.run(now, operationId, item.id, companyId, item.rowVersion);
            if (Number(result.changes) !== 1) {
                throw new DataOpsError(409, 'preview_stale', 'The selection changed. Preview again. Nothing was deleted.');
            }
        });
        return response;
    });
    try {
        return run();
    } catch (error) {
        if (error instanceof DataOpsError) throw error;
        if (isUniqueConstraint(error)) {
            const replay = replaySubmission(submission, companyId);
            if (replay) return replay;
        }
        throw error;
    }
}

function sameBusinessValue(left, right) {
    return (left ?? null) === (right ?? null);
}

function businessChanged(dataset, current, prior) {
    const keys = dataset === 'rates' ? RATE_BUSINESS : SAILING_BUSINESS;
    return keys.some(key => !sameBusinessValue(current[key], prior[key]));
}

function outsideWindow(deletedAt) {
    const parsed = Date.parse(deletedAt);
    if (Number.isNaN(parsed)) return true;
    return Date.now() - parsed > RESTORE_WINDOW_DAYS * MS_PER_DAY;
}

function restoreOperation({ operationId, submissionId, companyId, companyName, actorUserId }) {
    const submission = requireSubmissionId(submissionId);
    if (typeof operationId !== 'string' || !operationId) {
        throw new DataOpsError(400, 'invalid_operation', 'Operation id is required.');
    }
    const run = () => transaction(() => {
        const replay = replaySubmission(submission, companyId);
        if (replay) return replay;
        const operation = db.prepare(`
            SELECT * FROM data_operations WHERE id = ? AND owner_company_id = ?
        `).get(operationId, companyId);
        if (!operation || operation.type !== 'delete') {
            throw new DataOpsError(404, 'not_found', 'Delete operation was not found.');
        }
        const items = db.prepare(`
            SELECT * FROM data_operation_items
            WHERE operation_id = ? AND action = 'delete'
            ORDER BY record_id
        `).all(operationId);
        if (!items.length) throw new DataOpsError(400, 'empty_selection', 'That operation has no records to restore.');
        const table = tableFor(operation.dataset);
        const read = db.prepare(`SELECT * FROM ${table} WHERE id = ?`);
        const conflicts = [];
        const pending = [];
        let windowExpired = false;
        for (const item of items) {
            const current = read.get(item.record_id);
            const prior = item.prior_json ? JSON.parse(item.prior_json) : {};
            if (!current || current.owner_company_id !== companyId) {
                conflicts.push({ id: item.record_id, reason: 'missing' });
                continue;
            }
            if (!current.deleted_at) {
                conflicts.push({ id: item.record_id, reason: 'not_deleted' });
                continue;
            }
            if (outsideWindow(current.deleted_at)) {
                windowExpired = true;
                continue;
            }
            const expectedVersion = Number(prior.row_version) + 1;
            if (current.deleted_operation_id !== operationId || current.row_version !== expectedVersion || businessChanged(operation.dataset, current, prior)) {
                conflicts.push({ id: item.record_id, reason: 'changed' });
                continue;
            }
            pending.push({ current, prior });
        }
        if (windowExpired) {
            throw new DataOpsError(409, 'restore_window', 'The restore window has passed.');
        }
        if (conflicts.length || pending.length !== items.length) {
            throw new DataOpsError(409, 'restore_conflict', 'Some records changed after they were deleted. Nothing was restored.', { conflicts });
        }
        const now = new Date().toISOString();
        const restoreId = crypto.randomUUID();
        const response = {
            ok: true,
            operationId: restoreId,
            restoredOperationId: operationId,
            dataset: operation.dataset,
            affectedCount: pending.length,
            status: 'completed',
            company: companyPayload(companyId, companyName)
        };
        const mark = db.prepare(`
            UPDATE ${table}
            SET deleted_at = NULL, deleted_operation_id = NULL, row_version = row_version + 1
            WHERE id = ? AND owner_company_id = ? AND deleted_operation_id = ? AND row_version = ? AND deleted_at IS NOT NULL
        `);
        insertOperation({
            operationId: restoreId,
            type: 'restore',
            dataset: operation.dataset,
            companyId,
            actorUserId,
            affectedCount: pending.length,
            submissionId: submission,
            now,
            detail: response
        });
        const insertItem = db.prepare(`
            INSERT INTO data_operation_items (operation_id, dataset, record_id, action, prior_json)
            VALUES (?, ?, ?, 'restore', ?)
        `);
        for (const item of pending) {
            insertItem.run(restoreId, operation.dataset, item.current.id, JSON.stringify(item.current));
            const result = mark.run(item.current.id, companyId, operationId, item.current.row_version);
            if (Number(result.changes) !== 1) {
                throw new DataOpsError(409, 'restore_conflict', 'Some records changed after they were deleted. Nothing was restored.', {
                    conflicts: [{ id: item.current.id, reason: 'changed' }]
                });
            }
        }
        return response;
    });
    try {
        return run();
    } catch (error) {
        if (error instanceof DataOpsError) throw error;
        if (isUniqueConstraint(error)) {
            const replay = replaySubmission(submission, companyId);
            if (replay) return replay;
        }
        throw error;
    }
}

function undoConflict(conflicts) {
    const list = conflicts.map(item => `${item.id} (${item.reason})`).join(', ');
    throw new DataOpsError(
        409,
        'undo_conflict',
        `Undo refused because a record changed since this operation. Nothing was changed. Conflicts: ${list}.`,
        { conflicts }
    );
}

function undoAlreadyRecorded(companyId, operationId) {
    const rows = db.prepare(`
        SELECT detail_json FROM data_operations
        WHERE owner_company_id = ? AND type IN ('undo', 'restore')
    `).all(companyId);
    return rows.some(row => {
        if (!row.detail_json) return false;
        try {
            const detail = JSON.parse(row.detail_json);
            return detail.undoneOperationId === operationId || detail.restoredOperationId === operationId;
        } catch {
            return false;
        }
    });
}

function listConflicts(error) {
    if (!(error instanceof DataOpsError) || !error.extra?.conflicts?.length) throw error;
    const list = error.extra.conflicts.map(item => `${item.id} (${item.reason})`).join(', ');
    throw new DataOpsError(error.status, error.code, `${error.message} Conflicts: ${list}.`, error.extra);
}

function restoreEditedRow(dataset, prior, current, companyId) {
    const expected = current.row_version;
    const result = dataset === 'rates'
        ? db.prepare(`
            UPDATE rates SET
                rate_type = ?, origin_port = ?, destination_port = ?, inland_delivery_location = ?,
                commodity_type = ?, carrier = ?, contract_owner = ?, contract_number = ?,
                rate_20d = ?, rate_40d = ?, rate_40hc = ?,
                rate_effective_date = ?, rate_expiration_date = ?, notes_1 = ?, rate_view = ?,
                row_version = row_version + 1
            WHERE id = ? AND owner_company_id = ? AND deleted_at IS NULL AND row_version = ?
        `).run(
            prior.rate_type, prior.origin_port, prior.destination_port, prior.inland_delivery_location,
            prior.commodity_type, prior.carrier, prior.contract_owner, prior.contract_number,
            prior.rate_20d, prior.rate_40d, prior.rate_40hc,
            prior.rate_effective_date, prior.rate_expiration_date, prior.notes_1, prior.rate_view,
            current.id, companyId, expected
        )
        : db.prepare(`
            UPDATE sailings SET
                carrier = ?, departure_port = ?, arrival_port = ?, departure = ?, arrival = ?,
                transit_time = ?, vessel = ?, voyage = ?, service = ?,
                row_version = row_version + 1
            WHERE id = ? AND owner_company_id = ? AND deleted_at IS NULL AND row_version = ?
        `).run(
            prior.carrier, prior.departure_port, prior.arrival_port, prior.departure, prior.arrival,
            prior.transit_time, prior.vessel, prior.voyage, prior.service,
            current.id, companyId, expected
        );
    if (Number(result.changes) !== 1) {
        undoConflict([{ id: current.id, reason: 'changed' }]);
    }
}

function undoEditOrPullForward({ operation, companyId, companyName, actorUserId, submission }) {
    if (outsideWindow(operation.created_at)) {
        throw new DataOpsError(409, 'restore_window', 'The restore window has passed.');
    }
    if (undoAlreadyRecorded(companyId, operation.id)) {
        throw new DataOpsError(409, 'already_undone', 'That operation was already undone.');
    }
    const items = db.prepare(`
        SELECT * FROM data_operation_items WHERE operation_id = ? ORDER BY record_id
    `).all(operation.id);
    if (!items.length) throw new DataOpsError(400, 'empty_selection', 'That operation has no records to undo.');
    const table = tableFor(operation.dataset);
    const read = db.prepare(`SELECT * FROM ${table} WHERE id = ?`);
    const conflicts = [];
    const pending = [];
    for (const item of items) {
        const current = read.get(item.record_id);
        const prior = item.prior_json ? JSON.parse(item.prior_json) : null;
        if (!current || current.owner_company_id !== companyId || !prior) {
            conflicts.push({ id: item.record_id, reason: current ? 'changed' : 'missing' });
            continue;
        }
        if (operation.type === 'edit') {
            const expected = Number(prior.row_version) + 1;
            if (item.action !== 'edit' || current.deleted_at || current.row_version !== expected) {
                conflicts.push({ id: item.record_id, reason: 'changed' });
                continue;
            }
            pending.push({ item, current, prior });
            continue;
        }
        if (item.action === 'create') {
            if (current.deleted_at || current.row_version !== Number(prior.row_version) || businessChanged(operation.dataset, current, prior)) {
                conflicts.push({ id: item.record_id, reason: 'changed' });
                continue;
            }
            pending.push({ item, current, prior });
            continue;
        }
        if (item.action === 'replace') {
            const expected = Number(prior.row_version) + 1;
            if (!current.deleted_at || current.deleted_operation_id !== operation.id || current.row_version !== expected || businessChanged(operation.dataset, current, prior)) {
                conflicts.push({ id: item.record_id, reason: 'changed' });
                continue;
            }
            pending.push({ item, current, prior });
            continue;
        }
        conflicts.push({ id: item.record_id, reason: 'changed' });
    }
    if (conflicts.length || pending.length !== items.length) undoConflict(conflicts);
    const now = new Date().toISOString();
    const undoId = crypto.randomUUID();
    const response = {
        ok: true,
        operationId: undoId,
        undoneOperationId: operation.id,
        dataset: operation.dataset,
        affectedCount: pending.length,
        status: 'completed',
        company: companyPayload(companyId, companyName)
    };
    insertOperation({
        operationId: undoId,
        type: 'undo',
        dataset: operation.dataset,
        companyId,
        actorUserId,
        affectedCount: pending.length,
        submissionId: submission,
        now,
        detail: response
    });
    const insertItem = db.prepare(`
        INSERT INTO data_operation_items (operation_id, dataset, record_id, action, prior_json)
        VALUES (?, ?, ?, 'undo', ?)
    `);
    const hideCreated = db.prepare(`
        UPDATE ${table}
        SET deleted_at = ?, deleted_operation_id = ?, row_version = row_version + 1
        WHERE id = ? AND owner_company_id = ? AND deleted_at IS NULL AND row_version = ?
    `);
    const restoreReplaced = db.prepare(`
        UPDATE ${table}
        SET deleted_at = NULL, deleted_operation_id = NULL, row_version = row_version + 1
        WHERE id = ? AND owner_company_id = ? AND deleted_operation_id = ? AND row_version = ? AND deleted_at IS NOT NULL
    `);
    for (const entry of pending) {
        insertItem.run(undoId, operation.dataset, entry.current.id, JSON.stringify(entry.current));
        if (operation.type === 'edit') {
            restoreEditedRow(operation.dataset, entry.prior, entry.current, companyId);
            continue;
        }
        if (entry.item.action === 'create') {
            const result = hideCreated.run(now, undoId, entry.current.id, companyId, entry.current.row_version);
            if (Number(result.changes) !== 1) undoConflict([{ id: entry.current.id, reason: 'changed' }]);
            continue;
        }
        const result = restoreReplaced.run(entry.current.id, companyId, operation.id, entry.current.row_version);
        if (Number(result.changes) !== 1) undoConflict([{ id: entry.current.id, reason: 'changed' }]);
    }
    return response;
}

function undoOperation({ operationId, submissionId, companyId, companyName, actorUserId }) {
    const submission = requireSubmissionId(submissionId);
    if (typeof operationId !== 'string' || !operationId) {
        throw new DataOpsError(400, 'invalid_operation', 'Operation id is required.');
    }
    const replay = replaySubmission(submission, companyId);
    if (replay) return replay;
    const peek = db.prepare(`SELECT * FROM data_operations WHERE id = ? AND owner_company_id = ?`).get(operationId, companyId);
    if (!peek) throw new DataOpsError(404, 'not_found', 'Operation was not found.');
    if (peek.type !== 'edit' && peek.type !== 'pull-forward' && peek.type !== 'delete' && peek.type !== 'import') {
        throw new DataOpsError(409, 'not_undoable', 'That operation cannot be undone.');
    }
    if (outsideWindow(peek.created_at)) {
        throw new DataOpsError(409, 'restore_window', 'The restore window has passed.');
    }
    if (undoAlreadyRecorded(companyId, operationId)) {
        throw new DataOpsError(409, 'already_undone', 'That operation was already undone.');
    }
    if (peek.type === 'delete') {
        try {
            return restoreOperation({ operationId, submissionId: submission, companyId, companyName, actorUserId });
        } catch (error) {
            listConflicts(error);
        }
    }
    const run = () => transaction(() => {
        const replay = replaySubmission(submission, companyId);
        if (replay) return replay;
        const operation = db.prepare(`SELECT * FROM data_operations WHERE id = ? AND owner_company_id = ?`).get(operationId, companyId);
        if (!operation || (operation.type !== 'edit' && operation.type !== 'pull-forward' && operation.type !== 'import')) {
            throw new DataOpsError(409, 'not_undoable', 'That operation cannot be undone.');
        }
        return undoEditOrPullForward({ operation, companyId, companyName, actorUserId, submission });
    });
    try {
        return run();
    } catch (error) {
        if (error instanceof DataOpsError) throw error;
        if (isUniqueConstraint(error)) {
            const replay = replaySubmission(submission, companyId);
            if (replay) return replay;
        }
        throw error;
    }
}

function listHistory({ companyId, companyName, page, pageSize }) {
    const paging = pageArgs({ page, pageSize });
    const total = Number(db.prepare(`SELECT COUNT(*) AS count FROM data_operations WHERE owner_company_id = ?`).get(companyId).count);
    const offset = (paging.page - 1) * paging.pageSize;
    const rows = db.prepare(`
        SELECT o.id, o.type, o.dataset, o.status, o.affected_count, o.created_at, o.actor_user_id,
               u.username AS actor_username, u.display_name AS actor_display_name,
               c.company_name
        FROM data_operations o
        LEFT JOIN users u ON u.id = o.actor_user_id
        LEFT JOIN companies c ON c.id = o.owner_company_id
        WHERE o.owner_company_id = ?
        ORDER BY o.created_at DESC, o.id DESC
        LIMIT ? OFFSET ?
    `).all(companyId, paging.pageSize, offset);
    return {
        company: companyPayload(companyId, companyName),
        total,
        page: paging.page,
        pageSize: paging.pageSize,
        operations: rows.map(row => ({
            id: row.id,
            type: row.type,
            dataset: row.dataset,
            status: row.status,
            affectedCount: row.affected_count,
            createdAt: row.created_at,
            actor: {
                id: row.actor_user_id,
                username: row.actor_username || '',
                displayName: row.actor_display_name || ''
            },
            company: { id: companyId, name: row.company_name || companyName || '' }
        }))
    };
}

module.exports = {
    DataOpsError,
    parseFilter,
    searchRecords,
    editRecord,
    previewDelete,
    commitDelete,
    restoreOperation,
    undoOperation,
    listHistory,
    insertOperation,
    replaySubmission,
    requireSubmissionId
};
