/*******************************************************************************

    Wren AdBlock Pro - a comprehensive, MV3-compliant content blocker
    Copyright (C) 2026-present Raymond Hill

    This program is free software: you can redistribute it and/or modify
    it under the terms of the GNU General Public License as published by
    the Free Software Foundation, either version 3 of the License, or
    (at your option) any later version.

    This program is distributed in the hope that it will be useful,
    but WITHOUT ANY WARRANTY; without even the implied warranty of
    MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
    GNU General Public License for more details.

    You should have received a copy of the GNU General Public License
    along with this program.  If not, see {http://www.gnu.org/licenses/}.

    Home: https://github.com/nguyenquocanhz/uBlock-mv3
*/

import { browser, localRead, localWrite } from './ext.js';
import { dnr } from './ext-compat.js';
import { fetchJSON } from './fetch.js';
import { getEnabledRulesets } from './ruleset-manager.js';
import { ubolErr } from './debug.js';

/******************************************************************************/

// Blocking statistics.
//
// Nothing here works without the `declarativeNetRequestFeedback` permission:
// `getMatchedRules` is unavailable, and `action.getBadgeText` returns a
// placeholder rather than the count Chrome renders on the toolbar icon. That
// permission carries a "Read your browsing history" warning, so it is
// optional and off until the user asks for it in the dashboard.
//
// Two ways to collect, depending on what the browser offers:
//
// - `onRuleMatchedDebug` fires per match, with no quota. Chrome restricts it
//   to unpacked extensions, so it is what a locally-loaded build uses, and it
//   gives true running totals.
// - `getMatchedRules` works in a published build, but is capped at 20 calls
//   per 10 minutes outside a user gesture, and only reports matches for tabs
//   still open. So it is read on demand -- opening the popup or the stats
//   pane -- and describes the current page, not all time.
//
// Which one is in use is reported to the UI, because the two answer
// different questions and saying otherwise would be a lie.

/******************************************************************************/

export const CATEGORIES = [ 'ads', 'trackers', 'malware', 'annoyances', 'other' ];

// `group` in rulesets.json is close to the breakdown we want, but its
// "default" bucket mixes ad lists with a tracker list, so those four are
// named individually.
const categoryByRulesetId = new Map([
    [ 'ublock-filters', 'ads' ],
    [ 'easylist', 'ads' ],
    [ 'pgl', 'ads' ],
    [ 'easyprivacy', 'trackers' ],
]);

const categoryByGroup = new Map([
    [ 'ads', 'ads' ],
    [ 'malware', 'malware' ],
    [ 'privacy', 'trackers' ],
    [ 'annoyances', 'annoyances' ],
    [ 'regions', 'ads' ],
]);

let rulesetGroups;

async function categoryOf(rulesetId) {
    const named = categoryByRulesetId.get(rulesetId);
    if ( named !== undefined ) { return named; }
    if ( rulesetGroups === undefined ) {
        rulesetGroups = new Map();
        try {
            const details = await fetchJSON('/rulesets/ruleset-details');
            for ( const entry of details ) {
                rulesetGroups.set(entry.id, entry.group);
            }
        } catch (reason) {
            ubolErr(`stats/rulesetDetails/${reason}`);
        }
    }
    return categoryByGroup.get(rulesetGroups.get(rulesetId)) || 'other';
}

/******************************************************************************/

// A matched rule reports its id and ruleset but not what the rule does, and
// redirects are worth separating from outright blocks. The rulesets ship as
// JSON, so the redirecting ids can be indexed once and cached -- there are
// only a handful per list (13 of easyprivacy's 8955), so the index is tiny
// even though the file it came from is not.

const redirectIds = new Map();

async function loadRedirectIds(rulesetId) {
    if ( redirectIds.has(rulesetId) ) { return redirectIds.get(rulesetId); }
    const cacheKey = `stats.redirectIds.${rulesetId}`;
    let ids = await localRead(cacheKey);
    if ( Array.isArray(ids) === false ) {
        ids = [];
        try {
            const rules = await fetchJSON(`/rulesets/main/${rulesetId}`);
            for ( const rule of rules ) {
                if ( rule.action?.type === 'redirect' ) { ids.push(rule.id); }
            }
            localWrite(cacheKey, ids);
        } catch (reason) {
            ubolErr(`stats/redirectIds/${rulesetId}/${reason}`);
        }
    }
    const set = new Set(ids);
    redirectIds.set(rulesetId, set);
    return set;
}

async function isRedirect(rulesetId, ruleId) {
    const ids = await loadRedirectIds(rulesetId);
    return ids.has(ruleId);
}

/******************************************************************************/

export async function hasStatsPermission() {
    try {
        return await browser.permissions.contains({
            permissions: [ 'declarativeNetRequestFeedback' ],
        });
    } catch {
        return false;
    }
}

