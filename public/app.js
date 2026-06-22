let socket;
let gameState = null;
let teamId = null;
let role = null;
let clientServerOffset = 0;
let lastTimerData = { elapsed: 0, limit: 120, phaseStartTime: Date.now(), isPaused: true };
const hotRefreshTimeouts = {};
const bidActivityByAsset = {};
const previousBidderByAsset = {}; // Track previous bidder to detect outbids
let pendingUIFrame = null;
let lastKnownRound = null;

const getLimitForPhase = (phase) => {
    const limits = { signal: 30, auction: 330, crisis: 20, results: 150, waiting: 0, ended: 0 }; // CRITICAL FIX: Merged strategy (120s) into results (150s total)
    return limits[phase] || 120;
};

const connect = () => {
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    socket = new WebSocket(`${protocol}//${window.location.host}`);

    socket.onopen = () => {
        const stored = localStorage.getItem('sim_auth');
        if (stored) {
            const auth = JSON.parse(stored);
            socket.send(JSON.stringify({ type: 'AUTH', role: auth.role, teamId: auth.teamId, password: auth.password }));
            // Request fresh state explicitly on reconnect
            socket.send(JSON.stringify({ type: 'REQUEST_STATE' }));
        }
        const statusEl = document.getElementById('connection-status');
        if (statusEl) {
            statusEl.innerText = "CONNECTED";
            statusEl.style.color = "var(--positive)";
        }
    };

    socket.onmessage = (event) => {
        try {
            const data = JSON.parse(event.data);
            if (data.serverTime) clientServerOffset = data.serverTime - Date.now();
            
            if (data.timerData) {
                const previousRound = lastKnownRound;
                lastTimerData.phaseStartTime = data.timerData.phaseStartTime;
                lastTimerData.isPaused = data.timerData.isPaused;
                if (typeof data.timerData.elapsed === 'number') lastTimerData.elapsed = data.timerData.elapsed;
                lastTimerData.limit = getLimitForPhase(data.timerData.phase);
                if (Number.isInteger(data.timerData.round)) {
                    lastKnownRound = data.timerData.round;
                    if (previousRound !== null && previousRound !== lastKnownRound && gameState) {
                        rebuildPreviousBidderCache(gameState);
                    }
                }
            }
            
            handleServerEvent(data);
        } catch (err) {
            console.error("Msg Error:", err);
        }
    };

    socket.onclose = () => {
        const statusEl = document.getElementById('connection-status');
        if (statusEl) {
            statusEl.innerText = "DISCONNECTED";
            statusEl.style.color = "var(--negative)";
        }
        setTimeout(connect, 2000);
    };
};

const requestUIRender = () => {
    if (pendingUIFrame !== null) return;
    pendingUIFrame = requestAnimationFrame(() => {
        pendingUIFrame = null;
        if (typeof updateUI === 'function') updateUI();
    });
};

const rebuildPreviousBidderCache = (state) => {
    Object.keys(previousBidderByAsset).forEach((key) => delete previousBidderByAsset[key]);
    if (!state) return;

    Object.entries(state.assets || {}).forEach(([assetId, asset]) => {
        if (asset?.highestBidder) previousBidderByAsset[String(assetId)] = asset.highestBidder;
    });

    (state.boosters || []).forEach((booster) => {
        if (booster?.id && booster.highestBidder) {
            previousBidderByAsset[String(booster.id)] = booster.highestBidder;
        }
    });
};

// PRODUCTION FIX: Client-side state hash validation
let lastStateHash = null;
let stateHashMismatches = 0;

const computeClientStateHash = async (state) => {
    const snapshot = JSON.stringify({
        round: state.round,
        phase: state.phase,
        teams: Object.entries(state.teams || {})
            .map(([id, t]) => ({
                id,
                cash: parseFloat((t.cash || 0).toFixed(4)),
                lockedCash: parseFloat((t.lockedCash || 0).toFixed(4)),
                gdp: parseFloat((t.gdp || 0).toFixed(4)),
                assets: (t.assets || []).length
            }))
            .sort((a, b) => a.id.localeCompare(b.id)),
        assets: Object.entries(state.assets || {})
            .map(([id, a]) => ({
                id,
                highestBidder: a.highestBidder,
                currentBid: parseFloat((a.currentBid || 0).toFixed(4)),
                currentPrice: parseFloat((a.currentPrice || 0).toFixed(4))
            }))
            .sort((a, b) => a.id.localeCompare(b.id))
    });

    const cryptoObj = window.crypto || self.crypto;
    if (!cryptoObj || !cryptoObj.subtle) {
        return null;
    }

    const encoded = new TextEncoder().encode(snapshot);
    const digest = await cryptoObj.subtle.digest('SHA-256', encoded);
    return Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, '0')).join('');
};

