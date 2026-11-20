import Cairo from 'cairo';

const RED_FROM = 0.75;
const YELLOW_FROM = 0.5;
const UNLIT_ALPHA = 0.22;
const HUE_SATURATION = 0.7;
export const WAVE_LOOP_S = 3.6;

const WAVE_LAYERS = [
    [0.42, 0.10, 0.75, 0.0, 0.34, 1, 0.32],
    [0.29, 0.08, 1.00, 1.1, 0.36, 2, 0.56],
    [0.17, 0.06, 1.25, 2.2, 0.36, 3, 0.94],
];

function hexToRgb(hex) {
    const value = Number.parseInt(hex.slice(1), 16);
    return [(value >> 16) / 255, ((value >> 8) & 0xff) / 255, (value & 0xff) / 255];
}

const LEVEL_COLORS = [
    ['#2ec27e', '#f6d32d', '#e01b24'].map(hexToRgb),
    ['#26a269', '#e5a50a', '#c01c28'].map(hexToRgb),
];

export function clamp(value, min, max) {
    return Math.max(min, Math.min(max, value));
}

function hsvToRgb(hue, saturation, value) {
    const h = (((hue % 1) + 1) % 1) * 6;
    const sector = Math.floor(h);
    const f = h - sector;
    const p = value * (1 - saturation);
    const q = value * (1 - saturation * f);
    const t = value * (1 - saturation * (1 - f));

    switch (sector) {
    case 0: return [value, t, p];
    case 1: return [q, value, p];
    case 2: return [p, value, t];
    case 3: return [p, q, value];
    case 4: return [t, p, value];
    default: return [value, p, q];
    }
}

function drawPill(cr, x, y, width, height) {
    if (width <= 0 || height <= 0)
        return;
    const radius = Math.min(width, height) / 2;
    cr.newSubPath();
    cr.arc(x + width - radius, y + radius, radius, -Math.PI / 2, 0);
    cr.arc(x + width - radius, y + height - radius, radius, 0, Math.PI / 2);
    cr.arc(x + radius, y + height - radius, radius, Math.PI / 2, Math.PI);
    cr.arc(x + radius, y + radius, radius, Math.PI, 1.5 * Math.PI);
    cr.closePath();
}

function curveThrough(cr, points) {
    if (!points.length)
        return;
    for (let j = 0; j < points.length - 1; j++) {
        const [x0, y0] = points[Math.max(j - 1, 0)];
        const [x1, y1] = points[j];
        const [x2, y2] = points[j + 1];
        const [x3, y3] = points[Math.min(j + 2, points.length - 1)];
        cr.curveTo(
            x1 + (x2 - x0) / 6,
            y1 + (y2 - y0) / 6,
            x2 - (x3 - x1) / 6,
            y2 - (y3 - y1) / 6,
            x2,
            y2
        );
    }
}

function columnMetrics(width, count, gapTarget, scale) {
    if (count <= 0)
        return { gap: 0, colW: 0, pitch: 0 };
    const maxGap = count > 1 ? Math.max(0, (width - count * scale) / (count - 1)) : 0;
    const gap = Math.min(Math.max(scale, gapTarget), maxGap);
    const colW = Math.max(0.8 * scale, (width - (count - 1) * gap) / count);
    return { gap, colW, pitch: colW + gap };
}

function getZoneStops(state) {
    const [green, yellow, red] = LEVEL_COLORS[state.lightInk ? 0 : 1];
    switch (state.colorMode) {
    case 'classic':
        return [[0, state.ink], [RED_FROM, red]];
    case 'level':
        return [[0, green], [YELLOW_FROM, yellow], [RED_FROM, red]];
    default:
        return [[0, state.ink]];
    }
}

function colorAt(state, i, count, fraction) {
    if (state.colorMode === 'rainbow') {
        return hsvToRgb(
            state.hue + i / Math.max(1, count),
            HUE_SATURATION,
            state.lightInk ? 1 : 0.8
        );
    }
    const stops = getZoneStops(state);
    for (let j = stops.length - 1; j >= 0; j--) {
        if (fraction >= stops[j][0])
            return stops[j][1];
    }
    return state.ink;
}

