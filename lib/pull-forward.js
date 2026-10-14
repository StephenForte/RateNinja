'use strict';

// Pull-forward preview and commit. Soft-deletes matching target rows through a
// data_operations row. Migration 006 already stores the operation, its items,
// and each replaced row's prior state, so 007 is not required.

const crypto = require('node:crypto');
const { db, transaction } = require('./db');
const { parseDateOnly, shiftDateOnly, shiftDateTime, validatePullForwardRange } = require('./domain');
const { DataOpsError, insertOperation, replaySubmission, requireSubmissionId } = require('./data-ops');

const MS_PER_DAY = 24 * 60 * 60 * 1000;
const previews = new Map();

function tableFor(dataset) {
    if (dataset === 'rates' || dataset === 'sailings') return dataset;
    throw new DataOpsError(400, 'invalid_dataset', 'Dataset must be rates or sailings.');
}

function rememberPreview(preview) {
    previews.set(preview.previewId, preview);
    if (previews.size > 200) previews.delete(previews.keys().next().value);
}

function emptyFilter(dataset) {
    return dataset === 'rates'
        ? { carrier: '', origin: '', destination: '' }
        : { carrier: '', departurePort: '' };
}

function parsePullFilter(dataset, raw) {
    tableFor(dataset);
    const source = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
    const allowed = dataset === 'rates'
        ? ['carrier', 'origin', 'destination']
        : ['carrier', 'departurePort'];
    for (const key of Object.keys(source)) {
        if (!allowed.includes(key)) throw new DataOpsError(400, 'invalid_filter', `Unknown filter ${key}.`);
    }
    const text = key => {
        if (!Object.prototype.hasOwnProperty.call(source, key)) return '';
        const value = source[key];
        if (value === undefined || value === null || value === '') return '';
        if (typeof value !== 'string') throw new DataOpsError(400, 'invalid_filter', `${key} must be text.`);
        return value.trim();
    };
    const filter = emptyFilter(dataset);
    filter.carrier = text('carrier');
    if (dataset === 'rates') {
        filter.origin = text('origin');
        filter.destination = text('destination');
    } else {
        filter.departurePort = text('departurePort');
    }
    return filter;
}

function parseConflict(value) {
    if (value === undefined || value === null || value === '' || value === 'keep') return 'keep';
    if (value === 'replace') return 'replace';
    throw new DataOpsError(400, 'invalid_conflict', 'Conflict choice must be keep or replace.');
}

function parsePrice(dataset, value) {
    if (dataset !== 'rates') return 0;
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 100) {
        throw new DataOpsError(400, 'invalid_price', 'Price increase percent must be a number between 0 and 100.');
    }
    return value;
}

function resolveRange(body) {
    const sourceStart = body.sourceStart;
    const sourceEnd = body.sourceEnd;
    const targetStart = body.targetStart;
    let targetEnd = body.targetEnd;
    if (targetEnd === undefined || targetEnd === null || targetEnd === '') {
        const start = parseDateOnly(sourceStart);
        const sEnd = parseDateOnly(sourceEnd);
        const tStart = parseDateOnly(targetStart);
        if (!start || !sEnd || !tStart) {
            throw new DataOpsError(400, 'invalid_range', 'sourceStart, sourceEnd, and targetStart must all be valid YYYY-MM-DD dates.');
        }
        if (start.getTime() > sEnd.getTime()) {
            throw new DataOpsError(400, 'invalid_range', 'Source start date must not be after source end date.');
        }
        const offset = Math.round((tStart.getTime() - start.getTime()) / MS_PER_DAY);
        targetEnd = shiftDateOnly(sourceEnd, offset);
    }
    const validation = validatePullForwardRange({ sourceStart, sourceEnd, targetStart, targetEnd });
    if (validation.error) throw new DataOpsError(400, 'invalid_range', validation.error);
    return {
        sourceStart,
        sourceEnd,
        targetStart,
        targetEnd,
        offsetDays: validation.offsetDays
    };
}

function addExact(clauses, params, column, value) {
    if (!value) return;
    clauses.push(`lower(${column}) = lower(?)`);
    params.push(value);
}

