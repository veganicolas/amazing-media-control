import Cairo from 'cairo';
import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import St from 'gi://St';

import { getStageScaleFactor } from './iconUtils.js';
import { SPECTRUM_BANDS } from './spectrumAnalyzer.js';
import { clamp, renderSpectrumFrame, WAVE_LOOP_S } from './spectrumRenderers.js';

const FRAME_MS = 33;
const FALL_PER_S = 2.4;
const PEAK_HOLD_MS = 450;
const PEAK_FALL_PER_S = 1.1;
const WAVE_RISE_S = 0.16;

const DEFAULT_COLUMNS = 6;
const DEFAULT_RANGE_DB = 32;
const REFERENCE_RANGE_DB = 48;
const HUE_PERIOD = 10;
const HUE_STATIC = 0.58;

const STYLE_COUNTS = {
    bars: DEFAULT_COLUMNS,
    'center-bars': DEFAULT_COLUMNS,
    wave: 8,
    aurora: 8,
    line: 8,
    soundwave: 10,
    dots: DEFAULT_COLUMNS,
    mirror: DEFAULT_COLUMNS,
    segments: DEFAULT_COLUMNS,
    matrix: 8,
    ribbon: 8,
    ring: 12,
    pulse: 8,
    history: 14,
};

const CONTINUOUS_CURVE_STYLES = new Set(['wave', 'ribbon', 'aurora', 'line']);

const VALID_COLOR_MODES = new Set(['accent', 'classic', 'level', 'rainbow']);

const REST_CURVE = [0.22, 0.34, 0.48, 0.38, 0.52, 0.32, 0.40, 0.24];
const FALLBACK_SPEEDS = [4.8, 7.1, 6.2, 8.9, 5.4, 7.7, 6.5, 5.1];

/**
 * Audio-reactive spectrum widget drawn with Cairo, driven by real FFT bands
 * from SpectrumAnalyzer (`pulsesrc` default monitor) when available, with a
 * graceful animated fallback if audio capture is unavailable.
 */
