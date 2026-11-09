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

// Skips sponsor segments in YouTube videos. Runs in the ISOLATED world: it
// reads and sets the video element's currentTime, which works from here, and
// leaves the page's own JavaScript untouched.

(( ) => {

/******************************************************************************/

if ( self.wrenSponsorBlock ) { return; }
self.wrenSponsorBlock = true;

const runtime = (self.browser || self.chrome).runtime;
const i18n = (self.browser || self.chrome).i18n;

// A segment marked against a different cut of the video -- re-uploaded,
// trimmed -- would skip the wrong span. SponsorBlock records the duration the
// segment was marked on; if it disagrees with this video by more than this,
// the segment is ignored rather than trusted.
const DURATION_TOLERANCE = 2;

// Do not bother seeking for the last fraction of a second of a segment.
const END_SLACK = 0.3;

let videoId = null;
let segments = [];
const handled = new Set();

/******************************************************************************/

const videoIdFromURL = ( ) => {
    try {
        const url = new URL(location.href);
        if ( url.pathname === '/watch' ) {
            const v = url.searchParams.get('v');
            return v && /^[\w-]{11}$/.test(v) ? v : null;
        }
        const m = /^\/(?:shorts|embed|live|v)\/([\w-]{11})(?:[/?#]|$)/.exec(url.pathname);
        return m ? m[1] : null;
    } catch {
    }
    return null;
};

const load = ( ) => {
    const id = videoIdFromURL();
    if ( id === videoId ) { return; }
    videoId = id;
    segments = [];
    handled.clear();
    hideToast();
    if ( id === null ) { return; }
    runtime.sendMessage({ what: 'sponsorSegments', videoId: id }).then(result => {
        // The user may have moved on while the answer was in flight.
        if ( id !== videoId || Array.isArray(result) === false ) { return; }
        segments = result;
    }).catch(( ) => {
    });
};

/******************************************************************************/

// Only the video the user is watching. While YouTube is playing one of its
// own ads in the same element, its clock is the ad's, not the video's.
const isMainVideo = video => {
    if ( video instanceof HTMLVideoElement === false ) { return false; }
    const player = video.closest('#movie_player, .html5-video-player');
    if ( player === null ) { return false; }
    return player.classList.contains('ad-showing') === false;
};

const onTimeUpdate = ev => {
    if ( segments.length === 0 ) { return; }
    const video = ev.target;
    if ( isMainVideo(video) === false ) { return; }
    const t = video.currentTime;
    const duration = video.duration;
    for ( const seg of segments ) {
        if ( handled.has(seg.uuid) ) { continue; }
        if ( t < seg.start || t >= seg.end - END_SLACK ) { continue; }
        if ( seg.videoDuration > 0 && Number.isFinite(duration) ) {
            if ( Math.abs(seg.videoDuration - duration) > DURATION_TOLERANCE ) {
                handled.add(seg.uuid);
                continue;
            }
        }
        // Mark it handled whether or not the user later undoes the skip:
        // seeking back into a segment is a choice to watch it.
        handled.add(seg.uuid);
        video.currentTime = Math.min(seg.end, Number.isFinite(duration) ? duration : seg.end);
        showToast(video, seg);
        break;
    }
};

/******************************************************************************/

// A small notice with an undo, in a closed shadow root so the page's styles
// cannot reach it and its scripts cannot find it by query.

let toastHost = null;
let toastTimer;

const hideToast = ( ) => {
    clearTimeout(toastTimer);
    if ( toastHost !== null ) {
        toastHost.remove();
        toastHost = null;
    }
};

const label = (key, fallback) => {
    try { return i18n.getMessage(key) || fallback; } catch { return fallback; }
};

const showToast = (video, seg) => {
    hideToast();
    const player = video.closest('#movie_player, .html5-video-player') || document.body;
    if ( player === null ) { return; }
    toastHost = document.createElement('div');
    const root = toastHost.attachShadow({ mode: 'closed' });
    const category = label(`sponsorBlockCategory_${seg.category}`, seg.category);
    // Built node by node, never through innerHTML: YouTube enforces Trusted
    // Types, under which assigning a string to innerHTML throws.
    const style = document.createElement('style');
    style.textContent = `
:host { all: initial; }
div {
  position: absolute; left: 12px; bottom: 64px; z-index: 2147483647;
  display: flex; align-items: center; gap: 10px;
  padding: 8px 10px 8px 12px; border-radius: 8px;
  background: rgba(20, 20, 20, .88); color: #fff;
  font: 500 13px/1.3 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
}
button {
  all: unset; cursor: pointer; padding: 4px 8px; border-radius: 6px;
  background: rgba(255, 255, 255, .16); font-weight: 600;
}
button:hover { background: rgba(255, 255, 255, .26); }`;
    const box = document.createElement('div');
    box.setAttribute('role', 'status');
    const text = document.createElement('span');
    text.textContent = label('sponsorBlockSkipped', 'Skipped:') + ' ' + category;
    const undo = document.createElement('button');
    undo.type = 'button';
    undo.textContent = label('sponsorBlockUndo', 'Undo');
    box.append(text, undo);
    root.append(style, box);
    undo.addEventListener('click', ev => {
        ev.stopPropagation();
        video.currentTime = seg.start;
        hideToast();
    });
    player.append(toastHost);
    toastTimer = setTimeout(hideToast, 5000);
};

/******************************************************************************/

// Media events do not bubble, but they do pass through the capture phase on
// the document, which also covers YouTube swapping the video element out.
document.addEventListener('timeupdate', onTimeUpdate, true);
document.addEventListener('loadedmetadata', load, true);

// YouTube navigates without reloading the page.
document.addEventListener('yt-navigate-finish', load);
self.addEventListener('popstate', load);
// A fallback for navigations the events above miss; reading location.href
// once a second costs nothing.
setInterval(( ) => {
    if ( videoIdFromURL() !== videoId ) { load(); }
}, 1000);

load();

/******************************************************************************/

})();

void 0;
