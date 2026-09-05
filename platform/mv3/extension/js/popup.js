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

import { browser, runtime, sendMessage } from './ext.js';
import { dom, qs$, qsa$ } from './dom.js';
import { i18n$ } from './i18n.js';
import punycode from './punycode.js';

/******************************************************************************/

const popupPanelData = {};
const  currentTab = {};
const tabURL = new URL(runtime.getURL('/'));

/******************************************************************************/

function renderAdminRules() {
    const { disabledFeatures: forbid = [] } = popupPanelData;
    if ( forbid.length === 0 ) { return; }
    dom.body.dataset.forbid = forbid.join(' ');
}

/******************************************************************************/

const BLOCKING_MODE_MAX = 3;

// The dashboard mode descriptions open with a one-sentence summary and then
// spend further paragraphs on the permission implications. Only that opening
// sentence fits the popup -- and reusing these keys means every locale already
// has the text translated.
const modeDescriptionKeys = [
    'popupNoFilteringDescription',
    'basicFilteringModeDescription',
    'optimalFilteringModeDescription',
    'completeFilteringModeDescription',
];

function modeDescription(level) {
    const key = modeDescriptionKeys[level];
    if ( key === undefined ) { return ''; }
    return i18n$(key).split('\n')[0].trim();
}

function describeMode(level) {
    dom.text('#filteringModeText > span', modeDescription(level));
}

function renderFilteringMode(level) {
    const control = qs$('#filteringModeControl');
    if ( control === null ) { return; }
    control.dataset.level = level;
    for ( const button of qsa$('.modeOption') ) {
        const selected = parseInt(button.dataset.level, 10) === level;
        dom.attr(button, 'aria-checked', `${selected}`);
        // Roving tabindex: the group is one tab stop, arrows move within it.
        dom.attr(button, 'tabindex', selected ? '0' : '-1');
    }
    describeMode(level);
}

function committedLevel() {
    const control = qs$('#filteringModeControl');
    return parseInt(control.dataset.level, 10);
}

async function setFilteringMode(level, commit = false) {
    renderFilteringMode(level);
    if ( commit !== true ) { return; }
    dom.cl.add(dom.body, 'busy');
    await commitFilteringMode();
    dom.cl.remove(dom.body, 'busy');
}

async function commitFilteringMode() {
    if ( tabURL.hostname === '' ) { return; }
    const targetHostname = tabURL.hostname;
    const control = qs$('#filteringModeControl');
    const afterLevel = parseInt(control.dataset.level, 10);
    const beforeLevel = parseInt(control.dataset.levelBefore, 10);
    if ( afterLevel > 1 ) {
        if ( beforeLevel <= 1 ) {
            sendMessage({
                what: 'setPendingFilteringMode',
                tabId: currentTab.id,
                url: tabURL.href,
                hostname: targetHostname,
                beforeLevel,
                afterLevel,
            });
        }
        let granted = false;
        try {
            granted = await browser.permissions.request({
                origins: [ `*://*.${targetHostname}/*` ],
            });
        } catch {
        }
        if ( granted !== true ) {
            renderFilteringMode(beforeLevel);
            return;
        }
    }
    renderFilteringMode(afterLevel);
    const actualLevel = await sendMessage({
        what: 'setFilteringMode',
        hostname: targetHostname,
        level: afterLevel,
    });
    if ( actualLevel !== afterLevel ) {
        renderFilteringMode(actualLevel);
    }
    if ( actualLevel !== beforeLevel && popupPanelData.autoReload ) {
        const justReload = tabURL.href === currentTab.url;
        self.setTimeout(( ) => {
            if ( justReload ) {
                browser.tabs.reload(currentTab.id);
            } else {
                browser.tabs.update(currentTab.id, { url: tabURL.href });
            }
        }, 437);
    }
}

function selectMode(level) {
    if ( level < 0 || level > BLOCKING_MODE_MAX ) { return; }
    const control = qs$('#filteringModeControl');
    if ( `${level}` === control.dataset.level ) { return; }
    control.dataset.levelBefore = control.dataset.level;
    setFilteringMode(level, true);
}

dom.on('#filteringModeControl', 'click', '.modeOption', ev => {
    selectMode(parseInt(ev.target.dataset.level, 10));
});

// Radiogroup keyboard semantics: arrows move and commit, Home/End jump to the
// ends. The old slider could not be operated from the keyboard at all.
dom.on('#filteringModeControl', 'keydown', ev => {
    const rtl = dom.attr(dom.body, 'dir') === 'rtl';
    let level;
    switch ( ev.key ) {
    case 'ArrowUp':
        level = committedLevel() - 1;
        break;
    case 'ArrowDown':
        level = committedLevel() + 1;
        break;
    case 'ArrowLeft':
        level = committedLevel() + (rtl ? 1 : -1);
        break;
    case 'ArrowRight':
        level = committedLevel() + (rtl ? -1 : 1);
        break;
    case 'Home':
        level = 0;
        break;
    case 'End':
        level = BLOCKING_MODE_MAX;
        break;
    default:
        return;
    }
    if ( level < 0 || level > BLOCKING_MODE_MAX ) { return; }
    ev.preventDefault();
    selectMode(level);
    qs$(`.modeOption[data-level="${level}"]`).focus();
});

