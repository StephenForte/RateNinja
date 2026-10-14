'use strict';

const crypto = require('node:crypto');
const { db, transaction } = require('../db');
const {
    importMaxBytes,
    importMaxRows,
    importSampleRows,
    importSampleChars
} = require('../config');
const {
    insertOperation,
    replaySubmission,
    requireSubmissionId,
    DataOpsError
} = require('../data-ops');
const { ImportError, targetsFor } = require('./fields');
const { parseUpload, sheetByName, headerColumns, isDataSheet } = require('./parse');
const { projectRows, buildSample, sampleCell, cellByHeader } = require('./convert');
const { validateSuggestion } = require('./schema');
const { requestMapping } = require('./claude');
const {
    RETENTION_MS,
    writeUpload,
    readUpload,
    writeMeta,
    deleteJobFiles,
    safeFilename
} = require('./storage');

const APPEND_WARNING = 'Imported rows will be added and may duplicate existing rates or sailings.';

function limits() {
    return {
        maxBytes: importMaxBytes(),
        maxRows: importMaxRows(),
        sampleRows: importSampleRows(),
        sampleChars: importSampleChars(),
        retentionHours: 24,
        formats: ['CSV', 'Excel (.xlsx)'],
        templates: {
            rates: '/templates/rates.csv',
            sailings: '/templates/sailings.csv',
            fields: '/templates/fields.txt'
        }
    };
}

