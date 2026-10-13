'use strict';

const crypto = require('node:crypto');
const { db } = require('./db');
const { COMPANY_TYPE_CUSTOMER } = require('./constants');
const { getCompanyByRecordId, getRatesByOwner } = require('./store');
const { mapRateRecord } = require('./domain');
const { applyCustomerPrices } = require('./visibility');
const { marginTargetInScope } = require('./permissions');
const { customerPrice, storedMarginPercent, displayedMarginPercent } = require('./pricing');

const MARGIN_LIMIT = 1_000_000;
const LOOKUP_LIMIT = 20;

function marginValue(value) {
    return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= MARGIN_LIMIT;
}

function readMarginInput(body, { requireBoth }) {
    const hasPercent = Object.prototype.hasOwnProperty.call(body, 'marginPercent');
    const hasNumber = Object.prototype.hasOwnProperty.call(body, 'marginNumber');
    if (!hasPercent && !hasNumber) {
        if (requireBoth) return { ok: false, error: 'marginPercent and marginNumber are required.' };
        return { ok: true, present: false };
    }
    if (requireBoth && (!hasPercent || !hasNumber)) {
        return { ok: false, error: 'marginPercent and marginNumber are required.' };
    }
    if (hasPercent && !marginValue(body.marginPercent)) {
        return { ok: false, error: 'Margins must be non-negative numbers no greater than 1,000,000.' };
    }
    if (hasNumber && !marginValue(body.marginNumber)) {
        return { ok: false, error: 'Margins must be non-negative numbers no greater than 1,000,000.' };
    }
    return {
        ok: true,
        present: true,
        hasPercent,
        hasNumber,
        marginPercent: hasPercent ? storedMarginPercent(body.marginPercent) : null,
        marginNumber: hasNumber ? body.marginNumber : null
    };
}

function customerRow(row) {
    return {
        id: row.id,
        name: row.company_name,
        status: row.status,
        marginPercent: displayedMarginPercent(row.margin_percent),
        marginNumber: Number(row.margin_number) || 0,
        authorizedAt: row.authorized_at || null,
        revokedAt: row.revoked_at || null
    };
}

function linkRow(ownerCompanyId, customerCompanyId) {
    return db.prepare(`
        SELECT m.id, m.owner_company_id, m.customer_company_id, m.margin_percent, m.margin_number,
               m.status, m.authorized_at, m.revoked_at, m.created_at, m.updated_at, c.company_name
        FROM company_margins m
        JOIN companies c ON c.id = m.customer_company_id
        WHERE m.owner_company_id = ? AND m.customer_company_id = ?
    `).get(ownerCompanyId, customerCompanyId);
}

function listCustomers(ownerCompanyId) {
    const customers = db.prepare(`
        SELECT c.id, c.company_name, m.status, m.margin_percent, m.margin_number, m.authorized_at, m.revoked_at
        FROM company_margins m
        JOIN companies c ON c.id = m.customer_company_id
        WHERE m.owner_company_id = ?
        ORDER BY c.company_name, c.id
    `).all(ownerCompanyId).map(customerRow);
    return { customers };
}

function likePattern(value) {
    return `%${String(value).replace(/[\\%_]/g, match => `\\${match}`)}%`;
}

function lookupCustomers(ownerCompanyId, query) {
    const q = typeof query === 'string' ? query.trim() : '';
    if (!q) return { ok: false, status: 400, error: 'Enter a company name to look up.' };
    if (q.length > 100) return { ok: false, status: 400, error: 'Enter a shorter company name.' };
    const companies = db.prepare(`
        SELECT id, company_name
        FROM companies
        WHERE company_type = ?
          AND id != ?
          AND lower(company_name) LIKE lower(?) ESCAPE '\\'
        ORDER BY company_name, id
        LIMIT ?
    `).all(COMPANY_TYPE_CUSTOMER, ownerCompanyId, likePattern(q), LOOKUP_LIMIT).map(row => ({
        id: row.id,
        name: row.company_name
    }));
    return { ok: true, companies };
}

