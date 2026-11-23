import { request } from '../api.js';

export function read(path) {
    return request(path);
}

function requestUrl(url) {
    if (typeof url === 'string') return url;
    if (url && typeof url.url === 'string') return url.url;
    return '';
}

// Session writes go through the shared client so the CSRF header stays with it.
// A lane error's position is copied off that write's own response. Other fetches
// that overlap this call, including the booking-bell poll, are left alone.
export async function write(path, method, body) {
    const cell = { fetch: globalThis.fetch };
    let payload = null;
    const wrapper = async (url, init) => {
        const response = await cell.fetch.call(globalThis, url, init);
        if (requestUrl(url) === path && response && response.status !== 204 && typeof response.clone === 'function') {
            const parsed = await response.clone().json().catch(() => null);
            if (parsed && Number.isInteger(parsed.position)) payload = parsed;
        }
        return response;
    };
    wrapper.cell = cell;
    globalThis.fetch = wrapper;
    try {
        return await request(path, {
            method,
            ...(body === undefined ? {} : { body: JSON.stringify(body) })
        });
    } catch (error) {
        if (payload && Number.isInteger(payload.position)) error.position = payload.position;
        throw error;
    } finally {
        if (globalThis.fetch === wrapper) {
            globalThis.fetch = cell.fetch;
        } else {
            let cursor = globalThis.fetch;
            const seen = new Set();
            while (cursor && cursor.cell && !seen.has(cursor)) {
                seen.add(cursor);
                if (cursor.cell.fetch === wrapper) cursor.cell.fetch = cell.fetch;
                cursor = cursor.cell.fetch;
            }
        }
    }
}