// Exact, case-insensitive filters. Replace must not spill onto another carrier,
// route, or owner just because the date window matches.
function selectLive(dataset, { companyId, start, end, filter }) {
    const table = tableFor(dataset);
    const clauses = ['deleted_at IS NULL'];
    const params = [];
    if (companyId) {
        clauses.push('owner_company_id = ?');
        params.push(companyId);
    }
    if (dataset === 'rates') {
        clauses.push('rate_effective_date >= ?', 'rate_effective_date <= ?');
        params.push(start, end);
        addExact(clauses, params, 'carrier', filter.carrier);
        addExact(clauses, params, 'origin_port', filter.origin);
        addExact(clauses, params, 'destination_port', filter.destination);
    } else {
        clauses.push('substr(departure, 1, 10) >= ?', 'substr(departure, 1, 10) <= ?');
        params.push(start, end);
        addExact(clauses, params, 'carrier', filter.carrier);
        addExact(clauses, params, 'departure_port', filter.departurePort);
    }
    return db.prepare(`SELECT * FROM ${table} WHERE ${clauses.join(' AND ')} ORDER BY id`).all(...params);
}

function scaleMoney(value, percent) {
    if (value === null || value === undefined) return null;
    return Math.round(Number(value) * (1 + percent / 100));
}

function summarize(dataset, row) {
    if (dataset === 'rates') {
        return {
            id: row.id,
            rowVersion: row.row_version,
            carrier: row.carrier || '',
            origin: row.origin_port || '',
            destination: row.destination_port || '',
            date: row.rate_effective_date || ''
        };
    }
    return {
        id: row.id,
        rowVersion: row.row_version,
        carrier: row.carrier || '',
        departurePort: row.departure_port || '',
        date: String(row.departure || '').slice(0, 10)
    };
}

function companyPayload(companyId, companyName) {
    return { id: companyId, name: companyName || '' };
}

function buildPlan({ dataset, companyId, range, conflict, priceIncreasePercent, filter }) {
    const sources = selectLive(dataset, {
        companyId,
        start: range.sourceStart,
        end: range.sourceEnd,
        filter
    });
    const replaced = conflict === 'replace'
        ? selectLive(dataset, {
            companyId,
            start: range.targetStart,
            end: range.targetEnd,
            filter
        })
        : [];
    return {
        dataset,
        companyId: companyId || null,
        conflict,
        priceIncreasePercent,
        filter,
        ...range,
        sources,
        replaced
    };
}

function softDelete(dataset, rows, operationId, now, companyId) {
    const table = tableFor(dataset);
    const sql = companyId
        ? `UPDATE ${table}
           SET deleted_at = ?, deleted_operation_id = ?, row_version = row_version + 1
           WHERE id = ? AND owner_company_id = ? AND deleted_at IS NULL AND row_version = ?`
        : `UPDATE ${table}
           SET deleted_at = ?, deleted_operation_id = ?, row_version = row_version + 1
           WHERE id = ? AND deleted_at IS NULL AND row_version = ?`;
    const mark = db.prepare(sql);
    for (const row of rows) {
        const result = companyId
            ? mark.run(now, operationId, row.id, companyId, row.row_version)
            : mark.run(now, operationId, row.id, row.row_version);
        if (Number(result.changes) !== 1) {
            throw new DataOpsError(409, 'preview_stale', 'The selection changed. Preview again. Nothing was copied.');
        }
    }
}

function insertCopies(plan) {
    const created = [];
    if (plan.dataset === 'rates') {
        const insert = db.prepare(`
            INSERT INTO rates (
                id, rate_type, origin_port, destination_port, inland_delivery_location,
                commodity_type, carrier, contract_owner, rate_20d, rate_40d, rate_40hc,
                rate_effective_date, rate_expiration_date, notes_1, rate_view, owner_company_id, row_version
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)
        `);
        const read = db.prepare('SELECT * FROM rates WHERE id = ?');
        for (const row of plan.sources) {
            const id = crypto.randomUUID();
            insert.run(
                id,
                row.rate_type,
                row.origin_port,
                row.destination_port,
                row.inland_delivery_location,
                row.commodity_type,
                row.carrier,
                row.contract_owner,
                scaleMoney(row.rate_20d, plan.priceIncreasePercent),
                scaleMoney(row.rate_40d, plan.priceIncreasePercent),
                scaleMoney(row.rate_40hc, plan.priceIncreasePercent),
                shiftDateOnly(row.rate_effective_date, plan.offsetDays),
                shiftDateOnly(row.rate_expiration_date, plan.offsetDays),
                row.notes_1,
                row.rate_view,
                row.owner_company_id ?? plan.companyId ?? null
            );
            created.push(read.get(id));
        }
        return created;
    }
    const insert = db.prepare(`
        INSERT INTO sailings (
            id, departure, arrival, transit_time, vessel, voyage, service, carrier, departure_port, owner_company_id, row_version
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)
    `);
    const read = db.prepare('SELECT * FROM sailings WHERE id = ?');
    for (const row of plan.sources) {
        const id = crypto.randomUUID();
        insert.run(
            id,
            shiftDateTime(row.departure, plan.offsetDays),
            shiftDateTime(row.arrival, plan.offsetDays),
            row.transit_time,
            row.vessel,
            row.voyage,
            row.service,
            row.carrier,
            row.departure_port,
            row.owner_company_id ?? plan.companyId ?? null
        );
        created.push(read.get(id));
    }
    return created;
}