function getCachedGradient(state, key, buildFn) {
    const cache = state.gradientCache;
    if (!cache)
        return buildFn();
    if (cache.key === key && cache.gradient)
        return cache.gradient;
    if (!cache.entries)
        cache.entries = new Map();
    if (cache.entries.has(key)) {
        const hit = cache.entries.get(key);
        cache.key = key;
        cache.gradient = hit;
        return hit;
    }
    const gradient = buildFn();
    if (cache.entries.size >= 24) {
        const oldestKey = cache.entries.keys().next().value;
        cache.entries.delete(oldestKey);
    }
    cache.entries.set(key, gradient);
    cache.key = key;
    cache.gradient = gradient;
    return gradient;
}

function zoneGradientInk(state, width, height, mirrored, alpha = 1) {
    const clampedAlpha = clamp(alpha, 0, 1);
    const alphaKey = Math.round(clampedAlpha * 1000);

    if (state.colorMode === 'rainbow') {
        const hueKey = Math.round(state.hue * 120);
        const key = `rainbow|${width}|${state.lightInk}|${hueKey}|${alphaKey}`;
        return getCachedGradient(state, key, () => {
            const gradient = new Cairo.LinearGradient(0, 0, width, 0);
            for (let n = 0; n <= 8; n++) {
                gradient.addColorStopRGBA(
                    n / 8,
                    ...hsvToRgb(state.hue + n / 8, HUE_SATURATION, state.lightInk ? 1 : 0.8),
                    clampedAlpha
                );
            }
            return gradient;
        });
    }

    const key = `zone|${width}x${height}|${state.colorMode}|${state.lightInk}|${mirrored}|${state.ink.join(',')}|${alphaKey}`;
    return getCachedGradient(state, key, () => {
        const stops = getZoneStops(state);
        const gradient = mirrored
            ? new Cairo.LinearGradient(0, 0, 0, height)
            : new Cairo.LinearGradient(0, height, 0, 0);

        stops.forEach(([from, rgb], j) => {
            const to = j + 1 < stops.length ? stops[j + 1][0] - 0.1 : 1;
            if (mirrored) {
                for (const edge of [from, to]) {
                    gradient.addColorStopRGBA((1 - edge) / 2, ...rgb, clampedAlpha);
                    gradient.addColorStopRGBA((1 + edge) / 2, ...rgb, clampedAlpha);
                }
            } else {
                gradient.addColorStopRGBA(from, ...rgb, clampedAlpha);
                gradient.addColorStopRGBA(to, ...rgb, clampedAlpha);
            }
        });
        return gradient;
    });
}

function setGradient(cr, state, width, height, mirrored = false, alphaScale = 1) {
    const opacity = clamp(state.alpha * alphaScale, 0, 1);
    if (state.colorMode === 'accent') {
        cr.setSourceRGBA(state.ink[0], state.ink[1], state.ink[2], opacity);
    } else {
        cr.setSource(zoneGradientInk(state, width, height, mirrored, opacity));
    }
}

function centerMirrorIndex(i, count) {
    if (count <= 1)
        return 0;
    const minDist = count % 2 === 0 ? 1 : 0;
    const maxDist = count - 1;
    const dist = Math.abs(2 * i + 1 - count);
    const norm = (dist - minDist) / Math.max(1, maxDist - minDist);
    return clamp(Math.round(norm * (count - 1)), 0, count - 1);
}

function sampleBandLift(state, idx, layerIdx = 1) {
    const count = state.levels.length;
    const safeIdx = clamp(idx, 0, count - 1);
    const level = clamp(state.levels[safeIdx], 0, 1);
    const peak = state.showPeaks ? clamp(state.peaks[safeIdx], 0, 1) : level;
    if (layerIdx === 0)
        return peak;
    if (layerIdx === 1)
        return (level + peak) / 2;
    return level;
}

function wavePoints(count, width, yAt) {
    if (count <= 0)
        return [];
    const pitch = width / count;
    const points = [[0, yAt(0, 0)]];
    for (let i = 0; i < count; i++) {
        const x = (i + 0.5) * pitch;
        points.push([x, yAt(x, i)]);
    }
    points.push([width, yAt(width, count - 1)]);
    return points;
}

function fillClosedPath(cr, state, width, height, mirrored, alphaScale, buildPathFn) {
    buildPathFn();
    setGradient(cr, state, width, height, mirrored, alphaScale);
    cr.fill();
}

