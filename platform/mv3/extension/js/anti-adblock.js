/*******************************************************************************

    uBlock Origin Lite - a comprehensive, MV3-compliant content blocker
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

    Home: https://github.com/gorhill/uBlock
*/

import { rulesetConfig, saveRulesetConfig } from './config.js';
import { matchesFromHostnames } from './utils.js';

/******************************************************************************/

// The filter-driven scriptlets are injected only where an enabled ruleset
// says so. This one is injected everywhere uBOL is allowed to run, because a
// site which has just started serving an adblock detector is by definition
// not yet covered by any filter list.
//
// It needs the MAIN world -- the page's own realm -- to be able to shadow the
// DOM getters a detector reads.

export async function registerAntiAdblock(context) {
    if ( rulesetConfig.antiAdblockMode !== true ) { return; }

    const { none, basic, optimal, complete } = context.filteringModeDetails;

    // "none" and "basic" mean uBOL either must not touch the site, or has no
    // host permission for it -- no injection either way.
    let matches = [];
    let excludeMatches = [];
    if ( complete.has('all-urls') || optimal.has('all-urls') ) {
        matches = [ '*' ];
        excludeMatches = [ ...none, ...basic ];
    } else {
        matches = [ ...optimal, ...complete ];
    }
    if ( matches.length === 0 ) { return; }

    const directive = {
        id: 'anti-adblock',
        js: [ '/js/scripting/anti-adblock.js' ],
        matches: matchesFromHostnames(matches),
        allFrames: true,
        matchOriginAsFallback: true,
        runAt: 'document_start',
        world: 'MAIN',
    };
    if ( excludeMatches.length !== 0 ) {
        directive.excludeMatches = matchesFromHostnames(excludeMatches);
    }

    context.toAdd.push(directive);
}

/******************************************************************************/

export async function setAntiAdblockMode(state, force = false) {
    const newState = Boolean(state);
    if ( force === false ) {
        if ( newState === rulesetConfig.antiAdblockMode ) { return; }
    }
    rulesetConfig.antiAdblockMode = newState;
    await saveRulesetConfig();
}