function customerInScope(ownerCompany, customerId) {
    const company = getCompanyByRecordId(customerId);
    if (!marginTargetInScope({ company: ownerCompany }, company)) return null;
    return company;
}

function authorizeCustomer(ownerCompany, customerId, actorUserId, body) {
    const company = customerInScope(ownerCompany, customerId);
    if (!company) {
        return { ok: false, status: 404, error: 'Company was not found in your administration scope.' };
    }
    const margins = readMarginInput(body || {}, { requireBoth: false });
    if (!margins.ok) return { ok: false, status: 400, error: margins.error };
    const now = new Date().toISOString();
    const existing = linkRow(ownerCompany.id, customerId);
    if (existing) {
        const marginPercent = margins.hasPercent ? margins.marginPercent : existing.margin_percent;
        const marginNumber = margins.hasNumber ? margins.marginNumber : existing.margin_number;
        db.prepare(`
            UPDATE company_margins
            SET status = 'active', revoked_at = NULL, authorized_at = ?, updated_by = ?, updated_at = ?,
                margin_percent = ?, margin_number = ?
            WHERE id = ?
        `).run(now, actorUserId, now, marginPercent, marginNumber, existing.id);
    } else {
        db.prepare(`
            INSERT INTO company_margins (
                id, owner_company_id, customer_company_id, margin_percent, margin_number,
                created_at, updated_at, status, authorized_at, updated_by
            ) VALUES (?, ?, ?, ?, ?, ?, ?, 'active', ?, ?)
        `).run(
            crypto.randomUUID(),
            ownerCompany.id,
            customerId,
            margins.hasPercent ? margins.marginPercent : 0,
            margins.hasNumber ? margins.marginNumber : 0,
            now,
            now,
            now,
            actorUserId
        );
    }
    return { ok: true, customer: customerRow(linkRow(ownerCompany.id, customerId)) };
}

function revokeCustomer(ownerCompanyId, customerId, actorUserId) {
    const existing = linkRow(ownerCompanyId, customerId);
    if (!existing) {
        return { ok: false, status: 404, error: 'Company was not found in your administration scope.' };
    }
    const now = new Date().toISOString();
    db.prepare(`
        UPDATE company_margins
        SET status = 'revoked', revoked_at = ?, updated_by = ?, updated_at = ?
        WHERE id = ?
    `).run(now, actorUserId, now, existing.id);
    return { ok: true, customer: customerRow(linkRow(ownerCompanyId, customerId)) };
}

function updateMargins(ownerCompanyId, customerId, actorUserId, body) {
    const existing = linkRow(ownerCompanyId, customerId);
    if (!existing) {
        return { ok: false, status: 404, error: 'Company was not found in your administration scope.' };
    }
    const margins = readMarginInput(body || {}, { requireBoth: true });
    if (!margins.ok) return { ok: false, status: 400, error: margins.error };
    const now = new Date().toISOString();
    db.prepare(`
        UPDATE company_margins
        SET margin_percent = ?, margin_number = ?, updated_by = ?, updated_at = ?
        WHERE id = ?
    `).run(margins.marginPercent, margins.marginNumber, actorUserId, now, existing.id);
    return { ok: true, customer: customerRow(linkRow(ownerCompanyId, customerId)) };
}

function optionalFilter(body, key) {
    if (!Object.prototype.hasOwnProperty.call(body, key) || body[key] == null || body[key] === '') return { ok: true, value: '' };
    if (typeof body[key] !== 'string') return { ok: false };
    return { ok: true, value: body[key].trim() };
}

function rateMatches(rate, filters) {
    if (filters.carrier && rate.carrier !== filters.carrier) return false;
    if (filters.origin && rate.originPort !== filters.origin) return false;
    if (filters.destination && rate.destinationPort !== filters.destination) return false;
    if (!filters.search) return true;
    const needle = filters.search.toLowerCase();
    const haystack = [
        rate.rateType,
        rate.originPort,
        rate.destinationPort,
        rate.inlandDeliveryLocation,
        rate.commodityType,
        rate.carrier,
        rate.contractOwner,
        rate.notes1,
        rate.rate20D,
        rate.rate40D,
        rate.rate40HC
    ].map(value => String(value ?? '').toLowerCase());
    return haystack.some(value => value.includes(needle));
}