function sweepExpired(now = new Date()) {
    const table = db.prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'import_jobs'`).get();
    if (!table) return 0;
    const stamp = now.toISOString();
    const rows = db.prepare(`
        SELECT id FROM import_jobs WHERE status = 'uploaded' AND expires_at <= ?
    `).all(stamp);
    const finish = db.prepare(`
        UPDATE import_jobs SET status = 'expired', completed_at = ? WHERE id = ? AND status = 'uploaded'
    `);
    for (const row of rows) {
        deleteJobFiles(row.id);
        finish.run(stamp, row.id);
    }
    return rows.length;
}

function loadJob(id, companyId) {
    const job = db.prepare(`
        SELECT * FROM import_jobs WHERE id = ? AND owner_company_id = ?
    `).get(id, companyId);
    if (!job) throw new ImportError(404, 'not_found', 'Import was not found.');
    if (job.status === 'uploaded' && job.expires_at <= new Date().toISOString()) {
        deleteJobFiles(job.id);
        db.prepare(`UPDATE import_jobs SET status = 'expired', completed_at = ? WHERE id = ?`).run(new Date().toISOString(), job.id);
        throw new ImportError(410, 'expired', 'That upload has expired. Upload the file again.');
    }
    return job;
}

async function openParsed(job) {
    if (job.status !== 'uploaded') throw new ImportError(409, 'not_open', 'That import is already finished.');
    let buffer;
    try {
        buffer = readUpload(job.id);
    } catch {
        throw new ImportError(410, 'expired', 'That upload is no longer available. Upload the file again.');
    }
    const parsed = await parseUpload(buffer, job.filename, job.dataset);
    return parsed.parsed;
}

async function createUpload({ companyId, actorUserId, dataset, filename, buffer }) {
    if (dataset !== 'rates' && dataset !== 'sailings') {
        throw new ImportError(400, 'invalid_dataset', 'Choose Rates or Sailings before uploading.');
    }
    if (!buffer || !buffer.length) throw new ImportError(400, 'empty_file', 'The file is empty.');
    const storedName = safeFilename(filename);
    const described = await parseUpload(buffer, storedName, dataset);
    const id = crypto.randomUUID();
    writeUpload(id, buffer);
    const now = new Date();
    try {
        db.prepare(`
            INSERT INTO import_jobs (
                id, owner_company_id, actor_user_id, dataset, filename, byte_size,
                sheet_name, status, accepted_count, rejected_count, submission_id,
                operation_id, created_at, completed_at, expires_at
            ) VALUES (?, ?, ?, ?, ?, ?, NULL, 'uploaded', NULL, NULL, NULL, NULL, ?, NULL, ?)
        `).run(
            id,
            companyId,
            actorUserId,
            dataset,
            storedName,
            buffer.length,
            now.toISOString(),
            new Date(now.getTime() + RETENTION_MS).toISOString()
        );
    } catch (error) {
        deleteJobFiles(id);
        throw error;
    }
    return {
        jobId: id,
        dataset,
        filename: storedName,
        byteSize: buffer.length,
        sheets: described.sheets.map(sheet => ({
            name: sheet.name,
            data: sheet.data,
            ignored: sheet.ignored,
            matches: sheet.matches
        })),
        suggestedSheet: described.suggestedSheet,
        requireSheetChoice: described.requireSheetChoice
    };
}

async function sheetDetail(job, sheetName) {
    const parsed = await openParsed(job);
    const name = sheetName || job.sheet_name;
    if (!name) throw new ImportError(400, 'sheet_required', 'Choose a sheet.');
    const sheet = sheetByName(parsed, name);
    if (!sheet) throw new ImportError(400, 'unknown_sheet', 'That sheet is not in the file.');
    if (!isDataSheet(sheet.rows)) {
        throw new ImportError(400, 'ignored_sheet', 'That sheet is not a data sheet and was ignored.');
    }
    const dataRows = Math.max(0, sheet.rows.length - 1);
    if (dataRows > importMaxRows()) {
        throw new ImportError(413, 'too_many_rows', `That sheet has more than ${importMaxRows()} data rows.`);
    }
    db.prepare(`UPDATE import_jobs SET sheet_name = ? WHERE id = ?`).run(name, job.id);
    const columns = headerColumns(sheet.rows);
    const sample = buildSample({
        dataset: job.dataset,
        columns,
        rows: sheet.rows,
        maxRows: importSampleRows(),
        maxChars: importSampleChars()
    });
    const preview = [];
    for (let index = 1; index < sheet.rows.length && preview.length < 8; index += 1) {
        preview.push({
            row: index + 1,
            cells: columns.map(column => sampleCell(column.name, cellByHeader(sheet.rows[index], columns, column.name)))
        });
    }
    return {
        jobId: job.id,
        dataset: job.dataset,
        sheetName: name,
        headers: columns.map(column => column.name),
        rowCount: dataRows,
        preview,
        targets: targetsFor(job.dataset),
        sample,
        appendWarning: APPEND_WARNING
    };
}

function responseText(result) {
    if (typeof result === 'string') return result;
    if (result && typeof result.text === 'string') return result.text;
    return '';
}

async function suggestMapping(job, confirmed) {
    if (confirmed !== true) {
        throw new ImportError(400, 'confirmation_required', 'Confirm the sample before asking Claude for a mapping. Nothing was sent.');
    }
    if (!job.sheet_name) throw new ImportError(400, 'sheet_required', 'Choose a sheet first.');
    const parsed = await openParsed(job);
    const sheet = sheetByName(parsed, job.sheet_name);
    if (!sheet || !isDataSheet(sheet.rows)) {
        throw new ImportError(400, 'sheet_required', 'Choose a data sheet first.');
    }
    const columns = headerColumns(sheet.rows);
    const sample = buildSample({
        dataset: job.dataset,
        columns,
        rows: sheet.rows,
        maxRows: importSampleRows(),
        maxChars: importSampleChars()
    });
    const sentAt = new Date().toISOString();
    writeMeta(job.id, { sample, sentAt, modelResponse: null });
    try {
        const result = await requestMapping(sample);
        const text = responseText(result);
        writeMeta(job.id, { sample, sentAt, modelResponse: text });
        let parsedJson = null;
        try {
            parsedJson = JSON.parse(text);
        } catch {
            parsedJson = null;
        }
        const suggestions = validateSuggestion(parsedJson, job.dataset, sample.headers);
        if (!suggestions) return { suggestions: null, fallback: 'manual', reason: 'invalid' };
        return { suggestions, fallback: null };
    } catch (error) {
        const timedOut = error && (error.name === 'TimeoutError' || error.name === 'AbortError' || error.code === 23);
        return { suggestions: null, fallback: 'manual', reason: timedOut ? 'timeout' : 'unavailable' };
    }
}

async function evaluate(job, body) {
    const parsed = await openParsed(job);
    const name = (body && body.sheetName) || job.sheet_name;
    const sheet = name ? sheetByName(parsed, name) : null;
    if (!sheet || !isDataSheet(sheet.rows)) {
        throw new ImportError(400, 'sheet_required', 'Choose a data sheet.');
    }
    if (sheet.rows.length - 1 > importMaxRows()) {
        throw new ImportError(413, 'too_many_rows', `That sheet has more than ${importMaxRows()} data rows.`);
    }
    const dateOrder = body && Object.prototype.hasOwnProperty.call(body, 'dateOrder') ? body.dateOrder : null;
    if (dateOrder != null && dateOrder !== 'mdy' && dateOrder !== 'dmy') {
        throw new ImportError(400, 'invalid_date_order', 'Choose month/day or day/month for ambiguous dates.');
    }
    const columns = headerColumns(sheet.rows);
    const projected = projectRows({
        dataset: job.dataset,
        columns,
        rows: sheet.rows,
        mapping: body && body.mapping,
        dateOrder,
        excludedRows: body && body.excludedRows
    });
    return { sheetName: sheet.name, projected };
}

function validationPayload(evaluated) {
    const { projected } = evaluated;
    const errors = [];
    for (const row of projected.rejected) {
        for (const error of row.errors) {
            if (errors.length >= 500) break;
            errors.push({ row: row.sheetRow, field: error.field, message: error.message, excluded: row.excluded });
        }
    }
    return {
        acceptedCount: projected.accepted.length,
        rejectedCount: projected.rejected.length,
        blocked: projected.blocked,
        unmappedRequired: projected.unmappedRequired,
        needsDateChoice: projected.needsDateChoice,
        errors,
        appendWarning: APPEND_WARNING,
        sheetName: evaluated.sheetName
    };
}

function insertCreated(dataset, companyId, rows) {
    const created = [];
    if (dataset === 'rates') {
        const insert = db.prepare(`
            INSERT INTO rates (
                id, rate_type, origin_port, destination_port, inland_delivery_location,
                commodity_type, carrier, contract_owner, contract_number,
                rate_20d, rate_40d, rate_40hc,
                rate_effective_date, rate_expiration_date, notes_1, rate_view,
                owner_company_id, row_version
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)
        `);
        const read = db.prepare('SELECT * FROM rates WHERE id = ?');
        for (const row of rows) {
            const id = crypto.randomUUID();
            const value = row.value;
            insert.run(
                id,
                value.rateType,
                value.originPort,
                value.destinationPort,
                value.inlandDeliveryLocation,
                value.commodityType,
                value.carrier,
                value.contractOwner,
                value.contractNumber,
                value.rate20D,
                value.rate40D,
                value.rate40HC,
                value.rateEffectiveDate,
                value.rateExpirationDate,
                value.notes1,
                value.rateView,
                companyId
            );
            created.push(read.get(id));
        }
        return created;
    }
    const insert = db.prepare(`
        INSERT INTO sailings (
            id, departure, arrival, transit_time, vessel, voyage, service,
            carrier, departure_port, arrival_port, owner_company_id, row_version
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)
    `);
    const read = db.prepare('SELECT * FROM sailings WHERE id = ?');
    for (const row of rows) {
        const id = crypto.randomUUID();
        const value = row.value;
        insert.run(
            id,
            value.departure,
            value.arrival,
            value.transitTime,
            value.vessel,
            value.voyage,
            value.service,
            value.carrier,
            value.departurePort,
            value.arrivalPort,
            companyId
        );
        created.push(read.get(id));
    }
    return created;
}

async function commitImport({ job, companyId, companyName, actorUserId, body }) {
    if (!body || body.acknowledgeAppend !== true) {
        throw new ImportError(400, 'append_unconfirmed', `${APPEND_WARNING} Confirm that before committing.`);
    }
    const submission = requireSubmissionId(body.submissionId);
    const replay = replaySubmission(submission, companyId);
    if (replay) return replay;
    const evaluated = await evaluate(job, body);
    const { projected } = evaluated;
    if (projected.blocked) {
        throw new ImportError(400, 'unmapped_required', 'Required fields are still unmapped.', {
            unmappedRequired: projected.unmappedRequired
        });
    }
    if (projected.pending.length) {
        throw new ImportError(409, 'rows_rejected', 'Exclude or fix the invalid rows before committing. Nothing was saved.', validationPayload(evaluated));
    }
    if (!projected.accepted.length) {
        throw new ImportError(400, 'empty_import', 'No rows are left to import.');
    }
    const now = new Date().toISOString();
    let response;
    try {
        response = transaction(() => {
            const again = replaySubmission(submission, companyId);
            if (again) return again;
            const current = db.prepare(`SELECT status FROM import_jobs WHERE id = ? AND owner_company_id = ?`).get(job.id, companyId);
            if (!current || current.status !== 'uploaded') {
                throw new ImportError(409, 'not_open', 'That import is already finished.');
            }
            const created = insertCreated(job.dataset, companyId, projected.accepted);
            const operationId = crypto.randomUUID();
            response = {
                ok: true,
                operationId,
                dataset: job.dataset,
                affectedCount: created.length,
                acceptedCount: created.length,
                rejectedCount: projected.rejected.length,
                status: 'completed',
                filename: job.filename,
                byteSize: job.byte_size,
                sheetName: evaluated.sheetName,
                company: { id: companyId, name: companyName || '' }
            };
            insertOperation({
                operationId,
                type: 'import',
                dataset: job.dataset,
                companyId,
                actorUserId,
                affectedCount: created.length,
                submissionId: submission,
                now,
                detail: response
            });
            const insertItem = db.prepare(`
                INSERT INTO data_operation_items (operation_id, dataset, record_id, action, prior_json)
                VALUES (?, ?, ?, 'create', ?)
            `);
            for (const row of created) {
                insertItem.run(operationId, job.dataset, row.id, JSON.stringify(row));
            }
            const updated = db.prepare(`
                UPDATE import_jobs
                SET status = 'committed', sheet_name = ?, accepted_count = ?, rejected_count = ?,
                    submission_id = ?, operation_id = ?, completed_at = ?
                WHERE id = ? AND owner_company_id = ? AND status = 'uploaded'
            `).run(
                evaluated.sheetName,
                created.length,
                projected.rejected.length,
                submission,
                operationId,
                now,
                job.id,
                companyId
            );
            if (Number(updated.changes) !== 1) {
                throw new ImportError(409, 'not_open', 'That import is already finished.');
            }
            return response;
        });
    } catch (error) {
        if (error instanceof ImportError || error instanceof DataOpsError) throw error;
        const message = String(error && error.message || '');
        if (message.includes('UNIQUE') || error.code === 'SQLITE_CONSTRAINT_UNIQUE') {
            const again = replaySubmission(submission, companyId);
            if (again) return again;
        }
        throw error;
    }
    deleteJobFiles(job.id);
    return response;
}

function cancelImport(job, companyId) {
    if (job.status !== 'uploaded') throw new ImportError(409, 'not_open', 'That import is already finished.');
    deleteJobFiles(job.id);
    db.prepare(`
        UPDATE import_jobs SET status = 'cancelled', completed_at = ? WHERE id = ? AND owner_company_id = ? AND status = 'uploaded'
    `).run(new Date().toISOString(), job.id, companyId);
    return { ok: true };
}

module.exports = {
    APPEND_WARNING,
    limits,
    sweepExpired,
    loadJob,
    createUpload,
    sheetDetail,
    suggestMapping,
    evaluate,
    validationPayload,
    commitImport,
    cancelImport,
    importMaxBytes
};
