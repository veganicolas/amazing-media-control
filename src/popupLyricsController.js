import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import Pango from 'gi://Pango';
import St from 'gi://St';

import { LyricsService } from './lyricsService.js';

const LYRICS_USER_PAUSE_US = 3_000_000;

export class PopupLyricsController {
    constructor({
        getPositionUs,
        getAccent,
        isMenuOpen,
        onSyncClicked,
        onSeekToTime,
        onSyncedStateChanged,
        onSizeSyncNeeded,
        preserveFocusBeforeClear,
    }) {
        this._getPositionUs = getPositionUs;
        this._getAccent = getAccent;
        this._isMenuOpen = isMenuOpen;
        this._onSyncClicked = onSyncClicked;
        this._onSeekToTime = onSeekToTime;
        this._onSyncedStateChanged = onSyncedStateChanged;
        this._onSizeSyncNeeded = onSizeSyncNeeded;
        this._preserveFocus = preserveFocusBeforeClear;

        this._service = new LyricsService('AmazingMediaControl/1.0');
        this._destroyed = false;
        this._open = false;
        this._trackKey = '';
        this._syncedBaseKey = '';
        this._lyrics = null;
        this._lookupState = 'idle';
        this._renderedCanSeek = false;
        this._lineActors = [];
        this._activeIndex = -1;
        this._lastAccentCss = '';
        this._lookupGen = 0;
        this._errorRetryAfterUs = 0;
        this._manualScrollUs = 0;
        this._scrollRetries = 0;
        this._scrollRetryId = 0;
        this._scrollRetryImmediate = false;
        this._lastCardStyle = '';
        this._lastScrollStyle = '';
        this._signals = [];
        this._lineSignals = [];

        this._buildUi();
    }

    _buildUi() {
        this.cardBin = new St.Widget({
            style_class: 'amc-popup-card amc-lyrics-card',
            layout_manager: new Clutter.BinLayout(),
            y_align: Clutter.ActorAlign.START,
            visible: false,
        });
        this.sheen = new St.Widget({
            style_class: 'amc-popup-sheen',
            x_expand: true,
            y_expand: true,
        });
        this.cardBin.add_child(this.sheen);

        const panel = new St.BoxLayout({
            style_class: 'amc-lyrics-panel',
            orientation: Clutter.Orientation.VERTICAL,
            x_expand: true,
            y_expand: true,
            y_align: Clutter.ActorAlign.FILL,
        });

        this._header = new St.BoxLayout({
            style_class: 'amc-lyrics-header',
            orientation: Clutter.Orientation.HORIZONTAL,
            x_expand: true,
            y_align: Clutter.ActorAlign.CENTER,
        });
        const titleLabel = new St.Label({
            style_class: 'amc-lyrics-title',
            text: 'Lyrics',
            x_expand: true,
            y_align: Clutter.ActorAlign.CENTER,
        });
        this._syncBtn = new St.Button({
            style_class: 'amc-lyrics-sync-btn',
            label: 'Sync',
            can_focus: true,
            y_align: Clutter.ActorAlign.CENTER,
            visible: false,
        });
        this._signals.push([this._syncBtn, this._syncBtn.connect('clicked', () => {
            this._manualScrollUs = 0;
            this._scrollRetries = 0;
            this._onSyncClicked?.();
        })]);
        this._header.add_child(titleLabel);
        this._header.add_child(this._syncBtn);
        panel.add_child(this._header);

        this._scroll = new St.ScrollView({
            style_class: 'amc-lyrics-scroll',
            hscrollbar_policy: St.PolicyType.NEVER,
            vscrollbar_policy: St.PolicyType.AUTOMATIC,
            x_expand: true,
            y_expand: true,
            y_align: Clutter.ActorAlign.FILL,
        });
        this._signals.push([this._scroll, this._scroll.connect('scroll-event', () => {
            this._manualScrollUs = GLib.get_monotonic_time();
            return Clutter.EVENT_PROPAGATE;
        })]);
        if (this._scroll.vscroll) {
            this._signals.push([this._scroll.vscroll, this._scroll.vscroll.connect('captured-event', (_actor, event) => {
                const type = event.type();
                if (type === Clutter.EventType.BUTTON_PRESS ||
                    type === Clutter.EventType.MOTION ||
                    type === Clutter.EventType.SCROLL) {
                    this._manualScrollUs = GLib.get_monotonic_time();
                }
                return Clutter.EVENT_PROPAGATE;
            })]);
        }

        this._inner = new St.BoxLayout({
            style_class: 'amc-lyrics-inner',
            orientation: Clutter.Orientation.VERTICAL,
            x_expand: true,
        });
        this._scroll.set_child(this._inner);
        panel.add_child(this._scroll);
        this.cardBin.add_child(panel);
    }

