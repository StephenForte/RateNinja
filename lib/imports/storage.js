'use strict';

const fs = require('node:fs');
const path = require('node:path');

const RETENTION_MS = 24 * 60 * 60 * 1000;
const ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function databasePath() {
    if (process.env.SQLITE_DB_PATH && process.env.SQLITE_DB_PATH.trim()) {
        return path.resolve(process.env.SQLITE_DB_PATH);
    }
    return path.join(__dirname, '..', '..', 'data', 'rateninja.db');
}

function importsDir() {
    return path.join(path.dirname(databasePath()), 'imports-tmp');
}

function assertId(id) {
    if (typeof id !== 'string' || !ID_PATTERN.test(id)) {
        const error = new Error('Import was not found.');
        error.statusCode = 404;
        error.code = 'not_found';
        throw error;
    }
    return id;
}

function uploadPath(id) {
    return path.join(importsDir(), `${assertId(id)}.upload`);
}

function metaPath(id) {
    return path.join(importsDir(), `${assertId(id)}.meta.json`);
}

function ensureDir() {
    fs.mkdirSync(importsDir(), { recursive: true });
}

function writeUpload(id, buffer) {
    ensureDir();
    const filePath = uploadPath(id);
    fs.writeFileSync(filePath, buffer);
    return filePath;
}

function readUpload(id) {
    return fs.readFileSync(uploadPath(id));
}

function writeMeta(id, meta) {
    ensureDir();
    fs.writeFileSync(metaPath(id), JSON.stringify(meta));
}

function deleteJobFiles(id) {
    if (typeof id !== 'string' || !ID_PATTERN.test(id)) return;
    for (const filePath of [uploadPath(id), metaPath(id)]) {
        try {
            fs.rmSync(filePath, { force: true });
        } catch {
            // The directory may already be gone.
        }
    }
}

function safeFilename(value) {
    const base = path.basename(String(value || '')).replace(/[\u0000-\u001f]/g, '').trim();
    return base.slice(0, 200) || 'upload';
}

module.exports = {
    RETENTION_MS,
    ID_PATTERN,
    databasePath,
    importsDir,
    assertId,
    uploadPath,
    metaPath,
    writeUpload,
    readUpload,
    writeMeta,
    deleteJobFiles,
    safeFilename
};