function repaintBars(cr, state, width, height, scale, mirrored, indexMap = null) {
    const count = state.levels.length;
    const { colW, pitch } = columnMetrics(width, count, Math.round(height * 0.08), scale);
    const top = scale;
    const usableH = Math.max(4 * scale, height - 2 * scale);
    const middle = top + usableH / 2;
    const bottom = top + usableH;
    const reach = mirrored ? usableH / 2 : usableH;
    const minFrac = Math.min(0.45, Math.max(colW / Math.max(1, reach), 0.16));
    const zoned = state.colorMode === 'classic' || state.colorMode === 'level';
    const trackGrad = zoned && state.drawTrack
        ? zoneGradientInk(state, width, height, mirrored, state.alpha * UNLIT_ALPHA)
        : null;
    const litGrad = zoned
        ? zoneGradientInk(state, width, height, mirrored, state.alpha)
        : null;

    for (let i = 0; i < count; i++) {
        const srcIdx = indexMap ? indexMap(i, count) : i;
        const x = i * pitch;
        const level = clamp(state.levels[srcIdx], 0, 1);
        const lit = Math.max(level, minFrac);
        const peak = clamp(state.peaks[srcIdx], 0, 1);
        const barH = lit * (mirrored ? 2 * reach : reach);
        const barY = mirrored ? middle - lit * reach : bottom - barH;

        if (zoned) {
            if (trackGrad) {
                cr.setSource(trackGrad);
                drawPill(cr, x, top, colW, usableH);
                cr.fill();
            }
            cr.setSource(litGrad);
            drawPill(cr, x, barY, colW, barH);
            cr.fill();
        } else {
            const [crR, crG, crB] = colorAt(state, i, count, lit);
            if (state.drawTrack) {
                cr.setSourceRGBA(crR, crG, crB, state.alpha * UNLIT_ALPHA);
                drawPill(cr, x, top, colW, usableH);
                cr.fill();
            }
            cr.setSourceRGBA(crR, crG, crB, state.alpha);
            drawPill(cr, x, barY, colW, barH);
            cr.fill();
        }

        if (state.showPeaks && state.isLive && peak > lit + 0.06) {
            const capSize = Math.min(colW, 2.5 * scale);
            const [pkR, pkG, pkB] = colorAt(state, i, count, peak);
            cr.setSourceRGBA(pkR, pkG, pkB, Math.min(1, state.alpha * 1.05));
            if (mirrored) {
                const offset = peak * reach;
                drawPill(cr, x, middle - offset, colW, capSize);
                cr.fill();
                drawPill(cr, x, middle + offset - capSize, colW, capSize);
                cr.fill();
            } else {
                drawPill(cr, x, bottom - peak * reach, colW, capSize);
                cr.fill();
            }
        }
    }
}

function repaintDiscreteGrid(cr, state, rows, unlitFactor, drawCellFn) {
    const count = state.levels.length;
    for (let i = 0; i < count; i++) {
        const level = clamp(state.levels[i], 0, 1);
        const peak = clamp(state.peaks[i], 0, 1);
        const litRows = level > 0 ? Math.max(1, Math.round(level * rows)) : 0;
        const peakRow = state.showPeaks && state.isLive && peak > 0
            ? Math.round(peak * rows) - 1
            : -1;

        for (let row = 0; row < rows; row++) {
            const [r, g, b] = colorAt(state, i, count, (row + 0.5) / rows);
            const on = row < litRows || row === peakRow;
            cr.setSourceRGBA(r, g, b, on ? state.alpha : state.alpha * unlitFactor);
            drawCellFn(i, row, count);
            cr.fill();
        }
    }
}

function repaintRectGrid(cr, state, width, height, scale, rows, gapTarget, unlitFactor, rounded) {
    const count = state.levels.length;
    const { colW, pitch } = columnMetrics(width, count, gapTarget, scale);
    const maxGapY = rows > 1 ? Math.max(0, (height - 2 * scale - rows * 1.5 * scale) / (rows - 1)) : 0;
    const gapY = Math.min(Math.max(scale, gapTarget), maxGapY);
    const rowH = Math.max(1.5 * scale, (height - 2 * scale - (rows - 1) * gapY) / rows);
    const pitchY = rowH + gapY;
    const bottom = height - scale;

    repaintDiscreteGrid(cr, state, rows, unlitFactor, (i, row) => {
        const x = i * pitch;
        const y = bottom - row * pitchY - rowH;
        if (rounded)
            drawPill(cr, x, y, colW, rowH);
        else
            cr.rectangle(x, y, colW, rowH);
    });
}

