import Clutter from 'gi://Clutter';
import GdkPixbuf from 'gi://GdkPixbuf';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import St from 'gi://St';

export const DEFAULT_APP_ICON_NAME = 'audio-x-generic-symbolic';

const WHITE_SYMBOLIC_STYLE = 'color: #ffffff; -st-icon-style: symbolic;';
const REGULAR_ICON_STYLE = '-st-icon-style: regular;';
const EFFECT_DESATURATE = 'amc-white-desaturate';
const EFFECT_BRIGHTNESS = 'amc-white-brightness';
const ICON_RASTER_SIZE = 64;
const MAX_WHITE_CACHE = 32;

const GENERIC_ID_TAILS = new Set([
    'client', 'app', 'desktop', 'application', 'player', 'browser', 'main', 'bin',
]);

let _iconTheme = null;
let _defaultAppIcon = null;
const _whiteIconCache = new Map();

export function getIconTheme() {
    if (!_iconTheme)
        _iconTheme = new St.IconTheme();
    return _iconTheme;
}

export function getDefaultAppIcon() {
    if (!_defaultAppIcon)
        _defaultAppIcon = Gio.ThemedIcon.new(DEFAULT_APP_ICON_NAME);
    return _defaultAppIcon;
}

export function rec709Luminance(r, g, b) {
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

export function setBoundedCache(map, key, value, maxSize = MAX_WHITE_CACHE) {
    if (!map || !key)
        return;
    if (map.has(key)) {
        map.delete(key);
    } else if (map.size >= maxSize) {
        const oldestKey = map.keys().next().value;
        if (oldestKey !== undefined)
            map.delete(oldestKey);
    }
    map.set(key, value);
}

export function getStageScaleFactor() {
    if (typeof global === 'undefined' || !global.stage)
        return 1;
    return St.ThemeContext.get_for_stage(global.stage)?.scale_factor || 1;
}

export function clearIconCaches() {
    _whiteIconCache.clear();
    _iconTheme = null;
    _defaultAppIcon = null;
}

export function getGIconCacheKey(gicon) {
    const str = gicon?.to_string?.();
    if (str)
        return str;
    if (typeof gicon?.get_bytes === 'function') {
        const bytes = gicon.get_bytes();
        if (bytes)
            return `bytes:${GLib.compute_checksum_for_bytes(GLib.ChecksumType.SHA256, bytes)}`;
    }
    return '';
}

function isSymbolicFileIcon(gicon) {
    const basename = gicon?.get_file?.()?.get_basename?.() ?? '';
    return basename.includes('-symbolic.');
}

function resolveSymbolicThemedIcon(gicon, iconTheme) {
    if (typeof gicon?.get_names !== 'function')
        return null;

    const names = gicon.get_names();
    if (names[0]?.endsWith('-symbolic') && iconTheme.has_icon(names[0]))
        return gicon;

    const candidates = [];
    const seen = new Set();
    const pushCandidate = raw => {
        if (!raw)
            return;
        const sym = raw.endsWith('-symbolic') ? raw : `${raw}-symbolic`;
        if (!seen.has(sym)) {
            seen.add(sym);
            candidates.push(sym);
        }
    };

    for (const name of names) {
        pushCandidate(name);
        pushCandidate(name.toLowerCase());

        if (name.includes('.')) {
            const parts = name.split('.');
            const tail = parts[parts.length - 1]?.toLowerCase() ?? '';
            if (tail.length >= 3 && !GENERIC_ID_TAILS.has(tail)) {
                pushCandidate(tail);
            } else if (parts.length >= 3) {
                const parent = parts[parts.length - 2]?.toLowerCase() ?? '';
                if (parent.length >= 3 && !GENERIC_ID_TAILS.has(parent))
                    pushCandidate(parent);
            }
        }
    }

    for (const candidate of candidates) {
        if (iconTheme.has_icon(candidate))
            return Gio.ThemedIcon.new(candidate);
    }

    return null;
}

function loadPixbufFromIconInfo(info) {
    if (!info)
        return null;
    const filename = info.get_filename?.();
    if (filename) {
        return GdkPixbuf.Pixbuf.new_from_file_at_scale(
            filename,
            ICON_RASTER_SIZE,
            ICON_RASTER_SIZE,
            true
        );
    }
    return info.load_icon?.() ?? null;
}

export function loadPixbufForGIcon(gicon, iconTheme = getIconTheme()) {
    if (!gicon)
        return null;
    if (typeof gicon?.get_names === 'function') {
        for (const name of gicon.get_names()) {
            if (!name)
                continue;
            if (name.startsWith('/')) {
                try {
                    return GdkPixbuf.Pixbuf.new_from_file_at_scale(
                        name,
                        ICON_RASTER_SIZE,
                        ICON_RASTER_SIZE,
                        true
                    );
                } catch (_e) {
                    // Continue trying remaining icon names.
                }
            }
            try {
                const pixbuf = loadPixbufFromIconInfo(iconTheme.lookup_icon(name, ICON_RASTER_SIZE, 0));
                if (pixbuf)
                    return pixbuf;
            } catch (_e) {
                // Continue trying remaining icon names.
            }
        }
    }

    try {
        if (typeof iconTheme.lookup_by_gicon === 'function') {
            const pixbuf = loadPixbufFromIconInfo(iconTheme.lookup_by_gicon(gicon, ICON_RASTER_SIZE, 0));
            if (pixbuf)
                return pixbuf;
        }
    } catch (_e) {
        // Fall through to direct file / loadable icon decoding.
    }

    try {
        if (typeof gicon?.get_file === 'function') {
            const path = gicon.get_file()?.get_path?.();
            if (path) {
                return GdkPixbuf.Pixbuf.new_from_file_at_scale(
                    path,
                    ICON_RASTER_SIZE,
                    ICON_RASTER_SIZE,
                    true
                );
            }
        }
    } catch (_e) {
        // Fall through to LoadableIcon decoding.
    }

    try {
        if (typeof gicon?.load === 'function') {
            const [stream] = gicon.load(ICON_RASTER_SIZE, null);
            if (stream) {
                try {
                    return GdkPixbuf.Pixbuf.new_from_stream_at_scale(
                        stream,
                        ICON_RASTER_SIZE,
                        ICON_RASTER_SIZE,
                        true,
                        null
                    );
                } finally {
                    stream.close(null);
                }
            }
        }
    } catch (_e) {
        // Give up on pixbuf decoding.
    }

    return null;
}

function pixbufToWhiteBytesIcon(pixbuf) {
    const width = pixbuf.get_width();
    const height = pixbuf.get_height();
    if (width <= 0 || height <= 0)
        return null;

    const rowstride = pixbuf.get_rowstride();
    const nChannels = pixbuf.get_n_channels();
    const hasAlpha = pixbuf.get_has_alpha();
    const pixels = pixbuf.get_pixels();

    let hasTransparency = false;
    let visibleCount = 0;
    let minLum = 255;
    let maxLum = 0;
    const rimLums = [];

    const padX0 = Math.floor(width * 0.20);
    const padX1 = Math.ceil(width * 0.80);
    const padY0 = Math.floor(height * 0.20);
    const padY1 = Math.ceil(height * 0.80);

    for (let y = 0; y < height; y++) {
        const rowOffset = y * rowstride;
        const inRimY = y < padY0 || y >= padY1;
        for (let x = 0; x < width; x++) {
            const idx = rowOffset + x * nChannels;
            const srcAlpha = hasAlpha ? pixels[idx + 3] : 255;
            if (srcAlpha < 128) {
                hasTransparency = true;
                continue;
            }
            visibleCount++;
            const lum = rec709Luminance(pixels[idx], pixels[idx + 1], pixels[idx + 2]);
            if (lum < minLum)
                minLum = lum;
            if (lum > maxLum)
                maxLum = lum;

            if (inRimY || x < padX0 || x >= padX1)
                rimLums.push(lum);
        }
    }

    const totalPixels = width * height;
    const visibleRatio = visibleCount / Math.max(1, totalPixels);
    const lumRange = maxLum - minLum;

    // Detect rounded-square / circular badge icons with a uniform solid background plate
    // (like Zen Browser's dark rounded square around white rings) so we knock out the
    // plate cleanly instead of turning the entire badge into a solid white rectangle.
    let stripUniformPlate = false;
    let lightPlate = false;
    let plateLowLum = minLum;
    let plateHighLum = maxLum;

    if (hasTransparency && visibleRatio >= 0.58 && rimLums.length >= 16 && lumRange > 55) {
        rimLums.sort((a, b) => a - b);
        const rimP20 = rimLums[Math.floor(rimLums.length * 0.20)];
        const rimP80 = rimLums[Math.floor(rimLums.length * 0.80)];
        const rimMedian = rimLums[Math.floor(rimLums.length * 0.50)];
        if ((rimP80 - rimP20) <= 45) {
            if (rimMedian < 95 && (maxLum - rimMedian) >= 55) {
                stripUniformPlate = true;
                plateLowLum = rimMedian + 8;
                plateHighLum = maxLum;
            } else if (rimMedian > 175 && (rimMedian - minLum) >= 55) {
                stripUniformPlate = true;
                lightPlate = true;
                plateLowLum = minLum;
                plateHighLum = rimMedian - 8;
            }
        }
    }

    const out = new Uint8Array(width * height * 4);
    const useLumMask = !hasTransparency || stripUniformPlate;
    const maskSpan = Math.max(1, plateHighLum - plateLowLum);

    for (let y = 0; y < height; y++) {
        const rowOffset = y * rowstride;
        const dstRow = y * width * 4;
        for (let x = 0; x < width; x++) {
            const srcIdx = rowOffset + x * nChannels;
            const dstIdx = dstRow + x * 4;
            const srcAlpha = hasAlpha ? pixels[srcIdx + 3] : 255;

            let alpha = srcAlpha;
            if (useLumMask) {
                if (stripUniformPlate) {
                    const lum = rec709Luminance(pixels[srcIdx], pixels[srcIdx + 1], pixels[srcIdx + 2]);
                    const ramp = Math.max(0, Math.min(1, (lum - plateLowLum) / maskSpan));
                    const norm = lightPlate ? (1 - ramp) : ramp;
                    alpha = Math.round((srcAlpha / 255) * norm * 255);
                } else if (lumRange > 8) {
                    const lum = rec709Luminance(pixels[srcIdx], pixels[srcIdx + 1], pixels[srcIdx + 2]);
                    alpha = Math.round(((lum - minLum) / lumRange) * 255);
                }
            }

            out[dstIdx] = 255;
            out[dstIdx + 1] = 255;
            out[dstIdx + 2] = 255;
            out[dstIdx + 3] = alpha;
        }
    }

    const whitePixbuf = GdkPixbuf.Pixbuf.new_from_bytes(
        new GLib.Bytes(out),
        GdkPixbuf.Colorspace.RGB,
        true,
        8,
        width,
        height,
        width * 4
    );
    const [ok, pngBytes] = whitePixbuf.save_to_bufferv('png', [], []);
    if (!ok || !pngBytes)
        return null;

    return new Gio.BytesIcon({ bytes: new GLib.Bytes(pngBytes) });
}

/**
 * Resolve a pure monochrome white variant of `gicon` when `whiteMode` is enabled.
 * Prefers native `-symbolic` theme variants and falls back to a cached white
 * alpha-silhouette `Gio.BytesIcon` for full-color icons.
 *
 * @param {Gio.Icon|null|undefined} gicon
 * @returns {{ gicon: Gio.Icon, isSymbolic: boolean, needsEffectFallback?: boolean }}
 */
function resolveWhiteGIcon(gicon) {
    const baseIcon = gicon || getDefaultAppIcon();
    const iconTheme = getIconTheme();

    const symbolicIcon = resolveSymbolicThemedIcon(baseIcon, iconTheme);
    if (symbolicIcon)
        return { gicon: symbolicIcon, isSymbolic: true };

    if (isSymbolicFileIcon(baseIcon))
        return { gicon: baseIcon, isSymbolic: true };

    const key = getGIconCacheKey(baseIcon);
    if (key && _whiteIconCache.has(key)) {
        const cached = _whiteIconCache.get(key);
        return cached
            ? { gicon: cached, isSymbolic: false }
            : { gicon: baseIcon, isSymbolic: false, needsEffectFallback: true };
    }

    const pixbuf = loadPixbufForGIcon(baseIcon, iconTheme);
    const whiteIcon = pixbuf ? pixbufToWhiteBytesIcon(pixbuf) : null;
    if (key)
        setBoundedCache(_whiteIconCache, key, whiteIcon, MAX_WHITE_CACHE);

    if (whiteIcon)
        return { gicon: whiteIcon, isSymbolic: false };

    return { gicon: baseIcon, isSymbolic: false, needsEffectFallback: true };
}

/**
 * Remove any fallback white-tinting Clutter effects from an actor without throwing.
 *
 * @param {Clutter.Actor|null|undefined} actor
 */
function removeWhiteIconEffects(actor) {
    if (!actor)
        return;
    if (actor.get_effect(EFFECT_DESATURATE))
        actor.remove_effect_by_name(EFFECT_DESATURATE);
    if (actor.get_effect(EFFECT_BRIGHTNESS))
        actor.remove_effect_by_name(EFFECT_BRIGHTNESS);
}

function ensureWhiteIconEffects(actor) {
    if (!actor)
        return;
    if (!actor.get_effect(EFFECT_DESATURATE)) {
        actor.add_effect_with_name(
            EFFECT_DESATURATE,
            new Clutter.DesaturateEffect({ factor: 1.0 })
        );
    }
    if (!actor.get_effect(EFFECT_BRIGHTNESS)) {
        const brightness = new Clutter.BrightnessContrastEffect();
        brightness.set_brightness(0.45);
        brightness.set_contrast(0.35);
        actor.add_effect_with_name(EFFECT_BRIGHTNESS, brightness);
    }
}

/**
 * Apply either normal or pure monochrome white (`#ffffff`) appearance for `gicon`
 * on an `St.Icon`, cleaning up styles and effects when switching modes or players.
 *
 * @param {St.Icon|null|undefined} stIcon
 * @param {Gio.Icon|null|undefined} gicon
 * @param {boolean} whiteMode
 */
export function applyAppIconAppearance(stIcon, gicon, whiteMode) {
    if (!stIcon)
        return;

    const baseIcon = gicon || getDefaultAppIcon();

    if (!whiteMode) {
        removeWhiteIconEffects(stIcon);
        if (stIcon.style !== null)
            stIcon.style = null;
        if (stIcon.gicon !== baseIcon)
            stIcon.gicon = baseIcon;
        return;
    }

    const resolved = resolveWhiteGIcon(baseIcon);
    if (resolved.needsEffectFallback)
        ensureWhiteIconEffects(stIcon);
    else
        removeWhiteIconEffects(stIcon);

    const nextStyle = resolved.isSymbolic
        ? WHITE_SYMBOLIC_STYLE
        : (resolved.needsEffectFallback ? null : REGULAR_ICON_STYLE);
    if (stIcon.style !== nextStyle)
        stIcon.style = nextStyle;
    if (stIcon.gicon !== resolved.gicon)
        stIcon.gicon = resolved.gicon;
}

/**
 * Update sensitivity (`reactive`, `can_focus`, and `:insensitive` pseudo-class)
 * on an `St.Button` so CSS `:insensitive` rules apply consistently.
 *
 * @param {St.Button|null|undefined} btn
 * @param {boolean} enabled
 */
export function setButtonSensitive(btn, enabled) {
    if (!btn)
        return;
    const sensitive = Boolean(enabled);
    btn.reactive = sensitive;
    btn.can_focus = sensitive;
    if (sensitive)
        btn.remove_style_pseudo_class?.('insensitive');
    else
        btn.add_style_pseudo_class?.('insensitive');
}