function priceSample(record, link, proposed) {
    const marginCompany = {
        fields: {
            MarginPercent: link.marginPercent,
            MarginNumber: link.marginNumber,
            Admin: false
        }
    };
    const mapped = mapRateRecord(record, marginCompany);
    applyCustomerPrices(mapped, record, link);
    const containers = [
        ['20D', '20D Rate', 'rate20D'],
        ['40D', '40D rate', 'rate40D'],
        ['40HC', '40HC Rate', 'rate40HC']
    ].map(([size, field, key]) => {
        const base = customerPrice(record.fields[field], { marginPercent: 0, marginNumber: 0 });
        const customer = mapped[key];
        return {
            size,
            base,
            appliedMargin: customer - base,
            customerPrice: customer
        };
    });
    return {
        id: mapped.id,
        ownerCompanyId: record.ownerCompanyId,
        carrier: mapped.carrier,
        originPort: mapped.originPort,
        destinationPort: mapped.destinationPort,
        rateType: mapped.rateType,
        inlandDeliveryLocation: mapped.inlandDeliveryLocation,
        commodityType: mapped.commodityType,
        contractOwner: mapped.contractOwner,
        notes1: mapped.notes1,
        rate20D: mapped.rate20D,
        rate40D: mapped.rate40D,
        rate40HC: mapped.rate40HC,
        base20D: containers[0].base,
        appliedMargin20D: containers[0].appliedMargin,
        customerPrice20D: containers[0].customerPrice,
        base40D: containers[1].base,
        appliedMargin40D: containers[1].appliedMargin,
        customerPrice40D: containers[1].customerPrice,
        base40HC: containers[2].base,
        appliedMargin40HC: containers[2].appliedMargin,
        customerPrice40HC: containers[2].customerPrice,
        proposed
    };
}

// Prices this owner's rates with the customer's margin. It does not sign in as
// the customer and it does not read any other owner's rates.
function previewPrices(ownerCompanyId, customerId, body) {
    const existing = linkRow(ownerCompanyId, customerId);
    if (!existing) {
        return { ok: false, status: 404, error: 'Company was not found in your administration scope.' };
    }
    const source = body || {};
    const margins = readMarginInput(source, { requireBoth: false });
    if (!margins.ok) return { ok: false, status: 400, error: margins.error };
    const filters = {};
    for (const [key, aliases] of [
        ['search', ['search']],
        ['carrier', ['carrier']],
        ['origin', ['origin', 'originPort']],
        ['destination', ['destination', 'destinationPort']]
    ]) {
        let value = '';
        for (const alias of aliases) {
            const read = optionalFilter(source, alias);
            if (!read.ok) return { ok: false, status: 400, error: 'Filters must be text.' };
            if (read.value) value = read.value;
        }
        if (value.length > 200) return { ok: false, status: 400, error: 'Enter a shorter filter.' };
        filters[key] = value;
    }
    const proposed = margins.present;
    const link = {
        marginPercent: margins.hasPercent ? margins.marginPercent : existing.margin_percent,
        marginNumber: margins.hasNumber ? margins.marginNumber : existing.margin_number
    };
    const refreshedAt = new Date().toISOString();
    const rates = existing.status === 'active'
        ? getRatesByOwner(ownerCompanyId)
            .map(record => priceSample(record, link, proposed))
            .filter(rate => rate.ownerCompanyId === ownerCompanyId && rateMatches(rate, filters))
        : [];
    return {
        ok: true,
        preview: {
            refreshedAt,
            proposed,
            status: existing.status,
            marginPercent: displayedMarginPercent(link.marginPercent),
            marginNumber: Number(link.marginNumber) || 0,
            rates
        }
    };
}

module.exports = {
    listCustomers,
    lookupCustomers,
    authorizeCustomer,
    revokeCustomer,
    updateMargins,
    previewPrices,
    readMarginInput
};
