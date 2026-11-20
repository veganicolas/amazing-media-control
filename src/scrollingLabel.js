import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Pango from 'gi://Pango';
import St from 'gi://St';

import { getStageScaleFactor } from './iconUtils.js';
import { easeOutCubic, easeOutFade, startTween } from './tweenUtils.js';

const SCROLL_PAUSE_MS = 1400;
const SCROLL_RETURN_MS = 450;
const SCROLL_SPEED_PX_PER_S = 36;
const SCROLL_FRAME_MS = 25;
const RESIZE_DURATION_MS = 280;
const RESIZE_FRAME_MS = 16;

/**
 * Single-line label inside a clipped BinLayout that smoothly scrolls back and
 * forth when its text exceeds `maxWidth` and `scroll` is enabled.
 */
export const ScrollingLabel = GObject.registerClass(
class ScrollingLabel extends St.Widget {
    _init({ styleClass = 'amc-track-label', text = '' } = {}) {
        super._init({
            style_class: 'amc-scroll-wrap',
            layout_manager: new Clutter.BinLayout(),
            clip_to_allocation: true,
            y_align: Clutter.ActorAlign.CENTER,
        });

        this._label = new St.Label({
            style_class: styleClass,
            text,
            y_align: Clutter.ActorAlign.CENTER,
        });
        this._label.clutter_text.single_line_mode = true;
        this._label.clutter_text.ellipsize = Pango.EllipsizeMode.NONE;
        this.add_child(this._label);

        this._scroll = true;
        this._animateResize = true;
        this._maxWidth = 240;
        this._fontSize = 13;
        this._overflow = 0;
        this._currentWidth = -1;
        this._resizeTween = null;
        this._idleId = 0;
        this._walkTimerId = 0;
        this._walkStartUs = 0;
        this._walkElapsedMs = 0;
        this._walkDurationMs = 0;
        this._awayMs = 0;
        this._walkText = null;
        this._unmappedAtUs = 0;
        this._destroyed = false;

        this._mappedSigId = this.connect('notify::mapped', () => {
            if (!this.mapped) {
                this._stopResize(false);
                this._unmappedAtUs = GLib.get_monotonic_time();
            } else if (this._unmappedAtUs > 0 &&
                GLib.get_monotonic_time() - this._unmappedAtUs > 1500000) {
                this._currentWidth = -1;
            }
            this._restart();
        });
        this._destroySigId = this.connect('destroy', () => this._cleanup());
    }

    _scaleFactor() {
        return getStageScaleFactor();
    }

    _syncEllipsize(mode) {
        const ct = this._label?.clutter_text;
        if (ct && ct.ellipsize !== mode)
            ct.ellipsize = mode;
    }

    get text() {
        return this._destroyed ? '' : this._label.text;
    }

    set text(value) {
        if (this._destroyed)
            return;
        const next = value ?? '';
        if (this._label.text === next)
            return;

        const shouldAnimate = this._animateResize &&
            this.mapped &&
            this._currentWidth > 0;
        const fromWidth = this._currentWidth;

        this._label.text = next;

        this._stopWalk();
        this._label.translation_x = 0;
        this._overflow = 0;
        this._walkText = null;

        if (!shouldAnimate) {
            this._stopResize();
            this._currentWidth = -1;
            this._label.opacity = 255;
            this.queue_relayout();
            return;
        }

        const [, toWidth] = this._measureTargetWidth(-1);
        this._stopResize();
        this._currentWidth = fromWidth;
        this._label.opacity = 20;

        const sameWidthPulse = Math.abs(toWidth - fromWidth) < 8 && toWidth > 80;
        const pulseDip = sameWidthPulse
            ? Math.round(Math.min(28 * this._scaleFactor(), toWidth * 0.14))
            : 0;

        this._resizeTween = startTween({
            durationMs: RESIZE_DURATION_MS,
            frameMs: RESIZE_FRAME_MS,
            onFrame: p => {
                if (this._destroyed || !this.mapped)
                    return false;

                const eased = easeOutCubic(p);
                this._currentWidth = pulseDip > 0
                    ? Math.round(toWidth - Math.sin(Math.PI * p) * pulseDip)
                    : Math.round(fromWidth + (toWidth - fromWidth) * eased);

                const fadeEased = easeOutFade(p);
                this._label.opacity = Math.round(20 + 235 * fadeEased);
                this.queue_relayout();
                return true;
            },
            onComplete: () => {
                this._resizeTween = null;
                this._currentWidth = toWidth;
                if (this._label)
                    this._label.opacity = 255;
                this.queue_relayout();
            },
            onCancel: () => {
                this._resizeTween = null;
                this._currentWidth = -1;
                if (this._label)
                    this._label.opacity = 255;
            },
        });
    }

    setAppearance(fontSizePx, maxWidthPx, scrollEnabled, animateResize = true) {
        if (this._destroyed)
            return;
        const nextFontSize = Math.max(10, Math.round(fontSizePx));
        const nextMaxWidth = Math.max(60, Math.round(maxWidthPx));
        const nextScroll = Boolean(scrollEnabled);
        const nextAnimateResize = Boolean(animateResize);
        const nextStyle = `font-size: ${nextFontSize}px;`;

        if (this._fontSize === nextFontSize &&
            this._maxWidth === nextMaxWidth &&
            this._scroll === nextScroll &&
            this._animateResize === nextAnimateResize &&
            this._label.style === nextStyle)
            return;

        this._fontSize = nextFontSize;
        this._maxWidth = nextMaxWidth;
        this._scroll = nextScroll;
        this._animateResize = nextAnimateResize;
        this._stopResize();
        if (!this._scroll) {
            this._stopWalk();
            this._overflow = 0;
            if (this._label)
                this._label.translation_x = 0;
        }
        this._label.style = nextStyle;
        this._syncEllipsize(this._scroll ? Pango.EllipsizeMode.NONE : Pango.EllipsizeMode.END);
        this.queue_relayout();
    }

    _measureTargetWidth(forHeight) {
        this._syncEllipsize(this._scroll ? Pango.EllipsizeMode.NONE : Pango.EllipsizeMode.END);
        const [min, natural] = super.vfunc_get_preferred_width(forHeight);
        if (this._maxWidth > 0) {
            const cap = this._maxWidth * this._scaleFactor();
            const w = Math.min(natural, cap);
            return [Math.min(min, w), w];
        }
        return [min, natural];
    }

    vfunc_get_preferred_width(forHeight) {
        const [min, target] = this._measureTargetWidth(forHeight);
        if (this._resizeTween?.isActive()) {
            const w = Math.max(0, Math.round(this._currentWidth));
            return [Math.min(min, w), w];
        }
        return [min, target];
    }

    vfunc_allocate(box) {
        const width = box.get_width();
        const height = box.get_height();
        const resizing = Boolean(this._resizeTween?.isActive());
        if (!resizing)
            this._currentWidth = width;

        this._syncEllipsize(this._scroll ? Pango.EllipsizeMode.NONE : Pango.EllipsizeMode.END);
        const [, natural] = this._label.get_preferred_width(-1);
        const overflow = this._scroll ? Math.max(0, Math.ceil(natural - width)) : 0;

        this.set_allocation(box);
        this._label.allocate(new Clutter.ActorBox({
            x1: 0,
            y1: 0,
            x2: width + overflow,
            y2: height,
        }));

        if (!resizing && overflow !== this._overflow) {
            this._overflow = overflow;
            this._queueRestart();
        }
    }

    _queueRestart() {
        if (this._destroyed || this._idleId)
            return;
        this._idleId = GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
            this._idleId = 0;
            if (!this._destroyed)
                this._restart();
            return GLib.SOURCE_REMOVE;
        });
    }

    _canScroll() {
        return !this._destroyed &&
            this._scroll &&
            this._overflow >= 3 &&
            this.mapped;
    }

    _restart() {
        if (this._destroyed)
            return;

        const same = this._label.text === this._walkText;
        const carried = same ? this._walkElapsedMs : 0;
        this._walkText = this._label.text;

        this._stopWalk();
        this._label.translation_x = 0;

        if (!this._canScroll()) {
            this._walkElapsedMs = 0;
            return;
        }

        const speed = SCROLL_SPEED_PX_PER_S * this._scaleFactor();
        this._awayMs = Math.max(1, Math.round((this._overflow / speed) * 1000));
        this._walkDurationMs = 2 * SCROLL_PAUSE_MS + this._awayMs + SCROLL_RETURN_MS;
        const initialElapsed = carried > 0 ? (carried % this._walkDurationMs) : 0;
        this._walkStartUs = GLib.get_monotonic_time() - initialElapsed * 1000;

        this._onFrame();
        this._walkTimerId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, SCROLL_FRAME_MS, () => {
            if (this._destroyed || !this._canScroll()) {
                this._walkTimerId = 0;
                return GLib.SOURCE_REMOVE;
            }
            this._onFrame();
            return GLib.SOURCE_CONTINUE;
        });
    }

    _onFrame() {
        if (!this._walkDurationMs)
            return;
        const totalElapsedMs = (GLib.get_monotonic_time() - this._walkStartUs) / 1000;
        const elapsed = ((totalElapsedMs % this._walkDurationMs) + this._walkDurationMs) % this._walkDurationMs;
        this._walkElapsedMs = elapsed;

        const there = SCROLL_PAUSE_MS + this._awayMs;
        const backFrom = there + SCROLL_PAUSE_MS;

        let t;
        if (elapsed <= SCROLL_PAUSE_MS) {
            t = 0;
        } else if (elapsed <= there) {
            t = (elapsed - SCROLL_PAUSE_MS) / this._awayMs;
        } else if (elapsed <= backFrom) {
            t = 1;
        } else {
            const left = Math.min(1, (elapsed - backFrom) / SCROLL_RETURN_MS);
            t = (1 - left) * (1 - left);
        }

        this._label.translation_x = -Math.round(this._overflow * t);
    }

    _stopResize(resetWidth = true) {
        if (this._resizeTween) {
            this._resizeTween.cancel();
            this._resizeTween = null;
        }
        if (resetWidth)
            this._currentWidth = -1;
        if (this._label)
            this._label.opacity = 255;
    }

    _stopWalk() {
        if (this._walkTimerId) {
            GLib.Source.remove(this._walkTimerId);
            this._walkTimerId = 0;
        }
        this._walkDurationMs = 0;
    }

    _cleanup() {
        if (this._destroyed)
            return;
        this._destroyed = true;

        this._stopResize();
        if (this._idleId) {
            GLib.Source.remove(this._idleId);
            this._idleId = 0;
        }
        if (this._mappedSigId) {
            this.disconnect(this._mappedSigId);
            this._mappedSigId = 0;
        }
        if (this._destroySigId) {
            this.disconnect(this._destroySigId);
            this._destroySigId = 0;
        }
        this._stopWalk();
    }

    destroy() {
        this._cleanup();
        super.destroy();
    }
});

