const http = require('http');
const fs = require('fs');
const path = require('path');
const WebSocket = require('ws');
const crypto = require('crypto');

// UUID generator for bid idempotency
function generateUUID() {
    return crypto.randomUUID ? crypto.randomUUID() : 
        `${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
}

// Constants
const STARTING_CAPITAL = 7.0;
const MAX_ASSETS = 5;
const MAX_PER_SECTOR = 2;
const TEAMS_COUNT = 30;
const TOTAL_ROUNDS = 7;

const TOP_TAX_RATE = 0.20;      // Ranks 1-10
const MID_TAX_RATE = 0.25;      // Ranks 11-20
const BOTTOM_TAX_RATE = 0.30;   // Ranks 21-30

const BID_INCREMENT = 0.5; // Rs. 0.5 Cr (50 Lakhs) - per rules
const BID_THROTTLE_MS = 0; // ZERO THROTTLE: Real-time bidding enabled

const BOOSTER_DEFS = {
    stimulus: {
        id: 41,
        name: "Economic Stimulus Package",
        price: 2.82,
        multiplier: 1.20
    },
    infrastructure: {
        id: 42,
        name: "Infrastructure Investment",
        price: 3.15,
        multiplier: 1.25
    },
    innovation: {
        id: 43,
        name: "Innovation Accelerator",
        price: 3.50,
        multiplier: 1.30
    }
};

const PHASES = {
    signal: 30,
    auction: 330,
    crisis: 20,
    results: 150  // CRITICAL FIX: Merged strategy (120s) + results (20s) + 10s buffer
};

let gameConfig = {
    unlimitedBuysPerRound: false,
    unlimitedBuysAllRounds: false,
    unlimitedBuysRound: null
};

// Authentication
const HOST_AUTH = { username: "host", password: "control@123" };
const ADMIN_AUTH = { username: "admin", password: "override@999" };
const TEAM_PASSWORDS = {};
for (let i = 1; i <= 30; i++) {
    const id = `team-${i.toString().padStart(2, '0')}`;
    TEAM_PASSWORDS[id] = `adhik${i.toString().padStart(2, '0')}`;
}

let DEFAULT_TEAM_NAMES = [
    'Neo4j',
    'Compass',
    'ADV',
    'Upperups',
    'Bomboloni',
    'Arka',
    'Envision',
    'JMD',
    'SleepDeprived',
    'Team AKS',
    'Futurepreneurs',
    'Lannisters',
    'Gareeb Economists',
    'SavingPublicRyan',
    'HAKUNA MA TATA',
    'Pitch Masters',
    'Spartans',
    'All Izz Well',
    'Cardin',
    'xyz',
    'Prime',
    'Batman Buddies',
    'Maverick',
    'Starks',
    'Synergy',
    'Void',
    'Capital trio',
    'NeetiShastra'
];

const TEAM_CREDENTIALS_CSV = path.join(__dirname, 'team_credentials.csv');

function parseCsvLine(line) {
    const values = [];
    let current = '';
    let inQuotes = false;

    for (let i = 0; i < line.length; i++) {
        const ch = line[i];
        if (ch === '"') {
            if (inQuotes && line[i + 1] === '"') {
                current += '"';
                i++;
            } else {
                inQuotes = !inQuotes;
            }
            continue;
        }
        if (ch === ',' && !inQuotes) {
            values.push(current.trim());
            current = '';
            continue;
        }
        current += ch;
    }
    values.push(current.trim());
    return values;
}

function loadTeamCredentialsFromCsv() {
    if (!fs.existsSync(TEAM_CREDENTIALS_CSV)) return;

    try {
        const raw = fs.readFileSync(TEAM_CREDENTIALS_CSV, 'utf8');
        const lines = raw
            .split(/\r?\n/)
            .map((line) => line.trim())
            .filter((line) => line && !line.startsWith('#'));

        if (!lines.length) return;

        const hasHeader = /^teamId\s*,\s*name\s*,\s*password$/i.test(lines[0]);
        const rows = hasHeader ? lines.slice(1) : lines;
        const csvNames = [...DEFAULT_TEAM_NAMES];

        rows.forEach((line) => {
            const parts = parseCsvLine(line);
            if (parts.length < 3) return;

            const teamId = String(parts[0] || '').trim();
            const name = String(parts[1] || '').trim();
            const password = String(parts[2] || '').trim();
            if (!/^team-\d{2}$/.test(teamId)) return;

            const idx = Number(teamId.slice(5));
            if (!Number.isInteger(idx) || idx < 1 || idx > TEAMS_COUNT) return;

            if (name) csvNames[idx - 1] = name;
            if (password) TEAM_PASSWORDS[teamId] = password;
        });

        DEFAULT_TEAM_NAMES = csvNames;
    } catch (err) {
        console.error('Failed to load team credentials CSV', err);
    }
}

loadTeamCredentialsFromCsv();

function escapeCsvValue(value) {
    const str = String(value ?? '');
    if (str.includes('"') || str.includes(',') || str.includes('\n') || str.includes('\r')) {
        return `"${str.replace(/"/g, '""')}"`;
    }
    return str;
}

function getDefaultTeamName(index) {
    return DEFAULT_TEAM_NAMES[index - 1] || `RESONANCE_${index.toString().padStart(2, '0')}`;
}

function applyCanonicalTeamCredentialsToState() {
    for (let i = 1; i <= TEAMS_COUNT; i++) {
        const teamId = `team-${i.toString().padStart(2, '0')}`;
        const team = gameState.teams && gameState.teams[teamId];
        if (!team) continue;
        team.name = getDefaultTeamName(i);
        team.password = TEAM_PASSWORDS[teamId] || team.password;
    }
}

function writeTeamCredentialsCsvFromState() {
    try {
        const lines = ['teamId,name,password'];
        for (let i = 1; i <= TEAMS_COUNT; i++) {
            const teamId = `team-${i.toString().padStart(2, '0')}`;
            const stateTeam = gameState.teams && gameState.teams[teamId];
            const name = stateTeam && stateTeam.name ? stateTeam.name : getDefaultTeamName(i);
            const password = TEAM_PASSWORDS[teamId] || (stateTeam && stateTeam.password) || `adhik${i.toString().padStart(2, '0')}`;
            lines.push([
                escapeCsvValue(teamId),
                escapeCsvValue(name),
                escapeCsvValue(password)
            ].join(','));
        }
        fs.writeFileSync(TEAM_CREDENTIALS_CSV, `${lines.join('\n')}\n`);
    } catch (err) {
        console.error('Failed to write team credentials CSV', err);
    }
}

const ASSET_POOL = [
    // FOOD (1-10)
    { id: 'FOO-01', name: 'Rice Cultivation Complex', sector: 'Food', price: 1.1, yield: 9, depreciation: 0.07 },
    { id: 'FOO-02', name: 'Wheat Production Facility', sector: 'Food', price: 1.2, yield: 10, depreciation: 0.08 },
    { id: 'FOO-03', name: 'Dairy Processing Plant', sector: 'Food', price: 1.4, yield: 11, depreciation: 0.09 },
    { id: 'FOO-04', name: 'Fruit & Vegetable Farm', sector: 'Food', price: 0.9, yield: 8, depreciation: 0.06 },
    { id: 'FOO-05', name: 'Poultry Production Unit', sector: 'Food', price: 1.0, yield: 9, depreciation: 0.07 },
    { id: 'FOO-06', name: 'Fishery & Aquaculture', sector: 'Food', price: 1.3, yield: 10, depreciation: 0.08 },
    { id: 'FOO-07', name: 'Organic Food Cooperative', sector: 'Food', price: 1.5, yield: 12, depreciation: 0.10 },
    { id: 'FOO-08', name: 'Grain Storage & Distribution', sector: 'Food', price: 1.1, yield: 9, depreciation: 0.07 },
    { id: 'FOO-09', name: 'Livestock Ranch', sector: 'Food', price: 1.6, yield: 13, depreciation: 0.11 },
    { id: 'FOO-10', name: 'Agricultural Technology Hub', sector: 'Food', price: 1.7, yield: 14, depreciation: 0.12 },

    // MANUFACTURING (11-20)
    { id: 'MFG-11', name: 'Steel Manufacturing Plant', sector: 'Manufacturing', price: 1.3, yield: 12, depreciation: 0.09 },
    { id: 'MFG-12', name: 'Automobile Assembly Line', sector: 'Manufacturing', price: 1.8, yield: 15, depreciation: 0.12 },
    { id: 'MFG-13', name: 'Textile Production Facility', sector: 'Manufacturing', price: 1.0, yield: 9, depreciation: 0.07 },
    { id: 'MFG-14', name: 'Chemical Processing Unit', sector: 'Manufacturing', price: 1.5, yield: 13, depreciation: 0.10 },
    { id: 'MFG-15', name: 'Electronics Factory', sector: 'Manufacturing', price: 1.9, yield: 16, depreciation: 0.13 },
    { id: 'MFG-16', name: 'Cement Production Plant', sector: 'Manufacturing', price: 1.2, yield: 11, depreciation: 0.08 },
    { id: 'MFG-17', name: 'Pharmaceutical Manufacturing', sector: 'Manufacturing', price: 2.0, yield: 17, depreciation: 0.14 },
    { id: 'MFG-18', name: 'Machinery & Equipment Works', sector: 'Manufacturing', price: 1.4, yield: 12, depreciation: 0.09 },
    { id: 'MFG-19', name: 'Aerospace Component Factory', sector: 'Manufacturing', price: 2.2, yield: 18, depreciation: 0.15 },
    { id: 'MFG-20', name: 'Renewable Energy Equipment', sector: 'Manufacturing', price: 1.6, yield: 14, depreciation: 0.11 },

    // FINANCE (21-30)
    { id: 'FIN-21', name: 'Commercial Banking Network', sector: 'Finance', price: 1.7, yield: 14, depreciation: 0.11 },
    { id: 'FIN-22', name: 'Insurance Corporation', sector: 'Finance', price: 1.5, yield: 13, depreciation: 0.10 },
    { id: 'FIN-23', name: 'Investment Management Firm', sector: 'Finance', price: 1.8, yield: 15, depreciation: 0.12 },
    { id: 'FIN-24', name: 'Real Estate Development', sector: 'Finance', price: 1.9, yield: 16, depreciation: 0.13 },
    { id: 'FIN-25', name: 'Stock Exchange Platform', sector: 'Finance', price: 2.1, yield: 17, depreciation: 0.14 },
    { id: 'FIN-26', name: 'Venture Capital Fund', sector: 'Finance', price: 1.6, yield: 14, depreciation: 0.11 },
    { id: 'FIN-27', name: 'Pension Fund Management', sector: 'Finance', price: 1.4, yield: 12, depreciation: 0.09 },
    { id: 'FIN-28', name: 'Cryptocurrency Exchange', sector: 'Finance', price: 2.0, yield: 16, depreciation: 0.13 },
    { id: 'FIN-29', name: 'Microfinance Institution', sector: 'Finance', price: 1.2, yield: 10, depreciation: 0.08 },
    { id: 'FIN-30', name: 'Strategic Reserve Holdings', sector: 'Finance', price: 2.3, yield: 19, depreciation: 0.15 },

    // TRADE (31-40)
    { id: 'TRA-31', name: 'International Shipping Fleet', sector: 'Trade', price: 1.8, yield: 15, depreciation: 0.12 },
    { id: 'TRA-32', name: 'Air Cargo Operations', sector: 'Trade', price: 2.0, yield: 17, depreciation: 0.14 },
    { id: 'TRA-33', name: 'Port & Terminal Infrastructure', sector: 'Trade', price: 1.9, yield: 16, depreciation: 0.13 },
    { id: 'TRA-34', name: 'Railway Freight Network', sector: 'Trade', price: 1.6, yield: 14, depreciation: 0.11 },
    { id: 'TRA-35', name: 'Logistics & Warehousing Hub', sector: 'Trade', price: 1.4, yield: 12, depreciation: 0.09 },
    { id: 'TRA-36', name: 'E-commerce Distribution Center', sector: 'Trade', price: 1.7, yield: 14, depreciation: 0.11 },
    { id: 'TRA-37', name: 'Cold Chain Supply Network', sector: 'Trade', price: 1.5, yield: 13, depreciation: 0.10 },
    { id: 'TRA-38', name: 'Cross-border Trade Platform', sector: 'Trade', price: 1.3, yield: 11, depreciation: 0.08 },
    { id: 'TRA-39', name: 'Container Shipping Line', sector: 'Trade', price: 2.1, yield: 18, depreciation: 0.14 },
    { id: 'TRA-40', name: 'Global Freight Forwarding', sector: 'Trade', price: 1.2, yield: 10, depreciation: 0.07 }
];

