import GdkPixbuf from 'gi://GdkPixbuf';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

import {
    createLinkedCancellable,
    decodePixbufFromFileAsync,
    ensureDirAsync,
    fileExistsAsync,
    pruneDirFilesAsync,
    resolveLocalGioFile,
    writeBytesAsync,
} from './asyncUtils.js';
import { rec709Luminance, setBoundedCache } from './iconUtils.js';

const SIZE = 64;
const BLUR_RADIUS = 6;
const BLUR_PASSES = 3;
const SATURATION = 1.4;
const CEILING = 0.1;
const TRANSPARENT_FILL = 0.2;
const MAX_FILES = 16;
const IN_USE = 2;
const SRGB_STEPS = 4096;

function buildTables() {
    const toLinear = new Float32Array(256);
    for (let i = 0; i < 256; i++) {
        const c = i / 255;
        toLinear[i] = c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
    }

    const toSrgb = new Uint8Array(SRGB_STEPS + 1);
    for (let i = 0; i <= SRGB_STEPS; i++) {
        const c = i / SRGB_STEPS;
        const v = c <= 0.0031308 ? c * 12.92 : 1.055 * (c ** (1 / 2.4)) - 0.055;
        toSrgb[i] = Math.round(v * 255);
    }

    return { toLinear, toSrgb };
}

function srgb(toSrgb, c) {
    return toSrgb[Math.round(Math.min(1, Math.max(0, c)) * SRGB_STEPS)];
}

function boxBlur(src, dst, width, height, horizontal) {
    const lines = horizontal ? height : width;
    const last = (horizontal ? width : height) - 1;
    const step = horizontal ? 3 : 3 * width;
    const lineStep = horizontal ? 3 * width : 3;
    const span = 2 * BLUR_RADIUS + 1;

    for (let line = 0; line < lines; line++) {
        const start = line * lineStep;
        let r = 0;
        let g = 0;
        let b = 0;

        for (let i = -BLUR_RADIUS; i <= BLUR_RADIUS; i++) {
            const at = start + Math.min(last, Math.max(0, i)) * step;
            r += src[at];
            g += src[at + 1];
            b += src[at + 2];
        }

        for (let i = 0; i <= last; i++) {
            const at = start + i * step;
            dst[at] = r / span;
            dst[at + 1] = g / span;
            dst[at + 2] = b / span;

            const enter = start + Math.min(last, i + BLUR_RADIUS + 1) * step;
            const leave = start + Math.max(0, i - BLUR_RADIUS) * step;
            r += src[enter] - src[leave];
            g += src[enter + 1] - src[leave + 1];
            b += src[enter + 2] - src[leave + 2];
        }
    }
}

function blurPixbuf(pixbuf, { toLinear }) {
    const width = pixbuf.get_width();
    const height = pixbuf.get_height();
    const channels = pixbuf.get_n_channels();
    const stride = pixbuf.get_rowstride();
    const alpha = pixbuf.get_has_alpha();
    const data = pixbuf.get_pixels();

    let pixels = new Float32Array(width * height * 3);
    for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
            const from = y * stride + x * channels;
            const to = 3 * (y * width + x);
            const opacity = alpha ? data[from + 3] / 255 : 1;
            const fill = (1 - opacity) * TRANSPARENT_FILL;
            pixels[to] = opacity * toLinear[data[from]] + fill;
            pixels[to + 1] = opacity * toLinear[data[from + 1]] + fill;
            pixels[to + 2] = opacity * toLinear[data[from + 2]] + fill;
        }
    }

    let spare = new Float32Array(pixels.length);
    for (let pass = 0; pass < BLUR_PASSES; pass++) {
        boxBlur(pixels, spare, width, height, true);
        boxBlur(spare, pixels, width, height, false);
    }
    spare = null;

    for (let i = 0; i < pixels.length; i += 3) {
        const l = rec709Luminance(pixels[i], pixels[i + 1], pixels[i + 2]);
        pixels[i] = Math.min(1, Math.max(0, l + (pixels[i] - l) * SATURATION));
        pixels[i + 1] = Math.min(1, Math.max(0, l + (pixels[i + 1] - l) * SATURATION));
        pixels[i + 2] = Math.min(1, Math.max(0, l + (pixels[i + 2] - l) * SATURATION));
    }

    return { width, height, pixels };
}

function renderBackdrop(base, { toSrgb }) {
    const { width, height, pixels } = base;
    const rgb = new Uint8Array(pixels.length);
    let edgeR = 0;
    let edgeG = 0;
    let edgeB = 0;
    let edgeCount = 0;

    for (let y = 0, i = 0; y < height; y++) {
        const edgeRow = y === 0 || y === height - 1;
        for (let x = 0; x < width; x++, i += 3) {
            let r = pixels[i];
            let g = pixels[i + 1];
            let b = pixels[i + 2];
            const l = rec709Luminance(r, g, b);

            if (l > 0) {
                const scale = CEILING * (1 - Math.exp(-l / CEILING)) / l;
                r *= scale;
                g *= scale;
                b *= scale;
            }

            rgb[i] = srgb(toSrgb, r);
            rgb[i + 1] = srgb(toSrgb, g);
            rgb[i + 2] = srgb(toSrgb, b);

            if (edgeRow || x === 0 || x === width - 1) {
                edgeR += r;
                edgeG += g;
                edgeB += b;
                edgeCount++;
            }
        }
    }

    const edge = [edgeR, edgeG, edgeB].map(sum => srgb(toSrgb, sum / edgeCount));
    return { rgb, edge: `rgb(${edge.join(', ')})` };
}

