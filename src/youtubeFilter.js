import {
    comparePlayersByActivity,
    getPlayerIdentityString,
    isLikelyBrowserPlayer,
    matchPlayerWindows,
} from './playerUtils.js';

const YOUTUBE_ART_HOSTS = [
    'i.ytimg.com',
    'i9.ytimg.com',
    's.ytimg.com',
    'img.youtube.com',
    'yt3.ggpht.com',
    'yt3.googleusercontent.com',
];

const YT_MUSIC_ART_HOSTS = [
    'lh3.googleusercontent.com',
];

/**
 * Safely extract lowercase hostname from a URL string.
 *
 * @param {string} rawUrl
 * @returns {string}
 */
function extractHostname(rawUrl) {
    if (!rawUrl || typeof rawUrl !== 'string')
        return '';
    const match = rawUrl.match(/^https?:\/\/([^/:?#]+)/i);
    return match ? match[1].toLowerCase() : '';
}

/**
 * Determine whether an MprisPlayer originates from a web browser.
 *
 * @param {import('./mprisManager.js').MprisPlayer} player
 * @returns {boolean}
 */
function isBrowserPlayer(player) {
    return isLikelyBrowserPlayer(player);
}

function isYtMusicWindowTitle(lowerTitle) {
    return lowerTitle.includes('youtube music');
}

function isYtWindowTitle(lowerTitle) {
    if (isYtMusicWindowTitle(lowerTitle))
        return false;
    return (
        lowerTitle.endsWith('- youtube') ||
        lowerTitle.includes(' - youtube —') ||
        lowerTitle.includes(' - youtube -') ||
        lowerTitle.includes(' - youtube |')
    );
}

function inspectBrowserYouTubeWindows(player) {
    const cleanTitle = (player?.metadata?.title || '').trim();
    const rawTitle = (player?.metadata?.rawTitle || '').trim();
    const hasTrackTitle = cleanTitle.length >= 3 || rawTitle.length >= 3;

    const matches = matchPlayerWindows(player, {
        includeTitleFallback: false,
        minTitleLength: 3,
    });

    let matchedYtWindow = false;
    let matchedYtMusicWindow = false;
    let anyYtMusicWindow = false;

    for (const m of matches) {
        if (!m.title)
            continue;

        const lowerTitle = m.lowerTitle;
        const isYtMusic = isYtMusicWindowTitle(lowerTitle);
        const isYt = isYtWindowTitle(lowerTitle) ||
            (!isYtMusic && m.titleMatches && lowerTitle.includes('youtube'));

        if (isYtMusic)
            anyYtMusicWindow = true;

        if (hasTrackTitle && !m.titleMatches)
            continue;
        if (isYtMusic)
            matchedYtMusicWindow = true;
        else if (isYt)
            matchedYtWindow = true;
    }

    return {
        matchedYtWindow,
        matchedYtMusicWindow,
        anyYtMusicWindow,
    };
}

/**
 * Multi-signal native YouTube detector for browser MPRIS sources.
 *
 * Checks:
 *  1. `xesam:url` (available in Firefox / Plasma Integration / some wrappers)
 *  2. GNOME Shell browser window title for YouTube Music exclusion when `!includeYtMusic`
 *  3. `mpris:artUrl` (YouTube thumbnail CDN hosts)
 *  4. GNOME Shell browser window title (`- YouTube` / `YouTube Music`)
 *
 * @param {import('./mprisManager.js').MprisPlayer} player
 * @param {boolean} includeYtMusic
 * @returns {boolean}
 */
function isYouTubePlayback(player, includeYtMusic = true) {
    if (!player)
        return false;

    const rawUrl = (player.metadata?.url || '').toLowerCase();
    const urlHost = extractHostname(rawUrl);
    if (urlHost) {
        if (urlHost === 'music.youtube.com' || /(?:^|\/\/|\.)music\.youtube\.com(?:\/|$)/i.test(rawUrl))
            return Boolean(includeYtMusic);
        if (
            urlHost === 'youtube.com' ||
            urlHost.endsWith('.youtube.com') ||
            urlHost === 'youtu.be'
        ) {
            return true;
        }
        // Explicit non-YouTube URL provided by browser -> reject immediately
        return false;
    }

    const winInfo = inspectBrowserYouTubeWindows(player);
    if (!includeYtMusic && (winInfo.matchedYtMusicWindow || (winInfo.anyYtMusicWindow && !winInfo.matchedYtWindow)))
        return false;

    const artHost = extractHostname(player.metadata?.artUrl);
    if (artHost) {
        if (YOUTUBE_ART_HOSTS.some(h => artHost === h || artHost.endsWith(`.${h}`)))
            return true;
        if (includeYtMusic && YT_MUSIC_ART_HOSTS.some(h => artHost === h || artHost.endsWith(`.${h}`)))
            return true;
    }

    return winInfo.matchedYtWindow || Boolean(includeYtMusic && winInfo.matchedYtMusicWindow);
}

function parseTermList(raw) {
    if (!raw || typeof raw !== 'string')
        return [];
    return raw
        .split(/[\n,;]+/)
        .map(s => s.trim().toLowerCase())
        .filter(Boolean);
}

function playerMatchesTerm(player, term) {
    return getPlayerIdentityString(player).includes(term);
}

function priorityIndex(player, priorityTerms) {
    for (let i = 0; i < priorityTerms.length; i++) {
        if (playerMatchesTerm(player, priorityTerms[i]))
            return i;
    }
    return Number.MAX_SAFE_INTEGER;
}

/**
 * Filter and prioritize MPRIS players according to source preferences:
 * - ignoredPlayers blacklist
 * - hideAllBrowsers
 * - browserYoutubeOnly / includeYoutubeMusic
 * - priorityPlayers ordering (keeping active playing state primary unless tied)
 *
 * @param {import('./mprisManager.js').MprisPlayer[]} players
 * @param {object} options
 * @returns {import('./mprisManager.js').MprisPlayer[]}
 */
export function filterEligiblePlayers(players, options) {
    const {
        hideAllBrowsers = false,
        browserYoutubeOnly = false,
        includeYoutubeMusic = true,
        ignoredPlayers = '',
        priorityPlayers = '',
    } = options || {};

    const ignoredTerms = parseTermList(ignoredPlayers);
    const priorityTerms = parseTermList(priorityPlayers);

    const filtered = players.filter(player => {
        if (ignoredTerms.some(term => playerMatchesTerm(player, term)))
            return false;

        if (isBrowserPlayer(player)) {
            if (hideAllBrowsers)
                return false;
            if (browserYoutubeOnly)
                return isYouTubePlayback(player, includeYoutubeMusic);
        }
        return true;
    });

    if (priorityTerms.length === 0 || filtered.length <= 1)
        return filtered;

    return [...filtered].sort((a, b) => {
        if (a.isPlaying !== b.isPlaying)
            return a.isPlaying ? -1 : 1;
        if (a.isActive !== b.isActive)
            return a.isActive ? -1 : 1;

        const aPrio = priorityIndex(a, priorityTerms);
        const bPrio = priorityIndex(b, priorityTerms);
        if (aPrio !== bPrio)
            return aPrio - bPrio;

        return comparePlayersByActivity(a, b);
    });
}
