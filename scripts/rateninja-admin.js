#!/usr/bin/env node
'use strict';

try {
    process.loadEnvFile('.env');
} catch {
    // .env is optional; real environment variables win when present.
}

const readline = require('node:readline');
const { stdin, stdout, stderr } = require('node:process');
const {
    BODY_SIZE_CAP,
    cloudBbsSettings,
    buildAnnouncement,
    collectReferenceReads,
    putAnnouncement
} = require('../lib/cloudbbs-post');
const { runClientAgent } = require('../lib/client-agent');
const { previewManagedAgentPrompts } = require('../lib/managed-agent-prompts');
const { runManagedAgents } = require('../lib/managed-agent-runner');

const DEFAULT_BASE_URL = 'https://rate-ninja.onrender.com';
const QUIT_MENU_INDEX = 8;
const CLOUDBBS_MENU_INDEX = 9;
const CLIENT_AGENT_MENU_INDEX = 10;
const MANAGED_AGENT_PROMPTS_MENU_INDEX = 11;
const MANAGED_AGENTS_RUN_MENU_INDEX = 12;
const SAMPLE_AGENTS_MENU_INDEX = 13;
const SAMPLE_PRESETS = ['alan', 'bob', 'testbuyer'];

const COMMANDS = [
    {
        name: 'rate-date-ranges',
        description: 'Current rate effective/expiration periods',
        path: '/api/admin/v1/reference/rate-date-ranges',
        filters: ['company', 'carrier', 'origin-port', 'destination-port', 'page', 'page-size']
    },
    {
        name: 'origin-ports',
        description: 'Distinct origin ports on current rates',
        path: '/api/admin/v1/reference/origin-ports',
        filters: ['company', 'carrier', 'origin-port', 'destination-port', 'page', 'page-size']
    },
    {
        name: 'destination-ports',
        description: 'Distinct destination ports on current rates',
        path: '/api/admin/v1/reference/destination-ports',
        filters: ['company', 'carrier', 'origin-port', 'destination-port', 'page', 'page-size']
    },
    {
        name: 'contract-owners',
        description: 'Distinct contract-owner labels on current rates',
        path: '/api/admin/v1/reference/contract-owners',
        filters: ['company', 'carrier', 'origin-port', 'destination-port', 'page', 'page-size']
    },
    {
        name: 'sailing-date-ranges',
        description: 'Upcoming sailing departure ranges (owners)',
        path: '/api/admin/v1/reference/sailing-date-ranges',
        filters: ['company', 'origin-port', 'page', 'page-size']
    },
    {
        name: 'predictive-date-ranges',
        description: 'Predictive pricing departure windows (owners)',
        path: '/api/admin/v1/reference/predictive-date-ranges',
        filters: ['company', 'origin-port', 'destination-port', 'page', 'page-size']
    },
    {
        name: 'companies',
        description: 'All companies (id, name, type) for the company filter',
        path: '/api/admin/v1/reference/companies',
        filters: ['page', 'page-size']
    }
];

const FILTER_TO_QUERY = {
    company: 'company',
    carrier: 'carrier',
    'origin-port': 'originPort',
    'destination-port': 'destinationPort',
    page: 'page',
    'page-size': 'pageSize'
};

function usage() {
    const names = COMMANDS.map(command => command.name).join('|');
    stderr.write(
        `Usage: node scripts/rateninja-admin.js [list|${names}|post-cloudbbs|client-agent|managed-agent-prompts|managed-agents-run|managed-agents-samples] [--company ID] [--carrier X] [--origin-port X] [--destination-port X] [--page N] [--page-size N] [--json] [--yes] [--user ID]\n`
    );
}

function requireAdminKey() {
    const key = process.env.RATE_NINJA_ADMIN_API_KEY;
    if (typeof key !== 'string' || !key) {
        stderr.write('Set RATE_NINJA_ADMIN_API_KEY in the environment or .env\n');
        process.exit(2);
    }
    return key;
}

function baseUrl() {
    const configured = process.env.RATE_NINJA_BASE_URL;
    if (typeof configured === 'string' && configured.trim()) return configured.trim().replace(/\/$/, '');
    return DEFAULT_BASE_URL;
}