function repaintSegments(cr, state, width, height, scale) {
    repaintRectGrid(cr, state, width, height, scale, 6, Math.round(height * 0.08), UNLIT_ALPHA, true);
}

function repaintDots(cr, state, width, height, scale) {
    const count = state.levels.length;
    const rows = 5;
    const pitchX = width / count;
    const pitchY = (height - 2 * scale) / rows;
    const radius = Math.max(1.2 * scale, Math.min(pitchX, pitchY) * 0.34);

    repaintDiscreteGrid(cr, state, rows, UNLIT_ALPHA, (i, row) => {
        cr.newSubPath();
        cr.arc((i + 0.5) * pitchX, height - scale - (row + 0.5) * pitchY, radius, 0, 2 * Math.PI);
    });
}

function repaintMatrix(cr, state, width, height, scale) {
    const rows = state.fixedHeight > 0 ? 7 : 5;
    repaintRectGrid(cr, state, width, height, scale, rows, Math.round(scale * 1.4), UNLIT_ALPHA * 0.65, false);
}

function repaintWave(cr, state, width, height) {
    const count = state.levels.length;

    WAVE_LAYERS.forEach(([rest, swell, humps, start, reach, turns, layerAlpha], k) => {
        const shift = -2 * Math.PI * turns * state.drift / WAVE_LOOP_S;
        const pts = wavePoints(count, width, (x, i) => {
            const lift = sampleBandLift(state, i % count, k);
            const frac = Math.min(1, rest + reach * lift + swell * Math.sin(Math.PI * humps * x / height + start + shift));
            return height * (1 - frac);
        });

        fillClosedPath(cr, state, width, height, false, layerAlpha, () => {
            cr.moveTo(0, height);
            cr.lineTo(...pts[0]);
            curveThrough(cr, pts);
            cr.lineTo(width, height);
            cr.closePath();
        });
    });
}

function repaintRibbon(cr, state, width, height, scale) {
    const count = state.levels.length;
    const middle = height / 2;
    const narrow = x => Math.max(0, Math.sin(Math.PI * x / width)) ** 0.85;

    WAVE_LAYERS.forEach(([rest, , humps, start, reach, turns, layerAlpha], k) => {
        const shift = -2 * Math.PI * turns * state.drift / WAVE_LOOP_S;
        const liftAt = i => {
            const idx = centerMirrorIndex(i, count);
            return Math.max(sampleBandLift(state, Math.max(0, idx - 1), k), sampleBandLift(state, idx, k));
        };

        const top = wavePoints(count, width, (x, i) => {
            const lobe = Math.abs(Math.sin(Math.PI * humps * x / height + start + shift));
            const envelope = Math.min(
                1,
                0.55 * rest * (0.05 + 0.95 * (lobe ** 1.3)) +
                2.2 * reach * liftAt(i) * (0.5 + 0.5 * lobe)
            );
            return middle - middle * narrow(x) * envelope;
        });
        const bottom = top.map(([x, y]) => [x, height - y]).reverse();

        fillClosedPath(cr, state, width, height, true, layerAlpha, () => {
            cr.moveTo(...top[0]);
            curveThrough(cr, top);
            cr.lineTo(...bottom[0]);
            curveThrough(cr, bottom);
            cr.closePath();
        });
    });

    const fade = getCachedGradient(state, `ribbon-fade|${width}`, () => {
        const grad = new Cairo.LinearGradient(0, 0, width, 0);
        for (let n = 0; n <= 8; n++)
            grad.addColorStopRGBA(n / 8, 0, 0, 0, 0.7 * narrow(n * width / 8));
        return grad;
    });
    const lineHalf = Math.max(0.75 * scale, height / 32);
    cr.save();
    cr.rectangle(0, middle - lineHalf, width, lineHalf * 2);
    cr.clip();
    setGradient(cr, state, width, height, true, 1);
    cr.mask(fade);
    cr.restore();
}

