'use strict';

// Lane results and Agent activity, including the R1-75 badges and wrapper classes.
// Display strings are passed in from the fixture; this does not render the view.

const BOOKING_REQUESTS = '/profile/booking-requests';

const laneActivityRun = {
    id: 'run-r174',
    swarmName: 'North',
    status: 'completed',
    startedAt: '2026-11-23T01:00:00.000Z',
    finishedAt: '2026-11-23T01:05:00.000Z',
    summary: 'Done',
    failureReason: null,
    totalSpendCap: 40,
    totalSlotsCap: 3,
    spendBooked: 12,
    slotsBooked: 1,
    masterTurns: 4,
    inputTokens: 111,
    outputTokens: 222,
    cancelRequested: false,
    lanes: [{
        position: 1,
        rateType: 'Port',
        originPort: 'SHA',
        destinationPort: 'LAX',
        sailingDate: '2026-12-01',
        containerType: '40HC',
        priority: 'high',
        allowBookingRequest: true
    }],
    agents: [
        {
            role: 'search',
            lanePosition: 1,
            originPort: 'SHA',
            destinationPort: 'LAX',
            sailingDate: '2026-12-01',
            attempt: 1,
            status: 'completed',
            startedAt: '2026-11-23T01:00:00.000Z',
            finishedAt: '2026-11-23T01:05:00.000Z',
            report: 'found',
            rateId: 'rate-1',
            price: 1350.75,
            slots: null,
            bookingRequestId: null
        },
        {
            role: 'booking',
            lanePosition: 1,
            originPort: 'SHA',
            destinationPort: 'LAX',
            sailingDate: '2026-12-01',
            attempt: 1,
            status: 'completed',
            startedAt: '2026-11-23T01:00:00.000Z',
            finishedAt: '2026-11-23T01:05:00.000Z',
            report: 'booked',
            rateId: null,
            price: null,
            slots: 2,
            bookingRequestId: 'br-1'
        }
    ]
};

function leaf(tag, text, className = '', attributes = {}) {
    const node = { tag, className, attributes, children: [], text };
    if (tag === 'button') node.type = 'button';
    return node;
}

function branch(tag, className, children) {
    return { tag, className, attributes: {}, children };
}

function textNode(text) {
    return leaf('#text', text);
}

function cells(labels) {
    return labels.map(label => leaf('th', label));
}

function bookingRequest(id) {
    if (!id) return leaf('td', '');
    return branch('td', '', [
        textNode(id),
        textNode(' '),
        leaf('a', 'Booking requests', '', { href: BOOKING_REQUESTS })
    ]);
}

function shape(node) {
    const children = (node.children || []).map(shape);
    const shaped = {
        tag: node.tag,
        className: node.className || '',
        attributes: { ...(node.attributes || {}) },
        children
    };
    if (!children.length) shaped.text = node.textContent || '';
    if (node.tag === 'button') shaped.type = node.type || '';
    return shaped;
}

function laneActivityTail({ startedText, finishedText, price }) {
    const started = '2026-11-23T01:00:00.000Z';
    const finished = '2026-11-23T01:05:00.000Z';
    const laneRow = branch('tr', '', [
        leaf('td', '1'),
        leaf('td', 'Port, SHA to LAX', 'swarm-lane-name'),
        leaf('td', '2026-12-01'),
        leaf('td', '40HC'),
        leaf('td', 'high'),
        branch('td', 'swarm-lane-search', [leaf('span', 'Rate found', 'agent-status agent-status-completed')]),
        leaf('td', price, 'swarm-lane-price'),
        branch('td', 'swarm-lane-booking', [
            leaf('span', 'Requested, 2 slots', 'agent-status agent-status-completed'),
            textNode(' '),
            leaf('a', 'Booking requests', '', { href: BOOKING_REQUESTS })
        ]),
        leaf('td', 'found\nbooked', 'swarm-lane-result')
    ]);
    const agentRow = (agent, lane, report, rateId, agentPrice, slots, bookingId) => branch('tr', '', [
        leaf('td', agent),
        leaf('td', lane, 'swarm-agent-lane'),
        leaf('td', '1'),
        leaf('td', 'completed'),
        leaf('td', startedText, '', { title: started }),
        leaf('td', finishedText, '', { title: finished }),
        leaf('td', report, 'swarm-report'),
        leaf('td', rateId),
        leaf('td', agentPrice),
        leaf('td', slots),
        bookingRequest(bookingId)
    ]);
    return [
        branch('div', 'swarm-lane-heading-row', [
            leaf('h2', 'Lane results (1 lanes)', 'swarm-lane-heading'),
            leaf('button', 'Download CSV', 'agent-button swarm-lane-csv')
        ]),
        branch('div', 'agent-grid-scroll swarm-lane-scroll', [
            branch('table', 'agent-grid swarm-lane-table', [
                branch('tr', '', cells(['#', 'Lane', 'Sailing date', 'Container', 'Priority', 'Search', 'Price', 'Booking', 'Result'])),
                branch('tbody', '', [laneRow])
            ])
        ]),
        leaf('h2', 'Agent activity', 'swarm-agent-heading'),
        branch('div', 'agent-grid-scroll swarm-agent-scroll', [
            branch('table', 'agent-grid swarm-agent-table', [
                branch('tr', '', cells(['Role', 'Lane', 'Attempt', 'Status', 'Started', 'Finished', 'Report', 'Rate id', 'Price', 'Slots', 'Booking request id'])),
                branch('tbody', '', [
                    agentRow('search', '1, SHA to LAX, 2026-12-01', 'found', 'rate-1', price, '', ''),
                    agentRow('booking', '1, SHA to LAX, 2026-12-01', 'booked', '', '', '2', 'br-1')
                ])
            ])
        ])
    ];
}

module.exports = { laneActivityRun, laneActivityTail, shape };