function printMenu() {
    for (let index = 0; index < COMMANDS.length; index += 1) {
        const command = COMMANDS[index];
        stdout.write(`${index + 1}. ${command.name} — ${command.description} (${command.path})\n`);
    }
    stdout.write(`${QUIT_MENU_INDEX}. quit\n`);
    stdout.write(`${CLOUDBBS_MENU_INDEX}. Post this information to the CloudBBS\n`);
    stdout.write(`${CLIENT_AGENT_MENU_INDEX}. Run client agent\n`);
    stdout.write(`${MANAGED_AGENT_PROMPTS_MENU_INDEX}. Preview managed agent prompts\n`);
    stdout.write(`${MANAGED_AGENTS_RUN_MENU_INDEX}. Run managed agents\n`);
    stdout.write(`${SAMPLE_AGENTS_MENU_INDEX}. Queue sample managed agents\n`);
}

function findCommand(name) {
    return COMMANDS.find(command => command.name === name) || null;
}

function parseArgs(argv) {
    if (argv.length === 0) return { mode: 'menu' };
    const commandName = argv[0];
    if (commandName === 'list') return { mode: 'list' };
    if (commandName === 'managed-agent-prompts') {
        if (argv.length === 1 || (argv.length === 2 && argv[1] === '--json')) {
            return { mode: commandName, json: argv.length === 2 };
        }
        usage();
        process.exit(2);
    }
    if (commandName === 'managed-agents-samples') {
        let yes = false;
        let json = false;
        const userIds = [];
        for (let index = 1; index < argv.length; index += 1) {
            const arg = argv[index];
            if (arg === '--yes') {
                yes = true;
                continue;
            }
            if (arg === '--json') {
                json = true;
                continue;
            }
            if (arg === '--user') {
                const value = argv[index + 1];
                if (value == null || value.startsWith('--')) {
                    usage();
                    process.exit(2);
                }
                userIds.push(value);
                index += 1;
                continue;
            }
            usage();
            process.exit(2);
        }
        return { mode: commandName, yes, json, userIds };
    }
    if (commandName === 'post-cloudbbs' || commandName === 'client-agent' || commandName === 'managed-agents-run') {
        let yes = false;
        for (let index = 1; index < argv.length; index += 1) {
            const arg = argv[index];
            if (arg === '--yes') {
                yes = true;
                continue;
            }
            usage();
            process.exit(2);
        }
        return { mode: commandName, yes };
    }
    if (commandName.startsWith('-')) {
        usage();
        process.exit(2);
    }
    const command = findCommand(commandName);
    if (!command) {
        usage();
        process.exit(2);
    }
    const options = { json: false };
    for (let index = 1; index < argv.length; index += 1) {
        const arg = argv[index];
        if (arg === '--json') {
            options.json = true;
            continue;
        }
        if (!arg.startsWith('--')) {
            usage();
            process.exit(2);
        }
        const flag = arg.slice(2);
        if (!FILTER_TO_QUERY[flag]) {
            usage();
            process.exit(2);
        }
        if (!command.filters.includes(flag)) {
            usage();
            process.exit(2);
        }
        const value = argv[index + 1];
        if (value == null || value.startsWith('--')) {
            usage();
            process.exit(2);
        }
        options[flag] = value;
        index += 1;
    }
    return { mode: 'once', command, options };
}

function buildUrl(command, options) {
    const url = new URL(command.path, `${baseUrl()}/`);
    for (const flag of command.filters) {
        const value = options[flag];
        if (value == null || value === '') continue;
        url.searchParams.set(FILTER_TO_QUERY[flag], value);
    }
    return url;
}

function flattenRow(row) {
    const flat = {};
    for (const [key, value] of Object.entries(row)) {
        if (value && typeof value === 'object' && !Array.isArray(value)) {
            for (const [nestedKey, nestedValue] of Object.entries(value)) {
                flat[`${key}.${nestedKey}`] = nestedValue;
            }
        } else {
            flat[key] = value;
        }
    }
    return flat;
}

function printResults(payload, asJson) {
    if (asJson) {
        stdout.write(`${JSON.stringify(payload)}\n`);
        return;
    }
    const rows = Array.isArray(payload?.data) ? payload.data : [];
    if (rows.length === 0) {
        stdout.write('No rows.\n');
    } else {
        console.table(rows.map(flattenRow));
    }
    const meta = payload?.meta || {};
    const page = meta.page ?? 1;
    const pageSize = meta.pageSize || 50;
    const total = meta.total ?? rows.length;
    const pages = Math.max(1, Math.ceil(total / pageSize) || 1);
    stdout.write(`page ${page} of ${pages}, ${total} total\n`);
}