const ASSET_MAP = ASSET_POOL.reduce((acc, asset) => {
    acc[asset.id] = asset;
    return acc;
}, {});

function buildInitialAssets() {
    const assets = {};
    ASSET_POOL.forEach(asset => {
        assets[asset.id] = {
            ...asset,
            currentPrice: asset.price,
            currentYield: asset.yield,
            currentBid: null,
            highestBidder: null,
            isProcessing: false,
            bidHistory: [] // Initialize bid history for settlement overflow reallocation
        };
    });
    return assets;
}

const INITIAL_ASSETS = buildInitialAssets();

let gameState = {
    isGameStarted: false,
    round: 1,
    phase: "waiting",
    phaseStartTime: Date.now(),
    isPaused: true,
    timerPaused: true,
    isEnded: false,
    pausedAt: Date.now(),
    assets: INITIAL_ASSETS,
    boosters: [],
    teams: {},
    logs: [],
    gameConfig,
    signal: null,
    crisis: null,
    lastCrisisRound: 0,
    finalStandings: [],
    teamSummaries: {}
};

function createDefaultTeamRecord(index) {
    const teamId = `team-${index.toString().padStart(2, '0')}`;
    return {
        id: teamId,
        name: getDefaultTeamName(index),
        cash: STARTING_CAPITAL,
        lockedCash: 0,
        assets: [],
        gdp: 0,
        avgGDP: 0,
        gdpHistory: [],
        rank: index,
        previousRank: index,
        buysThisRound: 0,
        sellsThisRound: 0,
        boosterUsedInRound: 0,
        boosters: [],
        connected: false,
        password: TEAM_PASSWORDS[teamId],
        transactions: [],
        financials: { rounds: [] },
        _roundStats: { assetSpend: 0, salesIncome: 0, transactions: [] }
    };
}

for (let i = 1; i <= TEAMS_COUNT; i++) {
    const team = createDefaultTeamRecord(i);
    gameState.teams[team.id] = team;
}

const BACKUP_FILE = path.join(__dirname, 'backup.json');
function saveBackup() {
    try {
        applyCanonicalTeamCredentialsToState();
        fs.writeFileSync(BACKUP_FILE, JSON.stringify(gameState));
    } catch (err) { console.error("Backup failed", err); }
}
function loadBackup() {
    if (fs.existsSync(BACKUP_FILE)) {
        try {
            const data = JSON.parse(fs.readFileSync(BACKUP_FILE, 'utf8'));
            gameState = data;
            if (!gameState || typeof gameState !== 'object') {
                throw new Error('Corrupt backup payload');
            }
            if (!gameState.assets || Object.keys(gameState.assets).length !== 40) {
                gameState.assets = buildInitialAssets();
            }
            if (!gameState.teams || typeof gameState.teams !== 'object') {
                gameState.teams = {};
            }
            for (let i = 1; i <= TEAMS_COUNT; i++) {
                const defaults = createDefaultTeamRecord(i);
                const existing = gameState.teams[defaults.id] || {};
                gameState.teams[defaults.id] = {
                    ...defaults,
                    ...existing,
                    id: defaults.id,
                    name: existing.name || defaults.name,
                    password: TEAM_PASSWORDS[defaults.id]
                };
            }
            applyCanonicalTeamCredentialsToState();
            Object.values(gameState.assets).forEach((a) => {
                if (a && Object.prototype.hasOwnProperty.call(a, 'owner')) delete a.owner;
            });
            if (!Array.isArray(gameState.boosters)) gameState.boosters = [];
            gameState.boosters = enforceUniqueBoosters(gameState.boosters.map(normalizeBoosterShape).filter(Boolean)).slice(0, 3);
            if (gameState.phase === 'signal' || gameState.phase === 'auction') {
                gameState.boosters = normalizeBoostersForRound(gameState.round, gameState.boosters);
            }
            if (!gameState.gameConfig) {
                gameState.gameConfig = {
                    unlimitedBuysPerRound: false,
                    unlimitedBuysAllRounds: false,
                    unlimitedBuysRound: null
                };
            }
            if (typeof gameState.gameConfig.unlimitedBuysPerRound !== 'boolean') {
                gameState.gameConfig.unlimitedBuysPerRound = false;
            }
            if (typeof gameState.gameConfig.unlimitedBuysAllRounds !== 'boolean') {
                gameState.gameConfig.unlimitedBuysAllRounds = false;
            }
            if (!Number.isInteger(gameState.gameConfig.unlimitedBuysRound)) {
                gameState.gameConfig.unlimitedBuysRound = null;
            }
            // Backward compatibility: old backups only had one persistent toggle.
            if (
                gameState.gameConfig.unlimitedBuysPerRound === true &&
                gameState.gameConfig.unlimitedBuysAllRounds === false &&
                gameState.gameConfig.unlimitedBuysRound === null
            ) {
                gameState.gameConfig.unlimitedBuysPerRound = false;
                gameState.gameConfig.unlimitedBuysAllRounds = true;
            }
            gameConfig = gameState.gameConfig;
            if (typeof gameState.isEnded !== 'boolean') gameState.isEnded = false;
            if (typeof gameState.timerPaused !== 'boolean') gameState.timerPaused = Boolean(gameState.isPaused);
            if (!Array.isArray(gameState.finalStandings)) gameState.finalStandings = [];
            if (!gameState.teamSummaries || typeof gameState.teamSummaries !== 'object') gameState.teamSummaries = {};
            gameState.phaseStartTime = Date.now(); // Reset baseline on load
            gameState.isPaused = true;
            gameState.timerPaused = true;
            if (!gameState.signal) gameState.signal = null;
            // Ensure all teams have been initialized with new data properties
            Object.values(gameState.teams).forEach(t => {
                if (!t.financials) t.financials = { rounds: [] };
                if (!t._roundStats) t._roundStats = { assetSpend: 0, salesIncome: 0, transactions: [] };
                if (!Array.isArray(t.transactions)) t.transactions = [];
                if (!Array.isArray(t.boosters)) t.boosters = [];
                t.assets = Array.isArray(t.assets)
                    ? t.assets
                        .filter((owned) => Boolean(ASSET_MAP[(owned && (owned.assetId || owned.id))]))
                        .map((owned) => ({
                            assetId: owned.assetId || owned.id,
                            purchaseRound: Number.isInteger(owned.purchaseRound) ? owned.purchaseRound : 0
                        }))
                    : [];
                if (!Array.isArray(t.gdpHistory)) t.gdpHistory = [];
                if (t.gdpHistory.length > TOTAL_ROUNDS) {
                    t.gdpHistory = t.gdpHistory.slice(-TOTAL_ROUNDS);
                }
                if (typeof t.gdp !== 'number' || Number.isNaN(t.gdp)) t.gdp = 0;
                if (typeof t.avgGDP !== 'number' || Number.isNaN(t.avgGDP)) t.avgGDP = 0;
                if (typeof t.boosterUsedInRound !== 'number') t.boosterUsedInRound = 0;
                if (typeof t.cash !== 'number' || Number.isNaN(t.cash)) t.cash = STARTING_CAPITAL;
                if (typeof t.lockedCash !== 'number' || Number.isNaN(t.lockedCash)) t.lockedCash = 0;
                if (t.cash < 0) t.cash = 0;
                if (t.lockedCash > t.cash) t.lockedCash = 0;
                syncTeamBalances(t);
            });
            if (!gameState.isGameStarted && gameState.phase === 'waiting' && Number(gameState.round || 1) === 1) {
                Object.values(gameState.teams).forEach((t) => resetTeamForNewGame(t));
            }
            if (gameState.phase === 'signal' || gameState.phase === 'auction') {
                ensureRoundIntelligence();
            } else if (gameState.crisis) {
                roundCrisis = cloneDeep(gameState.crisis);
            }
            syncCrisisDefinitionForCurrentRound();
            writeTeamCredentialsCsvFromState();
            saveBackup();
        } catch (err) { console.error("Backup load failed", err); }
    }
}

const ROUND_INTELLIGENCE = {
    1: {
        signal: {
            title: "Commodity Imbalance",
            description: "Global agricultural and raw material production has surged with record harvests and expanded mining output. However, consumer and industrial demand has not kept pace, creating large inventories and falling commodity prices. Industries using these inputs benefit from lower costs while producers face compressed margins."
        },
        crisis: {
            name: "Commodity Imbalance",
            description: "Commodity oversupply reduces prices for agricultural and raw material producers.",
            impacts: { Food: -8, Manufacturing: 12, Finance: -3, Trade: 6 }
        }
    },
    2: {
        signal: {
            title: "Trade Policy Fragmentation",
            description: "Governments introduce tariff barriers on manufactured imports and subsidies for domestic agriculture. These protectionist measures disrupt global supply chains, causing manufacturing delays and increased costs. Domestic food producers gain market access while international shipping volumes decline."
        },
        crisis: {
            name: "Trade Policy Fragmentation",
            description: "Protectionist policies disrupt global trade and manufacturing supply chains.",
            impacts: { Food: 10, Manufacturing: -15, Finance: -5, Trade: -12 }
        }
    },
    3: {
        signal: {
            title: "Technology Disruption Wave",
            description: "AI automation, and robotics deploy at scale across manufacturing, finance, and logistics. Early adopters achieve major productivity gains with automated facilities reaching record output and fintech platforms outperforming traditional competitors. Traditional agriculture and tech-lagging sectors lose competitive ground."
        },
        crisis: {
            name: "Technology Disruption Wave",
            description: "Technology revolution boosts productivity for adopters while traditional sectors fall behind.",
            impacts: { Food: -6, Manufacturing: 14, Finance: 18, Trade: 8 }
        }
    },
    4: {
        signal: {
            title: "Global Financial Collapse",
            description: "After years of growth in fintech and leveraged investments, major banks report unexpected losses on complex digital assets. Credit markets tighten as lender confidence drops. Analysts warn that financial instability could trigger broader economic contraction in manufacturing and trade."
        },
        crisis: {
            name: "Global Financial Collapse",
            description: "Major financial institutions collapse, freezing credit and triggering global recession.",
            impacts: { Food: 5, Manufacturing: -20, Finance: -35, Trade: -18 }
        }
    },
    5: {
        signal: {
            title: "Green Economy Transition",
            description: "Governments launch coordinated green stimulus with major investments in renewable energy manufacturing and sustainable agriculture. Financial institutions create ESG funds attracting significant capital. Traditional logistics faces increased emissions regulations and compliance costs."
        },
        crisis: {
            name: "Green Economy Transition",
            description: "Green infrastructure investment drives sustainable sectors while penalizing high-emission operations.",
            impacts: { Food: 8, Manufacturing: 16, Finance: 12, Trade: -8 }
        }
    },
    6: {
        signal: {
            title: "Resource Scarcity Crisis",
            description: "Climate events disrupt agricultural production while mineral scarcity constrains manufacturing inputs. Production facilities struggle to secure resources and financial institutions write off commodity loans. Logistics firms command premium pricing for delivering scarce materials."
        },
        crisis: {
            name: "Resource Scarcity Crisis",
            description: "Climate and mineral scarcity create shortages while logistics providers profit from premiums.",
            impacts: { Food: -12, Manufacturing: -10, Finance: 6, Trade: 15 }
        }
    },
    7: {
        signal: {
            title: "Global Recovery & Cooperation",
            description: "Nations sign comprehensive trade agreements and launch infrastructure programs to rebuild logistics, expand manufacturing, and enhance food systems. Markets show renewed confidence as policy clarity improves and commerce flows surge beyond pre-crisis levels."
        },
        crisis: {
            name: "Global Recovery & Cooperation",
            description: "International cooperation and infrastructure investment drive broad economic expansion.",
            impacts: { Food: 14, Manufacturing: 18, Finance: 10, Trade: 20 }
        }
    }
};

const CRISIS_SECTORS = ['Food', 'Manufacturing', 'Finance', 'Trade'];

let roundCrisis = null;
const lastBidByTeamAt = {};
let previousBidderCache = { assets: {}, boosters: {} };
const pendingAssetBidQueues = new Map();
const pendingBoosterBidQueues = new Map();

// ============ PRODUCTION SAFEGUARDS ============
// 1. IDEMPOTENCY: Prevent duplicate bid processing
const bidIdempotencyCache = new Map();
const BID_CACHE_TTL_MS = 120000; // 2 minute TTL for bid deduplication

function getIdempotencyResponse(bidId) {
    const entry = bidIdempotencyCache.get(bidId);
    if (!entry) return null;
    if (entry && typeof entry === 'object' && Object.prototype.hasOwnProperty.call(entry, 'response')) {
        return entry.response;
    }
    // Backward compatibility for legacy entries saved as raw payloads.
    return entry;
}

