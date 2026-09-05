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

// Restores right-click, text selection and copying on pages that take them
// away.
//
// This is off by default, and should stay a deliberate choice. Preventing
// the default on contextmenu, selectstart and copy is exactly how an
// application builds its own context menu or its own copy behaviour, so a
// blanket restore is right for an article that does not want to be quoted
// and wrong for a spreadsheet. There is no way to tell the two apart from
// inside the page, which is why this is a switch rather than a heuristic.
//
// The mechanism is to listen in the capture phase at the window, ahead of
// anything the page attached, and stop the event there. The page's handler
// never runs, so its preventDefault never happens and the browser's own
// behaviour survives.

(( ) => {

/******************************************************************************/

const guard = Symbol.for('⁣uBOLui');
if ( Object.prototype.hasOwnProperty.call(self, guard) ) { return; }
try {
    Object.defineProperty(self, guard, { value: true });
} catch {
}

/******************************************************************************/

const swallow = ev => {
    ev.stopImmediatePropagation();
};

for ( const type of [ 'contextmenu', 'selectstart', 'copy', 'cut', 'dragstart' ] ) {
    try {
        self.addEventListener(type, swallow, true);
    } catch {
    }
}

/******************************************************************************/

// Keyboard shortcuts the page has no business intercepting. Note that F12
// and Ctrl+U never reached the page in the first place -- Chrome handles
// those itself -- so this is really about select-all, copy, cut and save.
// Plain typing is untouched: nothing here fires without a modifier.

const shortcutKeys = new Set([ 'a', 'c', 'x', 's', 'u', 'p' ]);

try {
    self.addEventListener('keydown', ev => {
        if ( ev.key === 'F12' ) {
            ev.stopImmediatePropagation();
            return;
        }
        if ( ev.ctrlKey !== true && ev.metaKey !== true ) { return; }
        const key = typeof ev.key === 'string' ? ev.key.toLowerCase() : '';
        if ( shortcutKeys.has(key) === false ) { return; }
        ev.stopImmediatePropagation();
    }, true);
} catch {
}

/******************************************************************************/

// Selection can also be denied through CSS rather than through events, so
// the rule has to be overridden too. Scoped away from form controls and
// anything the page marks draggable, where suppressing selection is normal
// behaviour rather than an obstruction.

try {
    const css = `
:not(input):not(textarea):not(select):not([draggable="true"]) {
    -webkit-user-select: text !important;
    user-select: text !important;
}`;
    const install = ( ) => {
        try {
            const style = document.createElement('style');
            style.textContent = css;
            (document.head || document.documentElement).append(style);
        } catch {
        }
    };
    if ( document.head || document.documentElement ) {
        install();
    } else {
        document.addEventListener('DOMContentLoaded', install, { once: true });
    }
} catch {
}

/******************************************************************************/

})();

void 0;
