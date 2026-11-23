import { request } from '../api.js';

export function read(path) {
    return request(path);
}

// Session writes go through the shared client so the CSRF header stays with it.
// The response body is kept beside that call so a lane error can still carry position.
export async function write(path, method, body) {
    const original = globalThis.fetch;
    let payload = null;
    globalThis.fetch = async (url, init) => {
        const response = await original(url, init);
        if (response && response.status !== 204 && typeof response.clone === 'function') {
            payload = await response.clone().json().catch(() => ({}));
        } else {
            payload = null;
        }
        return response;
    };
    try {
        return await request(path, {
            method,
            ...(body === undefined ? {} : { body: JSON.stringify(body) })
        });
    } catch (error) {
        if (payload && Number.isInteger(payload.position)) error.position = payload.position;
        throw error;
    } finally {
        globalThis.fetch = original;
    }
}
