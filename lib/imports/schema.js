'use strict';

const { targetIds } = require('./fields');

const CONFIDENCE = new Set(['high', 'medium', 'low']);

function mappingPrompt(sampleJson) {
    return `Map each source header onto one Rate Ninja field. Return only a JSON object, no markdown.

Rules:
- Use a target at most once.
- If no target fits, use null. Do not invent a field.
- Do not map Validity, Notes 2, Notes 3, or Note 4 onto another field. They have no target.
- Do not convert prices or dates. Do not fill empty cells.
- confidence is high, medium, or low. reason is one short sentence.
- Return header-to-field pairs only. Do not return cell values.
- Use this JSON shape and no other keys. One mappings entry per header. target is a field id or null, never a cell value.
{"dataset":"rates","mappings":[{"source":"Origin Port","target":"originPort","confidence":"high","reason":"The header names the origin."}]}

Rate targets: rateType, originPort, destinationPort, inlandDeliveryLocation, commodityType, carrier, contractOwner, contractNumber, rate20D, rate40D, rate40HC, rateEffectiveDate, rateExpirationDate, notes1.
Sailing targets: carrier, departurePort, arrivalPort, departure, arrival, transitTime, vessel, voyage, service.

Sample:
${sampleJson}`;
}

function isPlainObject(value) {
    return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function validateSuggestion(payload, dataset, headers) {
    if (!isPlainObject(payload)) return null;
    const keys = Object.keys(payload);
    if (keys.some(key => key !== 'dataset' && key !== 'mappings')) return null;
    if (payload.dataset !== dataset || !Array.isArray(payload.mappings)) return null;
    const allowed = targetIds(dataset);
    const sources = [];
    const targets = new Set();
    for (const item of payload.mappings) {
        if (!isPlainObject(item)) return null;
        const itemKeys = Object.keys(item);
        if (itemKeys.some(key => !['source', 'target', 'confidence', 'reason'].includes(key))) return null;
        if (itemKeys.length !== 4) return null;
        if (typeof item.source !== 'string' || !headers.includes(item.source)) return null;
        if (item.target !== null && (typeof item.target !== 'string' || !allowed.has(item.target))) return null;
        if (!CONFIDENCE.has(item.confidence)) return null;
        if (typeof item.reason !== 'string' || !item.reason.trim() || item.reason.length > 200) return null;
        if (item.target && targets.has(item.target)) return null;
        if (item.target) targets.add(item.target);
        sources.push(item.source);
    }
    if (sources.length !== headers.length) return null;
    if (headers.some(header => !sources.includes(header))) return null;
    if (new Set(sources).size !== sources.length) return null;
    return payload.mappings.map(item => ({
        source: item.source,
        target: item.target,
        confidence: item.confidence,
        reason: item.reason
    }));
}

module.exports = {
    mappingPrompt,
    validateSuggestion
};