// Preview the description of whichever option is under the pointer, so the
// choice can be understood before it is made.
if ( dom.cl.has(dom.html, 'mobile') === false ) {
    dom.on('#filteringModeControl', 'mouseover', '.modeOption', ev => {
        describeMode(parseInt(ev.target.dataset.level, 10));
    });
    dom.on('#filteringModeControl', 'mouseleave', ( ) => {
        describeMode(committedLevel());
    });
}

/******************************************************************************/

dom.on('#gotoMatchedRules', 'click', ev => {
    if ( ev.isTrusted !== true ) { return; }
    if ( ev.button !== 0 ) { return; }
    sendMessage({
        what: 'showMatchedRules',
        tabId: currentTab.id,
    });
});

/******************************************************************************/

dom.on('#gotoReport', 'click', ev => {
    if ( ev.isTrusted !== true ) { return; }
    let url;
    try {
        url = new URL(currentTab.url);
    } catch {
    }
    if ( url === undefined ) { return; }
    const reportURL = new URL(runtime.getURL('/report.html'));
    reportURL.searchParams.set('tabid', currentTab.id);
    reportURL.searchParams.set('url', tabURL.href);
    reportURL.searchParams.set('mode', popupPanelData.level);
    sendMessage({
        what: 'gotoURL',
        url: `${reportURL.pathname}${reportURL.search}`,
    });
});

/******************************************************************************/

dom.on('#gotoDashboard', 'click', ev => {
    if ( ev.isTrusted !== true ) { return; }
    if ( ev.button !== 0 ) { return; }
    runtime.openOptionsPage();
});

/******************************************************************************/

dom.on('#gotoZapper', 'click', ( ) => {
    if ( browser.scripting === undefined ) { return; }
    browser.scripting.executeScript({
        files: [ '/js/scripting/tool-overlay.js', '/js/scripting/zapper.js' ],
        target: { tabId: currentTab.id },
    });
    self.close();
});

/******************************************************************************/

dom.on('#gotoPicker', 'click', ( ) => {
    if ( browser.scripting === undefined ) { return; }
    browser.scripting.executeScript({
        files: [
            '/js/scripting/css-procedural-api.js',
            '/js/scripting/tool-overlay.js',
            '/js/scripting/picker.js',
        ],
        target: { tabId: currentTab.id },
    });
    self.close();
});

/******************************************************************************/

dom.on('#gotoUnpicker', 'click', ( ) => {
    if ( browser.scripting === undefined ) { return; }
    browser.scripting.executeScript({
        files: [
            '/js/scripting/css-procedural-api.js',
            '/js/scripting/tool-overlay.js',
            '/js/scripting/unpicker.js',
        ],
        target: { tabId: currentTab.id },
    });
    self.close();
});

/******************************************************************************/

async function init() {
    const [ tab ] = await browser.tabs.query({
        active: true,
        currentWindow: true,
    });
    if ( tab instanceof Object === false ) { return true; }
    Object.assign(currentTab, tab);

    let url;
    try {
        const strictBlockURL = runtime.getURL('/strictblock.');
        url = new URL(currentTab.url);
        if ( url.href.startsWith(strictBlockURL) ) {
            url = new URL(url.hash.slice(1));
        }
        tabURL.href = url.href || '';
    } catch {
        return false;
    }

    if ( url !== undefined ) {
        const response = await sendMessage({
            what: 'popupPanelData',
            origin: url.origin,
            hostname: tabURL.hostname,
        });
        if ( response instanceof Object ) {
            Object.assign(popupPanelData, response);
        }
    }

    renderAdminRules();

    renderFilteringMode(popupPanelData.level);

    dom.text('#hostname', punycode.toUnicode(tabURL.hostname));

    dom.cl.toggle('#gotoMatchedRules', 'enabled',
        popupPanelData.isSideloaded === true &&
        popupPanelData.developerMode &&
        typeof currentTab.id === 'number' &&
        isNaN(currentTab.id) === false
    );

    const isHTTP = url.protocol === 'http:' || url.protocol === 'https:';
    dom.cl.toggle(dom.root, 'isHTTP', isHTTP);

    dom.cl.toggle('#gotoUnpicker', 'enabled', popupPanelData.hasCustomFilters);

    return true;
}

async function tryInit() {
    try {
        await init();
    } catch {
        setTimeout(tryInit, 100);
    } finally {
        dom.cl.remove(dom.body, 'loading', 'busy');
    }
}

tryInit();

/******************************************************************************/

