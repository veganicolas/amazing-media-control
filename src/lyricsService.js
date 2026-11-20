import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Soup from 'gi://Soup?version=3.0';

import { gioAsync } from './asyncUtils.js';
import { setBoundedCache } from './iconUtils.js';
import {
    normalizeComparableText,
    stripTitleNoise,
    stripTopicSuffix,
} from './playerUtils.js';

const US_PER_SECOND = 1_000_000;
const API_URL = 'https://lrclib.net/api';
const DURATION_TOLERANCE_S = 10;
const MAX_FILE_BYTES = 512 * 1024;
const MAX_CACHE = 64;

const TIME_TAGS = /^(?:\[\d{1,3}:\d{1,2}(?:[.:]\d{1,3})?\])+/;
const TIME_TAG = /\[(\d{1,3}):(\d{1,2})(?:[.:](\d{1,3}))?\]/g;
const WORD_TAG = /<\d{1,3}:\d{1,2}(?:[.:]\d{1,3})?>/g;
const ID_TAG = /^\[(?:ar|al|ti|au|by|la|lang|length|re|tool|ve|version|id|#)\s*:[^\]]*\]$/i;
const OFFSET_TAG = /^\[offset\s*:\s*([+-]?\d+)\s*\]$/i;

const VIDEO_TITLE = /^(.+?)\s[-–—]\s(.+)$/;

function tagTimeUs([, minutes, seconds, fraction = '']) {
    const millis = Number(fraction.padEnd(3, '0').slice(0, 3));
    return ((Number(minutes) * 60 + Number(seconds)) * 1000 + millis) * 1000;
}

function parseLyrics(text) {
    if (!text?.trim())
        return null;

    const timed = new Map();
    const plain = [];
    let offsetUs = 0;

    for (const raw of text.split(/\r\n|\r|\n/)) {
        const line = raw.trim();
        const offsetMatch = OFFSET_TAG.exec(line);
        if (offsetMatch) {
            offsetUs = Number(offsetMatch[1]) * 1000;
            continue;
        }
        if (ID_TAG.test(line))
            continue;

        const tags = TIME_TAGS.exec(line)?.[0] ?? '';
        const words = line.slice(tags.length).replace(WORD_TAG, '').trim();
        if (!tags) {
            plain.push(words);
            continue;
        }

        for (const tag of tags.matchAll(TIME_TAG)) {
            const t = tagTimeUs(tag);
            const prev = timed.get(t);
            timed.set(t, prev ? [prev, words].filter(Boolean).join('\n') : words);
        }
    }

    if (timed.size > 0) {
        const adjusted = new Map();
        for (const [time, words] of [...timed].sort((a, b) => a[0] - b[0])) {
            const clampedTime = Math.max(0, time - offsetUs);
            const prev = adjusted.get(clampedTime);
            adjusted.set(clampedTime, prev ? [prev, words].filter(Boolean).join('\n') : words);
        }
        const lines = [...adjusted].map(([time, words]) => ({ time, text: words }));
        return lines.some(l => l.text) ? { synced: true, instrumental: false, lines } : null;
    }

    const lines = [];
    for (const words of plain) {
        if (words || lines.at(-1)?.text)
            lines.push({ time: null, text: words });
    }
    if (lines.at(-1)?.text === '')
        lines.pop();

    return lines.length > 0 ? { synced: false, instrumental: false, lines } : null;
}

function preferred(...candidates) {
    return candidates.find(l => l?.synced) ?? candidates.find(Boolean) ?? null;
}

function isClose(record, durationSec) {
    return !durationSec || Math.abs((record.duration ?? 0) - durationSec) <= DURATION_TOLERANCE_S;
}

function pickRecord(records, durationSec, trackName) {
    const wantedRaw = normalizeComparableText(trackName);
    const wanted = normalizeComparableText(stripTitleNoise(trackName)) || wantedRaw;
    let best = null;
    let bestScore = 0;

    for (const record of Array.isArray(records) ? records : []) {
        if (!record?.syncedLyrics && !record?.plainLyrics && !record?.instrumental)
            continue;

        const candRaw = normalizeComparableText(record.trackName ?? '');
        const candClean = normalizeComparableText(stripTitleNoise(record.trackName ?? '')) || candRaw;

        const exactTitle = Boolean(
            wanted && (candRaw === wantedRaw || candRaw === wanted || candClean === wanted)
        );
        const containsTitle = Boolean(
            wanted && !exactTitle && candRaw && (
                candRaw.includes(wanted) ||
                candClean.includes(wanted) ||
                (candClean.length >= 4 && wanted.includes(candClean))
            )
        );

        if (wanted && !exactTitle && !containsTitle)
            continue;

        const titleScore = exactTitle ? 4 : (containsTitle ? 2 : 0);
        const durationScore = (durationSec > 0 && isClose(record, durationSec)) ? 2 : 0;
        const fit = titleScore + durationScore;
        const score = fit > 0 ? fit + (record.syncedLyrics ? 1 : 0) : 0;
        if (score > bestScore) {
            best = record;
            bestScore = score;
        }
    }
    return best;
}

function fromRecord(record, durationSec) {
    if (!record)
        return null;
    if (record.instrumental)
        return { synced: false, instrumental: true, lines: [] };
    return (isClose(record, durationSec) && parseLyrics(record.syncedLyrics)) ||
        parseLyrics(record.plainLyrics);
}

/**
 * Resolves synced or plain lyrics from MPRIS embedded text, local `.lrc` files
 * beside local audio files, or LRCLIB (`lrclib.net`).
 */
export class LyricsService {
    constructor(userAgent = 'AmazingMediaControl/1.0') {
        this._session = new Soup.Session({ timeout: 12, user_agent: userAgent });
        this._cancellable = new Gio.Cancellable();
        this._cache = new Map();
        this._pending = new Map();
        this._destroyed = false;
    }

    async lookup(track, online = true) {
        if (this._destroyed || this._cancellable.is_cancelled())
            return null;

        const fromPlayer = parseLyrics(track.lyrics);
        const fromFile = fromPlayer?.synced ? null : await this._readLocalLrc(track.url);
        if (this._destroyed || this._cancellable.is_cancelled())
            return null;

        const local = preferred(fromPlayer, fromFile);
        if (local?.synced || !online)
            return local;

        try {
            return preferred(local, await this._remote(track));
        } catch (e) {
            if (local)
                return local;
            throw e;
        }
    }

    async _readLocalLrc(url) {
        if (this._destroyed || !url?.startsWith('file://') || this._cancellable.is_cancelled())
            return null;

        try {
            const trackFile = Gio.File.new_for_uri(url);
            const baseName = trackFile.get_basename();
            if (!baseName)
                return null;
            const stem = baseName.replace(/\.[^.]*$/, '');
            if (!stem)
                return null;
            const lrcFile = trackFile.get_parent()?.get_child(`${stem}.lrc`);
            if (!lrcFile)
                return null;

            const info = await gioAsync(
                lrcFile,
                'query_info',
                Gio.FILE_ATTRIBUTE_STANDARD_SIZE,
                Gio.FileQueryInfoFlags.NONE,
                GLib.PRIORITY_DEFAULT,
                this._cancellable
            );
            if (info.get_size() > MAX_FILE_BYTES)
                return null;
            const [, contents] = await gioAsync(lrcFile, 'load_contents', this._cancellable);
            return parseLyrics(new TextDecoder('utf-8').decode(contents));
        } catch {
            return null;
        }
    }

    _remote(track) {
        if (this._destroyed || this._cancellable.is_cancelled())
            return Promise.resolve(null);

        const durationSec = Math.round((track.lengthUs || 0) / US_PER_SECOND);
        const key = JSON.stringify([track.title, track.artist, track.album, durationSec]);

        if (this._cache.has(key)) {
            const hit = this._cache.get(key);
            setBoundedCache(this._cache, key, hit, MAX_CACHE);
            return Promise.resolve(hit);
        }

        if (!this._pending.has(key)) {
            this._pending.set(
                key,
                this._search(track, durationSec).then(lyrics => {
                    if (!this._destroyed && !this._cancellable.is_cancelled())
                        setBoundedCache(this._cache, key, lyrics, MAX_CACHE);
                    return lyrics;
                }).finally(() => this._pending.delete(key))
            );
        }
        return this._pending.get(key);
    }

    async _search(track, durationSec) {
        const title = stripTitleNoise(track.title || '');
        const artist = stripTopicSuffix(track.artist || '');
        if (!title)
            return null;

        let failure = null;
        const ask = async (endpoint, params) => {
            try {
                return await this._request(endpoint, params);
            } catch (e) {
                if (e.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED))
                    throw e;
                failure ??= e;
                return null;
            }
        };

        const search = async (name, by = '') => {
            const records = await ask('search', { track_name: name, artist_name: by });
            return fromRecord(pickRecord(records, durationSec, name), durationSec);
        };

        let lyrics = null;
        if (artist) {
            lyrics = fromRecord(await ask('get', {
                track_name: title,
                artist_name: artist,
                album_name: track.album || '',
                duration: durationSec || undefined,
            }), durationSec);
            if (!lyrics?.synced && !lyrics?.instrumental)
                lyrics = preferred(lyrics, await search(title, artist));
        }

        const [, named, song] = title.match(VIDEO_TITLE) ?? [];
        if (!lyrics?.synced && !lyrics?.instrumental && named && song)
            lyrics = preferred(lyrics, await search(song.trim(), named.trim()));

        if (!artist && !lyrics?.synced && !lyrics?.instrumental)
            lyrics = preferred(lyrics, await search(title));

        if (!lyrics && failure)
            throw failure;
        return lyrics;
    }

    async _request(endpoint, params) {
        if (!this._session)
            throw new GLib.Error(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED, 'Destroyed');
        this._cancellable.set_error_if_cancelled();

        const query = Object.entries(params)
            .filter(([, v]) => v !== undefined && v !== '')
            .map(([k, v]) => `${k}=${encodeURIComponent(v)}`)
            .join('&');
        const msg = Soup.Message.new('GET', `${API_URL}/${endpoint}?${query}`);
        const bytes = await gioAsync(
            this._session,
            'send_and_read',
            msg,
            GLib.PRIORITY_DEFAULT,
            this._cancellable
        );

        const status = msg.get_status();
        if (status === Soup.Status.NOT_FOUND)
            return null;
        if (status !== Soup.Status.OK)
            throw new Error(`LRCLIB returned HTTP ${status}`);
        return JSON.parse(new TextDecoder().decode(bytes.toArray()));
    }

    destroy() {
        if (this._destroyed)
            return;
        this._destroyed = true;
        this._cancellable?.cancel();
        this._session?.abort();
        this._session = null;
        this._pending.clear();
        this._cache.clear();
    }
}