function repaintSoundwave(cr, state, width, height, scale) {
    const count = state.levels.length;
    const pitch = width / count;
    const strokeW = clamp(pitch * 0.48, 1.4 * scale, 4.2 * scale);
    const middle = height / 2;
    const maxHalf = Math.max(3 * scale, middle - scale);

    cr.setLineCap(Cairo.LineCap.ROUND);
    cr.setLineWidth(strokeW);

    for (let i = 0; i < count; i++) {
        const cx = (i + 0.5) * pitch;
        const taper = state.fixedWidth > 0 ? (0.45 + 0.55 * Math.sin(Math.PI * (i + 0.5) / count)) : 1;
        const level = clamp(state.levels[i] * taper, 0, 1);
        const halfH = Math.max(strokeW * 0.55, level * maxHalf);
        const [r, g, b] = colorAt(state, i, count, level);

        cr.setSourceRGBA(r, g, b, state.alpha);
        cr.moveTo(cx, middle - halfH);
        cr.lineTo(cx, middle + halfH);
        cr.stroke();

        if (state.showPeaks && state.isLive) {
            const pk = clamp(state.peaks[i] * taper, 0, 1);
            if (pk > level + 0.08) {
                const [pr, pg, pb] = colorAt(state, i, count, pk);
                const py = pk * maxHalf;
                cr.setSourceRGBA(pr, pg, pb, state.alpha * 0.9);
                cr.newSubPath();
                cr.arc(cx, middle - py, strokeW * 0.5, 0, 2 * Math.PI);
                cr.newSubPath();
                cr.arc(cx, middle + py, strokeW * 0.5, 0, 2 * Math.PI);
                cr.fill();
            }
        }
    }
}

function repaintLine(cr, state, width, height, scale) {
    const count = state.levels.length;
    const pad = Math.max(2 * scale, height * 0.12);
    const usableH = Math.max(4 * scale, height - 2 * pad);

    const strokeCurve = (arr, lineW, alphaScale) => {
        const pts = wavePoints(count, width, (_x, i) => height - pad - clamp(arr[i % count], 0, 1) * usableH);
        cr.moveTo(...pts[0]);
        curveThrough(cr, pts);
        cr.setLineCap(Cairo.LineCap.ROUND);
        cr.setLineJoin(Cairo.LineJoin.ROUND);
        cr.setLineWidth(lineW);
        setGradient(cr, state, width, height, false, alphaScale);
        cr.stroke();
    };

    if (state.showPeaks && state.isLive)
        strokeCurve(state.peaks, 1.1 * scale, 0.38);
    strokeCurve(state.levels, 2.0 * scale, 1);
}

function repaintAurora(cr, state, width, height, scale) {
    const count = state.levels.length;
    const padTop = Math.max(2 * scale, height * 0.1);
    const usableH = Math.max(4 * scale, height - padTop);
    const pts = wavePoints(count, width, (x, i) => {
        const lvl = clamp(state.levels[i % count], 0, 1);
        const pk = state.showPeaks ? clamp(state.peaks[i % count], 0, 1) : lvl;
        const v = lvl * 0.72 + pk * 0.28;
        const ripple = 0.04 * Math.sin(Math.PI * 2.5 * x / Math.max(1, width) - state.drift * 2.5);
        return height - clamp(v + ripple, 0.05, 1) * usableH;
    });

    const buildClosedAurora = () => {
        cr.moveTo(0, height);
        cr.lineTo(...pts[0]);
        curveThrough(cr, pts);
        cr.lineTo(width, height);
        cr.closePath();
    };

    if (state.colorMode !== 'accent') {
        fillClosedPath(cr, state, width, height, false, 0.45, buildClosedAurora);
    } else {
        const alphaKey = Math.round(state.alpha * 1000);
        const vert = getCachedGradient(state, `aurora-vert|${padTop}|${height}|${state.ink.join(',')}|${alphaKey}`, () => {
            const grad = new Cairo.LinearGradient(0, padTop, 0, height);
            grad.addColorStopRGBA(0, state.ink[0], state.ink[1], state.ink[2], state.alpha * 0.72);
            grad.addColorStopRGBA(1, state.ink[0], state.ink[1], state.ink[2], state.alpha * 0.05);
            return grad;
        });
        buildClosedAurora();
        cr.setSource(vert);
        cr.fill();
    }

    cr.moveTo(...pts[0]);
    curveThrough(cr, pts);
    cr.setLineCap(Cairo.LineCap.ROUND);
    cr.setLineWidth(1.8 * scale);
    if (state.colorMode === 'rainbow') {
        const [r, g, b] = hsvToRgb(state.hue, HUE_SATURATION, state.lightInk ? 1 : 0.82);
        cr.setSourceRGBA(r, g, b, state.alpha);
    } else {
        cr.setSourceRGBA(state.ink[0], state.ink[1], state.ink[2], state.alpha);
    }
    cr.stroke();
}