async function runCommand(command, options) {
    const key = process.env.RATE_NINJA_ADMIN_API_KEY;
    const url = buildUrl(command, options);
    let response;
    try {
        response = await fetch(url, {
            method: 'GET',
            headers: { 'X-Admin-API-Key': key }
        });
    } catch (error) {
        const message = error && error.message ? error.message : String(error);
        stderr.write(`Network failure contacting ${baseUrl()}: ${message}\n`);
        return 1;
    }
    const text = await response.text();
    let body;
    try {
        body = text ? JSON.parse(text) : {};
    } catch {
        body = { error: text || 'invalid_response' };
    }
    if (!response.ok) {
        const errorField = body && body.error != null ? body.error : 'request_failed';
        stderr.write(`${response.status} ${errorField}\n`);
        return 1;
    }
    printResults(body, Boolean(options.json));
    return 0;
}

function createPrompter() {
    // readline/promises question() closes early on ended pipes; iterate lines instead.
    const rl = readline.createInterface({
        input: stdin,
        output: stdout,
        terminal: Boolean(stdin.isTTY),
        crlfDelay: Infinity
    });
    const lines = rl[Symbol.asyncIterator]();
    return {
        async ask(prompt) {
            stdout.write(prompt);
            const next = await lines.next();
            if (next.done) return null;
            return String(next.value);
        },
        close() {
            rl.close();
        }
    };
}

async function promptFilters(ask, command) {
    const options = {};
    for (const flag of command.filters) {
        const answer = await ask(`${flag} (Enter to skip): `);
        if (answer == null) break;
        const trimmed = answer.trim();
        if (trimmed) options[flag] = trimmed;
    }
    return options;
}

function isAffirmative(answer) {
    if (answer == null) return false;
    const trimmed = answer.trim().toLowerCase();
    return trimmed === 'y' || trimmed === 'yes';
}

function shortErrorLine(payload, text) {
    if (payload && payload.error != null && typeof payload.error !== 'object') {
        return String(payload.error);
    }
    if (typeof text === 'string' && text && !text.includes('\n')) {
        return text;
    }
    return 'request_failed';
}

async function runPostCloudBbs({ confirmed, ask = null }) {
    const settings = cloudBbsSettings();
    if (!settings.token) {
        stderr.write('Set CLOUDBBS_TOKEN in the environment or .env\n');
        return 2;
    }

    const adminKey = process.env.RATE_NINJA_ADMIN_API_KEY;
    const source = baseUrl();
    let reads;
    try {
        reads = await collectReferenceReads({ baseUrl: source, adminKey });
    } catch (error) {
        const message = error && error.message ? error.message : String(error);
        stderr.write(`${message}\n`);
        return 1;
    }

    const generatedAt = new Date().toISOString();
    const announcement = buildAnnouncement({ generatedAt, source, reads });
    if (announcement.byteLength > BODY_SIZE_CAP) {
        stderr.write(
            `Announcement body is ${announcement.byteLength} bytes; CloudBBS cap is ${BODY_SIZE_CAP}. Not posting.\n`
        );
        return 1;
    }

    if (!confirmed) {
        const prompt =
            `Replace the announcement on ${settings.url}/${settings.project} ` +
            `with ${announcement.byteLength} bytes? [y/N] `;
        const answer = ask ? await ask(prompt) : null;
        if (!isAffirmative(answer)) {
            stdout.write('Cancelled.\n');
            return 0;
        }
    }

    let result;
    try {
        result = await putAnnouncement({
            settings,
            title: announcement.title,
            body: announcement.body
        });
    } catch (error) {
        const message = error && error.message ? error.message : String(error);
        stderr.write(`${message}\n`);
        return 1;
    }

    if (!result.ok) {
        stderr.write(`${result.status} ${shortErrorLine(result.payload, result.text)}\n`);
        return 1;
    }

    const version = result.payload?.version;
    const updatedAt = result.payload?.updatedAt;
    stdout.write(
        `Posted to ${settings.project}: version ${version ?? '?'}, updatedAt ${updatedAt ?? '?'}\n`
    );
    return 0;
}

function compactName(value) {
    return String(value || '').toLowerCase().replace(/\s+/g, '');
}

function isSamplePreset(user) {
    const names = [compactName(user.displayName), compactName(user.username)];
    const firstWord = String(user.displayName || '').trim().split(/\s+/)[0].toLowerCase();
    return SAMPLE_PRESETS.some(target => names.includes(target) || firstWord === target);
}

function sampleLabel(user) {
    return `${user.displayName || user.username} (${user.username})`;
}

