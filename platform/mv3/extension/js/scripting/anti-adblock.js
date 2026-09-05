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

/******************************************************************************/

// Generic anti-adblock defuser.
//
// Unlike the filter-driven scriptlets, which are injected only on the
// hostnames present in the enabled rulesets, this one is registered against
// every URL for which uBOL has been granted host permissions -- i.e. every
// site in "optimal" or "complete" filtering mode.
//
// It must run in the MAIN world at document_start, before any page script
// gets a chance to install a detector.
//
// Design rules, in order of importance:
//
// - Never break a page. Every hook first computes the genuine result, and
//   only substitutes a fake one when the genuine result is the specific
//   "I have been blocked" signal *and* the element under scrutiny looks like
//   adblock bait. A page which does not probe for an adblocker sees a
//   completely unmodified DOM API.
// - Stay invisible. Hooks are `Proxy` objects whose `toString()` reports the
//   original native source, so integrity checks do not see tampering.
// - Never throw. A failure to install one hook must not prevent the others.

(( ) => {

/******************************************************************************/

// Injected once per world per frame; the guard only matters for the odd
// about:blank frame which can be matched twice through matchOriginAsFallback.
const guard = Symbol.for('⁣uBOL');
if ( Object.prototype.hasOwnProperty.call(self, guard) ) { return; }
try {
    Object.defineProperty(self, guard, { value: true });
} catch {
}

/******************************************************************************/

// Make our proxies report the source code of the function they wrap, so that
// `String(window.getComputedStyle)` still reads "[native code]".
// Same technique as uBO's `proxy-tostring.fn` scriptlet.

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

// Does this element look like adblock bait?
//
// The token list is deliberately narrow: these are the class/id names that
// detection scripts pick precisely *because* filter lists hide them. A real
// content element sharing one of these names is only ever affected when it
// already measures zero, in which case the page cannot be relying on the
// value for layout anyway.

const baitRe = /^(?:ad|ads|adbox|ad-?banner|adsbox|ad-?box|ad-?slot|ad-?unit|ad-?wrap(?:per)?|ad-?placement|ad-?container|advert|advertis(?:ing|ement)s?|banner-?ads?|sponsor(?:ed|ship)?|text-?ads?|adsbygoogle|pub_300x250m?|pub_728x90)$/i;

const baitAttrs = [
    'data-ad-slot',
    'data-ad-client',
    'data-ad-format',
    'data-ad-region',
    'data-adtest',
    'data-adbanner',
];

const hasBaitToken = str => {
    for ( const token of str.split(/\s+/) ) {
        if ( token === '' ) { continue; }
        // Whole token first, so that compound names which are themselves
        // bait -- `pub_300x250` -- are not split apart.
        if ( baitRe.test(token) ) { return true; }
        for ( const part of token.split(/[_-]+/) ) {
            if ( part === '' ) { continue; }
            if ( baitRe.test(part) ) { return true; }
        }
    }
    return false;
};

const isBait = el => {
    if ( el instanceof Element === false ) { return false; }
    try {
        const id = el.id;
        if ( typeof id === 'string' && id !== '' ) {
            if ( hasBaitToken(id) ) { return true; }
        }
        // `className` is an SVGAnimatedString on SVG elements, so read the
        // attribute instead.
        const cl = el.getAttribute('class');
        if ( typeof cl === 'string' && cl !== '' ) {
            if ( hasBaitToken(cl) ) { return true; }
        }
        for ( const name of baitAttrs ) {
            if ( el.hasAttribute(name) ) { return true; }
        }
    } catch {
    }
    return false;
};

/******************************************************************************/

// A blocked ad slot reports zero. Report a plausible banner instead, but only
// for bait, and only when the genuine value is zero.

const FAKE_WIDTH = 300;
const FAKE_HEIGHT = 250;

const hookZeroDimension = (proto, prop, fake) => {
    try {
        const desc = Object.getOwnPropertyDescriptor(proto, prop);
        if ( desc === undefined ) { return; }
        if ( typeof desc.get !== 'function' ) { return; }
        const native = desc.get;
        const get = new Proxy(native, {
            apply(target, thisArg, args) {
                const r = Reflect.apply(target, thisArg, args);
                if ( r !== 0 ) { return r; }
                return isBait(thisArg) ? fake : r;
            },
        });
        markNative(get, native);
        Object.defineProperty(proto, prop, {
            get,
            set: desc.set,
            enumerable: desc.enumerable,
            configurable: desc.configurable,
        });
    } catch {
    }
};

hookZeroDimension(HTMLElement.prototype, 'offsetHeight', FAKE_HEIGHT);
hookZeroDimension(HTMLElement.prototype, 'offsetWidth', FAKE_WIDTH);
hookZeroDimension(Element.prototype, 'clientHeight', FAKE_HEIGHT);
hookZeroDimension(Element.prototype, 'clientWidth', FAKE_WIDTH);
hookZeroDimension(Element.prototype, 'scrollHeight', FAKE_HEIGHT);
hookZeroDimension(Element.prototype, 'scrollWidth', FAKE_WIDTH);

/******************************************************************************/

// `offsetParent === null` is the other cheap way to spot `display: none`.

try {
    const desc = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'offsetParent');
    if ( desc !== undefined && typeof desc.get === 'function' ) {
        const native = desc.get;
        const get = new Proxy(native, {
            apply(target, thisArg, args) {
                const r = Reflect.apply(target, thisArg, args);
                if ( r !== null ) { return r; }
                if ( isBait(thisArg) === false ) { return r; }
                try {
                    if ( thisArg.isConnected !== true ) { return r; }
                    return thisArg.parentElement || document.body || r;
                } catch {
                }
                return r;
            },
        });
        markNative(get, native);
        Object.defineProperty(HTMLElement.prototype, 'offsetParent', {
            get,
            set: desc.set,
            enumerable: desc.enumerable,
            configurable: desc.configurable,
        });
    }
} catch {
}

/******************************************************************************/

try {
    const native = Element.prototype.getBoundingClientRect;
    const hooked = new Proxy(native, {
        apply(target, thisArg, args) {
            const r = Reflect.apply(target, thisArg, args);
            if ( r.width !== 0 || r.height !== 0 ) { return r; }
            if ( isBait(thisArg) === false ) { return r; }
            return new DOMRect(r.x, r.y, FAKE_WIDTH, FAKE_HEIGHT);
        },
    });
    markNative(hooked, native);
    Element.prototype.getBoundingClientRect = hooked;
} catch {
}

/******************************************************************************/

// uBOL hides elements with a user-origin stylesheet, which the page cannot
// read back through `document.styleSheets` -- but it can still observe the
// outcome through `getComputedStyle()`.

const fakeStyle = new Map([
    [ 'display', 'block' ],
    [ 'visibility', 'visible' ],
    [ 'opacity', '1' ],
    [ 'height', `${FAKE_HEIGHT}px` ],
    [ 'width', `${FAKE_WIDTH}px` ],
    [ 'max-height', 'none' ],
    [ 'max-width', 'none' ],
    [ 'maxHeight', 'none' ],
    [ 'maxWidth', 'none' ],
]);

try {
    const native = self.getComputedStyle;
    const hooked = new Proxy(native, {
        apply(target, thisArg, args) {
            const style = Reflect.apply(target, thisArg, args);
            try {
                if ( style.display !== 'none' && style.visibility !== 'hidden' ) {
                    return style;
                }
                if ( isBait(args[0]) === false ) { return style; }
            } catch {
                return style;
            }
            return new Proxy(style, {
                get(target, prop) {
                    if ( typeof prop === 'string' ) {
                        if ( fakeStyle.has(prop) ) {
                            return fakeStyle.get(prop);
                        }
                        if ( prop === 'getPropertyValue' ) {
                            return function getPropertyValue(name) {
                                const key = `${name}`;
                                if ( fakeStyle.has(key) ) {
                                    return fakeStyle.get(key);
                                }
                                return target.getPropertyValue(name);
                            };
                        }
                    }
                    // Methods must be bound to the genuine declaration,
                    // otherwise the browser throws on an illegal invocation.
                    const v = Reflect.get(target, prop, target);
                    return typeof v === 'function' ? v.bind(target) : v;
                },
            });
        },
    });
    markNative(hooked, native);
    self.getComputedStyle = hooked;
} catch {
}

/******************************************************************************/

// Ad libraries set these when they manage to load. Because the network
// request has been blocked, they stay undefined, which is exactly the tell
// detection scripts look for. Only define what the page has not defined.

const defineFlag = (name, value) => {
    try {
        if ( name in self ) { return; }
        Object.defineProperty(self, name, {
            value,
            writable: true,
            enumerable: false,
            configurable: true,
        });
    } catch {
    }
};

defineFlag('canRunAds', true);
defineFlag('canShowAds', true);
defineFlag('canRunAd', true);
defineFlag('isAdBlockActive', false);
defineFlag('adBlockDetected', false);
defineFlag('adblockDetected', false);
defineFlag('adsBlocked', false);
defineFlag('adBlockEnabled', false);

/******************************************************************************/

// FuckAdBlock / BlockAdBlock / SniffAdBlock share one API surface. Provide a
// stub which always reports "no adblocker", so the page runs its happy path.

try {
    const settle = (cb, arg) => {
        if ( typeof cb !== 'function' ) { return; }
        setTimeout(( ) => { try { cb(arg); } catch {} }, 1);
    };
    function AdBlockStub() {}
    Object.assign(AdBlockStub.prototype, {
        setOption() { return this; },
        setTempOption() { return this; },
        check() { settle(this._notDetected, false); return true; },
        clearEvent() { return this; },
        debug() { return this; },
        emitEvent() { settle(this._notDetected, false); return this; },
        on(detected, cb) {
            if ( detected !== true ) {
                this._notDetected = cb;
                settle(cb, false);
            }
            return this;
        },
        onDetected() { return this; },
        onNotDetected(cb) {
            this._notDetected = cb;
            settle(cb, false);
            return this;
        },
    });
    for ( const name of [ 'FuckAdBlock', 'BlockAdBlock', 'SniffAdBlock' ] ) {
        if ( name in self ) { continue; }
        Object.defineProperty(self, name, {
            value: AdBlockStub,
            writable: true,
            enumerable: false,
            configurable: true,
        });
        const instance = name.charAt(0).toLowerCase() + name.slice(1);
        Object.defineProperty(self, instance, {
            value: new AdBlockStub(),
            writable: true,
            enumerable: false,
            configurable: true,
        });
    }
} catch {
}

/******************************************************************************/

// Detection by broken event: when a request is blocked the browser fires
// `error` where the page expected `load`, and that flipped event *is* the
// signal.
//
//   <script src="//pagead2.../ads.js" onerror="adblockDetected()">
//   fetch('/ads.js').then(ok).catch(detected)
//   xhr.addEventListener('error', detected)
//
// The measurement hooks above cannot help here: nothing is hidden, the
// request simply never arrives. So the failure has to be turned back into
// the success the page was waiting for -- but only for requests that are
// recognisably ad or tracker traffic, otherwise a page's genuine error
// handling breaks.

// Which requests are ad traffic?
//
// Three tests, tried in order. The first is a curated list of ad networks --
// unavoidably a list, in the same way filter lists are lists, and it has to
// be kept current. The Vietnamese publishers are worth calling out: nearly
// all of them run on admicro, whose loader sets `window.admerrorload` from
// the script's own `onerror` and then falls back to an alternate CDN, so
// missing that one host misses the whole detection chain on most of the
// country's news sites.
//
// The second test catches hosts that name themselves, which generalises
// past the list. It matches on whole labels so `admin.`, `adobe.` and
// `addthis.` do not qualify.
//
// The third looks at the path, for first-party ad endpoints.

const adNetworkRe = /(?:^|\.)(?:doubleclick|googlesyndication|googletagservices|googletagmanager|google-analytics|adservice\.google|fundingchoicesmessages\.google|amazon-adsystem|adnxs|adsrvr|criteo|taboola|outbrain|scorecardresearch|moatads|pubmatic|rubiconproject|openx|openxcdn|smartadserver|zedo|adroll|quantserve|sharethrough|teads|indexww|casalemedia|creativecdn|crwdcntrl|admicro|amcdn|eclick|dtadnetwork|adtima|ants|novanet)\.[a-z.]{2,8}$/i;

const adHostLabelRe = /(?:^|\.)(?:ad|ads|adv|adx|adm|adserver|adservice|adsystem|adtech|adnet|adnetwork|pagead|pagead2|securepubads|pubads|banner|banners|prebid)(?:[.-]|$)/i;

const adPathRe = /\/(?:ads?|adv|adserver|advert(?:s|ising|isement)?|adsense|adsbygoogle|banners?|pagead|prebid|popunder|sponsors?)(?:[-._/?]|$)/i;

const isAdURL = url => {
    if ( typeof url !== 'string' || url === '' ) { return false; }
    let hostname = '';
    let pathname = url;
    try {
        const parsed = new URL(url, document.baseURI);
        hostname = parsed.hostname;
        pathname = parsed.pathname + parsed.search;
    } catch {
        return adPathRe.test(url);
    }
    if ( adNetworkRe.test(hostname) ) { return true; }
    if ( adHostLabelRe.test(hostname) ) { return true; }
    return adPathRe.test(pathname);
};

const isAdResourceElement = el => {
    if ( el instanceof Element === false ) { return false; }
    const name = el.localName;
    if ( name !== 'script' && name !== 'img' && name !== 'iframe' && name !== 'link' ) {
        return false;
    }
    if ( isBait(el) ) { return true; }
    return isAdURL(el.getAttribute('src') || el.getAttribute('href') || '');
};

// Resource `error` events do not bubble, but they do travel through the
// capture phase -- which is how error-reporting libraries see them, and how
// we get ahead of the page's own handler. Stopping it during capture means
// the listener on the element itself never runs.
try {
    self.addEventListener('error', ev => {
        // Script runtime errors target the window; only resource loads are
        // ours to rewrite.
        if ( ev.target === self ) { return; }
        if ( isAdResourceElement(ev.target) === false ) { return; }
        ev.stopImmediatePropagation();
        ev.preventDefault();
        const el = ev.target;
        setTimeout(( ) => {
            try { el.dispatchEvent(new Event('load')); } catch {}
        }, 0);
    }, true);
} catch {
}

// A blocked fetch rejects with a TypeError. Hand back an empty 200 instead,
// so `.catch(detected)` never runs and `response.ok` holds.
try {
    const native = self.fetch;
    if ( typeof native === 'function' ) {
        const hooked = new Proxy(native, {
            apply(target, thisArg, args) {
                const promise = Reflect.apply(target, thisArg, args);
                let url = '';
                try {
                    const a = args[0];
                    url = typeof a === 'string'
                        ? a
                        : (a instanceof Request ? a.url : `${a}`);
                } catch {
                }
                if ( isAdURL(url) === false ) { return promise; }
                return promise.catch(reason => {
                    // Only a network-level failure looks like blocking; let
                    // aborts and programming errors through untouched.
                    if ( reason instanceof TypeError === false ) { throw reason; }
                    return new Response('', {
                        status: 200,
                        statusText: 'OK',
                        headers: { 'Content-Type': 'text/plain' },
                    });
                });
            },
        });
        markNative(hooked, native);
        self.fetch = hooked;
    }
} catch {
}

// Same story for XMLHttpRequest: a blocked request fires `error`, which the
// older detectors listen for. Convert it into a completed empty response.
//
// Suppressing that event means being the first `error` listener on the
// object, because `stopImmediatePropagation()` only stops listeners
// registered after ours -- and at the target phase, capture does not jump
// the queue, registration order decides. Hooking `send()` is already too
// late: the page has usually attached its handler between `open()` and
// `send()`. So the listener goes on at construction time, which nothing on
// the page can precede.
//
// The set of ad requests lives in a WeakSet rather than on the instance, so
// the page cannot find the flag.
try {
    const adRequests = new WeakSet();
    const nativeAddEventListener = XMLHttpRequest.prototype.addEventListener;

    const swallow = function(ev) {
        const xhr = ev.currentTarget;
        if ( adRequests.has(xhr) === false ) { return; }
        ev.stopImmediatePropagation();
        ev.preventDefault();
        // Own properties shadow the prototype getters, so the page reads a
        // completed, empty, successful request.
        try {
            Object.defineProperties(xhr, {
                readyState: { value: 4, configurable: true },
                status: { value: 200, configurable: true },
                statusText: { value: 'OK', configurable: true },
                response: { value: '', configurable: true },
                responseText: { value: '', configurable: true },
            });
        } catch {
        }
        for ( const type of [ 'readystatechange', 'load', 'loadend' ] ) {
            try { xhr.dispatchEvent(new Event(type)); } catch {}
        }
    };

    const nativeOpen = XMLHttpRequest.prototype.open;
    const hookedOpen = new Proxy(nativeOpen, {
        apply(target, thisArg, args) {
            try {
                if ( isAdURL(args[1]) ) {
                    adRequests.add(thisArg);
                } else {
                    adRequests.delete(thisArg);
                }
            } catch {
            }
            return Reflect.apply(target, thisArg, args);
        },
    });
    markNative(hookedOpen, nativeOpen);
    XMLHttpRequest.prototype.open = hookedOpen;

    const NativeXHR = self.XMLHttpRequest;
    const HookedXHR = new Proxy(NativeXHR, {
        construct(target, args, newTarget) {
            const xhr = Reflect.construct(target, args, newTarget);
            try {
                nativeAddEventListener.call(xhr, 'error', swallow, true);
            } catch {
            }
            return xhr;
        },
    });
    markNative(HookedXHR, NativeXHR);
    self.XMLHttpRequest = HookedXHR;
} catch {
}

/******************************************************************************/

// BlockAdblock ships an obfuscated payload through `eval()`. Same signature
// matching as uBO's `prevent-bab` scriptlet.

try {
    const signatures = [
        [ 'blockadblock' ],
        [ 'babasbm' ],
        [ /getItem\('babn'\)/ ],
        [
            'getElementById',
            'String.fromCharCode',
            'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789',
            'charAt',
            'DOMContentLoaded',
            'AdBlock',
            'addEventListener',
            'doScroll',
            'fromCharCode',
            '<<2|r>>4',
            'sessionStorage',
            'clientWidth',
            'localStorage',
            'Math',
            'random',
        ],
    ];
    const isBab = s => {
        if ( typeof s !== 'string' ) { return false; }
        for ( const tokens of signatures ) {
            let match = 0;
            for ( const token of tokens ) {
                const hit = token instanceof RegExp ? token.test(s) : s.includes(token);
                if ( hit ) { match += 1; }
            }
            if ( (match / tokens.length) >= 0.8 ) { return true; }
        }
        return false;
    };
    const nativeEval = self.eval;
    const hookedEval = new Proxy(nativeEval, {
        apply(target, thisArg, args) {
            if ( isBab(args[0]) === false ) {
                return Reflect.apply(target, thisArg, args);
            }
            try {
                if ( document.body ) {
                    document.body.style.removeProperty('visibility');
                }
                const el = document.getElementById('babasbmsgx');
                if ( el ) { el.remove(); }
            } catch {
            }
        },
    });
    markNative(hookedEval, nativeEval);
    self.eval = hookedEval;

    const nativeSetTimeout = self.setTimeout;
    const hookedSetTimeout = new Proxy(nativeSetTimeout, {
        apply(target, thisArg, args) {
            if ( typeof args[0] === 'string' && /\.bab_elementid.$/.test(args[0]) ) {
                args[0] = ( ) => {};
            }
            return Reflect.apply(target, thisArg, args);
        },
    });
    markNative(hookedSetTimeout, nativeSetTimeout);
    self.setTimeout = hookedSetTimeout;
} catch {
}

/******************************************************************************/

})();

void 0;
