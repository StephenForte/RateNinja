'use strict';

function parseRunCsv(text) {
    const source = String(text ?? '');
    const body = source.charCodeAt(0) === 0xFEFF ? source.slice(1) : source;
    const rows = [];
    let row = [];
    let field = '';
    let quoted = false;
    for (let index = 0; index < body.length; index += 1) {
        const char = body[index];
        if (quoted) {
            if (char === '"') {
                if (body[index + 1] === '"') {
                    field += '"';
                    index += 1;
                    continue;
                }
                quoted = false;
                continue;
            }
            field += char;
            continue;
        }
        if (char === '"') {
            quoted = true;
            continue;
        }
        if (char === ',') {
            row.push(field);
            field = '';
            continue;
        }
        if (char === '\r' || char === '\n') {
            row.push(field);
            rows.push(row);
            row = [];
            field = '';
            if (char === '\r' && body[index + 1] === '\n') index += 1;
            continue;
        }
        field += char;
    }
    if (field.length > 0 || row.length > 0) {
        row.push(field);
        rows.push(row);
    }
    return rows;
}

function labelText(node) {
    if (!node || node.tag === 'a') return '';
    if (!node.children || !node.children.length) return node.textContent || '';
    return node.children.map(labelText).join('');
}

function downloadButtons(root, walk) {
    return walk(root).filter(node => node.tag === 'button' && node.textContent === 'Download CSV');
}

module.exports = { parseRunCsv, labelText, downloadButtons };
