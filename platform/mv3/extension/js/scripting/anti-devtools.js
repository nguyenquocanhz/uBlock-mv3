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

// Defuses pages that fight the developer tools.
//
// Worth being precise about what a page can and cannot do, because most
// write-ups on this are wrong: in Chrome a page cannot block F12, Ctrl+U or
// view-source:. Those are browser shortcuts and preventDefault does not
// reach them. What a page can actually do is make the tools useless once
// open, and notice that they are:
//
//   setInterval(() => { debugger }, 50)          // unsteppable
//   Function('debugger')()                        // same, built dynamically
//   const t = Date.now(); debugger;               // paused? then tools are open
//   if (Date.now() - t > 100) location = '/bye'
//   outerWidth - innerWidth > 160                 // docked panel changes the gap
//
// Those are what this handles. Two further tricks are deliberately left
// alone -- detection through a getter on a logged object, and through a
// replaced toString -- because neutralising them means gutting console.log,
// which costs the user the very tool this is meant to protect.

(( ) => {

/******************************************************************************/

const guard = Symbol.for('⁣uBOLdt');
if ( Object.prototype.hasOwnProperty.call(self, guard) ) { return; }
try {
    Object.defineProperty(self, guard, { value: true });
} catch {
}

/******************************************************************************/

// Same native-looking proxy technique as the anti-adblock defuser: an
// integrity check reading String(window.Function) must still see native code.

const nativeToString = Function.prototype.toString;
const unwrapMap = new WeakMap();
let toStringHooked = false;

const markNative = (proxy, native) => {
    unwrapMap.set(proxy, native);
    if ( toStringHooked ) { return; }
    toStringHooked = true;
    const hooked = new Proxy(nativeToString, {
        apply(target, thisArg, args) {
            const unwrapped = unwrapMap.get(thisArg);
            return Reflect.apply(target, unwrapped !== undefined ? unwrapped : thisArg, args);
        },
    });
    unwrapMap.set(hooked, nativeToString);
    try {
        Function.prototype.toString = hooked;
    } catch {
        toStringHooked = false;
    }
};

/******************************************************************************/

// Is this source text nothing but a debugger trap? Deliberately narrow: a
// body that only breaks, possibly wrapped in a function or a loop. Anything
// that also does real work is left to run, because `Function` is a normal
// tool for templating libraries and we must not break them.

const debuggerOnlyRe = /^[\s;{}()=>]*(?:function\s*\w*\s*\([^)]*\)\s*\{)?[\s;]*debugger[\s;]*\}?[\s;]*$/;

const isDebuggerTrap = src => {
    if ( typeof src !== 'string' ) { return false; }
    if ( src.includes('debugger') === false ) { return false; }
    return debuggerOnlyRe.test(src);
};

/******************************************************************************/

// `new Function('debugger')` and `eval('debugger')` are how a trap survives
// being minified into a loop. Hand back a function that does nothing.

try {
    const NativeFunction = self.Function;
    const noop = function(){};
    const handler = {
        construct(target, args, newTarget) {
            if ( isDebuggerTrap(args[args.length-1]) ) { return noop; }
            return Reflect.construct(target, args, newTarget);
        },
        apply(target, thisArg, args) {
            if ( isDebuggerTrap(args[args.length-1]) ) { return noop; }
            return Reflect.apply(target, thisArg, args);
        },
    };
    const HookedFunction = new Proxy(NativeFunction, handler);
    markNative(HookedFunction, NativeFunction);
    self.Function = HookedFunction;
    // Obfuscated traps usually reach the constructor through a literal, as
    // in (function(){}).constructor('debugger')(), so it needs the same
    // treatment.
    Object.defineProperty(Function.prototype, 'constructor', {
        value: HookedFunction,
        writable: true,
        configurable: true,
    });
} catch {
}

try {
    const nativeEval = self.eval;
    const hooked = new Proxy(nativeEval, {
        apply(target, thisArg, args) {
            if ( isDebuggerTrap(args[0]) ) { return; }
            return Reflect.apply(target, thisArg, args);
        },
    });
    markNative(hooked, nativeEval);
    self.eval = hooked;
} catch {
}

// A string first argument to setInterval/setTimeout is evaluated, so it is
// the third way to schedule the same trap.
for ( const name of [ 'setInterval', 'setTimeout' ] ) {
    try {
        const native = self[name];
        if ( typeof native !== 'function' ) { continue; }
        const hooked = new Proxy(native, {
            apply(target, thisArg, args) {
                if ( isDebuggerTrap(args[0]) ) {
                    args[0] = ( ) => {};
                }
                return Reflect.apply(target, thisArg, args);
            },
        });
        markNative(hooked, native);
        self[name] = hooked;
    } catch {
    }
}

/******************************************************************************/

// Detection by window geometry: docking the tools shrinks the viewport
// without shrinking the window, so a large gap between outer and inner is
// read as "tools are open". Close the gap, but only when it is wide enough
// to be that -- a genuine gap of a few pixels is just the browser's own
// chrome, and pages do legitimately read these values for layout.

const DEVTOOLS_GAP = 100;

const hookGeometry = (prop, innerProp) => {
    try {
        const desc = Object.getOwnPropertyDescriptor(self, prop) ||
                     Object.getOwnPropertyDescriptor(Object.getPrototypeOf(self) || {}, prop);
        if ( desc === undefined || typeof desc.get !== 'function' ) { return; }
        const native = desc.get;
        const get = new Proxy(native, {
            apply(target, thisArg, args) {
                const outer = Reflect.apply(target, thisArg, args);
                const inner = self[innerProp];
                if ( typeof inner !== 'number' ) { return outer; }
                // A backgrounded or hidden tab reports an inner size of
                // zero. The gap is then the whole window, which is not a
                // docked panel -- substituting would hand layout code a
                // zero it never asked for.
                if ( inner <= 0 ) { return outer; }
                if ( outer - inner < DEVTOOLS_GAP ) { return outer; }
                return inner;
            },
        });
        markNative(get, native);
        Object.defineProperty(self, prop, {
            get,
            set: desc.set,
            enumerable: desc.enumerable,
            configurable: true,
        });
    } catch {
    }
};

hookGeometry('outerWidth', 'innerWidth');
hookGeometry('outerHeight', 'innerHeight');

/******************************************************************************/

})();

void 0;