function extractEdgeFromPixbuf(pixbuf) {
    if (!pixbuf)
        return 'rgb(18, 18, 22)';
    const width = pixbuf.get_width();
    const height = pixbuf.get_height();
    const channels = pixbuf.get_n_channels();
    const stride = pixbuf.get_rowstride();
    const data = pixbuf.get_pixels();
    let r = 0;
    let g = 0;
    let b = 0;
    let count = 0;

    for (let y = 0; y < height; y++) {
        const edgeRow = y === 0 || y === height - 1;
        for (let x = 0; x < width; x++) {
            if (!edgeRow && x !== 0 && x !== width - 1)
                continue;
            const idx = y * stride + x * channels;
            r += data[idx];
            g += data[idx + 1];
            b += data[idx + 2];
            count++;
        }
    }
    if (count === 0)
        return 'rgb(18, 18, 22)';
    return `rgb(${Math.round(r / count)}, ${Math.round(g / count)}, ${Math.round(b / count)})`;
}

/**
 * Generates a pre-blurred, contrast-safe rounded-corner PNG backdrop
 * from local cover-art files.
 */
export class BackdropMaker {
    constructor() {
        this._activeCancellables = new Set();
        this._inUse = [];
        this._memCache = new Map();
        this._tables = buildTables();
        this._destroyed = false;

        const cachePath = GLib.build_filenamev([
            GLib.get_user_cache_dir(),
            'amazing-media-control',
            'backdrops',
        ]);
        this._dir = Gio.File.new_for_path(cachePath);
    }

    _touchInUse(filePath) {
        if (!filePath)
            return;
        this._inUse = [filePath, ...this._inUse.filter(p => p !== filePath)].slice(0, IN_USE);
    }

    _loadPixbuf(artUri, cancellable) {
        return decodePixbufFromFileAsync(resolveLocalGioFile(artUri), SIZE, SIZE, true, cancellable);
    }

    async make(artUri, externalCancellable = null) {
        if (!artUri || this._destroyed)
            return null;

        const { cancellable, release } = createLinkedCancellable(
            this._activeCancellables,
            externalCancellable
        );

        try {
            const key = GLib.compute_checksum_for_string(
                GLib.ChecksumType.SHA256,
                `${artUri}|v1`,
                -1
            );
            const file = this._dir.get_child(`${key}.png`);
            const path = file.get_path();
            const uri = file.get_uri();

            const diskExists = await fileExistsAsync(file, cancellable);
            if (this._destroyed || cancellable.is_cancelled())
                return null;

            if (diskExists) {
                const memHit = this._memCache.get(key);
                if (memHit) {
                    setBoundedCache(this._memCache, key, memHit, MAX_FILES);
                    this._touchInUse(path);
                    return memHit;
                }

                const cachedPixbuf = await decodePixbufFromFileAsync(file, SIZE, SIZE, false, cancellable);
                if (this._destroyed || cancellable.is_cancelled())
                    return null;
                const result = { uri, color: extractEdgeFromPixbuf(cachedPixbuf) };
                setBoundedCache(this._memCache, key, result, MAX_FILES);
                this._touchInUse(path);
                return result;
            }
            this._memCache.delete(key);

            await ensureDirAsync(this._dir, cancellable);
            if (this._destroyed || cancellable.is_cancelled())
                return null;

            const pixbuf = await this._loadPixbuf(artUri, cancellable);
            if (!pixbuf || this._destroyed || cancellable.is_cancelled())
                return null;

            const base = blurPixbuf(pixbuf, this._tables);
            const { rgb, edge } = renderBackdrop(base, this._tables);
            const pixels = new GLib.Bytes(rgb);
            const image = GdkPixbuf.Pixbuf.new_from_bytes(
                pixels,
                GdkPixbuf.Colorspace.RGB,
                false,
                8,
                base.width,
                base.height,
                base.width * 3
            );
            const [, png] = image.save_to_bufferv('png', ['compression'], ['1']);
            await writeBytesAsync(file, new GLib.Bytes(png), cancellable);

            if (this._destroyed || cancellable.is_cancelled())
                return null;

            const result = { uri, color: edge };
            setBoundedCache(this._memCache, key, result, MAX_FILES);
            this._touchInUse(path);
            await pruneDirFilesAsync(this._dir, {
                maxFiles: MAX_FILES,
                keepPaths: this._inUse,
                cancellable,
            });
            return result;
        } catch (e) {
            if (!e.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED))
                console.debug(`[AmazingMediaControl] backdrop failed: ${e.message}`);
            return null;
        } finally {
            release();
        }
    }

    destroy() {
        if (this._destroyed)
            return;
        this._destroyed = true;
        for (const c of this._activeCancellables)
            c.cancel();
        this._activeCancellables.clear();
        this._memCache.clear();
        this._inUse = [];
    }
}

