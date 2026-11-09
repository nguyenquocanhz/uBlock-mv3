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

import { rulesetConfig, saveRulesetConfig } from './config.js';
import { matchesFromHostnames } from './utils.js';
import { ubolErr } from './debug.js';

/******************************************************************************/

// Skipping sponsor reads inside YouTube videos.
//
// No ad blocker can remove these: they are not YouTube ads but part of the
// video file the creator uploaded. What can be done is to skip them, using
// the start and end times SponsorBlock's community has marked.
//
// Two things about the data source shape this module.
//
// - Privacy. Asking for "the segments of video X" tells the server what you
//   are watching. So only the first four hex digits of SHA-256(videoId) are
//   sent, and the server answers with every marked video sharing that prefix
//   -- dozens of them -- from which the right one is picked locally. That is
//   SponsorBlock's own k-anonymity endpoint.
// - Licence. SponsorBlock's database is CC BY-NC-SA 4.0: it must be credited,
//   which the About pane and the setting's legend do, and it must not be used
//   commercially.
//
// Off by default: it is the one feature here that contacts a third party.

const API = 'https://sponsor.ajay.app/api/skipSegments/';

// The categories that are advertising in all but name. Intros, outros and
// recaps are a matter of taste rather than of ads, so they stay out.
const CATEGORIES = [ 'sponsor', 'selfpromo', 'interaction' ];

/******************************************************************************/

export function registerSponsorBlock(context) {
    if ( rulesetConfig.sponsorBlockMode !== true ) { return; }
    const { none, basic } = context.filteringModeDetails;
    // Filtering switched off everywhere means everywhere.
    if ( none.has('all-urls') ) { return; }
    const directive = {
        id: 'sponsorblock',
        js: [ '/js/scripting/sponsorblock.js' ],
        matches: [ '*://*.youtube.com/*', '*://*.youtube-nocookie.com/*' ],
        // Embedded players on other sites run in their own youtube.com frame.
        allFrames: true,
        runAt: 'document_start',
        // ISOLATED, deliberately. The page's realm is left untouched, so
        // YouTube's BotGuard has nothing to notice: this only reads the video
        // element's clock and moves it, which works across worlds.
    };
    const excluded = [ ...none, ...basic ];
    if ( excluded.length !== 0 ) {
        directive.excludeMatches = matchesFromHostnames(excluded);
    }
    context.toAdd.push(directive);
}

export async function setSponsorBlockMode(state) {
    const newState = Boolean(state);
    if ( newState === rulesetConfig.sponsorBlockMode ) { return; }
    rulesetConfig.sponsorBlockMode = newState;
    await saveRulesetConfig();
}

/******************************************************************************/

// Fetched here rather than from the content script so the request leaves from
// the extension, not from youtube.com, and so answers can be shared between
// tabs. Results live for half an hour: segments do get added and voted on,
// but not fast enough to matter within a viewing session.

const cache = new Map();
const CACHE_TTL = 30 * 60 * 1000;
const CACHE_MAX = 256;

const sha256Hex = async text => {
    const bytes = new TextEncoder().encode(text);
    const digest = await crypto.subtle.digest('SHA-256', bytes);
    return Array.from(new Uint8Array(digest), b => b.toString(16).padStart(2, '0')).join('');
};

export async function getSponsorSegments(videoId) {
    if ( rulesetConfig.sponsorBlockMode !== true ) { return []; }
    if ( typeof videoId !== 'string' || /^[\w-]{11}$/.test(videoId) === false ) {
        return [];
    }
    const hit = cache.get(videoId);
    if ( hit !== undefined && (Date.now() - hit.t) < CACHE_TTL ) {
        return hit.segments;
    }
    let segments = [];
    try {
        const prefix = (await sha256Hex(videoId)).slice(0, 4);
        const url = new URL(API + prefix);
        url.searchParams.set('categories', JSON.stringify(CATEGORIES));
        url.searchParams.set('actionTypes', JSON.stringify([ 'skip' ]));
        const response = await fetch(url, { credentials: 'omit' });
        // 404 is how the API says "nothing in this bucket".
        if ( response.ok ) {
            const bucket = await response.json();
            const entry = Array.isArray(bucket)
                ? bucket.find(v => v && v.videoID === videoId)
                : undefined;
            if ( entry && Array.isArray(entry.segments) ) {
                segments = entry.segments
                    .filter(s => s && s.actionType === 'skip' &&
                        Array.isArray(s.segment) && s.segment.length === 2 &&
                        s.segment[1] > s.segment[0])
                    .map(s => ({
                        uuid: s.UUID,
                        category: s.category,
                        start: s.segment[0],
                        end: s.segment[1],
                        videoDuration: s.videoDuration || 0,
                    }));
            }
        } else if ( response.status !== 404 ) {
            return [];  // transient: do not cache a failure as "no segments"
        }
    } catch (reason) {
        ubolErr(`sponsorblock/${reason}`);
        return [];
    }
    if ( cache.size >= CACHE_MAX ) {
        cache.delete(cache.keys().next().value);
    }
    cache.set(videoId, { t: Date.now(), segments });
    return segments;
}
