import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Soup from 'gi://Soup?version=3.0';

import {
    createLinkedCancellable,
    decodePixbufFromBytesAsync,
    decodePixbufFromFileAsync,
    ensureDirAsync,
    fileExistsAsync,
    gioAsync,
    pruneDirFilesAsync,
    resolveLocalGioFile,
    writeBytesAsync,
} from './asyncUtils.js';
import {
    getGIconCacheKey,
    getIconTheme,
    loadPixbufForGIcon,
    rec709Luminance,
    setBoundedCache,
} from './iconUtils.js';

const MAX_CACHE_ENTRIES = 20;

const WHITE_ACCENT = Object.freeze({
    accentCss: '#ffffff',
    contrastFg: '#141418',
    borderRgba: 'rgba(255, 255, 255, 0.45)',
    tintRgba: 'rgba(32, 32, 38, 0.94)',
    isCssVar: false,
});

const SHELL_ACCENT = Object.freeze({
    accentCss: '-st-accent-color',
    contrastFg: '-st-accent-fg-color',
    borderRgba: 'rgba(255, 255, 255, 0.22)',
    tintRgba: 'rgba(30, 30, 36, 0.96)',
    isCssVar: true,
});

function hashString(input) {
    return GLib.compute_checksum_for_string(GLib.ChecksumType.SHA256, input, -1);
}

function rgbToHsl(r, g, b) {
    const rn = r / 255;
    const gn = g / 255;
    const bn = b / 255;
    const max = Math.max(rn, gn, bn);
    const min = Math.min(rn, gn, bn);
    const l = (max + min) / 2;

    if (max === min)
        return { h: 0, s: 0, l };

    const d = max - min;
    const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    let h = 0;
    if (max === rn)
        h = ((gn - bn) / d) + (gn < bn ? 6 : 0);
    else if (max === gn)
        h = ((bn - rn) / d) + 2;
    else
        h = ((rn - gn) / d) + 4;

    return { h: h / 6, s, l };
}

function normalizeAccent(r, g, b) {
    const { s, l } = rgbToHsl(r, g, b);
    let outR = r;
    let outG = g;
    let outB = b;

    if (l < 0.36) {
        const lift = 0.40 / Math.max(l, 0.08);
        outR = Math.min(255, Math.round(r * lift));
        outG = Math.min(255, Math.round(g * lift));
        outB = Math.min(255, Math.round(b * lift));
    } else if (l > 0.88 && s < 0.25) {
        return WHITE_ACCENT;
    }

    const bgR = Math.round(14 + outR * 0.20);
    const bgG = Math.round(14 + outG * 0.20);
    const bgB = Math.round(18 + outB * 0.20);

    const relLum = rec709Luminance(outR, outG, outB) / 255;
    const contrastFg = relLum > 0.62 ? '#141418' : '#ffffff';

    return {
        accentCss: `rgb(${outR}, ${outG}, ${outB})`,
        contrastFg,
        borderRgba: `rgba(${outR}, ${outG}, ${outB}, 0.55)`,
        tintRgba: `rgba(${bgR}, ${bgG}, ${bgB}, 0.94)`,
        isCssVar: false,
    };
}

function extractAccentFromPixbuf(pixbuf) {
    if (!pixbuf)
        return WHITE_ACCENT;

    const width = pixbuf.get_width();
    const height = pixbuf.get_height();
    const rowstride = pixbuf.get_rowstride();
    const nChannels = pixbuf.get_n_channels();
    const hasAlpha = pixbuf.get_has_alpha();
    const pixels = pixbuf.get_pixels();

    const buckets = new Map();
    let fallbackR = 0;
    let fallbackG = 0;
    let fallbackB = 0;
    let fallbackCount = 0;

    for (let y = 0; y < height; y++) {
        const rowOffset = y * rowstride;
        for (let x = 0; x < width; x++) {
            const idx = rowOffset + x * nChannels;
            const r = pixels[idx];
            const g = pixels[idx + 1];
            const b = pixels[idx + 2];
            const a = hasAlpha ? pixels[idx + 3] : 255;

            if (a < 128)
                continue;

            fallbackR += r;
            fallbackG += g;
            fallbackB += b;
            fallbackCount++;

            const { s, l } = rgbToHsl(r, g, b);
            if (l < 0.08 || l > 0.92)
                continue;

            const qr = r >> 4;
            const qg = g >> 4;
            const qb = b >> 4;
            const key = (qr << 8) | (qg << 4) | qb;
            const weight = 1 + (s * 4.5) + (1 - Math.abs(l - 0.5) * 2);

            const entry = buckets.get(key) || { score: 0, sumR: 0, sumG: 0, sumB: 0, count: 0 };
            entry.score += weight;
            entry.sumR += r;
            entry.sumG += g;
            entry.sumB += b;
            entry.count++;
            buckets.set(key, entry);
        }
    }

    if (buckets.size === 0) {
        if (fallbackCount === 0)
            return WHITE_ACCENT;
        return normalizeAccent(
            Math.round(fallbackR / fallbackCount),
            Math.round(fallbackG / fallbackCount),
            Math.round(fallbackB / fallbackCount)
        );
    }

    let best = null;
    for (const entry of buckets.values()) {
        if (!best || entry.score > best.score)
            best = entry;
    }

    return normalizeAccent(
        Math.round(best.sumR / best.count),
        Math.round(best.sumG / best.count),
        Math.round(best.sumB / best.count)
    );
}

/**
 * Resolves cover art files locally and extracts dominant accent colors
 * from either song cover art or the playing app's GIcon.
 */
