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

/******************************************************************************/

// Dismisses the "please disable your ad blocker" wall and gives the page
// back its scrollbar.
//
// This is the one hook here that changes what the page shows, so the gate
// matters more than the mechanism. Structurally an adblock wall is
// indistinguishable from a cookie banner, a paywall, a newsletter prompt or
// a login dialog: fixed position, high z-index, covers the viewport, locks
// scrolling. Acting on shape alone would take out all of them, and locking
// the scroll is the correct behaviour for a real dialog.
//
// What separates them is the words. No legitimate dialog asks you to turn
// off your ad blocker. So the text is the gate, and the shape only narrows
// where to look:
//
//   1. the element is positioned and covers a real part of the viewport
//   2. its own text is short -- a wall is a sentence or two, not an article
//   3. that text asks about an ad blocker, in one of the languages below
//
// Scrolling is only restored once a wall has actually been found, so a page
// whose modal is genuine keeps the lock it asked for.

(( ) => {

/******************************************************************************/

const guard = Symbol.for('⁣uBOLwall');
if ( Object.prototype.hasOwnProperty.call(self, guard) ) { return; }
try {
    Object.defineProperty(self, guard, { value: true });
} catch {
}

/******************************************************************************/

const wallRe = new RegExp([
    'ad\\s?-?blocke?r',
    'adblock',
    'disable\\s+(?:your\\s+)?ads?\\b',
    'turn\\s+off\\s+(?:your\\s+)?ads?\\b',
    'chặn\\s+quảng\\s+cáo',
    'tắt\\s+(?:trình\\s+)?chặn',
    'vô\\s+hiệu\\s+hoá\\s+trình\\s+chặn',
    'werbeblocker',
    'bloqueur\\s+de\\s+(?:pub|publicité)',
    'bloqueador\\s+de\\s+(?:anuncios|publicidad)',
    'блокировщик\\s+рекламы',
    '広告ブロック',
    '광고\\s?차단',
    '广告拦截',
    '廣告攔截',
].join('|'), 'i');

// A wall is a short message. An article that happens to discuss ad blockers
// runs to thousands of characters, and is not positioned over the viewport
// anyway, but the cap is cheap insurance.
const MAX_WALL_TEXT = 1200;

// It also has to actually be in the way.
const MIN_VIEWPORT_SHARE = 0.12;

/******************************************************************************/

const isInTheWay = el => {
    let cs;
    try {
        cs = getComputedStyle(el);
    } catch {
        return false;
    }
    if ( cs.position !== 'fixed' && cs.position !== 'absolute' ) { return false; }
    if ( cs.display === 'none' || cs.visibility === 'hidden' ) { return false; }
    if ( parseFloat(cs.opacity) === 0 ) { return false; }
    const rect = el.getBoundingClientRect();
    const vw = self.innerWidth || 1;
    const vh = self.innerHeight || 1;
    if ( rect.width <= 0 || rect.height <= 0 ) { return false; }
    return (rect.width * rect.height) >= (vw * vh * MIN_VIEWPORT_SHARE);
};

const looksLikeWall = el => {
    let text;
    try {
        text = el.textContent || '';
    } catch {
        return false;
    }
    text = text.trim();
    if ( text.length === 0 || text.length > MAX_WALL_TEXT ) { return false; }
    if ( wallRe.test(text) === false ) { return false; }
    return isInTheWay(el);
};

/******************************************************************************/

let unlocked = false;

// Hidden rather than removed: page scripts often keep a reference to the
// wall, and removing it can throw somewhere we cannot see. Hiding reaches
// the same result for the reader, and if the page puts it back the observer
// below hides it again.
const hide = el => {
    try {
        el.setAttribute('data-wren-dismissed', '');
        el.style.setProperty('display', 'none', 'important');
    } catch {
    }
};

// Only ever called after a wall was found. Walls lock the page by hiding
// overflow on the root, sometimes by pinning the body, sometimes by
// blurring the content behind them.
const unlockScrolling = ( ) => {
    if ( unlocked ) { return; }
    unlocked = true;
    try {
        const style = document.createElement('style');
        style.setAttribute('data-wren-unlock', '');
        style.textContent = [
            'html[style], body[style], html, body {',
            '  overflow: auto !important;',
            '  overflow-y: auto !important;',
            '  position: static !important;',
            '  height: auto !important;',
            '  filter: none !important;',
            '}',
        ].join('\n');
        (document.head || document.documentElement).append(style);
    } catch {
    }
};

/******************************************************************************/

const sweep = ( ) => {
    let found = false;
    let candidates;
    try {
        // Only positioned elements can be in the way, and querying for the
        // style attribute or a class is unreliable -- walls are styled every
        // possible way -- so this walks the elements and lets the cheap
        // checks in looksLikeWall() reject the vast majority.
        candidates = document.body ? document.body.querySelectorAll('div,section,aside,dialog,ins') : [];
    } catch {
        return;
    }
    for ( const el of candidates ) {
        if ( el.hasAttribute('data-wren-dismissed') ) { continue; }
        if ( looksLikeWall(el) === false ) { continue; }
        hide(el);
        found = true;
    }
    if ( found ) { unlockScrolling(); }
};

/******************************************************************************/

// Walls rarely exist at first paint: they arrive once the page has decided
// its ads did not load, which is typically a second or two in, and sometimes
// on a timer after that. Watch for additions, and sweep a few times besides.

const start = ( ) => {
    sweep();
    try {
        const observer = new MutationObserver(( ) => {
            if ( start.pending ) { return; }
            start.pending = true;
            setTimeout(( ) => { start.pending = false; sweep(); }, 250);
        });
        observer.observe(document.documentElement, {
            childList: true,
            subtree: true,
            attributes: true,
            attributeFilter: [ 'style', 'class' ],
        });
        // Stop watching once the page has settled; a wall that appears after
        // this is rare enough not to justify an observer running forever.
        setTimeout(( ) => observer.disconnect(), 30000);
    } catch {
    }
    for ( const delay of [ 500, 1500, 3000, 6000 ] ) {
        setTimeout(sweep, delay);
    }
};

if ( document.readyState === 'loading' ) {
    document.addEventListener('DOMContentLoaded', start, { once: true });
} else {
    start();
}

/******************************************************************************/

})();

void 0;
