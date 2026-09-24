const {
    listPartnerRates,
    getPartnerRate,
    listPartnerSailings,
    getPartnerSailing,
    ALLOCATION_NOTICE
} = require('./visibility');

const PROTOCOL_VERSION = '2025-03-26';

const TOOLS = [
    {
        name: 'rateninja_get_my_profile',
        description: 'Current Rate Ninja subject, company, and granted scopes. Rate data is not allocation evidence.',
        scope: 'profile:read',
        inputSchema: { type: 'object', properties: {}, additionalProperties: false }
    },
    {
        name: 'rateninja_list_my_rates',
        description: `Paginated base/contract rates for this contract owner. ${ALLOCATION_NOTICE}`,
        scope: 'rates:read',
        inputSchema: {
            type: 'object',
            properties: {
                carrier: { type: 'string' },
                originPort: { type: 'string' },
                destinationPort: { type: 'string' },
                effectiveDate: { type: 'string', description: 'YYYY-MM-DD covered by the rate' },
                page: { type: 'integer' },
                pageSize: { type: 'integer' }
            },
            additionalProperties: false
        }
    },
    {
        name: 'rateninja_get_my_rate',
        description: `One base/contract rate owned by this contract owner. ${ALLOCATION_NOTICE}`,
        scope: 'rates:read',
        inputSchema: {
            type: 'object',
            properties: { rateId: { type: 'string' } },
            required: ['rateId'],
            additionalProperties: false
        }
    },
    {
        name: 'rateninja_list_my_sailings',
        description: `Paginated sailings owned by this contract owner. ${ALLOCATION_NOTICE}`,
        scope: 'sailings:read',
        inputSchema: {
            type: 'object',
            properties: {
                carrier: { type: 'string' },
                originPort: { type: 'string' },
                after: { type: 'string' },
                page: { type: 'integer' },
                pageSize: { type: 'integer' }
            },
            additionalProperties: false
        }
    },
    {
        name: 'rateninja_get_my_sailing',
        description: `One sailing owned by this contract owner. ${ALLOCATION_NOTICE}`,
        scope: 'sailings:read',
        inputSchema: {
            type: 'object',
            properties: { sailingId: { type: 'string' } },
            required: ['sailingId'],
            additionalProperties: false
        }
    }
];

function toolResult(payload, isError = false) {
    return {
        content: [{ type: 'text', text: JSON.stringify(payload) }],
        structuredContent: payload,
        isError
    };
}

function rpcResult(id, result) {
    return { status: 200, body: { jsonrpc: '2.0', id, result } };
}

function rpcError(id, code, message, status = 200) {
    return { status, body: { jsonrpc: '2.0', id: id ?? null, error: { code, message } } };
}

function profilePayload(access) {
    return {
        sub: access.sub,
        name: access.username,
        companyId: access.companyRecordId,
        companyName: access.companyName,
        companyType: access.companyType,
        active: access.active,
        scopes: access.scopes,
        notice: ALLOCATION_NOTICE
    };
}

function handleMcp({ message, access, pageFrom }) {
    if (!message || message.jsonrpc !== '2.0' || typeof message.method !== 'string') {
        return rpcError(message?.id ?? null, -32600, 'Invalid Request', 400);
    }
    const { id, method, params } = message;
    if (method.startsWith('notifications/')) return { status: 202, body: null };
    if (!access) return rpcError(id, -32001, 'Authorization required', 401);
    if (method === 'initialize') {
        return rpcResult(id, {
            protocolVersion: PROTOCOL_VERSION,
            capabilities: { tools: { listChanged: false } },
            serverInfo: { name: 'rateninja', version: '1.0.0' },
            instructions: ALLOCATION_NOTICE
        });
    }
    if (method === 'ping') return rpcResult(id, {});
    if (method === 'tools/list') {
        return rpcResult(id, {
            tools: TOOLS.map(tool => ({ name: tool.name, description: tool.description, inputSchema: tool.inputSchema }))
        });
    }
    if (method === 'tools/call') {
        const name = params?.name;
        const args = params?.arguments || {};
        const tool = TOOLS.find(candidate => candidate.name === name);
        if (!tool) return rpcError(id, -32602, 'Unknown tool');
        if (!access.scopes.includes(tool.scope)) {
            return rpcResult(id, toolResult({ error: 'insufficient_scope', error_description: 'Token does not include the required scope.' }, true));
        }
        if (name === 'rateninja_get_my_profile') return rpcResult(id, toolResult(profilePayload(access)));
        if (name === 'rateninja_list_my_rates' || name === 'rateninja_list_my_sailings') {
            const query = pageFrom(args);
            if (query?.error) {
                return rpcResult(id, toolResult({ error: 'invalid_request', error_description: query.error }, true));
            }
            const payload = name === 'rateninja_list_my_rates'
                ? listPartnerRates(access, query)
                : listPartnerSailings(access, query);
            return rpcResult(id, toolResult(payload));
        }
        if (name === 'rateninja_get_my_rate') {
            const payload = getPartnerRate(access, args.rateId);
            if (!payload) return rpcResult(id, toolResult({ error: 'not_found', error_description: 'Rate not found.' }, true));
            return rpcResult(id, toolResult(payload));
        }
        if (name === 'rateninja_get_my_sailing') {
            const payload = getPartnerSailing(access, args.sailingId);
            if (!payload) return rpcResult(id, toolResult({ error: 'not_found', error_description: 'Sailing not found.' }, true));
            return rpcResult(id, toolResult(payload));
        }
    }
    return rpcError(id, -32601, 'Method not found');
}

module.exports = {
    handleMcp,
    profilePayload
};