function snapshot(row) {
    return JSON.parse(JSON.stringify(row));
}

function recordOperation(plan, { actorUserId, companyName, submissionId, previewId }) {
    const now = new Date().toISOString();
    const operationId = crypto.randomUUID();
    const replacedPriors = plan.replaced.map(snapshot);
    const response = {
        ok: true,
        operationId,
        dataset: plan.dataset,
        affectedCount: plan.sources.length + plan.replaced.length,
        copied: plan.sources.length,
        deleted: plan.replaced.length,
        status: 'completed',
        company: companyPayload(plan.companyId, companyName),
        previewId: previewId || null,
        conflict: plan.conflict,
        targetStart: plan.targetStart,
        targetEnd: plan.targetEnd
    };
    insertOperation({
        operationId,
        type: 'pull-forward',
        dataset: plan.dataset,
        companyId: plan.companyId,
        actorUserId,
        affectedCount: response.affectedCount,
        submissionId,
        now,
        detail: response
    });
    softDelete(plan.dataset, replacedPriors, operationId, now, plan.companyId);
    const created = insertCopies(plan);
    const insertItem = db.prepare(`
        INSERT INTO data_operation_items (operation_id, dataset, record_id, action, prior_json)
        VALUES (?, ?, ?, ?, ?)
    `);
    for (const prior of replacedPriors) {
        insertItem.run(operationId, plan.dataset, prior.id, 'replace', JSON.stringify(prior));
    }
    for (const row of created) {
        insertItem.run(operationId, plan.dataset, row.id, 'create', JSON.stringify(row));
    }
    return response;
}

function committedPreview(previewId, submission) {
    const rows = db.prepare(`
        SELECT submission_id, detail_json, owner_company_id
        FROM data_operations
        WHERE instr(detail_json, ?) > 0
    `).all(previewId);
    for (const row of rows) {
        let detail = null;
        try {
            detail = JSON.parse(row.detail_json);
        } catch {
            detail = null;
        }
        if (!detail || detail.previewId !== previewId) continue;
        if (row.submission_id === submission) return { replay: detail };
        return { conflict: true };
    }
    return null;
}

function isUniqueConstraint(error) {
    const message = String(error && error.message || '');
    return message.includes('UNIQUE') || error?.code === 'SQLITE_CONSTRAINT_UNIQUE';
}

function readChecked(dataset, companyId, expected) {
    const table = tableFor(dataset);
    const row = db.prepare(`SELECT * FROM ${table} WHERE id = ?`).get(expected.id);
    if (!row || row.deleted_at || row.owner_company_id !== companyId || row.row_version !== expected.rowVersion) {
        throw new DataOpsError(409, 'preview_stale', 'The selection changed. Preview again. Nothing was copied.');
    }
    return row;
}

function previewPullForward({ dataset, companyId, companyName, body }) {
    tableFor(dataset);
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
        throw new DataOpsError(400, 'invalid_body', 'Request body must be an object.');
    }
    const range = resolveRange(body);
    const conflict = parseConflict(body.conflict);
    const priceIncreasePercent = parsePrice(dataset, dataset === 'rates' ? body.priceIncreasePercent : 0);
    const filter = parsePullFilter(dataset, body.filter);
    const plan = buildPlan({ dataset, companyId, range, conflict, priceIncreasePercent, filter });
    if (!plan.sources.length) {
        throw new DataOpsError(400, 'empty_selection', 'No records match that source.');
    }
    const previewId = crypto.randomUUID();
    rememberPreview({
        previewId,
        dataset,
        companyId,
        conflict,
        priceIncreasePercent,
        filter,
        ...range,
        sources: plan.sources.map(row => ({ id: row.id, rowVersion: row.row_version })),
        replaced: plan.replaced.map(row => ({ id: row.id, rowVersion: row.row_version }))
    });
    return {
        previewId,
        dataset,
        conflict,
        ...range,
        priceIncreasePercent,
        filter,
        copied: plan.sources.length,
        replaced: plan.replaced.length,
        company: companyPayload(companyId, companyName),
        sources: plan.sources.map(row => summarize(dataset, row)),
        replacedRecords: plan.replaced.map(row => summarize(dataset, row))
    };
}