function setIdempotencyResponse(bidId, response) {
    bidIdempotencyCache.set(bidId, {
        timestamp: Date.now(),
        response
    });
}

function cleanupIdempotencyCache() {
    const now = Date.now();
    for (const [bidId, entry] of bidIdempotencyCache) {
        const ts = entry && typeof entry === 'object' ? Number(entry.timestamp || 0) : 0;
        if (!ts || now - ts > BID_CACHE_TTL_MS) {
            bidIdempotencyCache.delete(bidId);
        }
    }
}

// 2. STATE HASHING: Detect sync divergence
function computeStateHash() {
    try {
        const snapshot = {
            round: gameState.round,
            phase: gameState.phase,
            teams: Object.entries(gameState.teams || {}).map(([id, t]) => ({
                id,
                cash: Number((t.cash || 0).toFixed(4)),
                lockedCash: Number((t.lockedCash || 0).toFixed(4)),
                gdp: Number((t.gdp || 0).toFixed(4)),
                assets: (t.assets || []).length
            })).sort((a, b) => a.id.localeCompare(b.id)),
            assets: Object.entries(gameState.assets || {})
                .map(([id, a]) => ({
                    id,
                    highestBidder: a.highestBidder,
                    currentBid: Number((a.currentBid || 0).toFixed(4)),
                    currentPrice: Number((a.currentPrice || 0).toFixed(4))
                }))
                .sort((a, b) => a.id.localeCompare(b.id))
        };
        return crypto.createHash('sha256').update(JSON.stringify(snapshot)).digest('hex');
    } catch (e) {
        console.error('State hash computation error:', e);
        return 'ERROR';
    }
}

// 3. AUDIT LOG: Immutable event history
const auditLog = [];
function logAudit(event) {
    const entry = {
        timestamp: Date.now(),
        round: gameState.round,
        phase: gameState.phase,
        ...event,
        stateHash: computeStateHash()
    };
    auditLog.push(entry);
    // Keep last 10,000 events
    while (auditLog.length > 10000) auditLog.shift();
    return entry;
}

// 4. METRICS: Real-time performance monitoring
const metrics = {
    bidsProcessed: 0,
    bidsFailed: 0,
    boostersProcessed: 0,
    boostersFailed: 0,
    avgBidLatency: 0,
    syncMismatches: 0,
    settlementDuration: 0,
    lastReportTime: Date.now()
};

function reportMetrics() {
    const elapsed = Date.now() - metrics.lastReportTime;
    const bidsPerSecond = (metrics.bidsProcessed * 1000) / elapsed;
    const failureRate = metrics.bidsFailed / (metrics.bidsProcessed + 1);
    
    console.log(`\n[METRICS] Round ${gameState.round} | Phase: ${gameState.phase}`);
    console.log(`  Bids: ${metrics.bidsProcessed} @ ${bidsPerSecond.toFixed(1)} bids/sec | ${(failureRate*100).toFixed(2)}% failed`);
    console.log(`  Boosters: ${metrics.boostersProcessed} | Sync mismatches: ${metrics.syncMismatches}`);
    console.log(`  Avg bid latency: ${metrics.avgBidLatency.toFixed(2)}ms`);
    
    if (metrics.syncMismatches > 0) {
        console.error(`  ⚠️  WARNING: ${metrics.syncMismatches} state mismatches detected!`);
    }
    
    // Reset for next interval
    metrics.bidsProcessed = 0;
    metrics.bidsFailed = 0;
    metrics.boostersProcessed = 0;
    metrics.boostersFailed = 0;
    metrics.avgBidLatency = 0;
    metrics.syncMismatches = 0;
    metrics.lastReportTime = Date.now();
}

// Report metrics every 10 seconds
setInterval(reportMetrics, 10000);

function cloneDeep(obj) {
    return JSON.parse(JSON.stringify(obj));
}

function getSignalForRound(round) {
    const normalizedRound = Math.max(1, Math.min(7, Number(round) || 1));
    return cloneDeep(ROUND_INTELLIGENCE[normalizedRound].signal);
}

function getCrisisForRound(round) {
    const normalizedRound = Math.max(1, Math.min(7, Number(round) || 1));
    const crisis = cloneDeep(ROUND_INTELLIGENCE[normalizedRound].crisis);
    const sourceImpacts = (crisis && crisis.impacts) || {};
    crisis.impacts = CRISIS_SECTORS.reduce((acc, sector) => {
        acc[sector] = Number(sourceImpacts[sector] || 0);
        return acc;
    }, {});
    return crisis;
}

function syncCrisisDefinitionForCurrentRound() {
    const canonicalCrisis = getCrisisForRound(gameState.round);
    roundCrisis = cloneDeep(canonicalCrisis);

    if (!gameState.crisis || typeof gameState.crisis !== 'object') return;

    const crisisAlreadyApplied = Number(gameState.lastCrisisRound || 0) === Number(gameState.round || 0);
    if (crisisAlreadyApplied) {
        const oldImpacts = (gameState.crisis && gameState.crisis.impacts) || {};
        Object.values(gameState.assets || {}).forEach((asset) => {
            if (!asset) return;
            const oldPct = Number(oldImpacts[asset.sector] || 0);
            const newPct = Number((canonicalCrisis.impacts || {})[asset.sector] || 0);
            const oldMod = 1 + oldPct / 100;
            const newMod = 1 + newPct / 100;
            const safeOldMod = oldMod === 0 ? 1 : oldMod;

            asset.currentYield = Number(((Number(asset.currentYield || 0) / safeOldMod) * newMod).toFixed(4));
            asset.currentPrice = Number(((Number(asset.currentPrice || 0) / safeOldMod) * newMod).toFixed(4));
        });
    }

    gameState.crisis = cloneDeep(canonicalCrisis);
}

function isBoosterRound(round) {
    return Number(round) % 2 === 0;
}

function generateBoosters() {
    return Object.entries(BOOSTER_DEFS).map(([boosterType, def]) => ({
        id: def.id,
        type: boosterType,
        name: def.name,
        basePrice: def.price,
        multiplier: def.multiplier
    }));
}

function buildBoostersForRound(round) {
    if (!isBoosterRound(round)) return [];
    return generateBoosters().map((booster) => {
        const def = BOOSTER_DEFS[booster.type] || booster;
        return {
            id: booster.id,
            name: booster.name,
            type: 'booster',
            boosterType: booster.type,
            basePrice: booster.basePrice,
            currentBid: null,
            highestBidder: null,
            owner: null,
            purchaseRound: null,
            multiplier: def.multiplier,
            bidHistory: [],
            isProcessingBid: false,
            lastBidTime: 0
        };
    });
}

function normalizeBoostersForRound(round, existingBoosters = []) {
    if (!isBoosterRound(round)) return [];

    // Keep exactly one entry per booster type (best bid wins if duplicates exist in backup).
    const bestByType = {};
    (existingBoosters || []).forEach((b) => {
        const key = b && b.boosterType;
        if (!key || !BOOSTER_DEFS[key]) return;
        if (!bestByType[key]) {
            bestByType[key] = b;
            return;
        }
        const prevBid = Number(bestByType[key].currentBid || 0);
        const currBid = Number(b.currentBid || 0);
        if (currBid > prevBid) bestByType[key] = b;
    });

    return buildBoostersForRound(round).map((base) => {
        const existing = bestByType[base.boosterType];
        if (!existing) return base;
        return {
            ...base,
            currentBid: Number.isFinite(existing.currentBid) ? Number(existing.currentBid.toFixed(4)) : null,
            highestBidder: existing.highestBidder || null,
            bidHistory: Array.isArray(existing.bidHistory) ? existing.bidHistory : [],
            lastBidTime: Number.isFinite(existing.lastBidTime) ? existing.lastBidTime : 0,
            isProcessingBid: Boolean(existing.isProcessingBid)
        };
    });
}

function enforceUniqueBoosters(boosters) {
    const seen = new Set();
    return (boosters || []).filter((booster) => {
        if (!booster || !booster.id) return false;
        if (seen.has(booster.id)) return false;
        seen.add(booster.id);
        return true;
    });
}

function rebuildPreviousBidderCache(state) {
    const assets = {};
    const boosters = {};

    Object.entries((state && state.assets) || {}).forEach(([assetId, asset]) => {
        if (asset && asset.highestBidder) assets[String(assetId)] = asset.highestBidder;
    });

    ((state && state.boosters) || []).forEach((booster) => {
        if (booster && booster.id && booster.highestBidder) {
            boosters[String(booster.id)] = booster.highestBidder;
        }
    });

    previousBidderCache = { assets, boosters };
    return previousBidderCache;
}

function selectRoundIntelligence() {
    roundCrisis = getCrisisForRound(gameState.round);
    gameState.signal = getSignalForRound(gameState.round);
    gameState.crisis = null;
    gameState.boosters = buildBoostersForRound(gameState.round);
}

function ensureRoundIntelligence() {
    if (!gameState.signal || typeof gameState.signal !== 'object') {
        selectRoundIntelligence();
    }
    syncCrisisDefinitionForCurrentRound();
}

function revealCrisis() {
    ensureRoundIntelligence();
    syncCrisisDefinitionForCurrentRound();
    if (!gameState.crisis) {
        gameState.crisis = cloneDeep(roundCrisis);
        addLog(`BREAKING CRISIS: ${gameState.crisis.name}`, 'game');
    }
    if (gameState.lastCrisisRound < gameState.round && gameState.crisis) {
        Object.values(gameState.assets).forEach(a => {
            const mod = 1 + (gameState.crisis.impacts[a.sector] || 0) / 100;
            a.currentYield = Number((a.currentYield * mod).toFixed(4));
            a.currentPrice = Number((a.currentPrice * mod).toFixed(4));
        });
        gameState.lastCrisisRound = gameState.round;
        addLog(`CRISIS APPLIED: ${gameState.crisis.name} repriced sectors`, 'game');
    }
}

function getTeamAvgGDPExact(team) {
    const history = Array.isArray(team && team.gdpHistory) ? team.gdpHistory : [];
    const valid = history.filter((v) => Number.isFinite(v));
    if (valid.length > 0) {
        return valid.reduce((a, b) => a + Number(b || 0), 0) / valid.length;
    }
    if (Number.isFinite(Number(team && team.avgGDP))) return Number(team.avgGDP);
    return 0;
}

function calculateFinalStandings() {
    const teams = Object.values(gameState.teams);

    teams.forEach((team) => {
        const avgExact = getTeamAvgGDPExact(team);
        team.avgGDPExact = Number(avgExact.toFixed(6));
        team.avgGDP = Number(avgExact.toFixed(2));
    });

    teams.sort((a, b) => {
        if ((b.avgGDPExact || 0) !== (a.avgGDPExact || 0)) return (b.avgGDPExact || 0) - (a.avgGDPExact || 0);
        if ((b.gdp || 0) !== (a.gdp || 0)) return (b.gdp || 0) - (a.gdp || 0);
        return (b.cash || 0) - (a.cash || 0);
    });

    gameState.finalStandings = teams.map((team, index) => {
        team.rank = index + 1;
        return {
            rank: index + 1,
            teamId: team.id,
            name: team.name,
            avgGDP: Number((team.avgGDP || 0).toFixed(2)),
            finalGDP: Number((team.gdp || 0).toFixed(2)),
            cash: Number((team.cash || 0).toFixed(2))
        };
    });
}

function buildTeamSummaries() {
    gameState.teamSummaries = {};
    Object.values(gameState.teams).forEach((team) => {
        const history = Array.isArray(team.gdpHistory) && team.gdpHistory.length > 0 ? team.gdpHistory : [0];
        const values = history.map((v) => Number(v) || 0);
        gameState.teamSummaries[team.id] = {
            finalRank: team.rank,
            avgGDP: Number((team.avgGDP || 0).toFixed(2)),
            totalAssets: Array.isArray(team.assets) ? team.assets.length : 0,
            finalCash: Number((team.cash || 0).toFixed(2)),
            totalTransactions: Array.isArray(team.transactions) ? team.transactions.length : 0,
            bestRoundGDP: Number(Math.max(...values).toFixed(2)),
            worstRoundGDP: Number(Math.min(...values).toFixed(2))
        };
    });
}

function endGame() {
    if (gameState.isEnded) return;
    gameState.phase = "ended";
    gameState.isEnded = true;
    gameState.timerPaused = true;
    gameState.isPaused = true;

    calculateFinalStandings();
    buildTeamSummaries();
    addLog("MARKET SESSION CLOSED — FINAL STANDINGS GENERATED", 'system');

    saveBackup();
    broadcast({
        type: "GAME_ENDED",
        standings: gameState.finalStandings,
        summaries: gameState.teamSummaries,
        state: gameState
    });
    broadcast({ type: 'FULL_STATE', state: gameState });
}

