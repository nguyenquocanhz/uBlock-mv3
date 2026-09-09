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
import { matchesFromHostnames, sensitiveOriginMatches } from './utils.js';

/******************************************************************************/

// Two page-level tools, registered the same way the anti-adblock defuser is:
// MAIN world, document_start, everywhere uBOL may run.
//
// They are separate switches because the risk is not comparable. Defusing a
// debugger trap cannot break a site that was behaving -- no page has a
// legitimate reason to freeze your developer tools. Restoring right-click
// and selection can break one, because preventing those is also how an
// application builds its own context menu. So the first defaults on and the
// second defaults off.

function targetsFor(filteringModeDetails) {
    const { none, basic, optimal, complete } = filteringModeDetails;
    if ( complete.has('all-urls') || optimal.has('all-urls') ) {
        return { matches: [ '*' ], excludeMatches: [ ...none, ...basic ] };
    }
    return { matches: [ ...optimal, ...complete ], excludeMatches: [] };
}

function register(context, id, file, options = {}) {
    const { matches, excludeMatches } = targetsFor(context.filteringModeDetails);
    if ( matches.length === 0 ) { return; }
    const directive = {
        id,
        js: [ file ],
        matches: matchesFromHostnames(matches),
        allFrames: options.allFrames !== false,
        runAt: options.runAt || 'document_start',
        world: options.world || 'MAIN',
    };
    directive.excludeMatches = [
        ...matchesFromHostnames(excludeMatches),
        ...sensitiveOriginMatches,
    ];
    context.toAdd.push(directive);
}

/******************************************************************************/

export async function registerAntiDevtools(context) {
    if ( rulesetConfig.antiDevtoolsMode !== true ) { return; }
    register(context, 'anti-devtools', '/js/scripting/anti-devtools.js');
}

export async function registerUnlockInteraction(context) {
    if ( rulesetConfig.unlockInteractionMode !== true ) { return; }
    register(context, 'unlock-interaction', '/js/scripting/unlock-interaction.js');
}

/******************************************************************************/

export async function registerDismissWall(context) {
    if ( rulesetConfig.dismissWallMode !== true ) { return; }
    // ISOLATED world: this only reads and hides DOM nodes, so it has no need
    // of the page's realm. Top frame only -- a wall covers the page the
    // reader is looking at, not an ad iframe inside it.
    register(context, 'dismiss-wall', '/js/scripting/dismiss-wall.js', {
        world: 'ISOLATED',
        runAt: 'document_end',
        allFrames: false,
    });
}

/******************************************************************************/

export async function setDismissWallMode(state) {
    const newState = Boolean(state);
    if ( newState === rulesetConfig.dismissWallMode ) { return; }
    rulesetConfig.dismissWallMode = newState;
    await saveRulesetConfig();
}

export async function setAntiDevtoolsMode(state) {
    const newState = Boolean(state);
    if ( newState === rulesetConfig.antiDevtoolsMode ) { return; }
    rulesetConfig.antiDevtoolsMode = newState;
    await saveRulesetConfig();
}

export async function setUnlockInteractionMode(state) {
    const newState = Boolean(state);
    if ( newState === rulesetConfig.unlockInteractionMode ) { return; }
    rulesetConfig.unlockInteractionMode = newState;
    await saveRulesetConfig();
}
