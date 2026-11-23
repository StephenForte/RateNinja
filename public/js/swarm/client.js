import { request } from '../api.js';

export function read(path) {
    return request(path);
}

// Session writes go through the shared client so the CSRF header stays with it.
// A lane error's position is on the request error, so this call does not replace fetch.
export async function write(path, method, body) {
    return request(path, {
        method,
        ...(body === undefined ? {} : { body: JSON.stringify(body) })
    });
}
