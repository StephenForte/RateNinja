'use strict';

const { importMappingModel, importMappingTimeoutMs } = require('../config');
const { mappingPrompt } = require('./schema');

let client = null;
let calls = 0;

function setClient(fn) {
    client = typeof fn === 'function' ? fn : null;
    calls = 0;
}

function clientCalls() {
    return calls;
}

async function callAnthropic(sample) {
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) {
        const error = new Error('Claude is not configured.');
        error.code = 'claude_unavailable';
        throw error;
    }
    const model = importMappingModel();
    const response = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
            'content-type': 'application/json',
            'x-api-key': apiKey,
            'anthropic-version': '2023-06-01'
        },
        body: JSON.stringify({
            model,
            max_tokens: 4000,
            messages: [{ role: 'user', content: mappingPrompt(JSON.stringify(sample)) }]
        }),
        signal: AbortSignal.timeout(importMappingTimeoutMs())
    });
    const payload = await response.json().catch(() => null);
    if (!response.ok) {
        const error = new Error('Claude is unavailable.');
        error.code = 'claude_unavailable';
        error.status = response.status;
        throw error;
    }
    const text = Array.isArray(payload && payload.content)
        ? payload.content.filter(block => block && block.type === 'text').map(block => block.text).join('')
        : '';
    return {
        text,
        model: payload && payload.model ? payload.model : model,
        usage: payload && payload.usage ? payload.usage : null
    };
}

async function requestMapping(sample) {
    if (client) {
        calls += 1;
        return client(sample);
    }
    if (process.env.NODE_ENV === 'test') {
        const error = new Error('Claude is not stubbed.');
        error.code = 'claude_unavailable';
        throw error;
    }
    return callAnthropic(sample);
}

module.exports = {
    setClient,
    clientCalls,
    requestMapping,
    mappingPrompt
};