    get isOpen() {
        return this._open;
    }

    get hasSynced() {
        return Boolean(this._lyrics?.synced);
    }

    get activeIndex() {
        return this._activeIndex;
    }

    resetManualScroll() {
        this._manualScrollUs = 0;
        this._scrollRetries = 0;
    }

    setGlass(enabled) {
        if (this._destroyed)
            return;
        if (enabled)
            this.cardBin.add_style_class_name('amc-glass');
        else
            this.cardBin.remove_style_class_name('amc-glass');
    }

    setOpen(open) {
        if (this._destroyed)
            return;
        this._open = Boolean(open);
        this.cardBin.visible = this._open;
        if (!this._open)
            this._stopScrollRetry();
        else
            this.resetManualScroll();
    }

    syncSize(colW, cardNatH, backdropTintColor) {
        if (this._destroyed || !this._open || !this.cardBin.visible)
            return;

        const lyricsW = Math.max(300, Math.round(colW * 0.92));
        const targetH = Math.max(240, Math.ceil(cardNatH));
        const [, hdrH] = this._header.get_preferred_height(lyricsW - 34);
        const scrollH = Math.max(120, targetH - Math.ceil(hdrH) - 40);
        const bgDecl = backdropTintColor ? ` background-color: ${backdropTintColor};` : '';

        const nextScrollStyle = `height: ${scrollH}px; max-height: ${scrollH}px;`;
        if (this._lastScrollStyle !== nextScrollStyle) {
            this._lastScrollStyle = nextScrollStyle;
            this._scroll.style = nextScrollStyle;
        }

        const nextCardStyle = `width: ${lyricsW}px; height: ${targetH}px; max-height: ${targetH}px;${bgDecl}`;
        if (this._lastCardStyle !== nextCardStyle) {
            this._lastCardStyle = nextCardStyle;
            this.cardBin.style = nextCardStyle;
        }
    }

    _stopScrollRetry() {
        if (this._scrollRetryId) {
            GLib.source_remove(this._scrollRetryId);
            this._scrollRetryId = 0;
        }
        this._scrollRetries = 0;
        this._scrollRetryImmediate = false;
    }

    _clearLinesContainer() {
        this._stopScrollRetry();
        for (const [btn, sigId] of this._lineSignals) {
            try {
                btn?.disconnect(sigId);
            } catch {
                // Ignore.
            }
        }
        this._lineSignals = [];
        this._preserveFocus?.(this._inner);
        this._inner.remove_all_children();
        this._lineActors = [];
        this._activeIndex = -1;
    }

    renderStatus(message) {
        if (this._destroyed)
            return;
        this._lookupGen++;
        this._lookupState = 'status';
        this._syncBtn.visible = false;
        this._clearLinesContainer();
        const label = new St.Label({
            style_class: 'amc-lyrics-status',
            text: message,
            x_align: Clutter.ActorAlign.CENTER,
        });
        label.clutter_text.line_wrap = true;
        this._inner.add_child(label);
        this._onSizeSyncNeeded?.();
    }

