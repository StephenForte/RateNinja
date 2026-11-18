'use strict';

const { clientAgentSettings, createMcpClient, distinctLanes } = require('./client-agent');
const { extractJsonBlock, REFERENCE_SCHEMA } = require('./cloudbbs-post');

const AGENTS_PATH = '/api/admin/v1/managed-agents';
const KEY_PLACEHOLDER = '<RATE_NINJA_ADMIN_API_KEY>';
const READ_TOOLS = new Set(['connect_agent', 'list_projects', 'check_board']);

async function readKnownLanes(settings, fetchImpl) {
    const mcp = createMcpClient({
        baseUrl: settings.cloudBbsUrl,
        token: settings.agentToken,
        fetchImpl: (url, options) => {
            if (!READ_TOOLS.has(JSON.parse(options.body).params.name)) throw new Error('Unexpected CloudBBS tool.');
            return fetchImpl(url, { ...options, redirect: 'error' });
        }
    });
    const { sessionId } = await mcp.callTool('connect_agent', { name: settings.agentName });
    if (!sessionId) throw new Error('Missing CloudBBS session.');
    const { projects } = await mcp.callTool('list_projects', { session_id: sessionId });
    const project = projects?.find(row => row.slug === settings.project);
    if (!project?.id) throw new Error('CloudBBS project unavailable.');

    // Option 10's announcement reader is private. Read the same check_board pages
    // and use the shared reference parser without changing the option 10 module.
    const args = { session_id: sessionId, project_id: project.id, budget_bytes: 60000, format: 'json' };
    let body = '';
    const seen = new Set();
    for (let page = 0; page < 64; page += 1) {
        const board = await mcp.callTool('check_board', args);
        const chunk = board?.announcements?.projects?.[0];
        if (!chunk || typeof chunk.body !== 'string' || (chunk.bodyOffset ?? 0) !== body.length) {
            throw new Error('Incomplete CloudBBS announcement.');
        }
        body += chunk.body;
        if (!chunk.truncated) {
            const reference = extractJsonBlock(body);
            if (reference?.schema !== REFERENCE_SCHEMA || !Array.isArray(reference.reads?.rateDateRanges)) {
                throw new Error('Invalid CloudBBS announcement.');
            }
            return distinctLanes(reference.reads.rateDateRanges);
        }
        if (!chunk.continuation || seen.has(chunk.continuation)) throw new Error('Invalid announcement continuation.');
        seen.add(chunk.continuation);
        args.continuation = chunk.continuation;
    }
    throw new Error('CloudBBS announcement exceeded the page limit.');
}

async function getJson(baseUrl, path, key, fetchImpl) {
    const response = await fetchImpl(new URL(path, baseUrl), {
        method: 'GET',
        headers: { 'X-Admin-API-Key': key, Accept: 'application/json' },
        redirect: 'error'
    });
    if (!response.ok) return { status: response.status };
    return { data: await response.json() };
}