const server = http.createServer((req, res) => {
    let filePath = '.' + req.url;
    if (filePath === './') filePath = './public/team.html';
    else filePath = './public' + req.url;
    const extname = path.extname(filePath);
    let contentType = 'text/html';
    switch (extname) {
        case '.js': contentType = 'text/javascript'; break;
        case '.css': contentType = 'text/css'; break;
    }
    fs.readFile(filePath, (error, content) => {
        if (error) { res.writeHead(404); res.end(); }
        else { res.writeHead(200, { 'Content-Type': contentType }); res.end(content, 'utf-8'); }
    });
});

const wss = new WebSocket.Server({ server });

function broadcast(msg) {
    if (msg.type === 'FULL_STATE') {
        Object.keys(gameState.teams || {}).forEach((teamId) => recomputeLockedCashForTeam(teamId));
        rebuildPreviousBidderCache(gameState);
    }
    // Always ensure availableCash is fresh for all teams before sending
    recalculateAllAvailableCash();
    
    msg.serverTime = Date.now();
    const limit = PHASES[gameState.phase] || 120;
    const elapsed = Math.max(0, Math.min(limit, (msg.serverTime - gameState.phaseStartTime) / 1000));
    msg.timerData = { 
        phaseStartTime: gameState.phaseStartTime, 
        isPaused: gameState.isPaused, 
        elapsed,
        phase: gameState.phase, 
        round: gameState.round 
    };
    
    // PRODUCTION FIX: Add state hash for sync validation
    if (msg.type === 'FULL_STATE') {
        msg.stateHash = computeStateHash();
    }
    
    const data = JSON.stringify(msg);
    wss.clients.forEach(client => { if (client.readyState === WebSocket.OPEN) client.send(data); });
}

function sendFullState(ws) {
    Object.keys(gameState.teams || {}).forEach((teamId) => recomputeLockedCashForTeam(teamId));
    rebuildPreviousBidderCache(gameState);
    recalculateAllAvailableCash();
    // PRODUCTION FIX: Include state hash
    const fullStateMsg = { 
        type: 'FULL_STATE', 
        state: gameState,
        stateHash: computeStateHash(),
        serverTime: Date.now()
    };
    ws.send(JSON.stringify(fullStateMsg));
}

wss.on('connection', (ws) => {
    sendFullState(ws);

    ws.on('message', (message) => {
        let data;
        try { data = JSON.parse(message.toString()); } catch (e) { return; }
        const { type } = data;

        switch (type) {
            case 'AUTH': handleAuth(data, ws); break;
            case 'PLACE_BID': handleBid(data, ws); break;
            case 'BUY_BOOSTER': handleBuyBooster(data, ws); break;
            case 'SELL_ASSET': handleSell(data, ws); break;
            case 'HOST_UPDATE_TEAM': handleHostUpdateTeam(data, ws); break;
            case 'ADMIN_ACTION': handleAdmin(data, ws); break;
            case 'HOST_ACTION': handleHostAction(data, ws); break;
            case 'HOST_SET_TIMER': handleHostSetTimer(data, ws); break;
            case 'HOST_MESSAGE': handleHostMessage(data, ws); break;
            case 'REQUEST_STATE': sendFullState(ws); break;
        }
    });

    ws.on('close', () => {
        if (ws.role === 'team' && ws.teamId && gameState.teams[ws.teamId]) {
            gameState.teams[ws.teamId].connected = false;
            broadcast({ type: 'CONNECTION_UPDATE', teamId: ws.teamId, connected: false });
            broadcast({ type: 'FULL_STATE', state: gameState });
        }
    });
});

function handleAuth(data, ws) {
    const { role, teamId, password } = data;
    let success = false;
    if (role === 'team' && gameState.teams[teamId]) {
        if (password === gameState.teams[teamId].password) {
            success = true; ws.teamId = teamId; ws.role = 'team';
            gameState.teams[teamId].connected = true;
        }
    } else if (role === 'host' && password === HOST_AUTH.password) {
        success = true; ws.role = 'host';
    } else if (role === 'admin' && password === ADMIN_AUTH.password) {
        success = true; ws.role = 'admin';
    }

    if (success) {
        if (role === 'team' && teamId) {
            recomputeLockedCashForTeam(teamId);
        }
        const payloadState = { ...gameState };
        if (role !== 'host' && role !== 'admin') {
            // Strip passwords for teams
            payloadState.teams = JSON.parse(JSON.stringify(gameState.teams));
            Object.values(payloadState.teams).forEach(t => delete t.password);
        }
        ws.send(JSON.stringify({ type: 'AUTH_SUCCESS', role, teamId, state: payloadState }));
        if (role === 'team' && teamId) {
            broadcast({ type: 'CONNECTION_UPDATE', teamId, connected: true });
            broadcast({ type: 'FULL_STATE', state: gameState });
        }
    } else {
        ws.send(JSON.stringify({ type: 'AUTH_FAILED', message: "INVALID ACCESS KEY" }));
    }
}

function syncTeamBalances(team) {
    if (!team) return;
    const safeCash = Number.isFinite(team.cash) ? team.cash : 0;
    let safeLocked = Number.isFinite(team.lockedCash) ? team.lockedCash : 0;
    if (safeLocked < 0) safeLocked = 0;
    if (safeLocked > safeCash) safeLocked = safeCash;
    team.cash = Number(safeCash.toFixed(4));
    team.lockedCash = Number(safeLocked.toFixed(4));
}

function recomputeLockedCash(teamId) {
    let total = 0;

    Object.values(gameState.assets).forEach((a) => {
        if (a.highestBidder === teamId && Number.isFinite(a.currentBid)) {
            total += a.currentBid;
        }
    });

    (gameState.boosters || []).forEach((b) => {
        if (b.highestBidder === teamId && Number.isFinite(b.currentBid)) {
            total += b.currentBid;
        }
    });

    return Number(total.toFixed(4));
}

function recomputeLockedCashForTeam(teamId) {
    const team = gameState.teams[teamId];
    if (!team) return;
    team.lockedCash = recomputeLockedCash(teamId);
    syncTeamBalances(team);
}

function releaseUnusedLockedCash() {
    Object.keys(gameState.teams).forEach((teamId) => recomputeLockedCashForTeam(teamId));
}

function normalizeBoosterShape(booster) {
    if (!booster) return null;
    const boosterDef = BOOSTER_DEFS[booster.boosterType] || null;
    const basePrice = Number.isFinite(booster.basePrice)
        ? booster.basePrice
        : Number.isFinite(booster.price)
            ? booster.price
            : boosterDef
                ? boosterDef.price
            : 0;
    booster.type = 'booster';
    if (boosterDef && !booster.name) booster.name = boosterDef.name;
    booster.basePrice = Number(basePrice.toFixed(4));
    booster.currentBid = Number.isFinite(booster.currentBid) ? Number(booster.currentBid.toFixed(4)) : null;
    booster.highestBidder = booster.highestBidder || null;
    booster.owner = booster.owner || null;
    booster.purchaseRound = Number.isInteger(booster.purchaseRound) ? booster.purchaseRound : null;
    if (!Array.isArray(booster.bidHistory)) booster.bidHistory = [];
    booster.isProcessingBid = Boolean(booster.isProcessingBid);
    booster.lastBidTime = Number.isFinite(booster.lastBidTime) ? booster.lastBidTime : 0;
    if (typeof booster.multiplier !== 'number') booster.multiplier = boosterDef ? boosterDef.multiplier : 1;
    return booster;
}

function getTeamAvailableCash(team) {
    return Number(((team.cash || 0) - (team.lockedCash || 0)).toFixed(4));
}

function recalculateAllAvailableCash() {
    Object.values(gameState.teams || {}).forEach((team) => {
        team.availableCash = getTeamAvailableCash(team);
    });
}

function isBidThrottled(teamId) {
    const now = Date.now();
    const last = lastBidByTeamAt[teamId] || 0;
    if (now - last < BID_THROTTLE_MS) return true;
    lastBidByTeamAt[teamId] = now;
    return false;
}

function ensureRoundStats(team) {
    if (!team._roundStats) {
        team._roundStats = { assetSpend: 0, salesIncome: 0, transactions: [] };
    }
    if (!Array.isArray(team.transactions)) {
        team.transactions = [];
    }
}

function resetTeamForNewGame(team) {
    if (!team) return;
    const idx = String(team.id || '').split('-')[1] || '01';
    team.cash = STARTING_CAPITAL;
    team.lockedCash = 0;
    team.assets = [];
    team.gdp = 0;
    team.avgGDP = 0;
    team.gdpHistory = [];
    team.rank = Number(idx) || 1;
    team.previousRank = team.rank;
    team.buysThisRound = 0;
    team.sellsThisRound = 0;
    team.boosterUsedInRound = 0;
    team.boosters = [];
    team.transactions = [];
    team.financials = { rounds: [] };
    team._roundStats = { assetSpend: 0, salesIncome: 0, transactions: [] };
    syncTeamBalances(team);
}