const validateStateHash = (state, receivedHash) => {
    if (!receivedHash || !state) return true;

    lastStateHash = receivedHash;
    computeClientStateHash(state).then((computedHash) => {
        if (!computedHash) {
            return;
        }

        if (computedHash !== receivedHash) {
            stateHashMismatches++;
            console.warn(`State hash mismatch detected. Mismatches: ${stateHashMismatches}`);
            if (stateHashMismatches > 3) {
                console.error('ALERT: Multiple state mismatches! Requesting fresh sync...');
                socket.send(JSON.stringify({ type: 'REQUEST_STATE' }));
                stateHashMismatches = 0; // Reset
            }
        } else {
            stateHashMismatches = Math.max(0, stateHashMismatches - 1); // Gradually reduce counter
        }
    }).catch(() => {
        // Silently ignore hash validation errors
    });

    return true;
};

const handleServerEvent = (data) => {
    switch (data.type) {
        case 'AUTH_SUCCESS':
            role = data.role;
            teamId = data.teamId;
            gameState = data.state;
            // PRODUCTION FIX: Validate state hash on auth
            if (data.stateHash) validateStateHash(data.state, data.stateHash);
            if (data.state) {
                lastKnownRound = Number.isInteger(data.state.round) ? data.state.round : lastKnownRound;
                if (typeof data.state.phaseStartTime === 'number') lastTimerData.phaseStartTime = data.state.phaseStartTime;
                if (typeof data.state.isPaused === 'boolean') lastTimerData.isPaused = data.state.isPaused;
                lastTimerData.limit = getLimitForPhase(data.state.phase);
                rebuildPreviousBidderCache(data.state);
            }
            syncBidActivityOnState();
            const overlay = document.getElementById('login-overlay');
            if (overlay) overlay.style.display = 'none';
            if (data.serverTime) clientServerOffset = data.serverTime - Date.now();
            requestUIRender();
            break;
        case 'AUTH_FAILED':
            showToast(data.message);
            localStorage.removeItem('sim_auth');
            const btn = document.getElementById('login-btn');
            if (btn) btn.classList.remove('btn-loading');
            const surf = document.querySelector('#login-overlay .surface');
            if (surf) {
                surf.classList.add('shake');
                setTimeout(() => surf.classList.remove('shake'), 500);
            }
            break;
        case 'FULL_STATE':
            gameState = data.state;
            // PRODUCTION FIX: Validate state hash
            if (data.stateHash) validateStateHash(data.state, data.stateHash);
            if (data.state) {
                lastKnownRound = Number.isInteger(data.state.round) ? data.state.round : lastKnownRound;
                if (typeof data.state.phaseStartTime === 'number') lastTimerData.phaseStartTime = data.state.phaseStartTime;
                if (typeof data.state.isPaused === 'boolean') lastTimerData.isPaused = data.state.isPaused;
                lastTimerData.limit = getLimitForPhase(data.state.phase);
                rebuildPreviousBidderCache(data.state);
            }
            syncBidActivityOnState();
            if (data.serverTime) clientServerOffset = data.serverTime - Date.now();
            requestUIRender();
            break;
        case 'HOST_MESSAGE':
            showToast(`[HOST] ${data.payload.message}`);
            break;
        case 'SYSTEM_MESSAGE':
            showToast(data.message || 'SYSTEM MESSAGE', data.durationMs || 5000);
            break;
        case 'GAME_ENDED':
            if (!gameState) gameState = {};
            gameState.isEnded = true;
            gameState.phase = 'ended';
            gameState.finalStandings = data.standings || gameState.finalStandings || [];
            gameState.teamSummaries = data.summaries || gameState.teamSummaries || {};
            lastTimerData.isPaused = true;
            lastTimerData.limit = 0;
            showToast('MARKET SESSION CLOSED: FINAL STANDINGS READY');
            requestUIRender();
            break;
        case 'BID_UPDATE':
            if (!gameState) {
                break;
            }

            const isBooster = data.entityType === 'booster';
            const entityId = isBooster ? data.boosterId : data.assetId;
            const entityKey = String(entityId);
            const bucket = isBooster ? (gameState.boosters || []) : Object.values(gameState.assets || {});
            const entity = bucket.find((x) => x && String(x.id) === String(entityId));
            if (!entity) break;

            const previousLeader = entity.highestBidder || null;
            const newBidder = data.highestBidder || null;
            const weLostLead = previousLeader === teamId && newBidder !== teamId;

            entity.currentBid = data.currentBid;
            entity.highestBidder = data.highestBidder;
            entity.lastBidTime = Date.now();
            bidActivityByAsset[entityKey] = Date.now();
            if (newBidder) previousBidderByAsset[entityKey] = newBidder;
            else delete previousBidderByAsset[entityKey];

            if (data.affectedTeams && gameState.teams) {
                Object.entries(data.affectedTeams).forEach(([affectedTeamId, snapshot]) => {
                    const targetTeam = gameState.teams[affectedTeamId];
                    if (!targetTeam || !snapshot) return;
                    if (typeof snapshot.cash === 'number') targetTeam.cash = snapshot.cash;
                    if (typeof snapshot.lockedCash === 'number') targetTeam.lockedCash = snapshot.lockedCash;
                });
            }

            if (weLostLead && role === 'team') {
                const newBidderTeam = gameState.teams?.[newBidder];
                const bidderName = newBidderTeam?.name || newBidder;
                const label = isBooster ? 'booster' : 'asset';
                showToast(`OUTBID: ${entity.name} ${label} taken by ${bidderName}`);
            }

            scheduleHotRefresh(entityId);
            flashRow(entityId);
            break;
        case 'ACTION_REJECTED':
            showToast(data.message);
            break;
        case 'TIMER_UPDATE':
            lastTimerData.elapsed = data.elapsed;
            lastTimerData.limit = data.limit;
            break;
        case 'ROUND_CHANGE':
            if (gameState) rebuildPreviousBidderCache(gameState);
            break;
    }
};

