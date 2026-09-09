/*******************************************************************************

    uBlock Origin Lite - a comprehensive, MV3-compliant content blocker
    Copyright (C) 2022-present Raymond Hill

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

import {
    localRead, localWrite,
    sessionRead, sessionWrite,
    webextFlavor,
} from './ext.js';

/******************************************************************************/

export const rulesetConfig = {
    version: '',
    enabledRulesets: [],
    autoReload: true,
    showBlockedCount: true,
    strictBlockMode: webextFlavor !== 'safari',
    popupBlockMode: true,
    antiAdblockMode: true,
    // Off by default. It is the most invasive thing here: to neutralise a
    // debugger trap it has to replace Function, eval, setTimeout and
    // setInterval with proxies, on every page. A browser whose intrinsics
    // have been swapped out is what bot detection looks for, and most people
    // never meet a page that fights the developer tools. Those who do can
    // turn it on.
    antiDevtoolsMode: false,
    unlockInteractionMode: false,
    dismissWallMode: true,
    developerMode: false,
    hasBroadHostPermissions: true,
};

export const defaultConfig = Object.assign({}, rulesetConfig);

export const process = {
    firstRun: false,
    wakeupRun: false,
};

let pendingOpPromise = Promise.resolve();

/******************************************************************************/

async function _loadRulesetConfig() {
    const sessionData = await sessionRead('rulesetConfig');
    if ( sessionData ) {
        Object.assign(rulesetConfig, sessionData);
        process.wakeupRun = true;
        return;
    }
    const localData = await localRead('rulesetConfig');
    if ( localData ) {
        Object.assign(rulesetConfig, localData)
        sessionWrite('rulesetConfig', rulesetConfig);
        return;
    }
    sessionWrite('rulesetConfig', rulesetConfig);
    localWrite('rulesetConfig', rulesetConfig);
    process.firstRun = true;
}

async function _saveRulesetConfig() {
    sessionWrite('rulesetConfig', rulesetConfig);
    return localWrite('rulesetConfig', rulesetConfig);
}

/******************************************************************************/

export function loadRulesetConfig() {
    pendingOpPromise = pendingOpPromise.then(_loadRulesetConfig);
    return pendingOpPromise;
}

export function saveRulesetConfig() {
    pendingOpPromise = pendingOpPromise.then(_saveRulesetConfig);
    return pendingOpPromise;
}