// Atomic Bid Processing with Idempotency & Audit
function handleBid(data, ws) {
    if (gameState.isEnded) return reject(ws, "MARKET SESSION CLOSED");
    if (ws.role !== 'team' || gameState.phase !== 'auction' || gameState.isPaused) return;
    
    const bidStartTime = Date.now();
    const { teamId: payloadTeamId, assetId, bidId } = data;
    const actualBidId = bidId || generateUUID();
    const teamId = ws.teamId;
    
    if (!teamId || (payloadTeamId && payloadTeamId !== teamId)) return reject(ws, "INVALID TEAM CONTEXT");
    
    // PRODUCTION FIX: Idempotency check - if this bidId was already processed, return cached result
    if (bidIdempotencyCache.has(actualBidId)) {
        const cachedResult = getIdempotencyResponse(actualBidId);
        return ws.send(JSON.stringify({ ...cachedResult, bidId: actualBidId, fromCache: true }));
    }
    
    const team = gameState.teams[teamId];
    const asset = gameState.assets[assetId];

    if (!team || !asset) {
        const result = { type: 'ERROR', message: 'INVALID BID TARGET', bidId: actualBidId };
        setIdempotencyResponse(actualBidId, result);
        return ws.send(JSON.stringify(result));
    }
    
    if (Array.isArray(team.assets) && team.assets.length >= MAX_ASSETS) {
        const result = { type: 'ERROR', message: `ASSET HOLDING LIMIT REACHED (${MAX_ASSETS})`, bidId: actualBidId };
        setIdempotencyResponse(actualBidId, result);
        return ws.send(JSON.stringify(result));
    }
    
    const alreadyOwnsAsset = Array.isArray(team.assets)
        ? team.assets.some((owned) => (owned.assetId || owned.id) === assetId)
        : false;
    if (alreadyOwnsAsset) {
        const result = { type: 'ERROR', message: 'ALREADY OWNED: ONE COPY PER TEAM', bidId: actualBidId };
        setIdempotencyResponse(actualBidId, result);
        return ws.send(JSON.stringify(result));
    }

    if (asset.highestBidder === teamId) {
        const result = { type: 'ERROR', message: 'YOU ARE ALREADY LEADING THIS BID', bidId: actualBidId };
        setIdempotencyResponse(actualBidId, result);
        return ws.send(JSON.stringify(result));
    }
    
    if (asset.isProcessing) {
        const queueKey = String(assetId);
        const queue = pendingAssetBidQueues.get(queueKey) || [];
        queue.push({
            data: { ...data, teamId, assetId, bidId: actualBidId },
            ws
        });
        pendingAssetBidQueues.set(queueKey, queue);
        return ws.send(JSON.stringify({ type: 'BID_QUEUED', entityType: 'asset', assetId, bidId: actualBidId, queued: true }));
    }

    asset.isProcessing = true;

    try {
        const nextPrice = asset.currentBid ? asset.currentBid + BID_INCREMENT : asset.currentPrice;
        if (Number.isFinite(asset.currentBid) && Number(nextPrice.toFixed(4)) <= Number(asset.currentBid.toFixed(4))) {
            metrics.bidsFailed++;
            const result = { type: 'ERROR', message: 'INVALID BID AMOUNT', bidId: actualBidId };
            setIdempotencyResponse(actualBidId, result);
            return ws.send(JSON.stringify(result));
        }
        
        // Validation
        syncTeamBalances(team);
        if (Number(getTeamAvailableCash(team).toFixed(4)) < Number(nextPrice.toFixed(4))) {
            metrics.bidsFailed++;
            logAudit({ type: 'BID_REJECTED', teamId, assetId, reason: 'INSUFFICIENT_CAPITAL' });
            const result = { type: 'ERROR', message: 'INSUFFICIENT CAPITAL', bidId: actualBidId };
            setIdempotencyResponse(actualBidId, result);
            return ws.send(JSON.stringify(result));
        }
        
        // Reallocate locked cash from previous bidder
        if (asset.highestBidder) {
            const previousBidder = gameState.teams[asset.highestBidder];
            if (previousBidder) {
                const releasedAmount = asset.currentBid;
                previousBidder.lockedCash = Number((previousBidder.lockedCash - asset.currentBid).toFixed(4));
                syncTeamBalances(previousBidder);
                previousBidder.transactions.push({
                    type: 'BID_RELEASE',
                    assetId: asset.id,
                    assetName: asset.name,
                    amount: releasedAmount,
                    reason: 'outbid',
                    round: gameState.round,
                    timestamp: Date.now()
                });
            }
        }

        // Update asset with new bid
        asset.currentBid = Number(nextPrice.toFixed(4));
        asset.highestBidder = teamId;
        asset.lastBidTime = Date.now();
        
        team.transactions.push({
            type: 'BID_LOCK',
            assetId: asset.id,
            assetName: asset.name,
            amount: asset.currentBid,
            round: gameState.round,
            timestamp: Date.now()
        });
        
        if (!asset.bidHistory) asset.bidHistory = [];
        asset.bidHistory.unshift({ teamId: teamId, amount: asset.currentBid, timestamp: Date.now() });
        
        team.lockedCash = Number((team.lockedCash + asset.currentBid).toFixed(4));
        syncTeamBalances(team);

        // Send server-side outbid notification ONLY to previous bidder
        const previousBidderId = asset.bidHistory && asset.bidHistory.length > 1 ? asset.bidHistory[1]?.teamId : null;
        if (previousBidderId && previousBidderId !== teamId) {
            const prevWs = Array.from(wss.clients).find(c => c.teamId === previousBidderId);
            if (prevWs && prevWs.readyState === WebSocket.OPEN) {
                prevWs.send(JSON.stringify({ 
                    type: 'OUTBID', 
                    assetId: asset.id, 
                    assetName: asset.name,
                    newBidder: team.name,
                    newBid: asset.currentBid
                }));
            }
        }

        addLog(`${team.name} leads bid on ${asset.name} at ${formatCr(asset.currentBid)}`, 'game');
        
        // Audit log & metrics
        logAudit({ type: 'BID_ACCEPTED', teamId, assetId, amount: asset.currentBid });
        metrics.bidsProcessed++;
        const latency = Date.now() - bidStartTime;
        metrics.avgBidLatency = (metrics.avgBidLatency + latency) / 2;
        
        // Send fast BID_UPDATE (not FULL_STATE)
        const affectedTeams = {
            [teamId]: {
                cash: Number((team.cash || 0).toFixed(4)),
                lockedCash: Number((team.lockedCash || 0).toFixed(4))
            }
        };
        if (previousBidderId && previousBidderId !== teamId && gameState.teams[previousBidderId]) {
            const previousBidderTeam = gameState.teams[previousBidderId];
            affectedTeams[previousBidderId] = {
                cash: Number((previousBidderTeam.cash || 0).toFixed(4)),
                lockedCash: Number((previousBidderTeam.lockedCash || 0).toFixed(4))
            };
        }

        const successResult = { 
            type: 'BID_UPDATE', 
            entityType: 'asset', 
            assetId, 
            currentBid: asset.currentBid, 
            highestBidder: teamId,
            affectedTeams,
            bidId: actualBidId,
            success: true
        };
        setIdempotencyResponse(actualBidId, successResult);
        broadcast(successResult);
    } catch (err) {
        console.error('Bid processing error:', err);
        metrics.bidsFailed++;
        logAudit({ type: 'BID_ERROR', teamId, assetId, error: err.message });
        const result = { type: 'ERROR', message: 'BID PROCESSING FAILED', bidId: actualBidId };
        setIdempotencyResponse(actualBidId, result);
        ws.send(JSON.stringify(result));
    } finally {
        asset.isProcessing = false;

        const queueKey = String(assetId);
        const queue = pendingAssetBidQueues.get(queueKey);
        if (Array.isArray(queue) && queue.length > 0) {
            const next = queue.shift();
            if (queue.length === 0) pendingAssetBidQueues.delete(queueKey);
            if (next && next.ws && next.ws.readyState === WebSocket.OPEN) {
                setImmediate(() => handleBid(next.data, next.ws));
            }
        }

        // Cleanup old cache entries periodically
        if (metrics.bidsProcessed % 100 === 0) cleanupIdempotencyCache();
    }
}

function handleBuyBooster(data, ws) {
    if (gameState.isEnded) return reject(ws, "MARKET SESSION CLOSED");
    if (ws.role !== 'team' || gameState.phase !== 'auction' || gameState.isPaused) return;
    if (!isBoosterRound(gameState.round)) return reject(ws, "BOOSTERS AVAILABLE ONLY IN EVEN ROUNDS");

    const boostStartTime = Date.now();
    const { teamId: payloadTeamId, boosterId, bidId } = data;
    const actualBidId = bidId || generateUUID();
    const teamId = ws.teamId;
    
    if (!teamId || (payloadTeamId && payloadTeamId !== teamId)) return reject(ws, "INVALID TEAM CONTEXT");
    
    // PRODUCTION FIX: Idempotency check
    if (bidIdempotencyCache.has(actualBidId)) {
        const cachedResult = getIdempotencyResponse(actualBidId);
        return ws.send(JSON.stringify({ ...cachedResult, bidId: actualBidId, fromCache: true }));
    }
    
    const team = gameState.teams[teamId];
    const booster = (gameState.boosters || []).map(normalizeBoosterShape).find(b => b && String(b.id) === String(boosterId));
    
    if (!team || !booster || booster.owner || booster.purchaseRound) {
        const result = { type: 'ERROR', message: 'INVALID BOOSTER BID TARGET', bidId: actualBidId };
        setIdempotencyResponse(actualBidId, result);
        return ws.send(JSON.stringify(result));
    }

    if (booster.highestBidder === teamId) {
        const result = { type: 'ERROR', message: 'YOU ARE ALREADY LEADING THIS BOOSTER BID', bidId: actualBidId };
        setIdempotencyResponse(actualBidId, result);
        return ws.send(JSON.stringify(result));
    }
    
    if (booster.isProcessingBid) {
        const queueKey = String(booster.id);
        const queue = pendingBoosterBidQueues.get(queueKey) || [];
        queue.push({
            data: { ...data, teamId, boosterId: booster.id, bidId: actualBidId },
            ws
        });
        pendingBoosterBidQueues.set(queueKey, queue);
        return ws.send(JSON.stringify({ type: 'BID_QUEUED', entityType: 'booster', boosterId: booster.id, bidId: actualBidId, queued: true }));
    }

    booster.isProcessingBid = true;

    try {
        syncTeamBalances(team);
        const nextBid = booster.currentBid ? Number((booster.currentBid + BID_INCREMENT).toFixed(4)) : booster.basePrice;
        if (Number.isFinite(booster.currentBid) && nextBid <= Number(booster.currentBid.toFixed(4))) {
            metrics.boostersFailed++;
            const result = { type: 'ERROR', message: 'INVALID BOOSTER BID AMOUNT', bidId: actualBidId };
            setIdempotencyResponse(actualBidId, result);
            return ws.send(JSON.stringify(result));
        }
        
        if (Number(getTeamAvailableCash(team).toFixed(4)) < Number(nextBid.toFixed(4))) {
            metrics.boostersFailed++;
            logAudit({ type: 'BOOSTER_BID_REJECTED', teamId, boosterId, reason: 'INSUFFICIENT_CAPITAL' });
            const result = { type: 'ERROR', message: 'INSUFFICIENT CAPITAL FOR BOOSTER', bidId: actualBidId };
            setIdempotencyResponse(actualBidId, result);
            return ws.send(JSON.stringify(result));
        }

        if (booster.highestBidder) {
            const previousBidder = gameState.teams[booster.highestBidder];
            if (previousBidder) {
                const releasedAmount = booster.currentBid || 0;
                previousBidder.lockedCash = Number((previousBidder.lockedCash - (booster.currentBid || 0)).toFixed(4));
                syncTeamBalances(previousBidder);
                previousBidder.transactions.push({
                    type: 'BID_RELEASE',
                    boosterId: booster.id,
                    assetName: booster.name,
                    amount: releasedAmount,
                    reason: 'outbid',
                    round: gameState.round,
                    timestamp: Date.now()
                });
            }
        }

        booster.currentBid = Number(nextBid.toFixed(4));
        booster.highestBidder = teamId;
        booster.lastBidTime = Date.now();
        if (!Array.isArray(booster.bidHistory)) booster.bidHistory = [];
        booster.bidHistory.unshift({ teamId: teamId, amount: booster.currentBid, timestamp: Date.now() });
        
        team.transactions.push({
            type: 'BID_LOCK',
            boosterId: booster.id,
            assetName: booster.name,
            amount: booster.currentBid,
            reason: 'booster_bid',
            round: gameState.round,
            timestamp: Date.now()
        });
        team.lockedCash = Number((team.lockedCash + booster.currentBid).toFixed(4));
        syncTeamBalances(team);

        // Send server-side outbid notification ONLY to previous bidder
        const prevBoosterBidderId = booster.bidHistory && booster.bidHistory.length > 1 ? booster.bidHistory[1]?.teamId : null;
        if (prevBoosterBidderId && prevBoosterBidderId !== teamId) {
            const prevBoosterWs = Array.from(wss.clients).find(c => c.teamId === prevBoosterBidderId);
            if (prevBoosterWs && prevBoosterWs.readyState === WebSocket.OPEN) {
                prevBoosterWs.send(JSON.stringify({ 
                    type: 'OUTBID', 
                    boosterId: booster.id, 
                    boosterName: booster.name,
                    newBidder: team.name,
                    newBid: booster.currentBid
                }));
            }
        }

        addLog(`${team.name} leads booster bid on ${booster.name} at ${formatCr(booster.currentBid)}`, 'game');
        
        // Audit log & metrics
        logAudit({ type: 'BOOSTER_BID_ACCEPTED', teamId, boosterId, amount: booster.currentBid });
        metrics.boostersProcessed++;
        const latency = Date.now() - boostStartTime;
        metrics.avgBidLatency = (metrics.avgBidLatency + latency) / 2;
        
        const successResult = { 
            type: 'BID_UPDATE', 
            entityType: 'booster', 
            boosterId: booster.id, 
            currentBid: booster.currentBid, 
            highestBidder: teamId,
            affectedTeams: {
                [teamId]: {
                    cash: Number((team.cash || 0).toFixed(4)),
                    lockedCash: Number((team.lockedCash || 0).toFixed(4))
                },
                ...(prevBoosterBidderId && prevBoosterBidderId !== teamId && gameState.teams[prevBoosterBidderId]
                    ? {
                        [prevBoosterBidderId]: {
                            cash: Number((gameState.teams[prevBoosterBidderId].cash || 0).toFixed(4)),
                            lockedCash: Number((gameState.teams[prevBoosterBidderId].lockedCash || 0).toFixed(4))
                        }
                    }
                    : {})
            },
            bidId: actualBidId,
            success: true
        };
        setIdempotencyResponse(actualBidId, successResult);
        broadcast(successResult);
    } catch (err) {
        console.error('Booster bid processing error:', err);
        metrics.boostersFailed++;
        logAudit({ type: 'BOOSTER_BID_ERROR', teamId, boosterId, error: err.message });
        const result = { type: 'ERROR', message: 'BOOSTER BID PROCESSING FAILED', bidId: actualBidId };
        setIdempotencyResponse(actualBidId, result);
        ws.send(JSON.stringify(result));
    } finally {
        booster.isProcessingBid = false;

        const queueKey = String(booster.id);
        const queue = pendingBoosterBidQueues.get(queueKey);
        if (Array.isArray(queue) && queue.length > 0) {
            const next = queue.shift();
            if (queue.length === 0) pendingBoosterBidQueues.delete(queueKey);
            if (next && next.ws && next.ws.readyState === WebSocket.OPEN) {
                setImmediate(() => handleBuyBooster(next.data, next.ws));
            }
        }

        if (metrics.boostersProcessed % 100 === 0) cleanupIdempotencyCache();
    }
}