export async function requestStatsPermission() {
    try {
        const granted = await browser.permissions.request({
            permissions: [ 'declarativeNetRequestFeedback' ],
        });
        if ( granted ) { startLiveCollection(); }
        return granted;
    } catch {
        return false;
    }
}

export async function dropStatsPermission() {
    try {
        return await browser.permissions.remove({
            permissions: [ 'declarativeNetRequestFeedback' ],
        });
    } catch {
        return false;
    }
}

/******************************************************************************/

const emptyTotals = ( ) => {
    const out = { blocked: 0, redirected: 0 };
    for ( const c of CATEGORIES ) { out[c] = 0; }
    return out;
};

// Running totals, only ever populated by the live listener.
let totals = emptyTotals();
let totalsLoaded = false;
let totalsDirty = false;

async function loadTotals() {
    if ( totalsLoaded ) { return; }
    totalsLoaded = true;
    const stored = await localRead('stats.totals');
    if ( stored instanceof Object ) {
        totals = Object.assign(emptyTotals(), stored);
    }
}

function saveTotalsSoon() {
    if ( totalsDirty ) { return; }
    totalsDirty = true;
    // The service worker can be evicted at any moment, so do not let unsaved
    // counts sit for long -- but do not write on every matched request
    // either, which on a busy page is hundreds per second.
    setTimeout(( ) => {
        totalsDirty = false;
        localWrite('stats.totals', totals);
    }, 5000);
}

export async function resetStats() {
    await loadTotals();
    totals = emptyTotals();
    perTab.clear();
    return localWrite('stats.totals', totals);
}

/******************************************************************************/

// Per-tab counts, kept in memory only: they describe the page currently on
// screen, and a reload starts them over.
const perTab = new Map();

const tabTotals = tabId => {
    let t = perTab.get(tabId);
    if ( t === undefined ) {
        t = emptyTotals();
        perTab.set(tabId, t);
    }
    return t;
};

async function record(rulesetId, ruleId, tabId) {
    await loadTotals();
    const category = await categoryOf(rulesetId);
    const kind = await isRedirect(rulesetId, ruleId) ? 'redirected' : 'blocked';
    totals[category] += 1;
    totals[kind] += 1;
    if ( typeof tabId === 'number' && tabId >= 0 ) {
        const t = tabTotals(tabId);
        t[category] += 1;
        t[kind] += 1;
    }
    saveTotalsSoon();
}

/******************************************************************************/

let liveCollection = false;

export function startLiveCollection() {
    if ( liveCollection ) { return true; }
    if ( dnr.onRuleMatchedDebug instanceof Object === false ) { return false; }
    try {
        dnr.onRuleMatchedDebug.addListener(info => {
            const { rule, request } = info;
            if ( rule === undefined ) { return; }
            record(rule.rulesetId, rule.ruleId, request?.tabId);
        });
    } catch (reason) {
        ubolErr(`stats/onRuleMatchedDebug/${reason}`);
        return false;
    }
    liveCollection = true;
    return true;
}

/******************************************************************************/

// Fallback for published builds: ask for what matched on one tab. Subject to
// the 20-per-10-minutes quota, so only ever called when a panel is opened.

async function readTabFromBrowser(tabId) {
    if ( typeof dnr.getMatchedRules !== 'function' ) { return; }
    let matched;
    try {
        matched = await dnr.getMatchedRules({ tabId });
    } catch (reason) {
        ubolErr(`stats/getMatchedRules/${reason}`);
        return;
    }
    const info = matched?.rulesMatchedInfo;
    if ( Array.isArray(info) === false ) { return; }
    const out = emptyTotals();
    for ( const { rule } of info ) {
        const category = await categoryOf(rule.rulesetId);
        const kind = await isRedirect(rule.rulesetId, rule.ruleId) ? 'redirected' : 'blocked';
        out[category] += 1;
        out[kind] += 1;
    }
    perTab.set(tabId, out);
    return out;
}

/******************************************************************************/

export async function getTabStats(tabId) {
    const permitted = await hasStatsPermission();
    if ( permitted === false ) {
        return { permitted: false, live: false, totals: emptyTotals() };
    }
    let counts = perTab.get(tabId);
    if ( liveCollection === false ) {
        counts = await readTabFromBrowser(tabId) || counts;
    }
    return {
        permitted: true,
        live: liveCollection,
        totals: counts || emptyTotals(),
    };
}

export async function getOverallStats() {
    const permitted = await hasStatsPermission();
    if ( permitted === false ) {
        return { permitted: false, live: false, totals: emptyTotals(), rulesets: [] };
    }
    await loadTotals();
    return {
        permitted: true,
        // Without the live listener there are no running totals to report,
        // and the UI says so rather than showing a misleading zero.
        live: liveCollection,
        totals,
        rulesets: await getEnabledRulesets(),
    };
}

/******************************************************************************/

export function forgetTab(tabId) {
    perTab.delete(tabId);
}

/******************************************************************************/