export class CoverArtService {
    constructor() {
        this._soup = new Soup.Session({ timeout: 8 });
        this._artCache = new Map();
        this._iconAccentCache = new Map();
        this._activeCancellables = new Set();
        this._destroyed = false;
        this._cacheDir = GLib.build_filenamev([GLib.get_user_cache_dir(), 'amazing-media-control']);
        this._dir = Gio.File.new_for_path(this._cacheDir);
    }

    getWhiteAccent() {
        return WHITE_ACCENT;
    }

    getShellAccent() {
        return SHELL_ACCENT;
    }

    /**
     * Extract a vibrant accent color from an application's Gio.Icon via St.IconTheme.
     *
     * @param {Gio.Icon|null} gicon
     * @returns {object}
     */
    extractFromGIcon(gicon) {
        if (!gicon || this._destroyed)
            return WHITE_ACCENT;

        const key = getGIconCacheKey(gicon);
        if (key && this._iconAccentCache.has(key))
            return this._iconAccentCache.get(key);

        try {
            const pixbuf = loadPixbufForGIcon(gicon, getIconTheme());
            const accent = pixbuf ? extractAccentFromPixbuf(pixbuf) : WHITE_ACCENT;
            if (key)
                setBoundedCache(this._iconAccentCache, key, accent, MAX_CACHE_ENTRIES);
            return accent;
        } catch (_e) {
            return WHITE_ACCENT;
        }
    }

    /**
     * Resolve a local file:// URI and extracted accent color for `artUrl`.
     *
     * @param {string} artUrl
     * @param {Gio.Cancellable} cancellable
     * @returns {Promise<{ localUri: string, accent: object }>}
     */
    async resolve(artUrl, cancellable = null) {
        if (!artUrl || this._destroyed || !this._soup)
            return { localUri: '', accent: WHITE_ACCENT };

        const { cancellable: internalCancel, release } = createLinkedCancellable(
            this._activeCancellables,
            cancellable
        );

        try {
            const cached = this._artCache.get(artUrl);
            if (cached) {
                const localFile = cached.localUri ? resolveLocalGioFile(cached.localUri) : null;
                if (!localFile || await fileExistsAsync(localFile, internalCancel)) {
                    if (this._destroyed || internalCancel.is_cancelled())
                        return { localUri: '', accent: WHITE_ACCENT };
                    this._storeCache(artUrl, cached);
                    return cached;
                }
                this._artCache.delete(artUrl);
            }

            let localUri = '';
            let pixbuf = null;
            let tempBytes = null;

            if (artUrl.startsWith('file://') || artUrl.startsWith('/')) {
                const file = resolveLocalGioFile(artUrl);
                localUri = file.get_uri();
                pixbuf = await decodePixbufFromFileAsync(file, 32, 32, true, internalCancel);
            } else if (artUrl.startsWith('data:image/')) {
                const commaIdx = artUrl.indexOf(',');
                if (commaIdx !== -1) {
                    const bytes = GLib.base64_decode(artUrl.slice(commaIdx + 1));
                    tempBytes = new GLib.Bytes(bytes);
                    pixbuf = await decodePixbufFromBytesAsync(tempBytes, 32, 32, true, internalCancel);
                }
            } else if (artUrl.startsWith('http://') || artUrl.startsWith('https://')) {
                const msg = Soup.Message.new('GET', artUrl);
                tempBytes = await gioAsync(
                    this._soup,
                    'send_and_read',
                    msg,
                    GLib.PRIORITY_DEFAULT,
                    internalCancel
                );
                if (msg.get_status() >= 400)
                    throw new Error(`HTTP ${msg.get_status()}`);
                pixbuf = await decodePixbufFromBytesAsync(tempBytes, 32, 32, true, internalCancel);
            }

            if (this._destroyed || internalCancel.is_cancelled())
                return { localUri: '', accent: WHITE_ACCENT };

            const accent = extractAccentFromPixbuf(pixbuf);
            if (pixbuf && tempBytes) {
                localUri = await this._writeTempArt(artUrl, tempBytes, accent, internalCancel);
                if (this._destroyed || internalCancel.is_cancelled())
                    return { localUri: '', accent: WHITE_ACCENT };
            }

            const result = { localUri, accent };
            this._storeCache(artUrl, result);
            return result;
        } catch (e) {
            if (!e.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED))
                console.debug(`[AmazingMediaControl] Cover art load failed: ${e.message}`);
            return { localUri: '', accent: WHITE_ACCENT };
        } finally {
            release();
        }
    }

    async _writeTempArt(artUrl, bytesObj, accent, cancellable) {
        await ensureDirAsync(this._dir, cancellable);
        const file = this._dir.get_child(`cover_${hashString(artUrl)}.img`);
        await writeBytesAsync(file, bytesObj, cancellable);
        const localUri = file.get_uri();
        this._storeCache(artUrl, { localUri, accent });
        const activePaths = [...this._artCache.values()]
            .map(entry => entry.localUri)
            .filter(u => u?.startsWith('file://'))
            .map(u => Gio.File.new_for_uri(u).get_path());
        await pruneDirFilesAsync(this._dir, {
            prefix: 'cover_',
            maxFiles: MAX_CACHE_ENTRIES,
            keepPaths: activePaths,
            cancellable,
        });
        return localUri;
    }

    _storeCache(key, value) {
        if (this._destroyed)
            return;
        setBoundedCache(this._artCache, key, value, MAX_CACHE_ENTRIES);
    }

    destroy() {
        if (this._destroyed)
            return;
        this._destroyed = true;
        for (const c of this._activeCancellables)
            c.cancel();
        this._activeCancellables.clear();
        this._soup?.abort();
        this._soup = null;
        this._artCache.clear();
        this._iconAccentCache.clear();
    }
}
