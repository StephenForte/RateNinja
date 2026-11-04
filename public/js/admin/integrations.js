import { heading, paragraph } from '../dom.js';

const DOCS = [
    { href: '/api-testbed.html', text: 'Demo API testbed' },
    { href: '/api-docs.html', text: 'API documentation' },
    { href: '/API-README.md', text: 'API README' },
    { href: '/docs/partner-integration.md', text: 'Partner and MCP guide' }
];

const OWNER_POINTS = [
    'A contract-owner account can approve a registered OAuth client. That client then calls the partner API and POST /mcp for this account\'s base contract rates and sailings.',
    'Partner and MCP prices are base contract prices. They are not a customer margin price, and they are not a predictive estimate.',
    'Booking requests for this company can be listed and read with bookings:read, and approved or declined with bookings:write. That decision changes data and is final. The booking payload is the customer price and the requester, not the base price. Customer accounts can authorize the partner API and MCP for customer-priced rates and booking requests.',
    'Predictive pricing on the partner API and the MCP tool is an estimate for a departure more than 90 days ahead. It is calculated, not stored, and it does not add a customer margin.',
    'Unsupported company types cannot approve partner or MCP access.',
    'Partner OAuth, the partner API, and MCP answer only when PARTNER_OAUTH_ENABLED allows them. The shared demo key on /api/v1 is not this company\'s credential, and it is not accepted on those routes.',
    'Nothing on this page is a client id, client secret, access token, or password. Use the placeholders in the guide when you try a call.'
];

const CUSTOMER_POINTS = [
    'This account\'s company is a customer. Signed-in browsing uses: GET /api/rates, GET /api/sailings, and GET /api/rates/predictive, with the session cookie.',
    'Those rate and predictive responses apply this company\'s active margin. They are not the owner\'s base contract price, and they are not the partner API.',
    'Customers can list available-rates with rates:read, list and read their company booking requests with bookings:read, and create with bookings:write. A repeat create makes another request; clients should list before retrying.',
    'This account can authorize the partner API or MCP. Customer tokens cannot read owner base prices, sailings or predictive pricing, or decide requests.',
    'The key on /api/v1 is a shared demonstration key. It is not this company\'s private credential. The testbed calls that demo API.',
    'Nothing on this page is a key, client secret, access token, or password.'
];

export function instructionsFor(permissions) {
    const contractOwner = Boolean(permissions && permissions.contractOwner === true);
    if (contractOwner) {
        return {
            audience: 'owner',
            title: 'API and MCP instructions',
            summary: 'This account belongs to a contract owner. Partner OAuth and MCP are available to this account. Customers can also authorize access to their own prices and booking requests.',
            points: OWNER_POINTS.slice(),
            links: DOCS.concat([{ href: '/profile/connected-apps', text: 'Connected apps (revoke access)' }])
        };
    }
    if (!permissions || permissions.companyType !== 'Freight Forwarder/Customer') {
        return { audience: 'unsupported', title: 'API and MCP instructions',
            summary: 'This company type cannot authorize the partner API or MCP.',
            points: ['Unsupported company types cannot approve partner or MCP access.'], links: DOCS.slice() };
    }
    return {
        audience: 'customer',
        title: 'API and MCP instructions',
        summary: 'This account belongs to a customer. Session browsing, the partner API and MCP are available with customer prices and booking requests.',
        points: CUSTOMER_POINTS.slice(),
        links: DOCS.concat([{ href: '/profile/connected-apps', text: 'Connected apps (revoke access)' }])
    };
}

export function mount(container, ctx) {
    const model = instructionsFor(ctx && ctx.permissions);
    const section = document.createElement('section');
    section.className = 'integration-instructions';
    section.dataset.audience = model.audience;
    const list = document.createElement('ul');
    for (const point of model.points) {
        const item = document.createElement('li');
        item.textContent = point;
        list.append(item);
    }
    const links = document.createElement('ul');
    links.className = 'integration-links';
    for (const link of model.links) {
        const item = document.createElement('li');
        const anchor = document.createElement('a');
        anchor.href = link.href;
        anchor.textContent = link.text;
        item.append(anchor);
        links.append(item);
    }
    section.append(
        heading(model.title),
        paragraph('pull-forward-subtitle', model.summary),
        list,
        links
    );
    container.replaceChildren(section);
}

export function unmount() {}
