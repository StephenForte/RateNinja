#!/usr/bin/env node
'use strict';

try {
    process.loadEnvFile('.env');
} catch {
    // .env is optional; real environment variables win when present.
}

const readline = require('node:readline');
const { stdin, stdout, stderr } = require('node:process');

const DEFAULT_BASE_URL = 'https://rate-ninja.onrender.com';

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
        `Usage: node scripts/rateninja-admin.js [list|${names}] [--company ID] [--carrier X] [--origin-port X] [--destination-port X] [--page N] [--page-size N] [--json]\n`
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
    stdout.write(`${COMMANDS.length + 1}. quit\n`);
}

function findCommand(name) {
    return COMMANDS.find(command => command.name === name) || null;
}

function parseArgs(argv) {
    if (argv.length === 0) return { mode: 'menu' };
    const commandName = argv[0];
    if (commandName === 'list') return { mode: 'list' };
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

async function runMenu() {
    const prompter = createPrompter();
    try {
        while (true) {
            printMenu();
            const choiceRaw = await prompter.ask('Choice: ');
            if (choiceRaw == null) return;
            const choice = choiceRaw.trim();
            if (!choice) continue;
            const quitIndex = String(COMMANDS.length + 1);
            if (choice === quitIndex || choice.toLowerCase() === 'quit' || choice.toLowerCase() === 'q') {
                return;
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
    requireAdminKey();
    if (parsed.mode === 'list') {
        printMenu();
        process.exit(0);
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
