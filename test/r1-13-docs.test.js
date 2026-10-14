const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const docs = [
    'public/api-docs.html',
    'API-README.md',
    'docs/partner-integration.md'
];

const coverage = [
    ['GET /oauth/userinfo', 'rateninja_get_my_profile', 'profile:read'],
    ['GET /api/partner/v1/me/rates', 'rateninja_list_my_rates', 'rates:read'],
    ['GET /api/partner/v1/me/rates/{rateId}', 'rateninja_get_my_rate', 'rates:read'],
    ['GET /api/partner/v1/me/sailings', 'rateninja_list_my_sailings', 'sailings:read'],
    ['GET /api/partner/v1/me/sailings/{sailingId}', 'rateninja_get_my_sailing', 'sailings:read'],
    ['GET /api/partner/v1/me/predictive-pricing', 'rateninja_get_my_predictive_pricing', 'rates:read']
];

function readDoc(relativePath) {
    return fs.readFileSync(path.join(root, relativePath), 'utf8');
}

function secretHits(text) {
    const stripped = text
        .replace(/https?:\/\/\S+/g, ' ')
        .replace(/\bYOUR_[A-Z0-9_]+\b/g, ' ');
    const hits = [];
    if (/sk-[A-Za-z0-9]{8,}/.test(stripped)) hits.push('sk- prefix');
    if (/\b[A-Fa-f0-9]{32,}\b/.test(stripped)) hits.push('long hex');
    if (/\b[A-Za-z0-9+/]{40,}={0,2}\b/.test(stripped)) hits.push('long base64');
    if (/\b[A-Za-z0-9_-]{43,}\b/.test(stripped)) hits.push('long token');
    if (/RATE_NINJA_API_KEY\s*[=:]\s*\S+/.test(stripped)) hits.push('RATE_NINJA_API_KEY value');
    return hits;
}

describe('API and MCP instructions', () => {
    it('renders the owner variant for a contract owner and the customer variant for a customer', async () => {
        const { instructionsFor } = await import('../public/js/admin/integrations.js');
        const owner = instructionsFor({
            signedIn: true,
            companyAdmin: true,
            contractOwner: true,
            companyName: 'Kings Group'
        });
        const customer = instructionsFor({
            signedIn: true,
            companyAdmin: true,
            contractOwner: false,
            companyName: 'Blackwater'
        });

        assert.equal(owner.audience, 'owner');
        assert.match(owner.summary, /contract owner/i);
        assert.match(owner.points.join(' '), /OAuth/);
        assert.match(owner.points.join(' '), /MCP/);
        assert.match(owner.points.join(' '), /cannot approve partner or MCP access/);
        assert.deepEqual(owner.links.map(link => link.href), [
            '/api-testbed.html',
            '/api-docs.html',
            '/API-README.md',
            '/docs/partner-integration.md',
            '/profile/connected-apps'
        ]);

        assert.equal(customer.audience, 'customer');
        assert.match(customer.summary, /cannot authorize the partner API or MCP/);
        assert.match(customer.points.join(' '), /GET \/api\/rates/);
        assert.match(customer.points.join(' '), /session cookie/);
        assert.equal(customer.points.some(point => /client secret is [A-Za-z0-9]/.test(point)), false);
        assert.deepEqual(customer.links.map(link => link.href), [
            '/api-testbed.html',
            '/api-docs.html',
            '/API-README.md',
            '/docs/partner-integration.md'
        ]);
        assert.equal(customer.links.some(link => link.href === '/profile/connected-apps'), false);
    });

    it('keeps the R1-12 coverage rows in all three docs', () => {
        for (const relativePath of docs) {
            const text = readDoc(relativePath);
            for (const [api, tool, scope] of coverage) {
                assert.equal(text.includes(api), true, `${relativePath} missing ${api}`);
                assert.equal(text.includes(tool), true, `${relativePath} missing ${tool}`);
                assert.equal(text.includes(scope), true, `${relativePath} missing ${scope}`);
            }
        }
    });

    it('does not embed a secret or a RateView access rule', () => {
        for (const relativePath of docs) {
            const text = readDoc(relativePath);
            assert.deepEqual(secretHits(text), [], relativePath);
            assert.equal(text.includes('RateView'), false, relativePath);
            assert.equal(/not live/i.test(text), false, relativePath);
        }
    });
});
