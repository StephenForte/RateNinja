// DOM-free grouping, sorting, and saved-query application.
// Field metadata matches lib/view-fields.js. A test locks the two lists together.

export const RATE_FIELDS = Object.freeze([
    { id: 'rateType', label: 'Rate Type', shortLabel: 'Type', groupable: true, sortable: true, type: 'text' },
    { id: 'originPort', label: 'Origin Port', shortLabel: 'Origin', groupable: true, sortable: true, type: 'text' },
    { id: 'destinationPort', label: 'Destination Port/Via Port', shortLabel: 'Destination', groupable: true, sortable: true, type: 'text' },
    { id: 'inlandDeliveryLocation', label: 'Inland Delivery Location', shortLabel: 'Inland', groupable: true, sortable: true, type: 'text' },
    { id: 'commodityType', label: 'Commodity Type', shortLabel: 'Commodity', groupable: true, sortable: true, type: 'text' },
    { id: 'carrier', label: 'Carrier', shortLabel: 'Carrier', groupable: true, sortable: true, type: 'text' },
    { id: 'contractOwner', label: 'Contract Owner', shortLabel: 'Owner', groupable: true, sortable: true, type: 'text' },
    { id: 'contractNumber', label: 'Contract Number', shortLabel: 'Contract', groupable: true, sortable: true, type: 'text', defaultHidden: true },
    { id: 'rate20D', label: '20D Rate (USD)', shortLabel: "20'", groupable: true, sortable: true, type: 'number' },
    { id: 'rate40D', label: '40D Rate (USD)', shortLabel: "40'", groupable: true, sortable: true, type: 'number' },
    { id: 'rate40HC', label: '40HC Rate (USD)', shortLabel: "40HC", groupable: true, sortable: true, type: 'number' },
    { id: 'rateEffectiveDate', label: 'Rate Effective Date', shortLabel: 'Effective', groupable: true, sortable: true, type: 'date' },
    { id: 'rateExpirationDate', label: 'Rate Expiration Date', shortLabel: 'Expiration', groupable: true, sortable: true, type: 'date' },
    { id: 'notes1', label: 'Notes 1', shortLabel: 'Notes', groupable: true, sortable: true, type: 'text' }
]);

export const FILTER_FIELDS = Object.freeze(['carrier', 'originPort', 'destinationPort', 'contractOwner']);

const FILTER_LABELS = {
    carrier: 'Carrier',
    originPort: 'Origin port',
    destinationPort: 'Destination port',
    contractOwner: 'Contract owner'
};

export function standardView(fields = RATE_FIELDS) {
    return {
        columnOrder: fields.map(field => field.id),
        hiddenColumns: fields.filter(field => field.defaultHidden).map(field => field.id),
        groupBy: [],
        sort: [{ field: 'rateEffectiveDate', direction: 'desc' }],
        pageSize: 20
    };
}

export function emptyCriteria() {
    return { search: '', carrier: '', originPort: '', destinationPort: '', contractOwner: '' };
}

function typeOf(fields, id) {
    const field = (fields || RATE_FIELDS).find(item => item.id === id);
    return field ? field.type : 'text';
}

export function isMissing(value, type) {
    if (value === null || value === undefined) return true;
    if (typeof value === 'string' && value.trim() === '') return true;
    if (type === 'date' && String(value).toUpperCase() === 'N/A') return true;
    if (type === 'number' && typeof value !== 'number' && Number.isNaN(Number(value))) return true;
    if (type === 'number' && typeof value === 'number' && Number.isNaN(value)) return true;
    return false;
}

function comparePresent(left, right, type) {
    if (type === 'number') {
        const delta = Number(left) - Number(right);
        return delta < 0 ? -1 : delta > 0 ? 1 : 0;
    }
    const leftText = String(left);
    const rightText = String(right);
    if (leftText === rightText) return 0;
    return leftText < rightText ? -1 : 1;
}

function compareValues(left, right, type, direction) {
    const leftMissing = isMissing(left, type);
    const rightMissing = isMissing(right, type);
    if (leftMissing && rightMissing) return 0;
    if (leftMissing) return 1;
    if (rightMissing) return -1;
    const result = comparePresent(left, right, type);
    if (!result) return 0;
    return direction === 'desc' ? -result : result;
}