async function adminFetch(pathname, { method = 'GET', body } = {}) {
    const key = process.env.RATE_NINJA_ADMIN_API_KEY;
    let response;
    try {
        response = await fetch(new URL(pathname, `${baseUrl()}/`), {
            method,
            headers: {
                'X-Admin-API-Key': key,
                ...(body === undefined ? {} : { 'content-type': 'application/json' })
            },
            body: body === undefined ? undefined : JSON.stringify(body)
        });
    } catch (error) {
        const message = error && error.message ? error.message : String(error);
        return { ok: false, status: 0, body: { error: message } };
    }
    const text = await response.text();
    let payload;
    try {
        payload = text ? JSON.parse(text) : {};
    } catch {
        payload = { error: 'invalid_response' };
    }
    return { ok: response.ok, status: response.status, body: payload };
}

function sampleError(result) {
    if (result.body && typeof result.body.error === 'string' && result.body.error) return result.body.error;
    if (result.status) return `request failed (${result.status})`;
    return 'request_failed';
}

async function pickSampleUsers(customers, ask) {
    const selected = new Set(customers.filter(isSamplePreset).map(user => user.id));
    while (true) {
        customers.forEach((user, index) => {
            const mark = selected.has(user.id) ? 'x' : ' ';
            stdout.write(`${index + 1}. [${mark}] ${sampleLabel(user)} — ${user.companyName}\n`);
        });
        const answer = await ask('Toggle numbers (comma-separated), or Enter to accept: ');
        if (answer == null) return null;
        const trimmed = answer.trim();
        if (!trimmed) return customers.filter(user => selected.has(user.id));
        let valid = false;
        for (const part of trimmed.split(/[\s,]+/)) {
            if (!part) continue;
            const index = Number(part);
            if (!Number.isInteger(index) || index < 1 || index > customers.length) continue;
            valid = true;
            const id = customers[index - 1].id;
            if (selected.has(id)) selected.delete(id);
            else selected.add(id);
        }
        if (!valid) stdout.write('Enter list numbers separated by commas.\n');
    }
}

function printSamplePreview(plans) {
    const labels = { lowball: 'lowball', regular: 'regular', no_booking: 'no booking' };
    for (const plan of plans) {
        stdout.write(`${sampleLabel(plan)} — ${plan.companyName}\n`);
        for (const agent of plan.agents) {
            const booking = agent.allowBookingRequest ? 'booking on' : 'booking off';
            const ceiling = agent.allowBookingRequest ? ` ceiling ${agent.priceMax}` : '';
            stdout.write(
                `  ${labels[agent.sampleKind] || agent.sampleKind}  ${agent.originPort} → ${agent.destinationPort}  ` +
                `${agent.sailingDate}  ${agent.containerType}  ${booking}${ceiling}\n`
            );
        }
    }
}

async function runSampleAgents({ confirmed, ask = null, userIds = [], json = false }) {
    const listed = await adminFetch('/api/admin/v1/managed-agents/customers');
    if (!listed.ok) {
        stderr.write(`${listed.status || ''} ${sampleError(listed)}\n`.trim() + '\n');
        return 1;
    }
    const customers = Array.isArray(listed.body.customers) ? listed.body.customers : [];
    let chosen;
    let failed = false;
    if (userIds.length > 0) {
        const byId = new Map(customers.map(user => [user.id, user]));
        chosen = [];
        for (const id of userIds) {
            const user = byId.get(id);
            if (!user) {
                failed = true;
                stderr.write(`${id}: not an active customer user\n`);
                continue;
            }
            chosen.push(user);
        }
    } else if (ask) {
        chosen = await pickSampleUsers(customers, ask);
        if (chosen == null) return 0;
    } else {
        chosen = customers.filter(isSamplePreset);
    }
    if (chosen.length === 0 && !failed) {
        stdout.write('No customers selected.\n');
        return 0;
    }

    const plans = [];
    for (const user of chosen) {
        const preview = await adminFetch(
            `/api/admin/v1/managed-agents/samples?userId=${encodeURIComponent(user.id)}`
        );
        if (!preview.ok) {
            failed = true;
            stderr.write(`${sampleLabel(user)}: ${sampleError(preview)}\n`);
            continue;
        }
        plans.push(preview.body);
    }
    if (plans.length === 0) return 1;

    if (json && !confirmed) {
        stdout.write(`${JSON.stringify({ preview: plans })}\n`);
    } else if (!json) {
        printSamplePreview(plans);
    }
    if (!confirmed) {
        if (!ask) {
            stderr.write('Not created. Re-run with --yes to queue these agents.\n');
            return failed ? 1 : 0;
        }
        const answer = await ask('Queue these sample agents? [y/N] ');
        if (!isAffirmative(answer)) {
            stdout.write('Cancelled.\n');
            return failed ? 1 : 0;
        }
    }

    const results = [];
    for (const plan of plans) {
        const created = await adminFetch('/api/admin/v1/managed-agents/samples', {
            method: 'POST',
            body: { userId: plan.userId, seed: plan.seed }
        });
        if (!created.ok) {
            failed = true;
            const message = sampleError(created);
            stderr.write(`${sampleLabel(plan)}: ${message}\n`);
            results.push({ userId: plan.userId, agentIds: [], error: message });
            continue;
        }
        const agentIds = Array.isArray(created.body.agents) ? created.body.agents.map(agent => agent.id) : [];
        if (!json) stdout.write(`${sampleLabel(plan)}: ${agentIds.join(', ')}\n`);
        results.push({ userId: plan.userId, agentIds, error: null });
    }
    if (json) stdout.write(`${JSON.stringify({ results })}\n`);
    return failed ? 1 : 0;
}

