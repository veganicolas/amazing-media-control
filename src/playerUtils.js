import Shell from 'gi://Shell';

const BROWSER_IDENTIFIERS = [
    'firefox',
    'chromium',
    'chrome',
    'google-chrome',
    'brave',
    'vivaldi',
    'edge',
    'microsoft-edge',
    'opera',
    'zen',
    'librewolf',
    'floorp',
    'epiphany',
    'waterfox',
    'thorium',
    'ungoogled-chromium',
];

const BROWSER_PATTERNS = BROWSER_IDENTIFIERS.map(
    id => new RegExp(`(?:^|[\\s._/-])${id}(?:$|[\\s._/-])`, 'i')
);

const MPRIS_BUS_PREFIX = 'org.mpris.MediaPlayer2.';

function stripMprisBusPrefix(busName) {
    if (!busName || typeof busName !== 'string')
        return '';
    return busName.startsWith(MPRIS_BUS_PREFIX)
        ? busName.slice(MPRIS_BUS_PREFIX.length)
        : busName;
}

export const GENERIC_PLAYER_TOKENS = new Set([
    'music', 'media', 'player', 'mediaplayer', 'audio', 'video', 'sound',
    'browser', 'web', 'stream', 'radio', 'podcast',
    'mozilla', 'gnu', 'org', 'com', 'io', 'net', 'app', 'desktop', 'bin',
]);

export const KNOWN_PLAYER_ALIASES = [
    ['zen', ['app.zen_browser.zen', 'io.github.zen_browser.zen', 'zen-browser', 'zen_browser', 'zen-bin', 'zen-alpha', 'zen-twilight', 'zen']],
    ['librewolf', ['io.gitlab.librewolf-community', 'librewolf']],
    ['floorp', ['one.ablaze.floorp', 'floorp']],
    ['waterfox', ['net.waterfox.waterfox', 'waterfox']],
    ['thorium', ['thorium-browser', 'thorium']],
    ['brave', ['brave-browser', 'com.brave.Browser', 'brave_brave']],
    ['edge', ['microsoft-edge', 'com.microsoft.Edge']],
    ['opera', ['opera', 'opera_opera']],
    ['vivaldi', ['vivaldi-stable', 'vivaldi']],
    ['firefox', ['firefox', 'firefox-esr', 'org.mozilla.firefox', 'firefox_firefox']],
    ['chrome', ['google-chrome', 'com.google.Chrome', 'chromium', 'chromium-browser']],
    ['chromium', ['chromium', 'chromium-browser', 'chromium_chromium', 'org.chromium.Chromium', 'google-chrome']],
    ['spotify', ['com.spotify.Client', 'spotify', 'spotify_spotify']],
    ['vlc', ['vlc', 'org.videolan.VLC']],
    ['mpv', ['mpv', 'io.mpv.Mpv']],
    ['rhythmbox', ['org.gnome.Rhythmbox3', 'rhythmbox']],
    ['totem', ['org.gnome.Totem', 'totem']],
];

const TITLE_NOISE_PATTERNS = [
    /\s*[([][^)\]]*\b(?:feat|ft|featuring|official|video|audio|lyrics?|visuali[sz]er|remaster(?:ed)?|explicit|hd|4k)\b[^)\]]*[)\]]/gi,
    /\s+[-–—]\s+[^-–—]*\b(?:remaster(?:ed)?|radio edit|single version|mono|stereo)\b[^-–—]*$/i,
];

function isBrowserIdentity(text) {
    if (!text || typeof text !== 'string')
        return false;
    return BROWSER_PATTERNS.some(rx => rx.test(text));
}

export function getPlayerIdentityString(player) {
    if (!player)
        return '';
    const busSuffix = stripMprisBusPrefix(player.busName || player.busSuffix);
    return [
        busSuffix,
        player.appSlug,
        player.desktopEntry,
        player.identity,
    ]
        .filter(Boolean)
        .join(' ')
        .toLowerCase();
}