function handleSell(data, ws) {
    if (gameState.isEnded) return reject(ws, "MARKET SESSION CLOSED");
    const canSell = gameState.phase === 'auction' || gameState.phase === 'results'; // CRITICAL FIX: Changed 'strategy' to 'results'
    if (ws.role !== 'team' || !canSell || gameState.isPaused) return;
    const { teamId: payloadTeamId, assetId } = data;
    const teamId = ws.teamId;
    if (!teamId || (payloadTeamId && payloadTeamId !== teamId)) return reject(ws, "INVALID TEAM CONTEXT");
    const team = gameState.teams[teamId];
    if (!team) return;
    ensureRoundStats(team);

    const idx = team.assets.findIndex(a => (a.assetId || a.id) === assetId);
    if (idx === -1) return;

    const ownedAsset = team.assets[idx];
    const purchaseRound = Number.isInteger(ownedAsset.purchaseRound) ? ownedAsset.purchaseRound : 0;
    if (purchaseRound === gameState.round) {
        return reject(ws, "Cannot sell assets bought this round");
    }

    const resolvedAssetId = ownedAsset.assetId || ownedAsset.id;
    const asset = gameState.assets[resolvedAssetId];
    
    // CORRECT SELL PRICE: Use depreciated yield-based calculation
    const currentBasePrice = asset.currentPrice;
    const currentBaseYield = asset.currentYield;
    const roundsHeld = gameState.round - purchaseRound;
    const depreciatedYield = currentBaseYield * Math.pow(1 - asset.depreciation, roundsHeld);
    const floorYield = currentBaseYield * 0.50;
    const finalYield = Math.max(depreciatedYield, floorYield);
    const depreciationFactor = finalYield / currentBaseYield;
    // Selling Price = Purchase Price × (1 − Depreciation Rate × Rounds Held)
    const totalDepreciation = Math.min(asset.depreciation * roundsHeld, 1); // Cap at 100%
    const sellPrice = Number((currentBasePrice * (1 - totalDepreciation)).toFixed(4));
    team.cash = Number((team.cash + sellPrice).toFixed(4));
    syncTeamBalances(team);
    team.assets.splice(idx, 1);
    team.sellsThisRound++;
    team._roundStats.salesIncome += sellPrice;
    team._roundStats.transactions.push({ type: 'sell', asset: asset.name, amount: sellPrice });
    team.transactions.push({
        type: 'ASSET_SOLD',
        assetId,
        assetName: asset.name,
        amount: sellPrice,
        round: gameState.round,
        timestamp: Date.now()
    });
    asset.currentBid = null; asset.highestBidder = null;

    addLog(`${team.name} liquidated ${asset.name} for ${formatCr(sellPrice)}`, 'game');
    broadcast({ type: 'FULL_STATE', state: gameState });
}

function handleHostUpdateTeam(data, ws) {
    if (ws.role !== 'host') return reject(ws, "UNAUTHORIZED");
    if (gameState.isEnded) return reject(ws, "MARKET SESSION CLOSED: CONTROLS LOCKED");
    const { teamId, name, password } = data.payload || {};
    
    if (!teamId || !name || !password || name.length > 20 || password.length > 20) {
        return reject(ws, "INVALID NAME OR PASSWORD (MAX 20 CHARS)");
    }

    const team = gameState.teams[teamId];
    if (team) {
        const idx = Number(String(teamId).split('-')[1]);
        if (Number.isInteger(idx) && idx >= 1 && idx <= TEAMS_COUNT) {
            DEFAULT_TEAM_NAMES[idx - 1] = name;
        }
        TEAM_PASSWORDS[teamId] = password;
        team.name = name;
        team.password = password;
        writeTeamCredentialsCsvFromState();
        saveBackup();
        broadcast({ type: 'FULL_STATE', state: gameState });
        addLog(`HOST UPDATED CREDENTIALS FOR ${teamId.toUpperCase()}`, 'system');
    }
}

function handleAdmin(data, ws) {
    if (ws.role !== 'host' && ws.role !== 'admin') return;
    const { action, payload } = data;

    if (gameState.isEnded && action !== 'RESET') {
        return reject(ws, "MARKET SESSION CLOSED: RESET REQUIRED");
    }
    
    if (action === 'START_GAME') {
        if (!gameState.isGameStarted || gameState.phase === 'waiting') {
            Object.values(gameState.teams).forEach((t) => resetTeamForNewGame(t));
            Object.values(gameState.assets).forEach((a) => {
                a.highestBidder = null;
                a.currentBid = null;
                a.bidHistory = [];
                a.isProcessing = false;
            });
            gameState.boosters = [];
        }
        gameState.isGameStarted = true;
        gameState.isEnded = false;
        gameState.phase = 'signal';
        gameState.round = 1;
        gameState.isPaused = false;
        gameState.timerPaused = false;
        gameState.finalStandings = [];
        gameState.teamSummaries = {};
        gameState.phaseStartTime = Date.now();
        prepareRound();
        addLog(`[HOST] Started game`, 'system');
    }
    else if (action === 'PAUSE') {
        gameState.isPaused = !gameState.isPaused;
        gameState.timerPaused = gameState.isPaused;
        if (gameState.isPaused) gameState.pausedAt = Date.now();
        else gameState.phaseStartTime += (Date.now() - gameState.pausedAt);
        addLog(`[HOST] ${gameState.isPaused ? 'Paused' : 'Resumed'} simulation`, 'system');
    }
    else if (action === 'SKIP') {
        nextPhase();
        addLog(`[HOST] Skipped current phase`, 'system');
    }
    else if (action === 'JUMP_ROUND') { 
        gameState.round = payload.round; 
        gameState.phase = 'signal'; 
        prepareRound(); 
        gameState.phaseStartTime = Date.now();
        addLog(`[HOST] Jumped to Round ${payload.round}`, 'system');
    }
    else if (action === 'RESET') {
        rebuildStateFromTruth();
        addLog(`[ADMIN] System Hard Reset`, 'system');
    }
    else if (action === 'EDIT_CASH' || action === 'ADJUST_CASH') {
        const t = gameState.teams[payload.teamId];
        if (t) {
            const before = Number(t.cash || 0);
            if (action === 'EDIT_CASH') t.cash = Number(parseFloat(payload.value).toFixed(2));
            else t.cash += Number(parseFloat(payload.amount).toFixed(2));
            if (t.cash < 0) t.cash = 0;
            const delta = Number((t.cash - before).toFixed(4));
            t.transactions.push({
                type: 'CASH_ADJUSTMENT',
                amount: delta,
                reason: action,
                round: gameState.round,
                timestamp: Date.now()
            });
            syncTeamBalances(t);
            addLog(`[HOST] Modified ${t.name} cash`, 'system');
        }
    }
    else if (action === 'ASSIGN_ASSET') {
        const asset = gameState.assets[payload.assetId];
        const team = gameState.teams[payload.teamId];
        if (asset && team) {
            if (Array.isArray(team.assets) && team.assets.length >= MAX_ASSETS) {
                return reject(ws, `ASSET HOLDING LIMIT REACHED (${MAX_ASSETS})`);
            }
            const ownedInSector = Array.isArray(team.assets)
                ? team.assets.reduce((count, owned) => {
                    const ownedAssetId = owned.assetId || owned.id;
                    const ownedAsset = gameState.assets[ownedAssetId];
                    if (ownedAsset && ownedAsset.sector === asset.sector) return count + 1;
                    return count;
                }, 0)
                : 0;
            if (ownedInSector >= MAX_PER_SECTOR) {
                return reject(ws, `SECTOR LIMIT REACHED (${MAX_PER_SECTOR})`);
            }
            team.assets.push({ assetId: asset.id, purchaseRound: gameState.round });
            addLog(`[HOST] Assigned ${asset.name} copy to ${team.name}`, 'system');
        }
    }
    else if (action === 'REMOVE_ASSET') {
        const asset = gameState.assets[payload.assetId];
        if (asset) {
            const targetTeam = payload.teamId ? gameState.teams[payload.teamId] : null;
            if (targetTeam) {
                const idx = targetTeam.assets.findIndex(a => (a.assetId || a.id) === asset.id);
                if (idx !== -1) {
                    targetTeam.assets.splice(idx, 1);
                    addLog(`[HOST] Removed one ${asset.name} copy from ${targetTeam.name}`, 'system');
                }
            } else {
                let removed = false;
                Object.values(gameState.teams).forEach(team => {
                    if (removed) return;
                    const idx = team.assets.findIndex(a => (a.assetId || a.id) === asset.id);
                    if (idx !== -1) {
                        team.assets.splice(idx, 1);
                        removed = true;
                        addLog(`[HOST] Removed one ${asset.name} copy from ${team.name}`, 'system');
                    }
                });
            }
            asset.highestBidder = null;
            asset.currentBid = null;
        }
    }
    
    saveBackup();
    broadcast({ type: 'FULL_STATE', state: gameState });
}

function handleHostSetTimer(data, ws) {
    if (ws.role !== 'host' && ws.role !== 'admin') return;
    if (gameState.isEnded) return reject(ws, "MARKET SESSION CLOSED: TIMER LOCKED");
    const { remainingSeconds } = data.payload || {};
    if (remainingSeconds === undefined) return;
    
    const limit = getLimitForPhase(gameState.phase);
    const requested = Number(remainingSeconds);
    if (!Number.isFinite(requested)) return reject(ws, "INVALID TIMER VALUE");
    const safeRemaining = Math.max(0, Math.min(limit, requested));
    const now = Date.now();
    gameState.phaseStartTime = now - (limit - safeRemaining) * 1000;
    
    if (gameState.isPaused) gameState.pausedAt = now;
    
    if (safeRemaining !== requested) {
        addLog(`[HOST] Timer override clamped to ${safeRemaining}s`, 'system');
    } else {
        addLog(`[HOST] Adjusted timer to ${safeRemaining}s remaining`, 'system');
    }
    saveBackup();
    broadcast({ type: 'FULL_STATE', state: gameState });
}

function handleHostMessage(data, ws) {
    if (ws.role !== 'host' && ws.role !== 'admin') return;
    if (gameState.isEnded) return reject(ws, "MARKET SESSION CLOSED: CONTROLS LOCKED");
    broadcast({ 
        type: 'HOST_MESSAGE', 
        payload: { 
            message: data.payload.message, 
            target: data.payload.target 
        } 
    });
}

function handleHostAction(data, ws) {
    if (ws.role !== 'host' && ws.role !== 'admin') return reject(ws, "UNAUTHORIZED");
    if (gameState.isEnded) return reject(ws, "MARKET SESSION CLOSED: CONTROLS LOCKED");
    return reject(ws, "UNSUPPORTED HOST ACTION");
}

function getLimitForPhase(phase) {
    const limits = { signal: 30, auction: 330, crisis: 20, results: 150, waiting: 0, ended: 0 }; // CRITICAL FIX: Merged strategy (120s) into results (150s total)
    return limits[phase] || 120;
}

function rebuildStateFromTruth() {
    gameState.isGameStarted = false;
    gameState.round = 1;
    gameState.phase = 'waiting';
    gameState.phaseStartTime = Date.now();
    gameState.isPaused = true;
    gameState.timerPaused = true;
    gameState.isEnded = false;
    gameState.pausedAt = Date.now();
    gameState.logs = [];
    gameConfig.unlimitedBuysPerRound = false;
    gameConfig.unlimitedBuysAllRounds = false;
    gameConfig.unlimitedBuysRound = null;
    gameState.gameConfig = gameConfig;
    gameState.boosters = [];
    gameState.signal = null;
    gameState.crisis = null;
    gameState.finalStandings = [];
    gameState.teamSummaries = {};
    roundCrisis = null;
    gameState.lastCrisisRound = 0;
            Object.values(gameState.teams).forEach(t => {
                t.cash = STARTING_CAPITAL; t.lockedCash = 0;
                t.assets = []; t.gdp = 0; 
                t.avgGDP = 0;
                t.gdpHistory = [];
                t.rank = t.id.split('-')[1] * 1;
                const idx = t.id.split('-')[1];
                t.name = getDefaultTeamName(Number(idx));
                t.previousRank = t.rank; t.buysThisRound = 0; t.sellsThisRound = 0;
                t.boosterUsedInRound = 0;
                t.boosters = [];
                t.password = TEAM_PASSWORDS[t.id];
                t.transactions = [];
                t.financials = { rounds: [] };
                t._roundStats = { assetSpend: 0, salesIncome: 0, transactions: [] };
            });
    Object.values(gameState.assets).forEach(a => {
        const base = ASSET_POOL.find(p => a.id.startsWith(p.id));
        a.currentPrice = base.price; a.currentYield = base.yield;
        a.highestBidder = null; a.currentBid = null;
        a.isProcessing = false;
    });
    addLog("SYSTEM HARD RESET: ALL PARAMETERS RESTORED", 'system');
    saveBackup();
    // Force immediate broadcast to sync reset state
    broadcast({ type: 'FULL_STATE', state: gameState });
}