const syncBidActivityOnState = () => {
    if (!gameState) return;
    const entities = [
        ...Object.values(gameState.assets || {}),
        ...(Array.isArray(gameState.boosters) ? gameState.boosters : [])
    ];

    entities.forEach((asset) => {
        const stateBidTs = typeof asset?.lastBidTime === 'number' ? asset.lastBidTime : 0;
        const localBidTs = bidActivityByAsset[asset?.id] || 0;
        const mergedBidTs = Math.max(stateBidTs, localBidTs);

        if (!asset || !asset.id) return;
        if (gameState.phase !== 'auction') {
            asset.lastBidTime = 0;
            delete bidActivityByAsset[asset.id];
            return;
        }

        asset.lastBidTime = mergedBidTs;
        if (mergedBidTs > 0) bidActivityByAsset[asset.id] = mergedBidTs;
    });
};

const scheduleHotRefresh = (assetId) => {
    if (hotRefreshTimeouts[assetId]) clearTimeout(hotRefreshTimeouts[assetId]);
    hotRefreshTimeouts[assetId] = setTimeout(() => {
        requestUIRender();
        delete hotRefreshTimeouts[assetId];
    }, 3100);
};

const showToast = (msg, durationMs = 3000) => {
    const container = document.getElementById('toast-container');
    if (!container) return;
    const toast = document.createElement('div');
    toast.className = 'toast';
    toast.innerText = msg;
    toast.style.cssText = 'display: block;'; 
    container.appendChild(toast);
    
    // Remove after configured duration
    setTimeout(() => { 
        if (toast.parentNode) toast.remove(); 
    }, Math.max(1200, durationMs));
};

const flashRow = (assetId) => {
    const row = document.getElementById(`asset-row-${assetId}`) || document.getElementById(`row-${assetId}`);
    if (row) {
        row.classList.add('flash-highlight');
        setTimeout(() => { if(row) row.classList.remove('flash-highlight'); }, 2000);
    }
    requestUIRender();
};

// Local Ticker for UI smoothness
setInterval(() => {
    if (!gameState || !lastTimerData.phaseStartTime) return;
    try {
        const serverNow = Date.now() + clientServerOffset;
        let currentElapsed = lastTimerData.isPaused
            ? lastTimerData.elapsed
            : (serverNow - lastTimerData.phaseStartTime) / 1000;
        
        // Clamp to valid range
        currentElapsed = Math.max(0, Math.min(lastTimerData.limit, currentElapsed));
        
        refreshTimerUI(currentElapsed, lastTimerData.limit);
    } catch (e) { console.error("Local Timer Error:", e); }
}, 100);

const refreshTimerUI = (elapsed, limit) => {
    const bar = document.getElementById('timer-bar');
    if (bar) {
        const percent = Math.min(100, (elapsed / limit) * 100);
        bar.style.width = `${percent}%`;
        bar.classList.toggle('timer-urgent-yellow', percent > 80 && percent <= 95);
        bar.classList.toggle('timer-urgent-red', percent > 95);
    }
    const label = document.getElementById('timer-label') || document.getElementById('countdown-label') || document.querySelector('.timer-large');
    if (label) {
        const remaining = Math.max(0, Math.floor(limit - elapsed));
        label.innerText = `${Math.floor(remaining / 60)}:${(remaining % 60).toString().padStart(2, '0')}`;
    }
    if (typeof onTick === 'function') onTick(elapsed, limit);
};

// Note: placeBid, buyBooster, sellAsset are defined in team.html's inline script
// so they're globally accessible from onclick handlers

const formatCr = (num) => `₹${parseFloat(num || 0).toFixed(2)} Cr`;
const formatPercent = (val) => `${val > 0 ? '+' : ''}${val}%`;

connect();