function compareIds(left, right) {
    const leftId = String(left?.id ?? '');
    const rightId = String(right?.id ?? '');
    if (leftId === rightId) return 0;
    return leftId < rightId ? -1 : 1;
}

export function compareRates(left, right, rules, fields = RATE_FIELDS) {
    for (const rule of rules || []) {
        const result = compareValues(left[rule.field], right[rule.field], typeOf(fields, rule.field), rule.direction);
        if (result) return result;
    }
    return compareIds(left, right);
}

export function sortRates(rates, rules, fields = RATE_FIELDS) {
    return rates.slice().sort((left, right) => compareRates(left, right, rules, fields));
}

function bucketKey(value, type) {
    if (isMissing(value, type)) return null;
    if (type === 'number') return String(Number(value));
    return String(value);
}

function pathKey(parent, field, key) {
    const part = `${field}:${key === null ? '' : encodeURIComponent(String(key))}`;
    return parent ? `${parent}/${part}` : part;
}

function groupLabel(key) {
    return key === null ? '(No value)' : String(key);
}

function compareKeys(left, right, type) {
    if (left === null && right === null) return 0;
    if (left === null) return 1;
    if (right === null) return -1;
    return comparePresent(type === 'number' ? Number(left) : left, type === 'number' ? Number(right) : right, type);
}

function buildGroups(rates, groupBy, fields, sort, depth, parentKey) {
    if (depth >= groupBy.length) return null;
    const field = groupBy[depth];
    const type = typeOf(fields, field);
    const buckets = new Map();
    for (const rate of rates) {
        const key = bucketKey(rate[field], type);
        if (!buckets.has(key)) buckets.set(key, []);
        buckets.get(key).push(rate);
    }
    const keys = [...buckets.keys()].sort((left, right) => compareKeys(left, right, type));
    return keys.map(key => {
        const members = sortRates(buckets.get(key), sort, fields);
        const node = {
            field,
            key,
            label: groupLabel(key),
            count: members.length,
            depth,
            pathKey: pathKey(parentKey, field, key)
        };
        if (depth + 1 < groupBy.length) node.children = buildGroups(members, groupBy, fields, sort, depth + 1, node.pathKey);
        else node.rows = members;
        return node;
    });
}

export function groupRates(rates, groupBy, fields = RATE_FIELDS, sort = []) {
    const source = Array.isArray(rates) ? rates : [];
    return {
        groups: groupBy && groupBy.length ? buildGroups(source, groupBy, fields, sort, 0, '') : [],
        total: source.length
    };
}

function flatten(nodes, collapsed, events, cursor, ancestors) {
    for (const node of nodes) {
        const header = {
            field: node.field,
            key: node.key,
            label: node.label,
            count: node.count,
            depth: node.depth,
            pathKey: node.pathKey,
            collapsed: collapsed.has(node.pathKey)
        };
        events.push({ kind: 'header', header, atRow: cursor.index, ancestors });
        if (header.collapsed) continue;
        const chain = ancestors.concat(header);
        if (node.children) {
            flatten(node.children, collapsed, events, cursor, chain);
            continue;
        }
        for (const rate of node.rows) {
            events.push({ kind: 'row', rate, index: cursor.index, ancestors: chain });
            cursor.index += 1;
        }
    }
}