function validateGameState() {
    gameState.boosters = enforceUniqueBoosters((gameState.boosters || []).map(normalizeBoosterShape).filter(Boolean)).slice(0, 3);
    Object.values(gameState.assets || {}).forEach((a) => {
        if (a && Object.prototype.hasOwnProperty.call(a, 'owner')) delete a.owner;
    });
    Object.values(gameState.teams).forEach(t => {
        t.assets = Array.isArray(t.assets)
            ? t.assets
                .filter((owned) => Boolean(ASSET_MAP[(owned && (owned.assetId || owned.id))]))
                .map((owned) => ({
                    assetId: owned.assetId || owned.id,
                    purchaseRound: Number.isInteger(owned.purchaseRound) ? owned.purchaseRound : 0
                }))
            : [];
        if (t.cash < 0) t.cash = 0;
        if (t.lockedCash > t.cash) t.lockedCash = 0;
        if (typeof t.gdp !== 'number' || Number.isNaN(t.gdp)) t.gdp = 0;
        if (typeof t.avgGDP !== 'number' || Number.isNaN(t.avgGDP)) t.avgGDP = 0;
        t.avgGDPExact = Number(getTeamAvgGDPExact(t).toFixed(6));
        t.avgGDP = Number((t.avgGDPExact || 0).toFixed(2));
        if (!Array.isArray(t.gdpHistory)) t.gdpHistory = [];
        if (t.gdpHistory.length > TOTAL_ROUNDS) t.gdpHistory = t.gdpHistory.slice(-TOTAL_ROUNDS);
        if (!Array.isArray(t.transactions)) t.transactions = [];
        if (!Array.isArray(t.boosters)) t.boosters = [];
        recomputeLockedCashForTeam(t.id);
        syncTeamBalances(t);
    });
    // Ensure ranks are unique
    const sorted = Object.values(gameState.teams).sort((a,b) => (b.avgGDPExact || 0) - (a.avgGDPExact || 0) || (b.gdp || 0) - (a.gdp || 0) || (b.cash || 0) - (a.cash || 0));
    sorted.forEach((t, i) => t.rank = i + 1);
}

function nextPhase() {
    if (gameState.isEnded) return;
    const sequence = ['signal', 'auction', 'crisis', 'results']; // CRITICAL FIX: Removed 'strategy' phase
    const idx = sequence.indexOf(gameState.phase);

    if (gameState.phase === 'results') {
        if (gameState.round >= TOTAL_ROUNDS) {
            endGame();
            return;
        }
        gameState.round++;
        gameState.phase = 'signal';
        prepareRound();
    } else {
        gameState.phase = sequence[idx + 1] || 'signal';
    }

    gameState.phaseStartTime = Date.now();
    
    // CRITICAL FIX: Add AUCTION_STARTED system message
    if (gameState.phase === 'auction') {
        broadcast({
            type: 'SYSTEM_MESSAGE',
            message: 'Auction starts now. Markets open.',
            durationMs: 5000
        });
    }
    
    if (gameState.phase === 'crisis') revealCrisis();
    if (gameState.phase === 'results') executeSettlement();
    if (gameState.phase === 'signal' && !gameState.signal) prepareRound();
    rebuildPreviousBidderCache(gameState);
    
    validateGameState();
    broadcast({ type: 'FULL_STATE', state: gameState });
}

function prepareRound() {
    selectRoundIntelligence();
    Object.values(gameState.teams).forEach(t => { 
        t.buysThisRound = 0; 
        t.sellsThisRound = 0; 
        t.boosters = [];
        t._roundStats = { assetSpend: 0, salesIncome: 0, transactions: [] };
        recomputeLockedCashForTeam(t.id);
    });
    // Reset auction state for next round assets
    Object.values(gameState.assets).forEach(a => {
        a.highestBidder = null;
        a.currentBid = null;
        a.bidHistory = [];
    });
    if (gameConfig.unlimitedBuysPerRound && gameConfig.unlimitedBuysRound !== gameState.round) {
        gameConfig.unlimitedBuysPerRound = false;
        gameConfig.unlimitedBuysRound = null;
        gameState.gameConfig = gameConfig;
    }
    gameState.boosters = enforceUniqueBoosters(buildBoostersForRound(gameState.round)).slice(0, 3);
    gameState.timerPaused = gameState.isPaused;
    rebuildPreviousBidderCache(gameState);
}