function buildPrompt(agent, results, lanes, baseUrl) {
    const agentUrl = new URL(`${AGENTS_PATH}/${encodeURIComponent(agent.id)}`, baseUrl);
    const metadata = {
        id: agent.id,
        company: agent.companyName,
        companyType: agent.companyType,
        creator: agent.creatorName,
        status: agent.status,
        queuedAt: agent.createdAt,
        rateType: agent.rateType,
        originPort: agent.originPort,
        destinationPort: agent.destinationPort,
        sailingDate: agent.sailingDate,
        containerType: agent.containerType,
        allowAlternativeRoutes: agent.allowAlternativeRoutes,
        allowBookingRequest: agent.allowBookingRequest,
        priceMin: agent.priceMin,
        priceMax: agent.priceMax,
        bookingSlots: agent.bookingSlots
    };
    const lines = [
        `Managed agent ${agent.id}`,
        JSON.stringify(metadata, null, 2),
        'Judge the matches for this search using the customer price and available sailing dates.',
        'Matches and sailings',
        JSON.stringify(results, null, 2)
    ];
    if (agent.allowAlternativeRoutes) {
        const destinations = lanes.filter(lane => lane.origin === agent.originPort && lane.destination !== agent.destinationPort)
            .map(lane => lane.destination).sort();
        lines.push('Alternative destinations', JSON.stringify(destinations),
            'Choose up to three nearby destinations from this list. For each, query:',
            `GET ${agentUrl.href}/matches?destinationPort=<URL-encoded destination>`,
            `X-Admin-API-Key: ${KEY_PLACEHOLDER}`);
    }
    if (agent.allowBookingRequest) {
        const expiration = match => match.rateExpirationDate?.slice(0, 10) || '9999-12-31';
        const best = results.matches.filter(match => match.bookable && match.withinPriceRange)
            .sort((a, b) => a.price - b.price || expiration(a).localeCompare(expiration(b)))[0];
        lines.push('Booking request',
            `Make at most one booking request, for ${agent.bookingSlots} slot(s) of ${agent.containerType}, only for a bookable match inside the price range.`);
        if (best) {
            lines.push(`POST ${agentUrl.href}/booking-requests`,
                `X-Admin-API-Key: ${KEY_PLACEHOLDER}`,
                'Content-Type: application/json',
                JSON.stringify({ rateId: best.rateId }));
        } else {
            lines.push('No match inside the price range is currently bookable.');
        }
    }
    return lines.join('\n');
}

async function previewManagedAgentPrompts({
    baseUrl, json = false, env = process.env, stdout = process.stdout, stderr = process.stderr, fetchImpl = fetch
}) {
    const settings = clientAgentSettings(env);
    const key = env.RATE_NINJA_ADMIN_API_KEY;
    let step = 'listing queued agents';
    try {
        const list = await getJson(baseUrl, AGENTS_PATH, key, fetchImpl);
        if (!Array.isArray(list.data?.agents)) {
            stderr.write(`Could not list queued agents${list.status ? ` (HTTP ${list.status})` : ''}.\n`);
            return 1;
        }
        const agents = list.data.agents;
        let lanes = [];
        if (agents.some(agent => agent.allowAlternativeRoutes)) {
            if (!settings.agentToken) {
                stderr.write('Set CLOUDBBS_AGENT_TOKEN to preview agents that allow alternative routes.\n');
                return 2;
            }
            step = 'reading the CloudBBS announcement';
            lanes = await readKnownLanes(settings, fetchImpl);
        }
        step = 'reading managed agent matches';
        const prompts = [];
        const secrets = [key, settings.agentToken, settings.buyerApiKey, settings.anthropicKey, env.CLOUDBBS_TOKEN]
            .filter(Boolean).sort((a, b) => b.length - a.length);
        for (const agent of agents) {
            const result = await getJson(baseUrl, `${AGENTS_PATH}/${encodeURIComponent(agent.id)}/matches`, key, fetchImpl);
            if (!Array.isArray(result.data?.matches) || !Array.isArray(result.data?.sailings)) {
                stderr.write(`Could not read managed agent matches${result.status ? ` (HTTP ${result.status})` : ''}.\n`);
                return 1;
            }
            let prompt = buildPrompt(agent, result.data, lanes, baseUrl);
            for (const secret of secrets) {
                prompt = prompt.replaceAll(secret, '[redacted]');
            }
            prompts.push(prompt);
        }
        if (json) stdout.write(JSON.stringify(prompts, null, 2) + '\n');
        else stdout.write(prompts.length ? prompts.join('\n\n---\n\n') + '\n' : 'No queued managed agents.\n');
        return 0;
    } catch {
        // Upstream errors can echo request data, so report only the local step.
        stderr.write(`Preview failed while ${step}.\n`);
        return 1;
    }
}

module.exports = { previewManagedAgentPrompts };