export function isLikelyBrowserPlayer(player) {
    if (!player)
        return false;
    return isBrowserIdentity(getPlayerIdentityString(player));
}

export function comparePlayersByActivity(a, b) {
    if (a.isPlaying !== b.isPlaying)
        return a.isPlaying ? -1 : 1;
    if (a.isActive !== b.isActive)
        return a.isActive ? -1 : 1;
    return (b.lastActiveUs || 0) - (a.lastActiveUs || 0);
}

export function tokenizePlayerIdentity(text) {
    return (text || '')
        .toLowerCase()
        .split(/[^a-z0-9]+/)
        .filter(tok => tok.length >= 2 && !GENERIC_PLAYER_TOKENS.has(tok) && !tok.startsWith('instance'));
}

function getWindowActors() {
    if (typeof global === 'undefined')
        return [];
    return global.compositor?.get_window_actors?.() ?? global.get_window_actors?.() ?? [];
}

export function normalizeComparableText(text) {
    if (!text || typeof text !== 'string')
        return '';
    return text
        .normalize('NFKD')
        .replace(/\p{M}/gu, '')
        .toLowerCase()
        .replace(/[^\p{L}\p{N}]+/gu, ' ')
        .trim();
}

export function stripTopicSuffix(artist) {
    if (!artist || typeof artist !== 'string')
        return '';
    return artist.replace(/\s+[-–—]\s+topic$/i, '').trim();
}

export function stripTitleNoise(title) {
    if (!title || typeof title !== 'string')
        return '';
    return TITLE_NOISE_PATTERNS.reduce((s, rx) => s.replace(rx, ''), title).trim() || title.trim();
}

/**
 * Strip redundant `<Artist>` prefix or suffix from track/video titles
 * (e.g. "In the End - Linkin Park" when artist is already "Linkin Park").
 *
 * @param {string} title
 * @param {string} artist
 * @returns {string}
 */
export function stripArtistFromTitle(title, artist) {
    const cleanTitle = (title || '').trim();
    const cleanArtist = (artist || '').trim();
    if (!cleanTitle || !cleanArtist)
        return cleanTitle;

    const candidates = new Set();
    const addCandidate = raw => {
        const norm = normalizeComparableText(raw);
        if (norm.length >= 2)
            candidates.add(norm);
    };

    addCandidate(cleanArtist);
    addCandidate(stripTopicSuffix(cleanArtist));
    addCandidate(cleanArtist.replace(/\s+(?:official|music)$/i, ''));
    const primaryArtist = cleanArtist.split(/\s*[,;&]\s*|\s+(?:feat\.?|ft\.?|x)\s+/i)[0];
    if (primaryArtist)
        addCandidate(primaryArtist);

    const matchesArtist = segment => candidates.has(normalizeComparableText(segment));

    const matchBracketedTail = segment => {
        const m = segment.match(/^(.+?)\s+((?:[([][^)\]]*[)\]]\s*)+)$/);
        if (!m)
            return null;
        return matchesArtist(m[1]) ? m[2].trim() : null;
    };

    let current = cleanTitle;

    const prefixMatch = current.match(/^(.+?)(?:\s+[-–—|]\s+|:\s+)(.+)$/);
    if (prefixMatch && matchesArtist(prefixMatch[1]) && prefixMatch[2].trim())
        current = prefixMatch[2].trim();

    let lastSep = null;
    for (const match of current.matchAll(/\s+[-–—|]\s+/g))
        lastSep = match;

    if (lastSep) {
        const head = current.slice(0, lastSep.index).trim();
        const tail = current.slice(lastSep.index + lastSep[0].length).trim();
        if (head && !/^\d+$/.test(head)) {
            if (matchesArtist(tail)) {
                current = head;
            } else {
                const keptTags = matchBracketedTail(tail);
                if (keptTags)
                    current = `${head} ${keptTags}`.trim();
            }
        }
    }

    return current || cleanTitle;
}