function executeSettlement() {
    const settlementStartTime = Date.now();
    logAudit({ type: 'SETTLEMENT_START', round: gameState.round });
    
    ensureRoundIntelligence();
    syncCrisisDefinitionForCurrentRound();
    if (!gameState.crisis && roundCrisis) {
        gameState.crisis = cloneDeep(roundCrisis);
        addLog(`CRISIS ACTIVATED FOR SETTLEMENT: ${gameState.crisis.name}`, 'game');
    }
    const activeCrisisImpacts = (gameState.crisis && gameState.crisis.impacts) ? gameState.crisis.impacts : {};

    // 1. Resolve Booster Bids first (strict order)
    gameState.boosters = (gameState.boosters || []).map(normalizeBoosterShape).filter(Boolean);
    const boosterWinningByTeam = {};
    const finalBoosterAssignments = [];
    const assignedBoosterTeams = new Set();

    gameState.boosters.forEach((b) => {
        if (!b.highestBidder || b.owner) return;
        if (!boosterWinningByTeam[b.highestBidder]) boosterWinningByTeam[b.highestBidder] = [];
        boosterWinningByTeam[b.highestBidder].push(b);
    });

    Object.entries(boosterWinningByTeam).forEach(([teamId, wins]) => {
        const team = gameState.teams[teamId];
        if (!team || !wins.length) return;

        wins.sort((a, b) => {
            const mDiff = Number((b.multiplier || 0).toFixed(4)) - Number((a.multiplier || 0).toFixed(4));
            if (mDiff !== 0) return mDiff;
            return Number((b.currentBid || 0).toFixed(4)) - Number((a.currentBid || 0).toFixed(4));
        });

        const canKeepOne = !assignedBoosterTeams.has(teamId);
        const chosen = canKeepOne ? wins[0] : null;
        if (chosen) {
            finalBoosterAssignments.push({
                booster: chosen,
                teamId,
                amount: Number((chosen.currentBid || 0).toFixed(4)),
                releaseLock: true
            });
            assignedBoosterTeams.add(teamId);
        }

        const overflow = canKeepOne ? wins.slice(1) : wins;
        overflow.forEach((overflowBooster) => {
            const originalTeam = gameState.teams[teamId];
            const overflowAmount = Number((overflowBooster.currentBid || 0).toFixed(4));

            if (originalTeam && overflowAmount > 0) {
                originalTeam.lockedCash = Number((originalTeam.lockedCash - overflowAmount).toFixed(4));
                syncTeamBalances(originalTeam);
                originalTeam.transactions.push({
                    type: 'BID_RELEASE',
                    boosterId: overflowBooster.id,
                    assetName: overflowBooster.name,
                    amount: overflowAmount,
                    reason: 'booster_overflow',
                    round: gameState.round,
                    timestamp: Date.now()
                });
            }

            let reassigned = false;
            const history = Array.isArray(overflowBooster.bidHistory) ? overflowBooster.bidHistory : [];
            for (let i = 1; i < history.length; i++) {
                const candidate = history[i];
                if (!candidate || !candidate.teamId) continue;
                if (assignedBoosterTeams.has(candidate.teamId)) continue;

                const candidateTeam = gameState.teams[candidate.teamId];
                if (!candidateTeam) continue;

                const candidateAmount = Number((candidate.amount || 0).toFixed(4));
                if (candidateAmount <= 0) continue;
                syncTeamBalances(candidateTeam);
                if (Number(getTeamAvailableCash(candidateTeam).toFixed(4)) < candidateAmount) continue;

                finalBoosterAssignments.push({
                    booster: overflowBooster,
                    teamId: candidate.teamId,
                    amount: candidateAmount,
                    releaseLock: false
                });
                assignedBoosterTeams.add(candidate.teamId);
                reassigned = true;
                addLog(`${candidateTeam.name} reallocated ${overflowBooster.name} for ${formatCr(candidateAmount)}`, 'game');
                break;
            }

            if (!reassigned) {
                overflowBooster.highestBidder = null;
                overflowBooster.currentBid = null;
                overflowBooster.bidHistory = [];
                overflowBooster.owner = null;
                overflowBooster.purchaseRound = null;
                overflowBooster.isProcessingBid = false;
                addLog(`${overflowBooster.name} remains UNSOLD (no valid reassignment bidder)`, 'game');
            }
        });
    });

    finalBoosterAssignments.forEach(({ booster: b, teamId, amount, releaseLock }) => {
        const team = gameState.teams[teamId];
        if (!team) {
            b.highestBidder = null;
            b.currentBid = null;
            b.bidHistory = [];
            b.owner = null;
            b.purchaseRound = null;
            b.isProcessingBid = false;
            return;
        }

        ensureRoundStats(team);
        if (releaseLock) {
            team.lockedCash = Number((team.lockedCash - amount).toFixed(4));
        }
        team.cash = Number((team.cash - amount).toFixed(4));
        team._roundStats.assetSpend = Number((team._roundStats.assetSpend + amount).toFixed(4));
        team._roundStats.transactions.push({ type: 'booster_buy', asset: b.name, amount });
        syncTeamBalances(team);

        team.boosterUsedInRound = gameState.round;
        team.transactions.push({
            type: 'BOOSTER_PURCHASE',
            boosterId: b.id,
            assetName: b.name,
            multiplier: Number((b.multiplier || 1).toFixed(2)),
            amount,
            round: gameState.round,
            timestamp: Date.now()
        });

        if (!Array.isArray(team.boosters)) team.boosters = [];
        team.boosters = team.boosters.filter((owned) => owned.purchaseRound !== gameState.round);
        team.boosters.push({
            id: b.id,
            type: b.boosterType,
            name: b.name,
            multiplier: b.multiplier,
            purchaseRound: gameState.round
        });

        b.owner = team.id;
        b.purchaseRound = gameState.round;
        addLog(`${team.name} acquired ${b.name} for ${formatCr(amount)}`, 'game');
        b.highestBidder = null;
        b.currentBid = null;
        b.bidHistory = [];
        b.isProcessingBid = false;
    });

    gameState.boosters.forEach((b) => {
        if (b.owner) return;
        b.highestBidder = null;
        b.currentBid = null;
        b.bidHistory = [];
        b.isProcessingBid = false;
    });

    // 2. Resolve asset overflow and assignment plans
    
    // Step 1: Collect all winning bids per team
    const teamWinningAssets = {};
    Object.values(gameState.assets).forEach(a => {
        if (a.highestBidder) {
            if (!teamWinningAssets[a.highestBidder]) teamWinningAssets[a.highestBidder] = [];
            teamWinningAssets[a.highestBidder].push(a);
        }
    });
    
    // Step 2: Process allocation per team with sector overflow
    const finalAssetAssignments = [];
    Object.entries(teamWinningAssets).forEach(([teamId, assetList]) => {
        const team = gameState.teams[teamId];
        if (!team) return;
        ensureRoundStats(team);

        const existingOwnedBySector = {};
        if (Array.isArray(team.assets)) {
            team.assets.forEach((owned) => {
                const ownedAssetId = owned.assetId || owned.id;
                const ownedAsset = gameState.assets[ownedAssetId];
                if (!ownedAsset || !ownedAsset.sector) return;
                existingOwnedBySector[ownedAsset.sector] = (existingOwnedBySector[ownedAsset.sector] || 0) + 1;
            });
        }
        
        // Group by sector
        const bySector = {};
        assetList.forEach(a => {
            if (!bySector[a.sector]) bySector[a.sector] = [];
            bySector[a.sector].push(a);
        });
        
        let allowed = [];
        const overflow = [];
        
        // Step 3: Handle sector overflow (max 2 per sector)
        Object.entries(bySector).forEach(([sector, sectorAssets]) => {
            sectorAssets.sort((a, b) => b.currentBid - a.currentBid); // Sort by bid amount desc
            const existingOwned = existingOwnedBySector[sector] || 0;
            const remainingSlots = Math.max(0, MAX_PER_SECTOR - existingOwned);

            if (remainingSlots <= 0) {
                overflow.push(...sectorAssets);
                return;
            }
            
            if (sectorAssets.length > remainingSlots) {
                allowed.push(...sectorAssets.slice(0, remainingSlots));
                overflow.push(...sectorAssets.slice(remainingSlots));
            } else {
                allowed.push(...sectorAssets);
            }
        });

        // No per-round buy cap: only sector/cash/ownership/global-holding constraints apply.
        allowed.sort((a, b) => (b.currentBid || 0) - (a.currentBid || 0));
        const existingOwnedTotal = Array.isArray(team.assets) ? team.assets.length : 0;
        const remainingTotalSlots = Math.max(0, MAX_ASSETS - existingOwnedTotal);
        if (remainingTotalSlots <= 0) {
            overflow.push(...allowed);
            allowed = [];
        } else if (allowed.length > remainingTotalSlots) {
            overflow.push(...allowed.slice(remainingTotalSlots));
            allowed = allowed.slice(0, remainingTotalSlots);
        }
        
        // Step 3: Assign allowed assets (no cash deduction yet)
        const toAssign = [];
        allowed.forEach(a => {
            const alreadyOwnedByWinner = Array.isArray(team.assets)
                ? team.assets.some((owned) => (owned.assetId || owned.id) === a.id)
                : false;
            if (alreadyOwnedByWinner) {
                overflow.push(a);
                addLog(`${team.name} cannot stack ${a.name}; reallocation attempted`, 'game');
                return;
            }
            toAssign.push({ asset: a, teamId, bidAmount: a.currentBid });
        });
        
        // Step 5: Reallocate overflow assets to next valid bidders
        overflow.forEach(a => {
            let assigned = false;
            
            // Try each bidder in history once to avoid reassignment loops.
            if (a.bidHistory && a.bidHistory.length > 1) {
                const visited = new Set();
                let nextIndex = 1;
                while (nextIndex < a.bidHistory.length) {
                    const nextBidder = a.bidHistory[nextIndex++];
                    if (!nextBidder || !nextBidder.teamId) continue;
                    if (visited.has(nextBidder.teamId)) break;
                    visited.add(nextBidder.teamId);

                    const candidateTeamId = nextBidder.teamId;
                    const candidateTeam = gameState.teams[candidateTeamId];
                    const candidateBidAmount = nextBidder.amount;
                    
                    if (!candidateTeam) continue;
                    
                    // Validate: enough cash + sector limit not exceeded
                    const candidateAssignedInSector = toAssign.filter(x => x.teamId === candidateTeamId && gameState.assets[x.asset.id].sector === a.sector).length;
                    const candidateAssignedTotal = toAssign.filter(x => x.teamId === candidateTeamId).length;
                    const candidateOwnedInSector = Array.isArray(candidateTeam.assets)
                        ? candidateTeam.assets.reduce((count, owned) => {
                            const ownedAssetId = owned.assetId || owned.id;
                            const ownedAsset = gameState.assets[ownedAssetId];
                            if (ownedAsset && ownedAsset.sector === a.sector) return count + 1;
                            return count;
                        }, 0)
                        : 0;
                    const candidateOwnedTotal = Array.isArray(candidateTeam.assets) ? candidateTeam.assets.length : 0;
                    const candidateSectorCount = candidateOwnedInSector + candidateAssignedInSector;
                    
                    if (candidateSectorCount >= MAX_PER_SECTOR) continue;
                    if (candidateOwnedTotal + candidateAssignedTotal >= MAX_ASSETS) continue;
                    const candidateAlreadyOwns = Array.isArray(candidateTeam.assets)
                        ? candidateTeam.assets.some((owned) => (owned.assetId || owned.id) === a.id)
                        : false;
                    if (candidateAlreadyOwns) continue;
                    if (Number(getTeamAvailableCash(candidateTeam).toFixed(4)) < Number(candidateBidAmount.toFixed(4))) continue;
                    
                    // Assign to this candidate
                    toAssign.push({ asset: a, teamId: candidateTeamId, bidAmount: candidateBidAmount });
                    const previousWinner = gameState.teams[a.highestBidder];
                    if (previousWinner && previousWinner.id !== candidateTeamId && Number.isFinite(a.currentBid)) {
                        const releasedAmount = Number((a.currentBid || 0).toFixed(4));
                        previousWinner.lockedCash = Number((previousWinner.lockedCash - releasedAmount).toFixed(4));
                        syncTeamBalances(previousWinner);
                        previousWinner.transactions.push({
                            type: 'BID_RELEASE',
                            assetId: a.id,
                            assetName: a.name,
                            amount: releasedAmount,
                            reason: 'asset_overflow',
                            round: gameState.round,
                            timestamp: Date.now()
                        });
                    }
                    assigned = true;
                    addLog(`${candidateTeam.name} allocated ${a.name} (overflow reallocation) for ${formatCr(candidateBidAmount)}`, 'game');
                    break;
                }
            }
            
            if (!assigned) {
                a.highestBidder = null;
                a.currentBid = null;
                a.bidHistory = [];
                addLog(`${a.name} remains UNSOLD (no valid backup bidder)`, 'game');
            }
        });
        
        finalAssetAssignments.push(...toAssign);
    });

    // 3. Update portfolios for assigned assets
    finalAssetAssignments.forEach(({ asset: a, teamId: winnerId, bidAmount }) => {
        const winner = gameState.teams[winnerId];
        if (!winner) return;
        if (Array.isArray(winner.assets) && winner.assets.length >= MAX_ASSETS) {
            a.highestBidder = null;
            a.currentBid = null;
            a.bidHistory = [];
            addLog(`${a.name} remains UNSOLD (winner at max holdings)`, 'game');
            return;
        }
        winner.assets.push({ assetId: a.id, purchaseRound: gameState.round });
        winner.buysThisRound++;
        winner.transactions.push({
            type: 'ASSET_BOUGHT',
            assetId: a.id,
            assetName: a.name,
            amount: bidAmount,
            round: gameState.round,
            timestamp: Date.now()
        });
    });

    // 4. Deduct cash from winning assignments
    finalAssetAssignments.forEach(({ asset: a, teamId: winnerId, bidAmount }) => {
        const winner = gameState.teams[winnerId];
        if (!winner) return;
        ensureRoundStats(winner);
        winner.lockedCash = Number((winner.lockedCash - bidAmount).toFixed(4));
        winner.cash = Number((winner.cash - bidAmount).toFixed(4));
        winner._roundStats.assetSpend = Number((winner._roundStats.assetSpend + bidAmount).toFixed(4));
        winner._roundStats.transactions.push({ type: 'asset_buy', asset: a.name, amount: bidAmount });
        syncTeamBalances(winner);
        a.currentPrice = bidAmount;
        a.highestBidder = null;
        a.currentBid = null;
        a.bidHistory = [];
        addLog(`${winner.name} acquired ${a.name} for ${formatCr(bidAmount)}`, 'game');
    });

    // 5. Release any unused locked cash so it matches active bids exactly.
    releaseUnusedLockedCash();

    // 6. Apply Crisis (once per round safety)
    let crisisAppliedThisRound = gameState.lastCrisisRound === gameState.round;
    if (gameState.lastCrisisRound < gameState.round && gameState.crisis) {
        Object.values(gameState.assets).forEach(a => {
            const mod = 1 + (gameState.crisis.impacts[a.sector] || 0) / 100;
            a.currentYield = Number((a.currentYield * mod).toFixed(4));
            a.currentPrice = Number((a.currentPrice * mod).toFixed(4));
        });
        gameState.lastCrisisRound = gameState.round;
        crisisAppliedThisRound = true;
        addLog(`CRISIS APPLIED: ${gameState.crisis.name} repriced sectors`, 'game');
    }

    // 7. Calculate GDP (Yields - Depreciation)
    Object.values(gameState.teams).forEach(t => {
        t.assets = Array.isArray(t.assets)
            ? t.assets
                .filter((owned) => Boolean(ASSET_MAP[(owned && (owned.assetId || owned.id))]))
                .map((owned) => ({
                    assetId: owned.assetId || owned.id,
                    purchaseRound: Number.isInteger(owned.purchaseRound) ? owned.purchaseRound : 0
                }))
            : [];
        t.previousRank = t.rank;
        let totalYield = 0;
        t.assets.forEach(oa => {
            const assetId = oa.assetId || oa.id;
            const ad = gameState.assets[assetId];
            if (!ad) return;
            const roundCrisisMod = 1 + (Number(activeCrisisImpacts[ad.sector] || 0) / 100);
            const effectiveYield = !crisisAppliedThisRound
                ? Number((ad.currentYield * roundCrisisMod).toFixed(4))
                : ad.currentYield;
            const age = gameState.round - oa.purchaseRound;
            const depreciatedYield = effectiveYield * Math.pow(1 - ad.depreciation, age);
            const floorYield = effectiveYield * 0.50;
            totalYield += Math.max(depreciatedYield, floorYield);
        });

        const roundBooster = Array.isArray(t.boosters)
            ? t.boosters.find(b => b && b.purchaseRound === gameState.round)
            : null;
        if (roundBooster) {
            const boosterDef = BOOSTER_DEFS[roundBooster.type];
            const multiplier = boosterDef ? boosterDef.multiplier : (roundBooster.multiplier || 1);
            totalYield *= multiplier;
        }

        t.gdp = Number(totalYield.toFixed(4));
        if (!Array.isArray(t.gdpHistory)) t.gdpHistory = [];
        t.gdpHistory.push(t.gdp);
        if (t.gdpHistory.length > TOTAL_ROUNDS) t.gdpHistory.shift();

        // Calculate Average GDP
        const validRounds = t.gdpHistory.filter((v) => Number.isFinite(v));
        const totalSum = validRounds.reduce((a, b) => a + b, 0);
        const divisor = validRounds.length || 1;
        const avgExact = totalSum / divisor;
        t.avgGDPExact = Number(avgExact.toFixed(6));
        t.avgGDP = Number(avgExact.toFixed(2));
    });

    // 8. Ranking & Tax Income (based on avgGDP and leaderboard band)
    const ranked = Object.values(gameState.teams).sort((a,b) => (b.avgGDPExact || 0) - (a.avgGDPExact || 0) || (b.gdp || 0) - (a.gdp || 0) || b.cash - a.cash);
    ranked.forEach((t, i) => {
        ensureRoundStats(t);
        t.rank = i + 1;

        let taxRate = TOP_TAX_RATE;
        if (t.rank > 20) taxRate = BOTTOM_TAX_RATE;
        else if (t.rank > 10) taxRate = MID_TAX_RATE;

        const avgGdpBasis = Number.isFinite(Number(t.avgGDPExact))
            ? Number(t.avgGDPExact)
            : Number(t.gdp || 0);
        const taxIncome = Number((avgGdpBasis * taxRate).toFixed(4));
        
        t.transactions.push({
            type: 'TAX_INCOME',
            round: gameState.round,
            avgGdp: avgGdpBasis,
            amount: taxIncome,
            taxRate: taxRate,
            timestamp: Date.now()
        });
        
        t.cash = Number((t.cash + taxIncome).toFixed(4));
        syncTeamBalances(t);

        if (!t.financials) t.financials = { rounds: [] };
        if (!Array.isArray(t.financials.rounds)) t.financials.rounds = [];
        const inflow = Number((t._roundStats.salesIncome || 0).toFixed(4));
        const outflow = Number((t._roundStats.assetSpend || 0).toFixed(4));
        const net = Number((inflow - outflow).toFixed(4));
        t.financials.rounds.push({
            round: gameState.round,
            inflow,
            outflow,
            net,
            capital: Number((t.cash || 0).toFixed(4))
        });
        t._roundStats = { assetSpend: 0, salesIncome: 0, transactions: [] };
    });
    
    // PRODUCTION FIX: Log settlement completion & timing
    const settlementDuration = Date.now() - settlementStartTime;
    metrics.settlementDuration = settlementDuration;
    logAudit({ type: 'SETTLEMENT_COMPLETE', round: gameState.round, durationMs: settlementDuration });
}

function reject(ws, msg) { ws.send(JSON.stringify({ type: 'ACTION_REJECTED', message: msg })); }
function addLog(msg, type = 'game') {
    const time = new Date().toLocaleTimeString('en-US', { hour12: false, hour: '2-digit', minute: '2-digit' });
    gameState.logs.push({ message: `[${time}] ${msg}`, type });
    while (gameState.logs.length > 200) gameState.logs.shift();
}
function formatCr(num) { return `₹${num.toFixed(2)} Cr`; }

// System Loops
setInterval(() => {
    if (gameState.isPaused || gameState.timerPaused || gameState.isEnded) return;
    const now = Date.now();
    if (gameState.phaseStartTime > now) gameState.phaseStartTime = now;
    const elapsed = Math.max(0, (now - gameState.phaseStartTime) / 1000);
    const limit = PHASES[gameState.phase] || 120;
    if (elapsed >= limit) nextPhase();
    else broadcast({ type: 'TIMER_UPDATE', elapsed, limit });
}, 1000);

setInterval(validateGameState, 5000);
setInterval(saveBackup, 3000);

loadBackup();
server.listen(3000, () => console.log("ADHIKSHANA ENGINE ONLINE PORT 3000"));