export function layoutPage(rates, options = {}) {
    const fields = options.fields || RATE_FIELDS;
    const groupBy = options.groupBy || [];
    const sort = options.sort || [];
    const pageSize = options.pageSize > 0 ? options.pageSize : 20;
    const collapsed = new Set(options.collapsed || []);
    const source = Array.isArray(rates) ? rates : [];
    const matchedTotal = source.length;

    let rows = [];
    const events = [];
    if (!groupBy.length) {
        rows = sortRates(source, sort, fields);
    } else {
        const tree = groupRates(source, groupBy, fields, sort);
        const cursor = { index: 0 };
        flatten(tree.groups, collapsed, events, cursor, []);
        rows = events.filter(event => event.kind === 'row');
    }

    const visibleRowCount = groupBy.length ? rows.length : source.length;
    const pageCount = Math.max(1, Math.ceil(visibleRowCount / pageSize) || 1);
    const requested = options.page || 1;
    const page = Math.min(Math.max(1, requested), pageCount);
    const start = (page - 1) * pageSize;
    const end = start + pageSize;
    const items = [];

    if (!groupBy.length) {
        for (const rate of rows.slice(start, end)) items.push({ type: 'row', rate });
    } else {
        const firstRow = new Map();
        for (const event of events) {
            if (event.kind !== 'row') continue;
            for (const ancestor of event.ancestors) {
                if (!firstRow.has(ancestor.pathKey)) firstRow.set(ancestor.pathKey, event.index);
            }
        }
        const emitted = new Set();
        function emitHeader(header, continued) {
            if (emitted.has(header.pathKey)) return;
            emitted.add(header.pathKey);
            items.push({
                type: 'header',
                field: header.field,
                key: header.key,
                label: header.label,
                count: header.count,
                depth: header.depth,
                pathKey: header.pathKey,
                continued,
                collapsed: header.collapsed
            });
        }
        for (const event of events) {
            if (event.kind === 'header' && event.header.collapsed) {
                const at = event.atRow;
                const onThisPage = at >= start && at < end;
                const afterLastRow = at >= visibleRowCount && page === pageCount;
                if (onThisPage || afterLastRow || (visibleRowCount === 0 && page === 1)) {
                    for (const ancestor of event.ancestors || []) {
                        const first = firstRow.get(ancestor.pathKey);
                        emitHeader(ancestor, first !== undefined && first < start);
                    }
                    emitHeader(event.header, false);
                }
                continue;
            }
            if (event.kind === 'row' && event.index >= start && event.index < end) {
                for (const ancestor of event.ancestors) {
                    emitHeader(ancestor, firstRow.get(ancestor.pathKey) < start);
                }
                items.push({ type: 'row', rate: event.rate });
            }
        }
    }

    return { items, matchedTotal, visibleRowCount, page, pageSize, pageCount };
}

export function headerText(item) {
    if (!item || item.type !== 'header') return '';
    return item.continued ? `${item.label} (continued)` : item.label;
}

export function summarizeView(view, fields = RATE_FIELDS) {
    const byId = new Map(fields.map(field => [field.id, field]));
    const hidden = (view.hiddenColumns || []).length;
    const parts = [];
    if (hidden) parts.push(`${hidden} hidden`);
    const groups = view.groupBy || [];
    if (groups.length) {
        const labels = groups.map(id => byId.get(id)?.shortLabel || byId.get(id)?.label || id);
        parts.push(labels.length === 1 ? `grouped by ${labels[0]}` : `grouped by ${labels.join(', then ')}`);
    }
    const rules = view.sort || [];
    if (rules.length) {
        const text = rules.map(rule => {
            const label = byId.get(rule.field)?.shortLabel || rule.field;
            return `${label} ${rule.direction === 'desc' ? '↓' : '↑'}`;
        }).join(', ');
        parts.push(`sorted by ${text}`);
    }
    return parts.join(' · ') || 'Standard view';
}

export function applySavedQuery({ criteria = {}, available = {}, predictive = false, predictiveAfter = '' } = {}) {
    const next = emptyCriteria();
    for (const key of Object.keys(next)) {
        if (typeof criteria[key] === 'string') next[key] = criteria[key];
    }
    const missing = [];
    for (const field of FILTER_FIELDS) {
        const value = next[field];
        if (!value) continue;
        const options = Array.isArray(available[field]) ? available[field] : [];
        if (!options.includes(value)) missing.push({ field, value });
    }
    const applied = {
        criteria: next,
        page: 1,
        predictive,
        predictiveAfter,
        broadened: false,
        missing
    };
    if (missing.length) {
        const detail = missing.map(item => `${FILTER_LABELS[item.field]} “${item.value}” is not available.`).join(' ');
        return { ...applied, ok: false, warning: `${detail} No rates are shown.` };
    }
    return { ...applied, ok: true, warning: '' };
}

export function ratesForAppliedQuery(rates, applied) {
    if (!applied || applied.ok === false) return [];
    const criteria = applied.criteria || emptyCriteria();
    return (rates || []).filter(rate => FILTER_FIELDS.every(field => !criteria[field] || rate[field] === criteria[field]));
}

export function availableValues(rates) {
    const available = { carrier: [], originPort: [], destinationPort: [], contractOwner: [] };
    for (const field of FILTER_FIELDS) {
        available[field] = [...new Set((rates || []).map(rate => rate[field]).filter(value => value !== null && value !== undefined && String(value) !== ''))];
    }
    return available;
}