async function runMenu() {
    const prompter = createPrompter();
    try {
        while (true) {
            printMenu();
            const choiceRaw = await prompter.ask('Choice: ');
            if (choiceRaw == null) return;
            const choice = choiceRaw.trim();
            if (!choice) continue;
            if (
                choice === String(QUIT_MENU_INDEX) ||
                choice.toLowerCase() === 'quit' ||
                choice.toLowerCase() === 'q'
            ) {
                return;
            }
            if (choice === String(CLOUDBBS_MENU_INDEX)) {
                await runPostCloudBbs({ confirmed: false, ask: prompter.ask });
                continue;
            }
            if (choice === String(CLIENT_AGENT_MENU_INDEX)) {
                await runClientAgent({ confirmed: false, ask: prompter.ask });
                continue;
            }
            if (choice === String(MANAGED_AGENT_PROMPTS_MENU_INDEX)) {
                await previewManagedAgentPrompts({ baseUrl: baseUrl() });
                continue;
            }
            if (choice === String(MANAGED_AGENTS_RUN_MENU_INDEX)) {
                await runManagedAgents({ ask: prompter.ask });
                continue;
            }
            if (choice === String(SAMPLE_AGENTS_MENU_INDEX)) {
                await runSampleAgents({ confirmed: false, ask: prompter.ask });
                continue;
            }
            const index = Number(choice);
            const command = Number.isInteger(index) && index >= 1 && index <= COMMANDS.length
                ? COMMANDS[index - 1]
                : findCommand(choice);
            if (!command) {
                stdout.write('Unknown choice.\n');
                continue;
            }
            const options = await promptFilters(prompter.ask, command);
            // Print errors but keep the interactive session open.
            await runCommand(command, options);
        }
    } finally {
        prompter.close();
    }
}

async function main() {
    const parsed = parseArgs(process.argv.slice(2));
    if (parsed.mode === 'client-agent') {
        process.exit(await runClientAgent({ confirmed: Boolean(parsed.yes) }));
    }
    requireAdminKey();
    if (parsed.mode === 'managed-agent-prompts') {
        process.exitCode = await previewManagedAgentPrompts({ baseUrl: baseUrl(), json: parsed.json });
        return;
    }
    if (parsed.mode === 'managed-agents-samples') {
        process.exitCode = await runSampleAgents({
            confirmed: Boolean(parsed.yes),
            userIds: parsed.userIds,
            json: parsed.json
        });
        return;
    }
    if (parsed.mode === 'managed-agents-run') {
        const prompter = parsed.yes ? null : createPrompter();
        try {
            process.exitCode = await runManagedAgents({ confirmed: parsed.yes, ask: prompter?.ask });
        } finally {
            prompter?.close();
        }
        return;
    }
    if (parsed.mode === 'list') {
        printMenu();
        process.exit(0);
    }
    if (parsed.mode === 'post-cloudbbs') {
        if (!parsed.yes) {
            stderr.write('post-cloudbbs requires --yes\n');
            process.exit(2);
        }
        process.exit(await runPostCloudBbs({ confirmed: true }));
    }
    if (parsed.mode === 'once') {
        process.exit(await runCommand(parsed.command, parsed.options));
    }
    await runMenu();
    process.exit(0);
}

main().catch(error => {
    const message = error && error.message ? error.message : String(error);
    stderr.write(`${message}\n`);
    process.exit(1);
});