function repaintSideWings(cr, state, cx, cy, maxR, width, height, scale, mode, baseColor = null) {
    if (width <= height * 1.6)
        return;

    const count = state.levels.length;
    const wingPad = (mode === 'ring' ? 4 : 3) * scale;
    const wingStart = maxR + wingPad;
    const wingSpan = Math.max(0, cx - wingStart);

    if (mode === 'ring') {
        if (wingSpan <= 6 * scale)
            return;
        const wingCount = Math.max(4, Math.min(count, Math.floor(wingSpan / (3 * scale))));
        const { colW: wingBarW, pitch: wingPitch } = columnMetrics(wingSpan, wingCount, wingSpan * 0.04, scale);
        const wingMaxHalf = Math.max(2 * scale, height * 0.36);

        cr.setLineCap(Cairo.LineCap.ROUND);
        cr.setLineWidth(Math.min(wingBarW, 2.6 * scale));
        for (const side of [-1, 1]) {
            for (let j = 0; j < wingCount; j++) {
                const lvl = clamp(state.levels[Math.floor((j / wingCount) * count)], 0.06, 1);
                const fade = 1 - (j / Math.max(1, wingCount)) * 0.55;
                const halfH = Math.max(scale, lvl * wingMaxHalf * fade);
                const bx = cx + side * (wingStart + j * wingPitch + wingBarW * 0.5);
                const [wr, wg, wb] = colorAt(state, j, wingCount, lvl);
                cr.setSourceRGBA(wr, wg, wb, state.alpha * 0.72 * fade);
                cr.moveTo(bx, cy - halfH);
                cr.lineTo(bx, cy + halfH);
                cr.stroke();
            }
        }
        return;
    }

    if (wingSpan <= 8 * scale)
        return;
    const steps = 16;
    const [crR, crG, crB] = baseColor ?? state.ink;
    cr.setLineCap(Cairo.LineCap.ROUND);
    cr.setLineWidth(1.6 * scale);
    for (const side of [-1, 1]) {
        for (const signY of [-1, 1]) {
            for (let s = 0; s <= steps; s++) {
                const frac = s / steps;
                const px = cx + side * (wingStart + frac * wingSpan);
                const idx = Math.min(count - 1, Math.floor(frac * count));
                const amp = (0.15 + 0.85 * state.levels[idx]) * (1 - frac * 0.8) *
                    (height * 0.38) * Math.sin(frac * Math.PI * 2.2 - state.pulsePhase * Math.PI * 2);
                const py = cy + signY * Math.abs(amp);
                if (s === 0)
                    cr.moveTo(px, py);
                else
                    cr.lineTo(px, py);
            }
            cr.setSourceRGBA(crR, crG, crB, state.alpha * 0.55);
            cr.stroke();
        }
    }
}

function repaintRing(cr, state, width, height, scale) {
    const count = state.levels.length;
    const cx = width / 2;
    const cy = height / 2;
    const maxR = Math.max(5 * scale, Math.min(width, height) * 0.46);
    const rInner = maxR * 0.42;
    const strokeW = clamp((2 * Math.PI * rInner) / (count * 1.9), 1.2 * scale, 3.5 * scale);

    repaintSideWings(cr, state, cx, cy, maxR, width, height, scale, 'ring');

    cr.setLineCap(Cairo.LineCap.ROUND);
    cr.setLineWidth(strokeW);

    cr.setSourceRGBA(state.ink[0], state.ink[1], state.ink[2], state.alpha * UNLIT_ALPHA);
    cr.newSubPath();
    cr.arc(cx, cy, rInner * 0.85, 0, 2 * Math.PI);
    cr.stroke();

    for (let i = 0; i < count; i++) {
        const angle = -Math.PI / 2 + (2 * Math.PI * i) / count;
        const level = clamp(state.levels[i], 0.06, 1);
        const rOuter = rInner + level * (maxR - rInner);
        const [r, g, b] = colorAt(state, i, count, level);

        cr.setSourceRGBA(r, g, b, state.alpha);
        cr.moveTo(cx + Math.cos(angle) * rInner, cy + Math.sin(angle) * rInner);
        cr.lineTo(cx + Math.cos(angle) * rOuter, cy + Math.sin(angle) * rOuter);
        cr.stroke();

        if (state.showPeaks && state.isLive) {
            const pk = clamp(state.peaks[i], 0, 1);
            if (pk > level + 0.08) {
                const rPk = rInner + pk * (maxR - rInner);
                const [pr, pg, pb] = colorAt(state, i, count, pk);
                cr.setSourceRGBA(pr, pg, pb, state.alpha);
                cr.newSubPath();
                cr.arc(
                    cx + Math.cos(angle) * rPk,
                    cy + Math.sin(angle) * rPk,
                    strokeW * 0.45,
                    0,
                    2 * Math.PI
                );
                cr.fill();
            }
        }
    }
}