    _renderLines(lyrics = this._lyrics, seekable = this._renderedCanSeek) {
        if (this._destroyed || !lyrics)
            return;
        this._syncBtn.visible = Boolean(lyrics.synced);
        this._renderedCanSeek = Boolean(seekable);
        this._clearLinesContainer();

        for (const line of lyrics.lines) {
            const text = line.text || '♪';
            const label = new St.Label({
                style_class: 'amc-lyrics-line',
                text,
                x_expand: true,
            });
            label.clutter_text.line_wrap = true;
            label.clutter_text.line_wrap_mode = Pango.WrapMode.WORD_CHAR;
            label.clutter_text.ellipsize = Pango.EllipsizeMode.NONE;

            let actor;
            if (lyrics.synced && line.time !== null) {
                const btn = new St.Button({
                    style_class: 'amc-lyrics-line-btn',
                    child: label,
                    reactive: Boolean(seekable),
                    can_focus: Boolean(seekable),
                    x_expand: true,
                });
                if (seekable) {
                    const sigId = btn.connect('clicked', () => {
                        this._manualScrollUs = 0;
                        this._onSeekToTime?.(line.time);
                    });
                    this._lineSignals.push([btn, sigId]);
                }
                actor = btn;
            } else {
                actor = label;
            }

            this._inner.add_child(actor);
            this._lineActors.push({ actor, label, time: line.time });
        }

        this._onSizeSyncNeeded?.();
    }

    async ensureLoaded(player, { lengthUs = 0, canSeek = false } = {}) {
        if (this._destroyed)
            return;
        if (!player || !player.metadata?.title) {
            this.renderStatus('Play a track to search for synced lyrics.');
            return;
        }

        const m = player.metadata;
        const baseKey = `${player.busName}|${m.title}|${m.artist}`;
        const key = `${baseKey}|${m.album}|${lengthUs}`;
        const seekable = Boolean(canSeek);

        if (key === this._trackKey || (this._lyrics?.synced && baseKey === this._syncedBaseKey)) {
            if (this._lookupState === 'loading')
                return;
            if (this._lookupState === 'empty')
                return;
            if (this._lookupState === 'error' && GLib.get_monotonic_time() < this._errorRetryAfterUs)
                return;
            if (this._lookupState === 'loaded' || this._lyrics) {
                this._trackKey = key;
                this._lookupState = 'loaded';
                if (this._lineActors.length === 0 || (this._lyrics.synced && this._renderedCanSeek !== seekable)) {
                    this._renderLines(this._lyrics, seekable);
                    this.highlightActive(true, true, true);
                } else {
                    this.highlightActive(true, true);
                }
                if (this._isMenuOpen?.())
                    this._onSyncedStateChanged?.();
                return;
            }
        }

        this._trackKey = key;
        this._syncedBaseKey = '';
        this._lyrics = null;
        this._activeIndex = -1;
        this.renderStatus('Searching lyrics...');
        this._lookupState = 'loading';
        const gen = this._lookupGen;

        try {
            const result = await this._service.lookup({
                title: m.title,
                artist: m.artist,
                album: m.album,
                lengthUs,
                url: m.url,
                lyrics: m.lyrics,
            }, true);

            if (this._destroyed || gen !== this._lookupGen || this._trackKey !== key)
                return;

            this._lyrics = result;
            if (!result) {
                this.renderStatus('No lyrics found for this track.');
                this._lookupState = 'empty';
                return;
            }
            if (result.instrumental) {
                this.renderStatus('Instrumental track.');
                this._lookupState = 'empty';
                return;
            }
            this._lookupState = 'loaded';
            if (result.synced)
                this._syncedBaseKey = baseKey;
            this._renderLines(result, seekable);
            this.highlightActive(true, true, true);
            if (this._isMenuOpen?.())
                this._onSyncedStateChanged?.();
        } catch (_e) {
            if (!this._destroyed && gen === this._lookupGen && this._trackKey === key) {
                this.renderStatus('Could not reach lyrics service.');
                this._lookupState = 'error';
                this._errorRetryAfterUs = GLib.get_monotonic_time() + 5_000_000;
            }
        }
    }

    _getVAdjustment() {
        return this._scroll.vadjustment ??
            this._scroll.get_vadjustment?.() ??
            this._inner.vadjustment ??
            this._inner.get_vadjustment?.() ??
            this._scroll.vscroll?.adjustment ??
            this._scroll.get_vscroll_bar?.()?.get_adjustment?.() ??
            this._scroll.get_vscroll_bar?.()?.adjustment ??
            null;
    }