function buildPlayerWindowHints(player) {
    const busSuffix = stripMprisBusPrefix(player?.busName || player?.busSuffix)
        .trim()
        .toLowerCase()
        .replace(/\.instance.*$/, '');
    const slug = (player?.appSlug || '').trim().toLowerCase();
    const desktopEntry = (player?.desktopEntry || '').trim().toLowerCase().replace(/\.desktop$/, '');
    const identity = (player?.identity || '').trim().toLowerCase();

    const hints = new Set();
    const addHint = val => {
        const clean = (val || '').trim().toLowerCase();
        if (clean.length >= 2 && !GENERIC_PLAYER_TOKENS.has(clean))
            hints.add(clean);
    };

    addHint(busSuffix);
    addHint(slug);
    addHint(desktopEntry);
    addHint(identity);
    const combined = `${busSuffix} ${slug} ${desktopEntry} ${identity}`;
    for (const tok of tokenizePlayerIdentity(combined))
        addHint(tok);

    for (const [key, aliases] of KNOWN_PLAYER_ALIASES) {
        if (combined.includes(key)) {
            addHint(key);
            for (const alias of aliases)
                addHint(alias.toLowerCase().replace(/\.desktop$/, ''));
        }
    }

    return [...hints];
}

function windowTitleMatchesCandidates(winTitle, lowerWinTitle, candidates, minTitleLength) {
    if (!winTitle || candidates.length === 0)
        return false;
    let normWin = null;
    for (const { lower, norm } of candidates) {
        if (lower.length >= minTitleLength && lowerWinTitle.includes(lower))
            return true;
        if (norm.length >= minTitleLength) {
            normWin ??= normalizeComparableText(winTitle);
            if (normWin.includes(norm))
                return true;
        }
    }
    return false;
}

/**
 * Find open GNOME Shell windows matching a player's application identity and/or track title.
 *
 * @param {object} player
 * @param {object} [options]
 * @param {boolean} [options.includeTitleFallback=false]
 * @param {number} [options.minTitleLength=3]
 * @returns {Array<{metaWin: object, app: object|null, title: string, lowerTitle: string, appMatches: boolean, titleMatches: boolean}>}
 */
export function matchPlayerWindows(player, {
    includeTitleFallback = false,
    minTitleLength = 3,
} = {}) {
    if (!player)
        return [];

    const tracker = Shell.WindowTracker?.get_default?.() ?? null;
    const hints = buildPlayerWindowHints(player);

    const rawCandidates = [
        player.metadata?.rawTitle || '',
        player.metadata?.title || '',
        player.trackTitle || '',
    ].filter(Boolean);
    const seenCandidates = new Set();
    const titleCandidates = [];
    for (const raw of rawCandidates) {
        const lower = raw.trim().toLowerCase();
        if (!lower || seenCandidates.has(lower))
            continue;
        seenCandidates.add(lower);
        titleCandidates.push({
            lower,
            norm: normalizeComparableText(raw),
        });
    }

    const results = [];
    for (const actor of getWindowActors()) {
        const metaWin = actor.get_meta_window?.();
        if (!metaWin)
            continue;

        const app = tracker?.get_window_app?.(metaWin) ?? null;
        const appId = (app?.get_id?.() || '').toLowerCase();
        const appName = (app?.get_name?.() || '').toLowerCase();
        const wmClass = (metaWin.get_wm_class?.() || '').toLowerCase();
        const wmInstance = (metaWin.get_wm_class_instance?.() || '').toLowerCase();
        const winIdentity = `${appId} ${appName} ${wmClass} ${wmInstance}`;

        const appMatches = hints.length > 0 && hints.some(h => winIdentity.includes(h));
        const title = metaWin.get_title?.() || '';
        const lowerTitle = title.toLowerCase();
        const titleMatches = windowTitleMatchesCandidates(
            title,
            lowerTitle,
            titleCandidates,
            minTitleLength
        );

        if (appMatches || (includeTitleFallback && titleMatches)) {
            results.push({
                metaWin,
                app,
                title,
                lowerTitle,
                appMatches,
                titleMatches,
            });
        }
    }

    return results;
}