export const SpectrumWidget = GObject.registerClass(
class SpectrumWidget extends St.DrawingArea {
    _init() {
        super._init({
            style_class: 'amc-spectrum-area',
            y_align: Clutter.ActorAlign.CENTER,
            reactive: false,
        });

        this._style = 'bars';
        this._fontSize = 13;
        this._columns = DEFAULT_COLUMNS;
        this._widthPx = 0;
        this._rangeDb = DEFAULT_RANGE_DB;
        this._showPeaks = true;
        this._drawTrack = true;
        this._colorMode = 'accent';
        this._playing = false;
        this._allSound = false;
        this._demoAnimation = false;
        this._invert = false;
        this._frameMs = FRAME_MS;
        this._fixedWidth = 0;
        this._fixedHeight = 0;
        this._accentCss = '';
        this._analyzer = null;
        this._heard = null;
        this._held = false;
        this._destroyed = false;
        this._pulsePhase = 0;
        this._gradientCache = { key: '', gradient: null, entries: new Map() };

        this._timerId = 0;
        this._startUs = GLib.get_monotonic_time();
        this._lastStepUs = this._startUs;
        this._drift = 0;
        this._hue = HUE_STATIC;

        this._stSettings = St.Settings.get();
        this._resetLevels(true);
        this._updateSize();

        this._mappedSigId = this.connect('notify::mapped', () => {
            this._syncLoop();
        });
        this._styleChangedSigId = this.connect('style-changed', () => {
            this._updateSize();
            this.queue_relayout();
            this.queue_repaint();
        });
        this._animSigId = this._stSettings.connect('notify::enable-animations', () => {
            this._onAnimationsChanged();
        });
        this._destroySigId = this.connect('destroy', () => this._cleanup());
    }

    _applyLayoutChange(forceReset = false) {
        this._resetLevels(forceReset);
        this._updateSize();
        this.queue_relayout();
        if (this.mapped && this._timerId === 0 && (this._isLive() || this._needsSettle()))
            this._syncLoop();
        this.queue_repaint();
    }

    _applyLiveChange() {
        this._lastStepUs = GLib.get_monotonic_time();
        this._syncHold();
        if (!this._animationsEnabled()) {
            this._stopTimer();
            this._resetLevels(true);
        } else {
            this._ensureTimer();
        }
        this.queue_repaint();
    }

    _syncLoop() {
        if (this._destroyed)
            return;
        this._syncHold();
        if (!this._animationsEnabled()) {
            this._stopTimer();
            return;
        }
        this._ensureTimer();
    }

    /**
     * Batch-applies multiple spectrum configuration options in a single update pass.
     *
     * @param {object} cfg
     */
    applyConfig(cfg = {}) {
        if (this._destroyed || !cfg)
            return;

        if (cfg.analyzer !== undefined)
            this.setAnalyzer(cfg.analyzer);

        let layoutChanged = false;
        let styleChanged = false;
        let sizeOnlyChanged = false;
        let liveChanged = false;
        let fpsChanged = false;
        let repaintNeeded = false;

        const rawStyle = cfg.style ?? cfg.spectrumStyle;
        if (rawStyle !== undefined) {
            const nextStyle = Object.hasOwn(STYLE_COUNTS, rawStyle) ? rawStyle : 'bars';
            if (this._style !== nextStyle) {
                this._style = nextStyle;
                layoutChanged = true;
                styleChanged = true;
            }
        }

        const rawColumns = cfg.columns ?? cfg.spectrumColumns;
        if (rawColumns !== undefined) {
            const parsed = Number.isFinite(rawColumns) ? Math.round(rawColumns) : DEFAULT_COLUMNS;
            const next = clamp(parsed, 4, 24);
            if (this._columns !== next) {
                this._columns = next;
                layoutChanged = true;
            }
        }

        const rawWidthPx = cfg.widthPx ?? cfg.spectrumWidth;
        if (rawWidthPx !== undefined) {
            const parsed = Number.isFinite(rawWidthPx) ? Math.round(rawWidthPx) : 0;
            const next = parsed <= 0 ? 0 : clamp(parsed, 24, 220);
            if (this._widthPx !== next) {
                this._widthPx = next;
                layoutChanged = true;
            }
        }

        const rawTargetW = cfg.targetWidth ?? cfg.fixedWidth ?? cfg.width;
        const rawTargetH = cfg.targetHeight ?? cfg.fixedHeight ?? cfg.height;
        if (rawTargetW !== undefined || rawTargetH !== undefined) {
            const w = Math.max(0, Math.round((rawTargetW !== undefined ? rawTargetW : this._fixedWidth) || 0));
            const h = Math.max(0, Math.round((rawTargetH !== undefined ? rawTargetH : this._fixedHeight) || 0));
            const nextW = (w > 0 && h > 0) ? w : 0;
            const nextH = (w > 0 && h > 0) ? h : 0;
            if (this._fixedWidth !== nextW || this._fixedHeight !== nextH) {
                this._fixedWidth = nextW;
                this._fixedHeight = nextH;
                layoutChanged = true;
            }
        }

        const rawScale = cfg.scale ?? cfg.fontSize ?? cfg.barFontSize;
        if (rawScale !== undefined) {
            const nextSize = Math.max(10, Math.round(rawScale));
            if (this._fontSize !== nextSize) {
                this._fontSize = nextSize;
                sizeOnlyChanged = true;
            }
        }

        const rawRange = cfg.rangeDb ?? cfg.spectrumRange;
        if (rawRange !== undefined) {
            const parsed = Number.isFinite(rawRange) ? Math.round(rawRange) : DEFAULT_RANGE_DB;
            this._rangeDb = clamp(parsed, 12, 48);
        }

        const rawPeaks = cfg.showPeaks ?? cfg.spectrumPeaks;
        if (rawPeaks !== undefined) {
            const next = Boolean(rawPeaks);
            if (this._showPeaks !== next) {
                this._showPeaks = next;
                repaintNeeded = true;
            }
        }

        if (cfg.drawTrack !== undefined) {
            const next = Boolean(cfg.drawTrack);
            if (this._drawTrack !== next) {
                this._drawTrack = next;
                layoutChanged = true;
            }
        }

        const rawColorMode = cfg.colorMode ?? cfg.spectrumColors;
        if (rawColorMode !== undefined) {
            const next = VALID_COLOR_MODES.has(rawColorMode) ? rawColorMode : 'accent';
            if (this._colorMode !== next) {
                this._colorMode = next;
                repaintNeeded = true;
            }
        }

        const rawFps = cfg.fps ?? cfg.spectrumFps;
        if (rawFps !== undefined) {
            const parsed = Number.isFinite(rawFps) ? clamp(Math.round(rawFps), 10, 60) : 30;
            const nextMs = Math.max(16, Math.round(1000 / parsed));
            if (this._frameMs !== nextMs) {
                this._frameMs = nextMs;
                fpsChanged = true;
            }
        }

        const rawInvert = cfg.invert ?? cfg.spectrumInvert;
        if (rawInvert !== undefined) {
            const next = Boolean(rawInvert);
            if (this._invert !== next) {
                this._invert = next;
                repaintNeeded = true;
            }
        }

        if (cfg.accentColor !== undefined) {
            const next = cfg.accentColor || '';
            if (this._accentCss !== next) {
                this._accentCss = next;
                this.style = next ? `color: ${next};` : null;
                repaintNeeded = true;
            }
        }

        const rawAllSound = cfg.allSound ?? cfg.spectrumAllSound;
        if (rawAllSound !== undefined) {
            const next = Boolean(rawAllSound);
            if (this._allSound !== next) {
                this._allSound = next;
                liveChanged = true;
            }
        }

        const rawDemo = cfg.demoAnimation ?? cfg.spectrumDemoAnimation;
        if (rawDemo !== undefined) {
            const next = Boolean(rawDemo);
            if (this._demoAnimation !== next) {
                this._demoAnimation = next;
                liveChanged = true;
            }
        }

        if (cfg.playing !== undefined) {
            const next = Boolean(cfg.playing);
            if (this._playing !== next) {
                this._playing = next;
                liveChanged = true;
            }
        }

        if (layoutChanged) {
            this._applyLayoutChange(styleChanged && !this._isLive());
            repaintNeeded = false;
        } else if (sizeOnlyChanged) {
            this._updateSize();
            this.queue_relayout();
            repaintNeeded = true;
        }

        if (liveChanged) {
            this._applyLiveChange();
            return;
        }

        if (fpsChanged && this._timerId) {
            this._stopTimer();
            this._ensureTimer();
        } else if (this.mapped && this._timerId === 0 && (this._isLive() || this._needsSettle())) {
            this._syncLoop();
        }

        if (repaintNeeded)
            this.queue_repaint();
    }

    _detachAnalyzer() {
        if (!this._analyzer)
            return;
        if (this._held) {
            this._analyzer.release(this);
            this._held = false;
        }
        this._analyzer = null;
    }

    setAnalyzer(analyzer) {
        if (this._destroyed || this._analyzer === analyzer)
            return;
        this._detachAnalyzer();
        this._analyzer = analyzer ?? null;
        this._syncHold();
    }

    setStyle(style) {
        this.applyConfig({ style });
    }

    setColumns(columns) {
        this.applyConfig({ columns });
    }

    setWidthPx(widthPx) {
        this.applyConfig({ widthPx });
    }

    setTargetSize(targetWidth = 0, targetHeight = 0) {
        this.applyConfig({ targetWidth, targetHeight });
    }

    setDemoAnimation(demoAnimation) {
        this.applyConfig({ demoAnimation });
    }

    setRangeDb(rangeDb) {
        this.applyConfig({ rangeDb });
    }

    setShowPeaks(showPeaks = true) {
        this.applyConfig({ showPeaks });
    }

    setDrawTrack(drawTrack = true) {
        this.applyConfig({ drawTrack });
    }

    setColorMode(colorMode) {
        this.applyConfig({ colorMode });
    }

    setFps(fps) {
        this.applyConfig({ fps });
    }

    setInvert(invert) {
        this.applyConfig({ invert });
    }

    setAllSound(allSound) {
        this.applyConfig({ allSound });
    }

    _isLive() {
        return this._playing || this._allSound || this._demoAnimation;
    }

    setAccentColor(accentColor) {
        this.applyConfig({ accentColor });
    }

    setScale(scale) {
        this.applyConfig({ scale });
    }

    setPlaying(playing) {
        this.applyConfig({ playing });
    }

    /**
     * Called directly by SpectrumAnalyzer whenever a new FFT frame arrives.
     * Merges per-band peaks so transient spikes between repaint ticks are preserved.
     *
     * @param {Float32Array} bands
     */
    hear(bands) {
        if (this._destroyed || !bands)
            return;

        if (this._heard && this._heard.length === bands.length) {
            for (let i = 0; i < this._heard.length; i++)
                this._heard[i] = Math.max(this._heard[i], bands[i] ?? 0);
        } else {
            this._heard = new Float32Array(bands);
        }

        if (this._isLive() && this._timerId === 0 && this._animationsEnabled())
            this._ensureTimer();
    }

    /**
     * Called by SpectrumAnalyzer if subprocess state changes or audio wakes from silence.
     */
    wake() {
        this._syncLoop();
    }

    _animationsEnabled() {
        if (this._isLive())
            return true;
        return this._stSettings ? this._stSettings.enable_animations !== false : true;
    }

    _onAnimationsChanged() {
        if (this._destroyed)
            return;
        this._syncHold();
        if (!this._animationsEnabled()) {
            this._stopTimer();
            this._resetLevels(true);
            this.queue_repaint();
            return;
        }
        this._ensureTimer();
        this.queue_repaint();
    }

    _effectiveCount() {
        const wide = this._fixedWidth > 0;
        if (CONTINUOUS_CURVE_STYLES.has(this._style))
            return wide ? 20 : STYLE_COUNTS[this._style];
        if (this._style === 'ring')
            return Math.max(10, Math.min(28, this._columns * (wide ? 3 : 2)));
        if (this._style === 'pulse')
            return 8;
        if (this._style === 'history')
            return wide ? 36 : Math.max(12, Math.min(24, this._columns * 2));
        if (this._style === 'soundwave')
            return wide ? Math.max(24, this._columns * 4) : Math.max(10, Math.min(18, Math.round(this._columns * 1.8)));
        if (this._style === 'matrix')
            return wide ? Math.max(20, this._columns * 3) : Math.max(8, Math.min(16, Math.round(this._columns * 1.5)));
        if (wide) {
            if (!this._drawTrack && this._style === 'bars') {
                const gapLogical = Math.max(1, Math.round((this._fixedHeight || 46) * 0.08));
                const pitch = clamp(Math.round(12.2 - this._columns * 0.2), 7, 14);
                return clamp(Math.round((this._fixedWidth + gapLogical) / pitch), 12, 120);
            }
            return Math.max(16, Math.min(36, this._columns * 3));
        }
        return this._columns;
    }

    _updateSize() {
        const scale = getStageScaleFactor();
        if (this._fixedWidth > 0 && this._fixedHeight > 0) {
            this.set_size(
                Math.round(this._fixedWidth * scale),
                Math.round(this._fixedHeight * scale)
            );
            return;
        }

        const baseHeight = Math.max(14, Math.round(this._fontSize * 1.26));
        let baseWidth;
        if (this._widthPx > 0) {
            baseWidth = this._widthPx;
        } else {
            const ratio = this._columns / DEFAULT_COLUMNS;
            const square = this._style === 'ring' || this._style === 'pulse';
            const wide = CONTINUOUS_CURVE_STYLES.has(this._style) ||
                this._style === 'history' ||
                this._style === 'soundwave';
            baseWidth = square
                ? Math.max(16, Math.round(baseHeight * 1.3 * clamp(ratio, 0.85, 2.4)))
                : wide
                    ? Math.max(24, Math.round(baseHeight * 1.95 * ratio))
                    : Math.max(14, Math.round(baseHeight * 1.45 * ratio));
        }
        this.set_size(Math.round(baseWidth * scale), Math.round(baseHeight * scale));
    }

    _historyRestLevel(i) {
        return 0.16 + 0.65 * Math.abs(Math.sin(i * 1.15));
    }

    _restLevel(i) {
        if (this._style === 'wave' || this._style === 'ribbon')
            return 0;
        const count = this._effectiveCount();
        if (this._style === 'aurora' || this._style === 'line')
            return 0.22 + 0.52 * (0.5 + 0.5 * Math.sin(Math.PI * 2 * (i + 0.3) / Math.max(1, count)));
        if (this._style === 'history')
            return this._historyRestLevel(i);
        if (this._style === 'pulse')
            return 0.24;
        if (count !== DEFAULT_COLUMNS)
            return 0.25 + 0.45 * Math.sin(Math.PI * (i + 0.5) / count);
        return REST_CURVE[i % REST_CURVE.length];
    }

    _resetLevels(force = false) {
        const count = this._effectiveCount();
        const zeroPeaks = this._style === 'wave' || this._style === 'ribbon';

        if (!force && this._levels && this._peaks && this._peakTimesUs && this._history) {
            const oldLen = this._levels.length;
            if (oldLen === count) {
                if (zeroPeaks)
                    this._peaks.fill(0);
                return;
            }
            if (oldLen > 0) {
                const mapOld = (arr, fallbackFn) => Array.from({ length: count }, (_, i) => {
                    const srcIdx = Math.min(arr.length - 1, Math.floor(i * arr.length / count));
                    return arr[srcIdx] ?? fallbackFn(i);
                });
                this._levels = mapOld(this._levels, i => this._restLevel(i));
                this._peaks = zeroPeaks
                    ? new Array(count).fill(0)
                    : mapOld(this._peaks, i => this._levels[i]);
                this._peakTimesUs = mapOld(this._peakTimesUs, () => 0);
                this._history = mapOld(this._history, i => this._historyRestLevel(i));
                return;
            }
        }

        this._levels = Array.from({ length: count }, (_, i) => this._restLevel(i));
        this._peaks = zeroPeaks ? new Array(count).fill(0) : [...this._levels];
        this._peakTimesUs = new Array(count).fill(0);
        this._history = Array.from({ length: count }, (_, i) => this._historyRestLevel(i));
        this._heard = null;
    }

    _syncHold() {
        if (!this._analyzer || this._destroyed)
            return;

        const wantHold = this._isLive() && this.mapped && this._animationsEnabled();
        if (wantHold && !this._held) {
            this._held = true;
            this._analyzer.hold(this);
        } else if (!wantHold && this._held) {
            this._held = false;
            this._analyzer.release(this);
        }
    }

    _stopTimer() {
        if (this._timerId) {
            GLib.Source.remove(this._timerId);
            this._timerId = 0;
        }
    }

    _ensureTimer() {
        if (this._destroyed || this._timerId !== 0)
            return;
        if (!this.mapped || !this._animationsEnabled())
            return;

        if (!this._isLive() && !this._needsSettle())
            return;

        this._lastStepUs = GLib.get_monotonic_time();
        this._timerId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, this._frameMs, () => {
            if (this._destroyed || !this.mapped || !this._animationsEnabled()) {
                this._timerId = 0;
                return GLib.SOURCE_REMOVE;
            }

            const nowUs = GLib.get_monotonic_time();
            if (this._isLive()) {
                if (this._step(nowUs))
                    this.queue_repaint();
                return GLib.SOURCE_CONTINUE;
            }

            const moving = this._settle(nowUs);
            this.queue_repaint();
            if (!moving) {
                this._timerId = 0;
                return GLib.SOURCE_REMOVE;
            }
            return GLib.SOURCE_CONTINUE;
        });
    }

    _needsSettle() {
        return this._levels.some((lvl, i) => Math.abs(lvl - this._restLevel(i)) > 0.015) ||
            this._peaks.some((pk, i) => pk - this._levels[i] > 0.015) ||
            (this._style === 'history' &&
                Boolean(this._history?.some((h, i) => Math.abs(h - this._historyRestLevel(i)) > 0.015)));
    }

    _fallbackLevel(i, tSec) {
        const count = Math.max(1, this._levels.length);
        const bassBias = 1 - 0.35 * (i / count);
        const kick = Math.pow(Math.max(0, Math.sin(tSec * 3.1)), 3) * (0.45 * bassBias);
        const s1 = Math.sin(tSec * FALLBACK_SPEEDS[i % FALLBACK_SPEEDS.length] * 0.7 + i * 0.9);
        const s2 = Math.sin(tSec * FALLBACK_SPEEDS[(i + 2) % FALLBACK_SPEEDS.length] + i * 1.7);
        return clamp(((s1 + s2 + 2) / 4) * 0.72 * bassBias + kick + 0.12, 0.10, 0.98);
    }

    _turnDrift(dtSec) {
        const step = Math.min(dtSec, 4 * this._frameMs / 1000);
        this._drift = (this._drift + step) % WAVE_LOOP_S;
        this._hue = (this._hue + step / HUE_PERIOD) % 1;
    }

    _step(nowUs) {
        const dtSec = clamp((nowUs - this._lastStepUs) / 1000000, 0.001, 0.12);
        const tSec = (nowUs - this._startUs) / 1000000;
        this._lastStepUs = nowUs;
        this._turnDrift(dtSec);

        const bands = this._heard ?? this._analyzer?.bands ?? null;
        this._heard = null;

        const hasSignal = bands !== null && bands.some(v => v > 0.001);
        let useFallback;
        if (this._demoAnimation) {
            useFallback = !hasSignal;
        } else {
            const waitingForHelper = Boolean(
                this._analyzer &&
                this._analyzer.listening &&
                !this._analyzer.deaf &&
                !this._analyzer.hasReceivedData
            );
            const usingRealCapture = bands !== null ||
                waitingForHelper ||
                Boolean(this._analyzer && !this._analyzer.deaf && this._analyzer.hasReceivedData);
            useFallback = !usingRealCapture && (this._playing || Boolean(this._analyzer?.deaf));
        }

        const isDrifting = CONTINUOUS_CURVE_STYLES.has(this._style) ||
            this._style === 'pulse' ||
            this._style === 'history' ||
            this._colorMode === 'rainbow';
        const wasZero = !isDrifting &&
            this._levels.every(v => v === 0) &&
            this._peaks.every(v => v === 0);
        let allTargetsZero = true;

        const smoothRise = CONTINUOUS_CURVE_STYLES.has(this._style);
        const stretch = REFERENCE_RANGE_DB / this._rangeDb;
        const count = this._levels.length;
        let frameEnergy = 0;

        for (let i = 0; i < count; i++) {
            const bandSlot = this._invert ? (count - 1 - i) : i;
            let target = 0;

            if (bands && !useFallback) {
                const from = Math.floor(bandSlot * SPECTRUM_BANDS / count);
                const to = Math.max(from + 1, Math.floor((bandSlot + 1) * SPECTRUM_BANDS / count));
                let sum = 0;
                let peak = 0;
                for (let b = from; b < to; b++) {
                    const raw = clamp(bands[b] ?? 0, 0, 1);
                    const v = Math.max(0, 1 - (1 - raw) * stretch);
                    sum += v;
                    if (v > peak)
                        peak = v;
                }
                const avg = sum / (to - from);
                target = clamp(avg * 0.55 + peak * 0.45, 0, 1);
            } else if (useFallback) {
                target = this._fallbackLevel(bandSlot, tSec);
            }

            if (target > 0)
                allTargetsZero = false;

            if (smoothRise && !useFallback && target > this._levels[i]) {
                this._levels[i] += (target - this._levels[i]) * Math.min(1, dtSec / WAVE_RISE_S);
            } else if (useFallback || target >= this._levels[i]) {
                this._levels[i] = target;
            } else {
                this._levels[i] = Math.max(target, this._levels[i] - FALL_PER_S * dtSec);
            }
            if (!useFallback && this._levels[i] <= 0.001)
                this._levels[i] = 0;

            frameEnergy += this._levels[i];

            if (this._levels[i] >= this._peaks[i]) {
                this._peaks[i] = this._levels[i];
                this._peakTimesUs[i] = nowUs;
            } else if (nowUs - this._peakTimesUs[i] > PEAK_HOLD_MS * 1000) {
                this._peaks[i] = Math.max(
                    this._levels[i],
                    this._peaks[i] - PEAK_FALL_PER_S * dtSec
                );
            }
            if (!useFallback && this._peaks[i] <= 0.001)
                this._peaks[i] = 0;
        }

        const meanEnergy = count > 0 ? frameEnergy / count : 0;
        this._pulsePhase = (this._pulsePhase + dtSec * (0.9 + meanEnergy * 2.2)) % 1;

        if (!this._history || this._history.length !== count)
            this._history = new Array(count).fill(0.18);
        this._history.shift();
        const histSample = useFallback
            ? clamp(0.18 + Math.pow(Math.abs(Math.sin(tSec * 3.1)), 2) * 0.78, 0.10, 0.98)
            : clamp(meanEnergy * 1.35, 0.08, 1);
        this._history.push(histSample);

        return !(wasZero && allTargetsZero);
    }

    _settle(nowUs) {
        const dtSec = clamp((nowUs - this._lastStepUs) / 1000000, 0.001, 0.12);
        this._lastStepUs = nowUs;
        this._turnDrift(dtSec);

        let stillMoving = false;
        for (let i = 0; i < this._levels.length; i++) {
            const rest = this._restLevel(i);
            const cur = this._levels[i];
            if (Math.abs(cur - rest) > 0.01) {
                if (cur > rest)
                    this._levels[i] = Math.max(rest, cur - FALL_PER_S * dtSec);
                else
                    this._levels[i] = Math.min(rest, cur + FALL_PER_S * 0.7 * dtSec);
                stillMoving = true;
            } else {
                this._levels[i] = rest;
            }

            if (this._peaks[i] - this._levels[i] > 0.01) {
                this._peaks[i] = Math.max(this._levels[i], this._peaks[i] - PEAK_FALL_PER_S * dtSec);
                stillMoving = true;
            } else {
                this._peaks[i] = this._levels[i];
            }

            if (this._style === 'history' && this._history && i < this._history.length) {
                const histRest = this._historyRestLevel(i);
                const curHist = this._history[i];
                if (Math.abs(curHist - histRest) > 0.01) {
                    if (curHist > histRest)
                        this._history[i] = Math.max(histRest, curHist - FALL_PER_S * dtSec);
                    else
                        this._history[i] = Math.min(histRest, curHist + FALL_PER_S * 0.7 * dtSec);
                    stillMoving = true;
                } else {
                    this._history[i] = histRest;
                }
            }
        }
        return stillMoving;
    }

    vfunc_repaint() {
        if (this._destroyed)
            return;
        const parent = this.get_parent();
        if (!parent)
            return;

        const [width, height] = this.get_surface_size();
        if (width <= 0 || height <= 0)
            return;

        const cr = this.get_context();
        try {
            const themeNode = this.get_theme_node();
            const color = themeNode.get_foreground_color();
            const parentNode = typeof parent.get_theme_node === 'function'
                ? parent.get_theme_node()
                : themeNode;
            const parentColor = parentNode.get_foreground_color();
            const lightInk = (parentColor.red + parentColor.green + parentColor.blue) / 3 > 127;
            // Classic mode uses clean monochrome base + red peaks, ignoring any accent tint on the widget.
            const ink = this._colorMode === 'classic'
                ? (lightInk ? [1, 1, 1] : [0.12, 0.12, 0.14])
                : [color.red / 255, color.green / 255, color.blue / 255];
            const alpha = (this._colorMode === 'classic' ? 0.95 : (color.alpha / 255)) *
                (this._isLive() ? 0.96 : 0.56);
            const scale = getStageScaleFactor();

            cr.setOperator(Cairo.Operator.CLEAR);
            cr.paint();
            cr.setOperator(Cairo.Operator.OVER);

            renderSpectrumFrame(cr, {
                style: this._style,
                levels: this._levels,
                peaks: this._peaks,
                history: this._history,
                ink,
                alpha,
                lightInk,
                colorMode: this._colorMode,
                hue: this._hue,
                drift: this._drift,
                pulsePhase: this._pulsePhase,
                showPeaks: this._showPeaks,
                drawTrack: this._drawTrack,
                isLive: this._isLive(),
                fixedWidth: this._fixedWidth,
                fixedHeight: this._fixedHeight,
                gradientCache: this._gradientCache,
            }, width, height, scale);
        } finally {
            cr.$dispose();
        }
    }

    _cleanup() {
        if (this._destroyed)
            return;
        this._destroyed = true;

        this._stopTimer();
        if (this._mappedSigId) {
            this.disconnect(this._mappedSigId);
            this._mappedSigId = 0;
        }
        if (this._styleChangedSigId) {
            this.disconnect(this._styleChangedSigId);
            this._styleChangedSigId = 0;
        }
        if (this._animSigId && this._stSettings) {
            this._stSettings.disconnect(this._animSigId);
            this._animSigId = 0;
        }
        this._stSettings = null;
        if (this._destroySigId) {
            this.disconnect(this._destroySigId);
            this._destroySigId = 0;
        }
        this._detachAnalyzer();
        this._heard = null;
        this._gradientCache = null;
    }

    destroy() {
        this._cleanup();
        super.destroy();
    }
});
