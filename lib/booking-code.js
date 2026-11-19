'use strict';

const { cloudBbsServerToken } = require('./config');
const { createMcpClient } = require('./client-agent');
const { cloudBbsSettings, extractJsonBlock } = require('./cloudbbs-post');

const CACHE_MS = 60_000;
const READ_TIMEOUT_MS = 3_000;

function normalizeCode(value) {
    if (typeof value !== 'string') return null;
    const trimmed = value.trim();
    return /^[A-Za-z0-9]{9}$/.test(trimmed) ? trimmed.toUpperCase() : null;
}

async function readAnnouncement({ baseUrl, project, token, agentName, includeReference = false, fetchImpl = fetch,
    timeoutMs = READ_TIMEOUT_MS }) {
    if (!token) return {};
    let bookingCode = null;
    try {
        const signal = AbortSignal.timeout(timeoutMs);
        const mcp = createMcpClient({
            baseUrl, token,
            fetchImpl: (url, options) => fetchImpl(url, { ...options, redirect: 'error', signal })
        });
        const { sessionId } = await mcp.callTool('connect_agent', { name: agentName });
        if (!sessionId) return {};
        const { projects } = await mcp.callTool('list_projects', { session_id: sessionId });
        const projectId = projects?.find(row => row.slug === project)?.id;
        if (!projectId) return {};

        const args = { session_id: sessionId, project_id: projectId, budget_bytes: 60_000, format: 'json' };
        let body = '';
        let hasCodeLine = false;
        const seen = new Set();
        for (let page = 0; page < 64; page += 1) {
            const board = await mcp.callTool('check_board', args);
            const chunk = board?.announcements?.projects?.[0];
            if (typeof chunk?.body !== 'string' || (chunk.bodyOffset ?? 0) !== body.length) break;
            body += chunk.body;
            if (!hasCodeLine) {
                // A truncated chunk may end partway through the code line.
                const match = /^Today's Booking Code:[ \t]*([^\r\n]*)(?:\r?\n|$)/m.exec(body);
                if (match && (!chunk.truncated || match[0].endsWith('\n'))) {
                    hasCodeLine = true;
                    bookingCode = normalizeCode(match[1]);
                    if (!includeReference) return { bookingCode };
                }
            }
            if (!chunk.truncated) {
                let reference;
                try {
                    reference = extractJsonBlock(body);
                } catch {
                    return { bookingCode };
                }
                return { bookingCode: hasCodeLine ? bookingCode : normalizeCode(reference?.bookingCode), reference };
            }
            if (!chunk.continuation || seen.has(chunk.continuation)) break;
            seen.add(chunk.continuation);
            args.continuation = chunk.continuation;
        }
    } catch {
        // A completed code line may have arrived before a later reference page failed.
    }
    return { bookingCode };
}

function createBookingCodeCheck({ settings, now = () => performance.now() }) {
    let state;
    return async function bookingCodeFailure(value) {
        const { baseUrl, project, token, agentName } = settings();
        if (!state || state.baseUrl !== baseUrl || state.project !== project || state.token !== token) {
            clearTimeout(state?.expirationTimer);
            if (state) state.code = null;
            state = { baseUrl, project, token };
        }
        const current = state;
        if (!current.code || now() >= current.expiresAt) {
            clearTimeout(current.expirationTimer);
            current.code = null;
            current.pending ??= readAnnouncement({ baseUrl, project, token, agentName }).then(({ bookingCode }) => {
                if (!bookingCode || state !== current) return;
                current.code = bookingCode;
                current.expiresAt = now() + CACHE_MS;
                current.expirationTimer = setTimeout(() => { current.code = null; }, CACHE_MS).unref();
            }).finally(() => { current.pending = null; });
            await current.pending;
        }
        if (!current.code) return { status: 503, error: 'booking_code_unavailable' };
        if (normalizeCode(value) !== current.code) return { status: 403, error: 'invalid_booking_code' };
        return null;
    };
}

const bookingCodeFailure = createBookingCodeCheck({
    settings() {
        const { url, project } = cloudBbsSettings();
        return { baseUrl: url, project, token: cloudBbsServerToken(), agentName: 'rateninja-server' };
    }
});

module.exports = { bookingCodeFailure, createBookingCodeCheck, readAnnouncement };