    highlightActive(scrollIntoView, forceStyle = false, immediate = false) {
        if (this._destroyed || !this._open || !this._lyrics?.synced || this._lineActors.length === 0)
            return;

        const posUs = this._getPositionUs?.() ?? 0;
        let activeIdx = -1;
        for (let i = 0; i < this._lineActors.length; i++) {
            const t = this._lineActors[i].time;
            if (t !== null && t <= posUs + 220_000)
                activeIdx = i;
            else if (t !== null && t > posUs + 220_000)
                break;
        }

        const accent = this._getAccent?.() ?? { accentCss: '#ffffff' };
        const idxChanged = activeIdx !== this._activeIndex;
        const accentChanged = accent.accentCss !== this._lastAccentCss;
        this._activeIndex = activeIdx;
        this._lastAccentCss = accent.accentCss;

        if (forceStyle || idxChanged || accentChanged) {
            for (let i = 0; i < this._lineActors.length; i++) {
                const item = this._lineActors[i];
                if (i === activeIdx) {
                    item.actor.add_style_class_name?.('amc-lyrics-line-active');
                    item.actor.style = `border-left-color: ${accent.accentCss};`;
                    item.label.opacity = 255;
                } else {
                    item.actor.remove_style_class_name?.('amc-lyrics-line-active');
                    item.actor.style = null;
                    item.label.opacity = (activeIdx >= 0 && i < activeIdx) ? 120 : 185;
                }
            }
        }

        if (scrollIntoView || idxChanged) {
            if (activeIdx >= 0) {
                this._scrollToActor(this._lineActors[activeIdx].actor, immediate);
            } else if (immediate) {
                const vadj = this._getVAdjustment();
                if (vadj) {
                    vadj.remove_all_transitions?.();
                    vadj.remove_transition?.('value');
                    vadj.value = 0;
                }
            }
        }
    }

    _scrollToActor(actor, immediate = false) {
        const vadj = this._getVAdjustment();
        if (this._destroyed || !vadj || !this._open || (this._isMenuOpen && !this._isMenuOpen()))
            return;
        if (!immediate && GLib.get_monotonic_time() - this._manualScrollUs < LYRICS_USER_PAUSE_US)
            return;

        const box = actor.get_allocation_box?.();
        const boxY = box ? box.y1 : actor.get_position()[1];
        const boxH = box ? box.get_height() : actor.get_size()[1];
        const pageH = vadj.page_size;

        if (pageH <= 0 || boxH <= 0) {
            this._scrollRetryImmediate = Boolean(this._scrollRetryImmediate || immediate);
            if (!this._scrollRetryId && this._scrollRetries < 10) {
                this._scrollRetries++;
                this._scrollRetryId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 50, () => {
                    this._scrollRetryId = 0;
                    const retryImmediate = this._scrollRetryImmediate;
                    this._scrollRetryImmediate = false;
                    const idx = this._activeIndex;
                    if (!this._destroyed && this._open && idx >= 0 && this._lineActors[idx])
                        this._scrollToActor(this._lineActors[idx].actor, retryImmediate);
                    return GLib.SOURCE_REMOVE;
                });
            }
            return;
        }
        this._scrollRetries = 0;
        this._scrollRetryImmediate = false;

        const maxScroll = Math.max(0, vadj.upper - pageH);
        const target = Math.max(0, Math.min(maxScroll, boxY - pageH * 0.36 + boxH / 2));
        vadj.remove_all_transitions?.();
        vadj.remove_transition?.('value');
        if (!immediate && St.Settings.get().enable_animations && typeof vadj.ease === 'function') {
            try {
                vadj.ease(target, {
                    duration: 280,
                    mode: Clutter.AnimationMode.EASE_OUT_QUAD,
                });
            } catch {
                vadj.value = target;
            }
        } else {
            vadj.value = target;
        }
    }

    destroy() {
        if (this._destroyed)
            return;
        this._destroyed = true;
        this._lookupGen++;
        this._lookupState = 'idle';
        this._stopScrollRetry();

        const vadj = this._getVAdjustment();
        vadj?.remove_all_transitions?.();
        vadj?.remove_transition?.('value');

        for (const [obj, sigId] of this._signals) {
            try {
                obj?.disconnect(sigId);
            } catch {
                // Ignore.
            }
        }
        this._signals = [];
        this._clearLinesContainer();
        this._service?.destroy();
        this._service = null;
        this._lyrics = null;
        this.cardBin = null;
        this.sheen = null;
        this._scroll = null;
        this._inner = null;
        this._header = null;
        this._syncBtn = null;
    }
}