function repaintPulse(cr, state, width, height, scale) {
    const count = state.levels.length;
    const bassCount = Math.max(1, Math.floor(count * 0.35));
    let bass = 0;
    let highs = 0;
    for (let i = 0; i < count; i++) {
        if (i < bassCount)
            bass += state.levels[i];
        else
            highs += state.levels[i];
    }
    bass /= bassCount;
    highs /= Math.max(1, count - bassCount);

    const cx = width / 2;
    const cy = height / 2;
    const maxR = Math.max(5 * scale, Math.min(width, height) * 0.45);

    for (let ring = 0; ring < 3; ring++) {
        const phase = (state.pulsePhase + ring / 3) % 1;
        const radius = maxR * (0.28 + 0.72 * phase) * (0.75 + 0.25 * bass);
        const ringAlpha = state.alpha * (1 - phase) * (0.4 + 0.6 * bass);
        const [r, g, b] = colorAt(state, ring, 3, bass);
        cr.setSourceRGBA(r, g, b, clamp(ringAlpha, 0.08, 1));
        cr.setLineWidth(Math.max(1.2 * scale, (1.8 - ring * 0.3) * scale));
        cr.newSubPath();
        cr.arc(cx, cy, radius, 0, 2 * Math.PI);
        cr.stroke();
    }

    const coreR = maxR * (0.22 + 0.28 * (bass * 0.7 + highs * 0.3));
    const coreColor = colorAt(state, 0, 1, bass);
    cr.setSourceRGBA(coreColor[0], coreColor[1], coreColor[2], state.alpha);
    cr.newSubPath();
    cr.arc(cx, cy, coreR, 0, 2 * Math.PI);
    cr.fill();

    repaintSideWings(cr, state, cx, cy, maxR, width, height, scale, 'pulse', coreColor);
}

function repaintHistory(cr, state, width, height, scale) {
    const hist = state.history || state.levels;
    const count = hist.length;
    const { colW, pitch } = columnMetrics(width, count, Math.round(height * 0.06), scale);
    const middle = height / 2;
    const maxHalf = Math.max(2 * scale, middle - scale);

    for (let i = 0; i < count; i++) {
        const x = i * pitch;
        const ageFade = 0.28 + 0.72 * (i / Math.max(1, count - 1));
        const lvl = clamp(hist[i], 0.06, 1);
        const h = Math.max(colW, lvl * maxHalf * 2);
        const y = middle - h / 2;
        const [r, g, b] = colorAt(state, i, count, lvl);
        cr.setSourceRGBA(r, g, b, state.alpha * ageFade);
        drawPill(cr, x, y, colW, h);
        cr.fill();
    }
}

export function renderSpectrumFrame(cr, state, width, height, scale) {
    if (!state.levels?.length || width <= 0 || height <= 0)
        return;

    switch (state.style) {
    case 'center-bars':
        repaintBars(cr, state, width, height, scale, false, centerMirrorIndex);
        break;
    case 'wave':
        repaintWave(cr, state, width, height);
        break;
    case 'aurora':
        repaintAurora(cr, state, width, height, scale);
        break;
    case 'line':
        repaintLine(cr, state, width, height, scale);
        break;
    case 'soundwave':
        repaintSoundwave(cr, state, width, height, scale);
        break;
    case 'dots':
        repaintDots(cr, state, width, height, scale);
        break;
    case 'mirror':
        repaintBars(cr, state, width, height, scale, true);
        break;
    case 'segments':
        repaintSegments(cr, state, width, height, scale);
        break;
    case 'matrix':
        repaintMatrix(cr, state, width, height, scale);
        break;
    case 'ribbon':
        repaintRibbon(cr, state, width, height, scale);
        break;
    case 'ring':
        repaintRing(cr, state, width, height, scale);
        break;
    case 'pulse':
        repaintPulse(cr, state, width, height, scale);
        break;
    case 'history':
        repaintHistory(cr, state, width, height, scale);
        break;
    case 'bars':
    default:
        repaintBars(cr, state, width, height, scale, false);
        break;
    }
}
