import Clutter from 'gi://Clutter';
import GObject from 'gi://GObject';
import St from 'gi://St';

import { DEFAULT_BAR_ORDER, normalizeBarOrder } from './barOrderUtils.js';
import { applyAppIconAppearance, DEFAULT_APP_ICON_NAME, setButtonSensitive } from './iconUtils.js';
import { ScrollingLabel } from './scrollingLabel.js';
import { SpectrumWidget } from './spectrumWidget.js';
import { easeOutCubic, easeOutFade, startTween } from './tweenUtils.js';

const REVEAL_DURATION_MS = 280;
const CONCEAL_DURATION_MS = 220;
const REVEAL_FRAME_MS = 16;

function hitTestActor(actor, x, y) {
    if (!actor?.visible)
        return false;
    const [bx, by] = actor.get_transformed_position();
    const [w, h] = actor.get_transformed_size();
    return x >= bx && x < bx + w && y >= by && y < by + h;
}

export const MediaCard = GObject.registerClass({
    Signals: {
        'card-clicked': {},
    },
}, class MediaCard extends St.Widget {
    _init({ enableClickGesture = false } = {}) {
        super._init({
            layout_manager: new Clutter.BinLayout(),
            clip_to_allocation: true,
            y_align: Clutter.ActorAlign.CENTER,
            reactive: true,
        });

        this._row = new St.BoxLayout({
            style_class: 'amc-card',
            y_align: Clutter.ActorAlign.CENTER,
            orientation: Clutter.Orientation.HORIZONTAL,
        });
        this.add_child(this._row);

        this._player = null;
        this._showControls = true;
        this._barElementsOrder = [...DEFAULT_BAR_ORDER];
        this._controlsOnlyWhenPlaying = false;
        this._showSpectrum = true;
        this._spectrumAllSound = false;
        this._spectrumDemoAnimation = false;
        this._appIconWhite = false;
        this._barIconMode = 'cover-art';
        this._barTextFormat = 'title-artist';
        this._logoClickRaises = true;
        this._animateResize = true;
        this._coverArtUri = '';
        this._enableClickGesture = enableClickGesture;
        this._revealWidth = -1;
        this._revealTween = null;
        this._revealState = 'idle';
        this._destroyed = false;
        this._signals = [];
        this._gestures = [];

        // 1. App Logo (optionally clickable to raise window) & Mini Cover Art
        this._appIcon = new St.Icon({
            style_class: 'amc-app-icon',
            icon_name: DEFAULT_APP_ICON_NAME,
            icon_size: 16,
            y_align: Clutter.ActorAlign.CENTER,
        });
        this._logoBtn = new St.Button({
            style_class: 'amc-logo-btn',
            child: this._appIcon,
            can_focus: false,
            y_align: Clutter.ActorAlign.CENTER,
        });
        this._signals.push([this._logoBtn, this._logoBtn.connect('clicked', () => {
            if (this._logoClickRaises && this._player)
                this._player.raise();
            else
                this.emit('card-clicked');
        })]);

        this._miniCover = new St.Widget({
            style_class: 'amc-bar-cover',
            reactive: enableClickGesture,
            y_align: Clutter.ActorAlign.CENTER,
            visible: false,
        });

        this._logoGroup = new St.BoxLayout({
            style_class: 'amc-info-box',
            y_align: Clutter.ActorAlign.CENTER,
            orientation: Clutter.Orientation.HORIZONTAL,
        });
        this._logoGroup.add_child(this._logoBtn);
        this._logoGroup.add_child(this._miniCover);

        // 2. Real-time Audio Spectrum Graphic
        this._spectrum = new SpectrumWidget();
        this._spectrum.reactive = enableClickGesture;

        // 3. Smooth-scrolling Track Label
        this._trackLabel = new ScrollingLabel({
            styleClass: 'amc-track-label',
            text: 'No media playing',
        });
        this._trackLabel.reactive = enableClickGesture;

        if (enableClickGesture) {
            for (const target of [this._miniCover, this._spectrum, this._trackLabel]) {
                const gesture = new Clutter.ClickGesture({
                    required_button: Clutter.BUTTON_PRIMARY,
                });
                const sigId = gesture.connect('recognize', () => {
                    this.emit('card-clicked');
                });
                target.add_action(gesture);
                this._gestures.push([target, gesture, sigId]);
            }
        }

        // 4. Inline Media Controls
        this._prevIcon = new St.Icon({ icon_name: 'media-skip-backward-symbolic', icon_size: 14 });
        this._playIcon = new St.Icon({ icon_name: 'media-playback-start-symbolic', icon_size: 14 });
        this._nextIcon = new St.Icon({ icon_name: 'media-skip-forward-symbolic', icon_size: 14 });

        this._prevBtn = this._makeControlButton(this._prevIcon, () => this._player?.previous());
        this._playBtn = this._makeControlButton(this._playIcon, () => this._player?.playPause());
        this._nextBtn = this._makeControlButton(this._nextIcon, () => this._player?.next());

        this._controlsBox = new St.BoxLayout({
            style_class: 'amc-controls-box',
            y_align: Clutter.ActorAlign.CENTER,
            orientation: Clutter.Orientation.HORIZONTAL,
        });
        this._controlsBox.add_child(this._prevBtn);
        this._controlsBox.add_child(this._playBtn);
        this._controlsBox.add_child(this._nextBtn);

        this._layoutChildren();

        this._signals.push([this, this.connect('button-press-event', (_actor, event) => {
            if (event.get_button() === Clutter.BUTTON_MIDDLE && this._player) {
                this._player.playPause();
                return Clutter.EVENT_STOP;
            }
            return Clutter.EVENT_PROPAGATE;
        })]);
        this._signals.push([this, this.connect('destroy', () => this._cleanup())]);
    }

    _makeControlButton(icon, onClick) {
        const btn = new St.Button({
            style_class: 'amc-control-btn',
            child: icon,
            can_focus: true,
            y_align: Clutter.ActorAlign.CENTER,
        });
        this._signals.push([btn, btn.connect('clicked', onClick)]);
        return btn;
    }

    _layoutChildren() {
        const slots = {
            'app-logo': this._logoGroup,
            'spectrum': this._spectrum,
            'title': this._trackLabel,
            'controls': this._controlsBox,
        };
        let idx = 0;
        for (const id of this._barElementsOrder) {
            const actor = slots[id];
            if (!actor)
                continue;
            if (actor.get_parent() === this._row)
                this._row.set_child_at_index(actor, idx);
            else
                this._row.insert_child_at_index(actor, idx);
            idx++;
        }
    }

    vfunc_get_preferred_width(forHeight) {
        const [min, nat] = super.vfunc_get_preferred_width(forHeight);
        if (this._revealTween?.isActive() && this._revealWidth >= 0) {
            const w = Math.max(0, Math.round(this._revealWidth));
            return [Math.min(min, w), w];
        }
        return [min, nat];
    }

    vfunc_allocate(box) {
        this.set_allocation(box);
        const [, rowNatW] = this._row.get_preferred_width(-1);
        const fullW = this._revealTween?.isActive()
            ? Math.max(box.get_width(), rowNatW)
            : box.get_width();
        const childBox = new Clutter.ActorBox({
            x1: 0,
            y1: 0,
            x2: fullW,
            y2: box.get_height(),
        });
        this._row.allocate(childBox);
    }

    isConcealing() {
        return this._revealState === 'concealing';
    }

    _stopReveal() {
        if (this._revealTween) {
            this._revealTween.cancel();
            this._revealTween = null;
        }
        this._revealWidth = -1;
        this._revealState = 'idle';
    }

    _startVisibilityTween({
        durationMs,
        fromW,
        toWidthFn,
        fromOpacity,
        toOpacity,
        state,
        onComplete = null,
    }) {
        this._stopReveal();
        this._revealState = state;
        this._revealWidth = fromW;
        this.opacity = fromOpacity;

        this._revealTween = startTween({
            durationMs,
            frameMs: REVEAL_FRAME_MS,
            onFrame: p => {
                if (this._destroyed)
                    return false;
                const eased = easeOutCubic(p);
                const targetW = toWidthFn();
                this._revealWidth = Math.round(fromW + (targetW - fromW) * eased);
                const fadeEased = easeOutFade(p);
                this.opacity = Math.round(fromOpacity + (toOpacity - fromOpacity) * fadeEased);
                this.queue_relayout();
                return true;
            },
            onComplete: () => {
                this._revealWidth = -1;
                this._revealTween = null;
                this._revealState = 'idle';
                if (toOpacity > 0)
                    this.opacity = 255;
                else
                    this.opacity = toOpacity;
                this.queue_relayout();
                onComplete?.();
            },
        });
    }

    reveal(animate = true) {
        if (!animate || !this._animateResize || this._destroyed) {
            this._stopReveal();
            this._revealWidth = -1;
            this.opacity = 255;
            this.queue_relayout();
            return;
        }

        const [, targetInit] = this._row.get_preferred_width(-1);
        const fromW = this._revealWidth >= 0 ? this._revealWidth : 0;
        if (targetInit <= 2) {
            this._stopReveal();
            this._revealWidth = -1;
            this.opacity = 255;
            this.queue_relayout();
            return;
        }

        const fromOpacity = fromW > 0 ? this.opacity : 0;
        this._startVisibilityTween({
            durationMs: REVEAL_DURATION_MS,
            fromW,
            toWidthFn: () => this._row.get_preferred_width(-1)[1],
            fromOpacity,
            toOpacity: 255,
            state: 'revealing',
        });
    }

    conceal(animate = true, onComplete = null) {
        if (!animate || !this._animateResize || this._destroyed) {
            this._stopReveal();
            this._revealWidth = -1;
            this.opacity = 255;
            onComplete?.();
            return;
        }

        const fallbackW = this._row.get_preferred_width(-1)[1];
        const fromW = this._revealWidth >= 0
            ? this._revealWidth
            : Math.round(this.get_width() || fallbackW);
        if (fromW <= 2) {
            this._stopReveal();
            this._revealWidth = -1;
            this.opacity = 255;
            onComplete?.();
            return;
        }

        this._startVisibilityTween({
            durationMs: CONCEAL_DURATION_MS,
            fromW,
            toWidthFn: () => 0,
            fromOpacity: this.opacity,
            toOpacity: 0,
            state: 'concealing',
            onComplete,
        });
    }

    isOnInteractiveChild(event) {
        const [x, y] = event.get_coords();
        if (hitTestActor(this._controlsBox, x, y))
            return true;
        if (this._logoClickRaises && this._player && hitTestActor(this._logoBtn, x, y))
            return true;
        return false;
    }

    _syncBarIcons() {
        const mode = this._barIconMode;
        const hasPlayer = Boolean(this._player);
        const hasCover = hasPlayer && Boolean(this._coverArtUri);

        if (!hasPlayer && this._spectrumAllSound) {
            this._logoBtn.visible = true;
            this._logoBtn.reactive = (this._logoClickRaises && hasPlayer) || Boolean(this._enableClickGesture);
            this._miniCover.visible = false;
            this._logoGroup.visible = true;
            applyAppIconAppearance(this._appIcon, null, this._appIconWhite);
            return;
        }

        const showLogo = mode === 'app-logo' || mode === 'both' || !hasCover;
        const showCover = (mode === 'cover-art' || mode === 'both') && hasCover;

        this._logoBtn.visible = showLogo;
        this._logoBtn.reactive = (this._logoClickRaises && hasPlayer) || Boolean(this._enableClickGesture);
        applyAppIconAppearance(this._appIcon, this._player?.gicon ?? null, this._appIconWhite);

        this._miniCover.visible = showCover;
        if (showCover)
            this._miniCover.style = `background-image: url("${this._coverArtUri}");`;
        else
            this._miniCover.style = null;

        this._logoGroup.visible = showLogo || showCover;
    }

    _formatTrackText(player) {
        if (!player)
            return this._spectrumAllSound ? 'System Audio' : 'No media playing';

        const title = player.metadata.title || player.displayName;
        const artist = player.metadata.artist;
        if (!artist || this._barTextFormat === 'title-only')
            return title;
        if (title.toLowerCase() === artist.toLowerCase())
            return title;
        if (this._barTextFormat === 'artist-title')
            return `${artist} - ${title}`;
        return `${title} - ${artist}`;
    }

    applySettings(config) {
        const fontSize = config.barFontSize;
        const maxWidth = config.barMaxWidth;
        const iconSize = Math.max(12, Math.round(fontSize * 1.18));
        const coverSize = Math.max(14, Math.round(fontSize * 1.32));

        this._trackLabel.setAppearance(
            fontSize,
            maxWidth,
            config.scrollingText,
            config.animateTrackResize
        );
        this._appIcon.icon_size = iconSize;
        this._miniCover.set_size(coverSize, coverSize);
        this._prevIcon.icon_size = Math.max(12, iconSize - 2);
        this._playIcon.icon_size = Math.max(12, iconSize - 1);
        this._nextIcon.icon_size = Math.max(12, iconSize - 2);

        this._spectrum.applyConfig({
            columns: config.spectrumColumns ?? 6,
            widthPx: config.spectrumWidth ?? 0,
            rangeDb: config.spectrumRange ?? 32,
            showPeaks: config.spectrumPeaks ?? true,
            colorMode: config.spectrumColors ?? 'accent',
            fps: config.spectrumFps ?? 30,
            invert: config.spectrumInvert ?? false,
            allSound: config.spectrumAllSound ?? false,
            demoAnimation: config.spectrumDemoAnimation ?? false,
            style: config.spectrumStyle,
            scale: fontSize,
        });

        this._showSpectrum = config.showSpectrum;
        this._spectrumAllSound = Boolean(config.spectrumAllSound);
        this._spectrumDemoAnimation = Boolean(config.spectrumDemoAnimation);
        this._spectrum.visible = this._showSpectrum &&
            (Boolean(this._player) || this._spectrumAllSound || this._spectrumDemoAnimation);

        const nextOrder = normalizeBarOrder(config.barElementsOrder);
        const orderChanged = nextOrder.length !== this._barElementsOrder.length ||
            nextOrder.some((v, i) => v !== this._barElementsOrder[i]);

        this._showControls = config.controlsPosition !== 'hidden';
        if (orderChanged) {
            this._barElementsOrder = nextOrder;
            this._layoutChildren();
        }

        this._controlsOnlyWhenPlaying = config.controlsOnlyWhenPlaying;
        this._appIconWhite = Boolean(config.appIconWhite);
        this._barIconMode = config.barIconMode || 'cover-art';
        this._barTextFormat = config.barTextFormat || 'title-artist';
        this._logoClickRaises = Boolean(config.logoClickRaises);
        this._animateResize = Boolean(config.animateTrackResize ?? true);

        this._syncBarIcons();
        this._trackLabel.text = this._formatTrackText(this._player);
        this._updateControlsVisibility();
    }

    playPause() {
        this._player?.playPause();
    }

    setCoverArtUri(localUri) {
        const next = localUri || '';
        if (this._coverArtUri === next)
            return;
        this._coverArtUri = next;
        this._syncBarIcons();
    }

    setSpectrumAnalyzer(analyzer) {
        this._spectrum?.setAnalyzer(analyzer);
    }

    setSpectrumAccentColor(cssColor) {
        this._spectrum?.setAccentColor(cssColor);
    }

    updatePlayer(player) {
        this._player = player;
        this._syncBarIcons();
        this._trackLabel.text = this._formatTrackText(player);

        if (!player) {
            this._spectrum.setPlaying(false);
            this._spectrum.visible = this._showSpectrum &&
                (this._spectrumAllSound || this._spectrumDemoAnimation);
            this._controlsBox.visible = false;
            return;
        }

        this._spectrum.visible = this._showSpectrum;
        this._spectrum.setPlaying(player.isPlaying);

        this._playIcon.icon_name = player.isPlaying
            ? 'media-playback-pause-symbolic'
            : 'media-playback-start-symbolic';

        setButtonSensitive(this._prevBtn, player.canGoPrevious);
        setButtonSensitive(this._nextBtn, player.canGoNext);
        setButtonSensitive(this._playBtn, player.canPlay || player.canPause);

        this._updateControlsVisibility();
    }

    _updateControlsVisibility() {
        if (!this._player || !this._showControls) {
            this._controlsBox.visible = false;
            return;
        }
        if (this._controlsOnlyWhenPlaying) {
            this._controlsBox.visible = this._player.isPlaying;
            return;
        }
        this._controlsBox.visible = true;
    }

    _cleanup() {
        if (this._destroyed)
            return;
        this._destroyed = true;
        this._stopReveal();
        this._player = null;

        for (const [actor, gesture, sigId] of this._gestures) {
            try {
                gesture.disconnect(sigId);
                actor?.remove_action(gesture);
            } catch {
                // Ignore if already disposed.
            }
        }
        this._gestures = [];

        for (const [obj, sigId] of this._signals) {
            try {
                obj?.disconnect(sigId);
            } catch {
                // Ignore if already disposed.
            }
        }
        this._signals = [];
    }

    destroy() {
        this._cleanup();
        this._trackLabel?.destroy();
        this._spectrum?.destroy();
        super.destroy();
    }
});