function commitPullForward({ previewId, submissionId, companyId, companyName, actorUserId }) {
    const submission = requireSubmissionId(submissionId);
    if (typeof previewId !== 'string' || !previewId) {
        throw new DataOpsError(400, 'invalid_preview', 'previewId is required.');
    }
    const run = () => transaction(() => {
        const replay = replaySubmission(submission, companyId);
        if (replay) return replay;
        const preview = previews.get(previewId);
        if (!preview || preview.companyId !== companyId) {
            throw new DataOpsError(404, 'preview_not_found', 'Pull-forward preview was not found. Preview again.');
        }
        const priorCommit = committedPreview(previewId, submission);
        if (priorCommit?.replay) return priorCommit.replay;
        if (priorCommit?.conflict) {
            throw new DataOpsError(409, 'preview_stale', 'That preview was already committed. Preview again. Nothing was copied.');
        }
        const sources = preview.sources.map(item => readChecked(preview.dataset, companyId, item));
        const replaced = preview.replaced.map(item => readChecked(preview.dataset, companyId, item));
        return recordOperation({
            dataset: preview.dataset,
            companyId,
            conflict: preview.conflict,
            priceIncreasePercent: preview.priceIncreasePercent,
            filter: preview.filter,
            sourceStart: preview.sourceStart,
            sourceEnd: preview.sourceEnd,
            targetStart: preview.targetStart,
            targetEnd: preview.targetEnd,
            offsetDays: preview.offsetDays,
            sources,
            replaced
        }, {
            actorUserId,
            companyName,
            submissionId: submission,
            previewId
        });
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

function executeLegacy({ dataset, companyId, companyName, actorUserId, sourceStart, sourceEnd, targetStart, targetEnd, offsetDays, priceIncreasePercent, conflict }) {
    if (!companyId) throw new DataOpsError(400, 'invalid_company', 'A company is required.');
    tableFor(dataset);
    const submissionId = `legacy-${crypto.randomUUID()}`;
    return transaction(() => {
        const plan = buildPlan({
            dataset,
            companyId,
            range: { sourceStart, sourceEnd, targetStart, targetEnd, offsetDays },
            conflict: conflict === 'replace' ? 'replace' : 'keep',
            priceIncreasePercent: dataset === 'rates' ? priceIncreasePercent : 0,
            filter: emptyFilter(dataset)
        });
        if (!plan.sources.length && !plan.replaced.length) {
            return { ok: true, copied: 0, deleted: 0 };
        }
        const recorded = recordOperation(plan, {
            actorUserId,
            companyName,
            submissionId,
            previewId: null
        });
        return { ok: true, copied: recorded.copied, deleted: recorded.deleted };
    });
}

function copyWithoutOperation({ dataset, ownerCompanyId, sourceStart, sourceEnd, targetStart, targetEnd, offsetDays, priceIncreasePercent, conflict }) {
    return transaction(() => {
        const plan = buildPlan({
            dataset,
            companyId: ownerCompanyId || null,
            range: { sourceStart, sourceEnd, targetStart, targetEnd, offsetDays },
            conflict: conflict === 'replace' ? 'replace' : 'keep',
            priceIncreasePercent: dataset === 'rates' ? Number(priceIncreasePercent) || 0 : 0,
            filter: emptyFilter(dataset)
        });
        const now = new Date().toISOString();
        softDelete(dataset, plan.replaced.map(snapshot), null, now, plan.companyId);
        insertCopies(plan);
        return { copied: plan.sources.length, deleted: plan.replaced.length };
    });
}

module.exports = {
    previewPullForward,
    commitPullForward,
    executeLegacy,
    copyWithoutOperation
};
