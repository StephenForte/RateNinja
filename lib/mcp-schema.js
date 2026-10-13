// Validates a tools/call arguments object against that tool's declared inputSchema.
// Covers the schema keywords this server publishes: required, additionalProperties,
// type, format date (YYYY-MM-DD), minLength, and pagination bounds that match the
// partner API (page 1..10000, pageSize 1..100).

const { parseDateOnly } = require('./domain');

const PAGE_MAX = 10_000;
const PAGE_SIZE_MAX = 100;

function isPlainObject(value) {
    return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function fail(error) {
    return { ok: false, error };
}

function validateToolArguments(schema, args) {
    if (!isPlainObject(schema)) return fail('Tool schema is missing.');
    if (!isPlainObject(args)) return fail('Tool arguments must be an object.');
    const properties = isPlainObject(schema.properties) ? schema.properties : {};
    const required = new Set(Array.isArray(schema.required) ? schema.required : []);
    if (schema.additionalProperties === false) {
        for (const key of Object.keys(args)) {
            if (!Object.prototype.hasOwnProperty.call(properties, key)) {
                return fail(`Unexpected property '${key}'.`);
            }
        }
    }
    for (const name of required) {
        if (!Object.prototype.hasOwnProperty.call(args, name)) {
            return fail(`Missing required property '${name}'.`);
        }
    }
    for (const [name, definition] of Object.entries(properties)) {
        if (!Object.prototype.hasOwnProperty.call(args, name) || !isPlainObject(definition)) continue;
        const value = args[name];
        if (definition.type === 'string') {
            if (typeof value !== 'string') return fail(`'${name}' must be a string.`);
            if (definition.minLength && value.length < definition.minLength) {
                return fail(`'${name}' is required.`);
            }
            if (definition.format === 'date') {
                const optionalBlank = value === '' && !required.has(name);
                if (!optionalBlank && !parseDateOnly(value)) return fail(`'${name}' must be YYYY-MM-DD.`);
            }
        } else if (definition.type === 'integer') {
            if (typeof value !== 'number' || !Number.isInteger(value)) return fail(`'${name}' must be an integer.`);
            if (name === 'page' && (value < 1 || value > PAGE_MAX)) {
                return fail(`'page' must be an integer from 1 to ${PAGE_MAX}.`);
            }
            if (name === 'pageSize' && (value < 1 || value > PAGE_SIZE_MAX)) {
                return fail(`'pageSize' must be an integer from 1 to ${PAGE_SIZE_MAX}.`);
            }
        }
    }
    return { ok: true };
}

module.exports = {
    PAGE_MAX,
    PAGE_SIZE_MAX,
    validateToolArguments
};
