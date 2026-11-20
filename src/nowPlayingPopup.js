import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Pango from 'gi://Pango';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';
import { Slider } from 'resource:///org/gnome/shell/ui/slider.js';

import { BackdropMaker } from './backdrop.js';
import { CoverArtService } from './colorExtractor.js';
import {
    applyAppIconAppearance,
    DEFAULT_APP_ICON_NAME,
    getStageScaleFactor,
    setButtonSensitive,
} from './iconUtils.js';
import { PopupLyricsController } from './popupLyricsController.js';
import { SpectrumWidget } from './spectrumWidget.js';

const BACKDROP_FADE_MS = 500;
const SEEK_STEP_US = 10_000_000;

function formatTime(us) {
    if (!Number.isFinite(us) || us <= 0)
        return '0:00';
    const totalSec = Math.floor(us / 1_000_000);
    const hours = Math.floor(totalSec / 3600);
    const mins = Math.floor((totalSec % 3600) / 60);
    const secs = totalSec % 60;
    const secStr = secs < 10 ? `0${secs}` : `${secs}`;
    if (hours > 0) {
        const minStr = mins < 10 ? `0${mins}` : `${mins}`;
        return `${hours}:${minStr}:${secStr}`;
    }
    return `${mins}:${secStr}`;
}

function volumeIconName(volume, muted) {
    if (muted || volume <= 0.005)
        return 'audio-volume-muted-symbolic';
    if (volume < 0.34)
        return 'audio-volume-low-symbolic';
    if (volume < 0.68)
        return 'audio-volume-medium-symbolic';
    return 'audio-volume-high-symbolic';
}

export class NowPlayingPopup {
    /**
     * @param {PopupMenu.PopupMenu} menu
     * @param {object} callbacks
     */
    constructor(menu, {
        audioOutputs = null,
        spectrumAnalyzer = null,
        onSelectPlayer = null,
        onAccentChanged = null,
        onCoverArtResolved = null,
    } = {}) {
        this._destroyed = false;
        this._menu = menu;
        this._audioOutputs = audioOutputs;
        this._spectrumAnalyzer = spectrumAnalyzer;
        this._onSelectPlayer = onSelectPlayer;
        this._onAccentChanged = onAccentChanged;
        this._onCoverArtResolved = onCoverArtResolved;

        this._coverService = new CoverArtService();
        this._backdropMaker = new BackdropMaker();
        this._coverAccent = this._coverService.getWhiteAccent();

        this._player = null;
        this._players = [];
        this._blurEnabled = true;
        this._accentSource = 'cover';
        this._appIconWhite = false;
        this._popupWidth = 380;
        this._popupOpacity = 90;
        this._showShuffleRepeat = true;
        this._showSeekButtons = true;
        this._showVolumeOutput = true;
        this._showLyrics = true;
        this._showPopupSpectrum = false;
        this._showPopupTopSpectrum = false;
        this._accentApplySpectrum = true;

        this._artCancellable = null;
        this._backdropCancellable = null;
        this._currentArtUrl = null;
        this._currentLocalUri = '';
        this._backdropGeneration = 0;
        this._backdropUri = null;
        this._backdropTintColor = '';

        this._isOpen = false;
        this._isDragging = false;
        this._isVolumeDragging = false;
        this._updatingSlider = false;
        this._updatingVolume = false;
        this._positionUs = 0;
        this._positionTimerId = 0;
        this._dbusSyncTicks = 0;

        this._uiSignals = [];
        this._outputBtnSignals = [];
        this._switcherBtnSignals = [];
        this._menuOpenSigId = 0;
        this._overviewSigId = 0;
        this._outputsSigIds = [];
        this._playerSeekSigId = 0;
        this._playerSigOwner = null;

        this._lastTrackKey = '';
        this._lastSyncedTopWidth = 0;
        this._lastSyncedLyricsKey = '';
        this._layoutSyncIdleId = 0;
        this._pendingLyricsScroll = false;
        this._seekTargetUs = 0;
        this._seekGuardUntilUs = 0;
        this._postTrackRefreshId = 0;
        this._postSeekRefreshId = 0;
        this._outputsExpanded = false;

        this._lyrics = new PopupLyricsController({
            getPositionUs: () => this._currentPositionUs(),
            getAccent: () => this._resolveActiveAccent(),
            isMenuOpen: () => Boolean(!this._destroyed && (this._isOpen || this._menu?.isOpen)),
            onSyncClicked: () => {
                if (this._destroyed)
                    return;
                this._seekGuardUntilUs = 0;
                this._pendingLyricsScroll = true;
                this._isOpen = Boolean(this._isOpen || this._menu?.isOpen);
                if (this._isOpen)
                    this._restartPositionTimer();
                this._refreshPositionOnce(true);
                this._lyrics?.highlightActive(true, true, true);
            },
            onSeekToTime: timeUs => {
                if (this._destroyed)
                    return;
                this._commitSeekTo(timeUs, { syncLayout: false, forceLyricStyle: true });
                this._isOpen = Boolean(this._isOpen || this._menu?.isOpen);
                if (this._isOpen && !this._positionTimerId)
                    this._startPositionTimer();
            },
            onSyncedStateChanged: () => {
                if (!this._destroyed && this._isOpen)
                    this._restartPositionTimer();
            },
            onSizeSyncNeeded: () => this._syncLyricsPanelSize(),
            preserveFocusBeforeClear: container => this._preserveMenuFocusBeforeClear(container),
        });

        this._buildUi();
        this._attachSignals();
    }

    _trackSignal(obj, signalName, handler) {
        if (!obj)
            return 0;
        const id = obj.connect(signalName, handler);
        this._uiSignals.push([obj, id]);
        return id;
    }

    _disconnectSignalList(list) {
        for (const [obj, id] of list) {
            try {
                obj?.disconnect(id);
            } catch {
                // Ignore if actor was already disposed.
            }
        }
        list.length = 0;
    }

    _buildUi() {
        this._menu.box.add_style_class_name('amc-card-menu');

        this._section = new PopupMenu.PopupMenuSection();
        this._menu.addMenuItem(this._section);

        this._rootCol = new St.BoxLayout({
            style_class: 'amc-popup-root-col',
            orientation: Clutter.Orientation.VERTICAL,
            x_expand: true,
            y_align: Clutter.ActorAlign.START,
        });

        this._topSpectrum = new SpectrumWidget();
        this._topSpectrum.applyConfig({
            analyzer: this._spectrumAnalyzer,
            style: 'bars',
            drawTrack: false,
            targetWidth: Math.max(220, this._popupWidth - 8),
            targetHeight: 46,
        });
        this._topSpectrum.x_expand = true;
        this._topSpectrum.x_align = Clutter.ActorAlign.CENTER;
        this._topSpectrum.y_align = Clutter.ActorAlign.END;

        this._topSpectrumBox = new St.BoxLayout({
            style_class: 'amc-popup-top-spectrum-box',
            orientation: Clutter.Orientation.HORIZONTAL,
            x_expand: true,
            x_align: Clutter.ActorAlign.FILL,
            y_align: Clutter.ActorAlign.END,
            visible: false,
        });
        this._topSpectrumBox.add_child(this._topSpectrum);
        this._rootCol.add_child(this._topSpectrumBox);

        this._rootRow = new St.BoxLayout({
            style_class: 'amc-popup-root-row',
            orientation: Clutter.Orientation.HORIZONTAL,
            x_expand: true,
            y_align: Clutter.ActorAlign.START,
        });
        this._trackSignal(this._rootRow, 'notify::width', () => {
            this._queueLayoutSync();
        });
        this._rootCol.add_child(this._rootRow);

        this._cardBin = new St.Widget({
            style_class: 'amc-popup-card',
            layout_manager: new Clutter.BinLayout(),
            y_align: Clutter.ActorAlign.START,
        });

        this._backdropLayers = [0, 1].map(() => new St.Widget({
            style_class: 'amc-popup-backdrop',
            x_expand: true,
            y_expand: true,
        }));
        this._sheen = new St.Widget({
            style_class: 'amc-popup-sheen',
            x_expand: true,
            y_expand: true,
        });
        for (const layer of [...this._backdropLayers, this._sheen])
            this._cardBin.add_child(layer);

        this._playerCol = new St.BoxLayout({
            style_class: 'amc-popup-container',
            orientation: Clutter.Orientation.VERTICAL,
            y_align: Clutter.ActorAlign.START,
        });
        this._trackSignal(this._playerCol, 'notify::height', () => {
            this._queueLayoutSync();
        });

        this._cardBin.add_child(this._playerCol);
        this._rootRow.add_child(this._cardBin);
        this._rootRow.add_child(this._lyrics.cardBin);

        const item = new PopupMenu.PopupBaseMenuItem({
            activate: false,
            reactive: false,
            can_focus: false,
            style_class: 'amc-card-item',
        });
        item.add_child(this._rootCol);
        this._section.addMenuItem(item);

        this._buildHeaderSection();
        this._buildSwitcherRow();
        this._buildTrackSection();
        this._buildPopupSpectrumSection();
        this._buildProgressSection();
        this._buildControlsRow();
        this._buildAudioSection();
    }

    _buildHeaderSection() {
        const header = new St.BoxLayout({
            style_class: 'amc-popup-header',
            orientation: Clutter.Orientation.HORIZONTAL,
            x_expand: true,
            y_align: Clutter.ActorAlign.CENTER,
        });

        this._headerLeftSpacer = new St.Widget({
            style_class: 'amc-popup-header-spacer',
            y_align: Clutter.ActorAlign.CENTER,
        });

        const appBadgeContent = new St.BoxLayout({
            style_class: 'amc-popup-app-badge',
            orientation: Clutter.Orientation.HORIZONTAL,
            y_align: Clutter.ActorAlign.CENTER,
        });
        this._appIcon = new St.Icon({ icon_size: 16 });
        this._appLabel = new St.Label({
            style_class: 'amc-popup-app-name',
            text: 'Media Player',
            y_align: Clutter.ActorAlign.CENTER,
        });
        this._appLabel.clutter_text.ellipsize = Pango.EllipsizeMode.END;
        appBadgeContent.add_child(this._appIcon);
        appBadgeContent.add_child(this._appLabel);

        this._appBadgeBtn = new St.Button({
            style_class: 'amc-popup-badge-btn',
            child: appBadgeContent,
            can_focus: true,
            x_align: Clutter.ActorAlign.CENTER,
            y_align: Clutter.ActorAlign.CENTER,
        });
        this._trackSignal(this._appBadgeBtn, 'clicked', () => this._player?.raise());

        const badgeCenterBin = new St.Bin({
            x_expand: true,
            x_align: Clutter.ActorAlign.CENTER,
            y_align: Clutter.ActorAlign.CENTER,
            child: this._appBadgeBtn,
        });

        this._lyricsBtn = new St.Button({
            style_class: 'amc-popup-mini-btn',
            child: new St.Icon({ icon_name: 'format-justify-left-symbolic', icon_size: 15 }),
            can_focus: true,
            y_align: Clutter.ActorAlign.CENTER,
        });
        this._trackSignal(this._lyricsBtn, 'clicked', () => this._toggleLyrics());

        header.add_child(this._headerLeftSpacer);
        header.add_child(badgeCenterBin);
        header.add_child(this._lyricsBtn);
        this._playerCol.add_child(header);
    }

    _buildSwitcherRow() {
        this._switcherBox = new St.BoxLayout({
            style_class: 'amc-popup-switcher',
            orientation: Clutter.Orientation.HORIZONTAL,
            x_expand: true,
            x_align: Clutter.ActorAlign.CENTER,
            y_align: Clutter.ActorAlign.CENTER,
            visible: false,
        });
        this._playerCol.add_child(this._switcherBox);
    }

    _buildTrackSection() {
        const trackRow = new St.BoxLayout({
            style_class: 'amc-popup-track-row',
            orientation: Clutter.Orientation.HORIZONTAL,
            x_expand: true,
        });

        this._artFrame = new St.Bin({
            style_class: 'amc-popup-art-frame',
            x_align: Clutter.ActorAlign.CENTER,
            y_align: Clutter.ActorAlign.CENTER,
        });
        this._artFallbackIcon = new St.Icon({
            icon_name: DEFAULT_APP_ICON_NAME,
            icon_size: 42,
        });
        this._artFrame.set_child(this._artFallbackIcon);

        const metaBox = new St.BoxLayout({
            style_class: 'amc-popup-meta-box',
            orientation: Clutter.Orientation.VERTICAL,
            y_align: Clutter.ActorAlign.CENTER,
            x_expand: true,
        });

        this._titleLabel = new St.Label({
            style_class: 'amc-popup-title',
            text: 'No media playing',
        });
        this._titleLabel.clutter_text.line_wrap = true;
        this._titleLabel.clutter_text.line_wrap_mode = Pango.WrapMode.WORD_CHAR;
        this._titleLabel.clutter_text.ellipsize = Pango.EllipsizeMode.END;

        this._artistLabel = new St.Label({ style_class: 'amc-popup-artist', text: '' });
        this._artistLabel.clutter_text.ellipsize = Pango.EllipsizeMode.END;

        this._albumLabel = new St.Label({ style_class: 'amc-popup-album', text: '' });
        this._albumLabel.clutter_text.ellipsize = Pango.EllipsizeMode.END;

        metaBox.add_child(this._titleLabel);
        metaBox.add_child(this._artistLabel);
        metaBox.add_child(this._albumLabel);

        trackRow.add_child(this._artFrame);
        trackRow.add_child(metaBox);
        this._playerCol.add_child(trackRow);
    }

    _buildPopupSpectrumSection() {
        this._popupSpectrum = new SpectrumWidget();
        this._popupSpectrum.applyConfig({
            analyzer: this._spectrumAnalyzer,
            targetWidth: Math.max(220, this._popupWidth - 46),
            targetHeight: 38,
        });
        this._popupSpectrumBox = new St.Bin({
            style_class: 'amc-popup-spectrum-box',
            x_align: Clutter.ActorAlign.CENTER,
            x_expand: true,
            visible: false,
        });
        this._popupSpectrumBox.set_child(this._popupSpectrum);
        this._playerCol.add_child(this._popupSpectrumBox);
    }

    _buildProgressSection() {
        const progressBox = new St.BoxLayout({
            style_class: 'amc-popup-progress-box',
            orientation: Clutter.Orientation.VERTICAL,
            x_expand: true,
        });

        this._slider = new Slider(0);
        this._slider.add_style_class_name('amc-popup-slider');
        this._trackSignal(this._slider, 'drag-begin', () => {
            if (!this._isOpen || this._destroyed)
                return;
            this._isDragging = true;
        });
        this._trackSignal(this._slider, 'drag-end', () => {
            this._isDragging = false;
            if (!this._isOpen || this._destroyed)
                return;
            this._commitSeek();
        });
        this._trackSignal(this._slider, 'notify::value', () => {
            if (this._updatingSlider || !this._isOpen || this._destroyed)
                return;
            const lengthUs = this._getEffectiveLengthUs();
            if (lengthUs > 0) {
                const targetUs = this._slider.value * lengthUs;
                this._elapsedLabel.text = formatTime(targetUs);
            }
        });

        const timeRow = new St.BoxLayout({
            style_class: 'amc-popup-time-row',
            orientation: Clutter.Orientation.HORIZONTAL,
            x_expand: true,
        });
        this._elapsedLabel = new St.Label({ text: '0:00', x_expand: true });
        this._durationLabel = new St.Label({ text: '0:00' });
        timeRow.add_child(this._elapsedLabel);
        timeRow.add_child(this._durationLabel);

        progressBox.add_child(this._slider);
        progressBox.add_child(timeRow);
        this._playerCol.add_child(progressBox);
    }

    _makeTransportButton(styleClass, iconName, iconSize, onClick) {
        const icon = new St.Icon({ icon_name: iconName, icon_size: iconSize });
        const btn = new St.Button({
            style_class: styleClass,
            child: icon,
            can_focus: true,
        });
        this._trackSignal(btn, 'clicked', onClick);
        return { btn, icon };
    }

    _buildControlsRow() {
        const controlsRow = new St.BoxLayout({
            style_class: 'amc-popup-controls-row',
            orientation: Clutter.Orientation.HORIZONTAL,
            x_align: Clutter.ActorAlign.CENTER,
            y_align: Clutter.ActorAlign.CENTER,
        });

        const shuffle = this._makeTransportButton('amc-popup-sub-btn', 'media-playlist-shuffle-symbolic', 16, () => {
            if (this._player?.canShuffle)
                this._player.setShuffle(!this._player.shuffle);
        });
        this._shuffleBtn = shuffle.btn;

        const seekBack = this._makeTransportButton('amc-popup-sub-btn', 'media-seek-backward-symbolic', 17, () => {
            this._seekRelative(-SEEK_STEP_US);
        });
        this._seekBackBtn = seekBack.btn;

        const prev = this._makeTransportButton('amc-popup-nav-btn', 'media-skip-backward-symbolic', 20, () => {
            this._player?.previous();
        });
        this._prevBtn = prev.btn;

        const play = this._makeTransportButton('amc-popup-play-btn', 'media-playback-start-symbolic', 22, () => {
            this._player?.playPause();
        });
        this._playBtn = play.btn;
        this._playIcon = play.icon;

        const next = this._makeTransportButton('amc-popup-nav-btn', 'media-skip-forward-symbolic', 20, () => {
            this._player?.next();
        });
        this._nextBtn = next.btn;

        const seekFwd = this._makeTransportButton('amc-popup-sub-btn', 'media-seek-forward-symbolic', 17, () => {
            this._seekRelative(SEEK_STEP_US);
        });
        this._seekFwdBtn = seekFwd.btn;

        const repeat = this._makeTransportButton('amc-popup-sub-btn', 'media-playlist-repeat-symbolic', 16, () => {
            this._player?.cycleLoopStatus();
        });
        this._repeatBtn = repeat.btn;
        this._repeatIcon = repeat.icon;

        for (const btn of [
            this._shuffleBtn,
            this._seekBackBtn,
            this._prevBtn,
            this._playBtn,
            this._nextBtn,
            this._seekFwdBtn,
            this._repeatBtn,
        ])
            controlsRow.add_child(btn);

        this._playerCol.add_child(controlsRow);
    }

    _buildAudioSection() {
        this._audioSection = new St.BoxLayout({
            style_class: 'amc-popup-audio-section',
            orientation: Clutter.Orientation.VERTICAL,
            x_expand: true,
        });

        const volumeRow = new St.BoxLayout({
            style_class: 'amc-popup-volume-row',
            orientation: Clutter.Orientation.HORIZONTAL,
            y_align: Clutter.ActorAlign.CENTER,
            x_expand: true,
        });

        this._muteIcon = new St.Icon({ icon_name: 'audio-volume-high-symbolic', icon_size: 16 });
        this._muteBtn = new St.Button({
            style_class: 'amc-popup-mini-btn',
            child: this._muteIcon,
            can_focus: true,
            y_align: Clutter.ActorAlign.CENTER,
        });
        this._trackSignal(this._muteBtn, 'clicked', () => this._toggleMuteOrZero());

        this._volumeSlider = new Slider(0.8);
        this._volumeSlider.add_style_class_name('amc-popup-volume-slider');
        this._volumeSlider.x_expand = true;
        this._trackSignal(this._volumeSlider, 'drag-begin', () => {
            if (!this._isOpen || this._destroyed)
                return;
            this._isVolumeDragging = true;
        });
        this._trackSignal(this._volumeSlider, 'drag-end', () => {
            const wasDragging = this._isVolumeDragging;
            this._isVolumeDragging = false;
            if (!this._isOpen || this._destroyed || !wasDragging)
                return;
            this._applyVolumeSliderValue(this._volumeSlider.value);
        });
        this._trackSignal(this._volumeSlider, 'notify::value', () => {
            if (!this._updatingVolume && this._isOpen && !this._destroyed)
                this._applyVolumeSliderValue(this._volumeSlider.value);
        });

        const outputBtnBox = new St.BoxLayout({
            style_class: 'amc-output-btn-box',
            orientation: Clutter.Orientation.HORIZONTAL,
            y_align: Clutter.ActorAlign.CENTER,
        });
        this._outputIcon = new St.Icon({ icon_name: 'audio-speakers-symbolic', icon_size: 14 });
        this._outputLabel = new St.Label({
            style_class: 'amc-output-label',
            text: 'Output',
            y_align: Clutter.ActorAlign.CENTER,
        });
        this._outputLabel.clutter_text.ellipsize = Pango.EllipsizeMode.END;
        this._outputChevron = new St.Icon({ icon_name: 'pan-down-symbolic', icon_size: 13 });
        outputBtnBox.add_child(this._outputIcon);
        outputBtnBox.add_child(this._outputLabel);
        outputBtnBox.add_child(this._outputChevron);

        this._outputBtn = new St.Button({
            style_class: 'amc-output-pill-btn',
            child: outputBtnBox,
            can_focus: true,
            y_align: Clutter.ActorAlign.CENTER,
        });
        this._trackSignal(this._outputBtn, 'clicked', () => {
            this._outputsExpanded = !this._outputsExpanded;
            this._syncOutputsList();
        });

        volumeRow.add_child(this._muteBtn);
        volumeRow.add_child(this._volumeSlider);
        volumeRow.add_child(this._outputBtn);
        this._audioSection.add_child(volumeRow);

        this._outputsListBox = new St.BoxLayout({
            style_class: 'amc-output-list',
            orientation: Clutter.Orientation.VERTICAL,
            x_expand: true,
            visible: false,
        });
        this._audioSection.add_child(this._outputsListBox);
        this._playerCol.add_child(this._audioSection);
    }

    _attachSignals() {
        this._menuOpenSigId = this._menu.connect('open-state-changed', (_menu, isOpen) => {
            if (this._destroyed)
                return;
            this._isOpen = isOpen;
            this._isDragging = false;
            this._isVolumeDragging = false;

            if (isOpen) {
                this._applyAccentTheme();
                this._syncVolumeUi();
                this._syncOutputsList();
                this._refreshPositionOnce();
                this._startPositionTimer();
                if (this._lyrics.isOpen && this._showLyrics && this._player) {
                    this._lyrics.ensureLoaded(this._player, {
                        lengthUs: this._getEffectiveLengthUs(),
                        canSeek: Boolean(this._player.canSeek),
                    }).catch(() => {});
                }
            } else {
                this._stopPositionTimer();
                this._outputsExpanded = false;
                this._outputsListBox.visible = false;
            }
        });

        this._overviewSigId = Main.overview.connect('showing', () => {
            if (this._menu?.isOpen)
                this._menu.close(false);
        });

        if (this._audioOutputs) {
            this._outputsSigIds = [
                this._audioOutputs.connect('changed', () => {
                    if (!this._destroyed)
                        this._syncOutputsList();
                }),
                this._audioOutputs.connect('volume-changed', () => {
                    if (!this._destroyed)
                        this._syncVolumeUi();
                }),
            ];
        }
    }

    _configureSpectrumWidget(widget, opts) {
        widget?.applyConfig(opts);
    }

    _syncSpectrumPlaying(playing) {
        const next = Boolean(playing);
        this._popupSpectrum?.setPlaying(next);
        this._topSpectrum?.setPlaying(next);
    }

    applySettings({
        popupBlur,
        accentSource,
        appIconWhite = false,
        popupWidth = 380,
        popupOpacity = 90,
        showShuffleRepeat = true,
        showSeekButtons = true,
        showVolumeOutput = true,
        showLyrics = true,
        showPopupSpectrum = false,
        popupSpectrumStyle = 'aurora',
        showPopupTopSpectrum = false,
        spectrumColumns = 6,
        spectrumRange = 32,
        spectrumPeaks = true,
        spectrumColors = 'accent',
        spectrumFps = 30,
        spectrumInvert = false,
        spectrumAllSound = false,
        spectrumDemoAnimation = false,
        accentApplySpectrum = true,
    }) {
        if (this._destroyed)
            return;

        const blurChanged = this._blurEnabled !== popupBlur;
        const showLyricsChanged = this._showLyrics !== Boolean(showLyrics);
        this._blurEnabled = popupBlur;
        this._accentSource = accentSource;
        this._appIconWhite = Boolean(appIconWhite);
        this._popupWidth = Math.max(320, Math.min(520, popupWidth));
        this._popupOpacity = Math.max(40, Math.min(100, popupOpacity));
        this._showShuffleRepeat = Boolean(showShuffleRepeat);
        this._showSeekButtons = Boolean(showSeekButtons);
        this._showVolumeOutput = Boolean(showVolumeOutput);
        this._showLyrics = Boolean(showLyrics);
        this._showPopupSpectrum = Boolean(showPopupSpectrum);
        this._showPopupTopSpectrum = Boolean(showPopupTopSpectrum);
        this._accentApplySpectrum = Boolean(accentApplySpectrum);

        const sharedSpectrumOpts = {
            rangeDb: spectrumRange,
            showPeaks: spectrumPeaks,
            colorMode: spectrumColors,
            fps: spectrumFps,
            invert: spectrumInvert,
            allSound: spectrumAllSound,
            demoAnimation: spectrumDemoAnimation,
        };

        this._popupSpectrumBox.visible = this._showPopupSpectrum;
        this._configureSpectrumWidget(this._popupSpectrum, {
            ...sharedSpectrumOpts,
            width: Math.max(220, this._popupWidth - 46),
            height: 38,
            columns: spectrumColumns,
            style: popupSpectrumStyle || 'aurora',
        });

        this._topSpectrumBox.visible = this._showPopupTopSpectrum;
        this._configureSpectrumWidget(this._topSpectrum, {
            ...sharedSpectrumOpts,
            width: Math.max(220, this._popupWidth - 8),
            height: 46,
            columns: spectrumColumns,
            style: 'bars',
        });

        const layerAlpha = Math.round(255 * (this._popupOpacity / 100));
        this._sheen.opacity = layerAlpha;
        this._lyrics.sheen.opacity = layerAlpha;
        if (this._backdropUri) {
            this._backdropLayers[1].remove_all_transitions();
            this._backdropLayers[1].opacity = layerAlpha;
        }

        if (blurChanged)
            this._updateBackdrop();

        this._lyricsBtn.visible = this._showLyrics;
        this._headerLeftSpacer.visible = this._showLyrics;
        if (!this._showLyrics)
            this._lyrics.setOpen(false);
        if (showLyricsChanged && this._isOpen)
            this._restartPositionTimer();
        this._audioSection.visible = this._showVolumeOutput;

        this._lastSyncedTopWidth = 0;
        this._syncLyricsPanelSize();
        this._syncSpectrumPlaying(this._player?.isPlaying);
        this._syncAppIcons();
        this._syncTransportControls();
        this._syncVolumeUi();
        this._applyAccentTheme();
    }

    _syncAppIcons() {
        const gicon = this._player?.gicon ?? null;
        applyAppIconAppearance(this._appIcon, gicon, this._appIconWhite);
        if (!this._currentLocalUri)
            applyAppIconAppearance(this._artFallbackIcon, gicon, this._appIconWhite);
    }

    _resolveActiveAccent() {
        switch (this._accentSource) {
        case 'app-logo':
            return this._coverService.extractFromGIcon(this._player?.gicon ?? null);
        case 'shell':
            return this._coverService.getShellAccent();
        case 'white':
            return this._coverService.getWhiteAccent();
        case 'cover':
        default:
            return this._coverAccent;
        }
    }

    _applyAccentTheme() {
        if (this._destroyed)
            return;

        const accent = this._resolveActiveAccent();
        this._elapsedLabel.style = `color: ${accent.accentCss};`;

        const sliderStyle =
            `color: ${accent.accentCss}; ` +
            `-barlevel-active-background-color: ${accent.accentCss};`;
        this._slider.style = sliderStyle;
        this._volumeSlider.style = sliderStyle;

        this._playBtn.style =
            `background-color: ${accent.accentCss}; ` +
            `color: ${accent.contrastFg};`;

        this._shuffleBtn.style = this._player?.shuffle
            ? `color: ${accent.accentCss};`
            : null;
        const loopActive = this._player?.loopStatus && this._player.loopStatus !== 'None';
        this._repeatBtn.style = loopActive
            ? `color: ${accent.accentCss};`
            : null;

        this._lyricsBtn.style = this._lyrics.isOpen
            ? `color: ${accent.accentCss}; background-color: rgba(255, 255, 255, 0.16);`
            : null;

        if (this._currentLocalUri) {
            this._artFrame.style =
                `background-image: url("${this._currentLocalUri}"); ` +
                `border-color: ${accent.borderRgba};`;
        } else {
            this._artFrame.style = `border-color: ${accent.borderRgba};`;
        }

        this._rebuildSwitcher();
        this._lyrics.highlightActive(false);
        const spectrumAccent = this._accentApplySpectrum ? accent.accentCss : '';
        this._popupSpectrum?.setAccentColor(spectrumAccent);
        this._topSpectrum?.setAccentColor(spectrumAccent);
        this._onAccentChanged?.(accent.accentCss);
    }

    _syncTransportControls() {
        const p = this._player;
        const canPlay = Boolean(p && (p.canPlay || p.canPause));
        setButtonSensitive(this._prevBtn, Boolean(p?.canGoPrevious));
        setButtonSensitive(this._nextBtn, Boolean(p?.canGoNext));
        setButtonSensitive(this._playBtn, canPlay);

        const canSeek = Boolean(p?.canSeek);
        this._seekBackBtn.visible = this._showSeekButtons;
        this._seekFwdBtn.visible = this._showSeekButtons;
        setButtonSensitive(this._seekBackBtn, canSeek);
        setButtonSensitive(this._seekFwdBtn, canSeek);

        this._shuffleBtn.visible = Boolean(this._showShuffleRepeat && p?.canShuffle);
        this._repeatBtn.visible = Boolean(this._showShuffleRepeat && p?.canLoop);
        if (p?.canLoop) {
            this._repeatIcon.icon_name = p.loopStatus === 'Track'
                ? 'media-playlist-repeat-song-symbolic'
                : 'media-playlist-repeat-symbolic';
        }
    }

    _syncVolumeUi() {
        if (this._destroyed || !this._showVolumeOutput)
            return;

        const usePlayerVol = Boolean(this._player?.canSetVolume);
        const vol = usePlayerVol
            ? (this._player.volume ?? 1)
            : (this._audioOutputs?.volume ?? 0);
        const muted = usePlayerVol ? vol <= 0.005 : Boolean(this._audioOutputs?.muted);

        this._muteIcon.icon_name = volumeIconName(vol, muted);
        if (!this._isVolumeDragging) {
            this._updatingVolume = true;
            this._volumeSlider.value = Math.max(0, Math.min(1, vol));
            this._updatingVolume = false;
        }
    }

    _applyVolumeSliderValue(fraction) {
        if (this._player?.canSetVolume)
            this._player.setVolume(fraction);
        else
            this._audioOutputs?.setVolume(fraction);
    }

    _toggleMuteOrZero() {
        if (this._player?.canSetVolume) {
            const cur = this._player.volume ?? 1;
            this._player.setVolume(cur > 0.02 ? 0 : 0.75);
        } else {
            this._audioOutputs?.toggleMute();
        }
    }

    _syncOutputsList() {
        if (this._destroyed)
            return;

        this._disconnectSignalList(this._outputBtnSignals);
        this._preserveMenuFocusBeforeClear(this._outputsListBox);
        this._outputsListBox.remove_all_children();

        if (!this._audioOutputs) {
            this._outputBtn.visible = false;
            this._outputsListBox.visible = false;
            return;
        }

        const outputs = this._audioOutputs.outputs;
        const active = this._audioOutputs.active;
        this._outputBtn.visible = outputs.length > 0;
        if (active) {
            this._outputIcon.gicon = active.gicon;
            this._outputLabel.text = active.name || 'Output';
        } else {
            this._outputIcon.icon_name = 'audio-speakers-symbolic';
            this._outputLabel.text = 'Output';
        }
        this._outputChevron.icon_name = this._outputsExpanded ? 'pan-up-symbolic' : 'pan-down-symbolic';

        if (!this._outputsExpanded || outputs.length === 0) {
            this._outputsListBox.visible = false;
            this._syncLyricsPanelSize();
            return;
        }

        this._outputsListBox.visible = true;
        const accent = this._resolveActiveAccent();
        for (const out of outputs) {
            const isActive = out.id === this._audioOutputs.activeId;
            const row = new St.BoxLayout({
                style_class: 'amc-output-item-row',
                orientation: Clutter.Orientation.HORIZONTAL,
                y_align: Clutter.ActorAlign.CENTER,
                x_expand: true,
            });
            const icon = new St.Icon({ gicon: out.gicon, icon_size: 15 });
            const label = new St.Label({
                text: out.name || 'Audio Output',
                x_expand: true,
                y_align: Clutter.ActorAlign.CENTER,
            });
            label.clutter_text.ellipsize = Pango.EllipsizeMode.END;
            row.add_child(icon);
            row.add_child(label);

            if (isActive) {
                const check = new St.Icon({ icon_name: 'object-select-symbolic', icon_size: 14 });
                check.style = `color: ${accent.accentCss};`;
                row.add_child(check);
            }

            const btn = new St.Button({
                style_class: isActive ? 'amc-output-item amc-output-item-active' : 'amc-output-item',
                child: row,
                can_focus: true,
                x_expand: true,
            });
            const sigId = btn.connect('clicked', () => {
                this._audioOutputs?.selectOutput(out.id);
                this._outputsExpanded = false;
                this._syncOutputsList();
            });
            this._outputBtnSignals.push([btn, sigId]);
            this._outputsListBox.add_child(btn);
        }
        this._syncLyricsPanelSize();
    }

    _getEffectiveLengthUs() {
        return this._player?.metadata?.lengthUs || 0;
    }

    _currentPositionUs() {
        if (!this._player)
            return 0;
        const est = this._player.getEstimatedPositionUs();
        this._positionUs = est;
        return est;
    }

    _setPositionAnchor(posUs) {
        const lengthUs = this._getEffectiveLengthUs();
        const clamped = lengthUs > 0
            ? Math.max(0, Math.min(lengthUs, posUs || 0))
            : Math.max(0, posUs || 0);
        this._positionUs = clamped;
    }

    _markSeekTarget(targetUs) {
        this._seekTargetUs = Math.max(0, targetUs || 0);
        this._seekGuardUntilUs = GLib.get_monotonic_time() + 2_200_000;
        if (this._postSeekRefreshId) {
            GLib.Source.remove(this._postSeekRefreshId);
            this._postSeekRefreshId = 0;
        }
        this._postSeekRefreshId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 2350, () => {
            this._postSeekRefreshId = 0;
            if (!this._destroyed && (this._isOpen || this._menu?.isOpen))
                this._refreshPositionOnce();
            return GLib.SOURCE_REMOVE;
        });
    }

    _shouldIgnoreSeekPosition(posUs, forceScroll = false) {
        if (!Number.isFinite(posUs) || posUs < 0)
            return true;
        const nowUs = GLib.get_monotonic_time();
        return !forceScroll &&
            nowUs < this._seekGuardUntilUs &&
            (posUs <= 0 || Math.abs(posUs - this._seekTargetUs) > 4_000_000);
    }

    _attachPlayerSeekSignal(player) {
        if (this._playerSeekSigId && this._playerSigOwner) {
            try {
                this._playerSigOwner.disconnect(this._playerSeekSigId);
            } catch {
                // Ignore if already destroyed.
            }
            this._playerSeekSigId = 0;
            this._playerSigOwner = null;
        }
        if (player) {
            this._playerSigOwner = player;
            this._playerSeekSigId = player.connect('seeked', (_p, posUs) => {
                if (this._destroyed || this._player !== player || this._isDragging)
                    return;
                const safePos = Number(posUs);
                if (this._shouldIgnoreSeekPosition(safePos, false))
                    return;
                this._setPositionAnchor(safePos);
                this._syncSliderAndTime();
                this._lyrics?.highlightActive(true);
            });
        }
    }

    _syncCardSurfaces() {
        const dual = Boolean(this._lyrics.isOpen && this._lyrics.cardBin.visible);
        const floating = dual || this._showPopupTopSpectrum;
        const box = this._menu?.box;
        const menuActor = this._menu?.actor;
        const tint = this._backdropTintColor;

        if (floating) {
            menuActor?.add_style_class_name('amc-dual-boxpointer');
            if (box) {
                box.add_style_class_name('amc-dual-menu');
                box.style = null;
            }
            this._cardBin.add_style_class_name('amc-card-standalone');
            this._cardBin.style = tint ? `background-color: ${tint};` : null;
        } else {
            menuActor?.remove_style_class_name('amc-dual-boxpointer');
            if (box) {
                box.remove_style_class_name('amc-dual-menu');
                box.style = tint ? `background-color: ${tint};` : null;
            }
            this._cardBin.remove_style_class_name('amc-card-standalone');
            this._cardBin.style = null;
        }
    }

    _queueLayoutSync() {
        if (this._destroyed || this._layoutSyncIdleId)
            return;
        this._layoutSyncIdleId = GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
            this._layoutSyncIdleId = 0;
            if (!this._destroyed)
                this._syncLyricsPanelSize();
            return GLib.SOURCE_REMOVE;
        });
    }

    _syncTopSpectrumWidth() {
        if (this._destroyed || !this._topSpectrum || !this._topSpectrumBox || !this._rootRow)
            return;
        const scale = getStageScaleFactor();
        const [, natRowW] = this._rootRow.get_preferred_width(-1);
        const dual = Boolean(this._lyrics.isOpen && this._lyrics.cardBin?.visible);
        const fallbackCardW = this._popupWidth + 34;
        const fallbackW = dual
            ? fallbackCardW + 12 + Math.max(300, Math.round(this._popupWidth * 0.92)) + 2
            : fallbackCardW;
        const totalW = natRowW > 0 ? Math.round(natRowW / scale) : fallbackW;
        const barW = Math.max(220, totalW - 40);
        if (barW === this._lastSyncedTopWidth)
            return;
        this._lastSyncedTopWidth = barW;
        this._topSpectrum.setTargetSize(barW, 46);
    }

    _syncLyricsPanelSize() {
        if (this._destroyed || !this._playerCol)
            return;
        const colW = this._popupWidth;
        const nextColStyle = `width: ${colW}px;`;
        if (this._playerCol.style !== nextColStyle)
            this._playerCol.style = nextColStyle;
        this._syncCardSurfaces();
        if (!this._lyrics.isOpen || !this._lyrics.cardBin.visible) {
            this._lastSyncedLyricsKey = '';
            this._syncTopSpectrumWidth();
            return;
        }

        const [, cardNatH] = this._cardBin.get_preferred_height(colW);
        const tintKey = `${colW}|${cardNatH}|${this._backdropTintColor}`;
        if (this._lastSyncedLyricsKey !== tintKey) {
            this._lastSyncedLyricsKey = tintKey;
            this._lyrics.syncSize(colW, cardNatH, this._backdropTintColor);
        }
        this._syncTopSpectrumWidth();
    }

    _commitSeekTo(targetUs, { syncLayout = false, forceLyricStyle = false, applySeek = null } = {}) {
        this._lyrics?.resetManualScroll();
        this._markSeekTarget(targetUs);
        this._setPositionAnchor(targetUs);
        if (applySeek)
            applySeek(targetUs);
        else
            this._player?.setPosition(targetUs);
        this._syncSliderAndTime();
        if (syncLayout)
            this._syncLyricsPanelSize();
        this._lyrics?.highlightActive(true, forceLyricStyle, forceLyricStyle);
    }

    _seekRelative(offsetUs) {
        if (!this._player?.canSeek)
            return;
        const lengthUs = this._getEffectiveLengthUs();
        const nextPos = Math.max(0, this._currentPositionUs() + offsetUs);
        const target = lengthUs > 0 ? Math.min(lengthUs, nextPos) : nextPos;
        this._commitSeekTo(target, {
            syncLayout: false,
            applySeek: () => this._player?.seek(offsetUs),
        });
    }

    _toggleLyrics() {
        if (!this._showLyrics || this._destroyed)
            return;
        const nextOpen = !this._lyrics.isOpen;
        this._lyrics.setOpen(nextOpen);
        this._syncLyricsPanelSize();
        this._applyAccentTheme();

        if (nextOpen) {
            this._lyrics.resetManualScroll();
            this._refreshPositionOnce();
            this._lyrics.ensureLoaded(this._player, {
                lengthUs: this._getEffectiveLengthUs(),
                canSeek: Boolean(this._player?.canSeek),
            }).catch(() => {});
            if (this._isOpen)
                this._restartPositionTimer();
        } else if (this._isOpen) {
            this._restartPositionTimer();
        }
    }

    _preserveMenuFocusBeforeClear(container) {
        const focus = global?.stage?.get_key_focus?.();
        if (focus && container?.contains?.(focus))
            this._menu?.actor?.grab_key_focus?.();
    }

    _updateBackdrop() {
        if (this._destroyed)
            return;
        if (this._backdropCancellable) {
            this._backdropCancellable.cancel();
            this._backdropCancellable = null;
        }
        if (!this._blurEnabled || !this._currentLocalUri) {
            this._backdropGeneration++;
            this._showBackdrop(null);
            return;
        }

        const generation = ++this._backdropGeneration;
        const cancellable = new Gio.Cancellable();
        this._backdropCancellable = cancellable;
        this._backdropMaker.make(this._currentLocalUri, cancellable)
            .then(backdrop => {
                if (this._backdropCancellable === cancellable)
                    this._backdropCancellable = null;
                if (!this._destroyed && !cancellable.is_cancelled() && generation === this._backdropGeneration)
                    this._showBackdrop(backdrop);
            })
            .catch(() => {});
    }

    _showBackdrop(backdrop) {
        if (this._destroyed || !this._backdropLayers)
            return;
        const uri = backdrop?.uri ?? null;
        if (uri === this._backdropUri)
            return;
        this._backdropUri = uri;

        const [lower, upper] = this._backdropLayers;
        lower.remove_all_transitions();
        upper.remove_all_transitions();
        if (upper.style) {
            lower.style = upper.style;
            lower.opacity = upper.opacity;
        }

        upper.style = uri ? `background-image: url("${uri}");` : null;
        upper.opacity = 0;

        const targetOpacity = Math.round(255 * (this._popupOpacity / 100));
        const fade = {
            duration: BACKDROP_FADE_MS,
            mode: Clutter.AnimationMode.EASE_OUT_QUAD,
            onComplete: () => {
                if (!this._destroyed)
                    lower.style = null;
            },
        };
        if (uri) {
            upper.ease({ opacity: targetOpacity, ...fade });
            if (lower.style) {
                lower.ease({
                    opacity: 0,
                    duration: BACKDROP_FADE_MS,
                    mode: Clutter.AnimationMode.EASE_OUT_QUAD,
                });
            }
        } else {
            lower.ease({ opacity: 0, ...fade });
        }

        const box = this._menu?.box;
        this._backdropTintColor = backdrop?.color || '';
        if (backdrop?.color) {
            box?.add_style_class_name('amc-glass');
            this._lyrics.setGlass(true);
        } else {
            box?.remove_style_class_name('amc-glass');
            this._lyrics.setGlass(false);
        }
        this._syncLyricsPanelSize();
    }

    update(player, players) {
        if (this._destroyed)
            return;

        const prevPlayer = this._player;
        this._player = player;
        this._players = players || [];
        if (prevPlayer !== player)
            this._attachPlayerSeekSignal(player);

        if (!player) {
            this._lastTrackKey = '';
            this._isDragging = false;
            this._seekGuardUntilUs = 0;
            if (this._postTrackRefreshId) {
                GLib.Source.remove(this._postTrackRefreshId);
                this._postTrackRefreshId = 0;
            }
            if (this._postSeekRefreshId) {
                GLib.Source.remove(this._postSeekRefreshId);
                this._postSeekRefreshId = 0;
            }
            if (this._artCancellable) {
                this._artCancellable.cancel();
                this._artCancellable = null;
            }
            this._setPositionAnchor(0);
            this._syncSpectrumPlaying(false);
            this._syncAppIcons();
            this._appLabel.text = 'No Active Player';
            this._titleLabel.text = 'Nothing Playing';
            this._artistLabel.visible = false;
            this._albumLabel.visible = false;
            this._elapsedLabel.text = '0:00';
            this._durationLabel.text = '0:00';
            this._updatingSlider = true;
            this._slider.value = 0;
            this._updatingSlider = false;
            this._slider.reactive = false;
            this._playIcon.icon_name = 'media-playback-start-symbolic';
            this._currentArtUrl = '';
            this._syncTransportControls();
            this._syncVolumeUi();
            this._setCoverVisual('', this._coverService.getWhiteAccent());
            if (this._lyrics.isOpen)
                this._lyrics.renderStatus('No active media player.');
            this._syncLyricsPanelSize();
            return;
        }

        this._syncSpectrumPlaying(player.isPlaying);
        this._syncAppIcons();
        this._appLabel.text = player.displayName;

        this._titleLabel.text = player.metadata.title || player.displayName;
        this._artistLabel.text = player.metadata.artist || '';
        this._artistLabel.visible = Boolean(player.metadata.artist);
        this._albumLabel.text = player.metadata.album || '';
        this._albumLabel.visible = Boolean(player.metadata.album);

        this._playIcon.icon_name = player.isPlaying
            ? 'media-playback-pause-symbolic'
            : 'media-playback-start-symbolic';

        this._syncTransportControls();
        this._syncVolumeUi();

        const trackKey = `${player.busName}|${player.metadata.title}|${player.metadata.artist}`;
        const trackChanged = trackKey !== this._lastTrackKey;
        this._lastTrackKey = trackKey;

        const lengthUs = this._getEffectiveLengthUs();
        const effectiveCanSeek = Boolean(player.canSeek);
        this._durationLabel.text = formatTime(lengthUs);
        if (!this._isDragging)
            this._slider.reactive = effectiveCanSeek && lengthUs > 0;

        if (trackChanged) {
            this._lyrics.resetManualScroll();
            this._seekGuardUntilUs = 0;
            this._setPositionAnchor(0);
            if (this._postTrackRefreshId) {
                GLib.Source.remove(this._postTrackRefreshId);
                this._postTrackRefreshId = 0;
            }
            if (this._isOpen) {
                this._postTrackRefreshId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 400, () => {
                    this._postTrackRefreshId = 0;
                    if (!this._destroyed)
                        this._refreshPositionOnce();
                    return GLib.SOURCE_REMOVE;
                });
            }
        } else {
            this._setPositionAnchor(player.getEstimatedPositionUs());
        }

        if (this._isOpen || prevPlayer !== player || trackChanged)
            this._refreshPositionOnce();

        if (this._isOpen && this._lyrics.isOpen && this._showLyrics) {
            this._lyrics.ensureLoaded(player, {
                lengthUs,
                canSeek: effectiveCanSeek,
            }).catch(() => {});
        }

        this._syncLyricsPanelSize();

        const nextArtUrl = player.metadata.artUrl || '';
        if (nextArtUrl !== this._currentArtUrl) {
            this._currentArtUrl = nextArtUrl;
            this._applyAccentTheme();
            this._loadCoverArtAsync(nextArtUrl).catch(() => {});
        } else {
            this._applyAccentTheme();
        }
    }

    _rebuildSwitcher() {
        if (this._destroyed)
            return;

        this._disconnectSignalList(this._switcherBtnSignals);
        this._preserveMenuFocusBeforeClear(this._switcherBox);
        this._switcherBox.remove_all_children();
        if (this._players.length <= 1) {
            this._switcherBox.visible = false;
            return;
        }

        this._switcherBox.visible = true;
        const accent = this._resolveActiveAccent();

        for (const p of this._players) {
            const isSelected = p.busName === this._player?.busName;
            const chip = new St.Button({
                style_class: isSelected
                    ? 'amc-player-chip amc-player-chip-active'
                    : 'amc-player-chip',
                label: p.displayName,
                can_focus: true,
            });
            if (isSelected) {
                chip.style =
                    `background-color: ${accent.accentCss}; ` +
                    `color: ${accent.contrastFg};`;
            }
            const sigId = chip.connect('clicked', () => this._onSelectPlayer?.(p.busName));
            this._switcherBtnSignals.push([chip, sigId]);
            this._switcherBox.add_child(chip);
        }
    }

    async _loadCoverArtAsync(artUrl) {
        if (this._destroyed)
            return;

        if (this._artCancellable) {
            this._artCancellable.cancel();
            this._artCancellable = null;
        }

        if (!artUrl) {
            this._setCoverVisual('', this._coverService.getWhiteAccent());
            return;
        }

        const cancellable = new Gio.Cancellable();
        this._artCancellable = cancellable;

        const { localUri, accent } = await this._coverService.resolve(artUrl, cancellable);
        if (this._destroyed || cancellable.is_cancelled() || this._currentArtUrl !== artUrl)
            return;

        this._setCoverVisual(localUri, accent);
    }

    _setCoverVisual(localUri, coverAccent) {
        if (this._destroyed)
            return;
        this._currentLocalUri = localUri;
        this._coverAccent = coverAccent || this._coverService.getWhiteAccent();

        if (localUri) {
            this._artFrame.set_child(null);
        } else {
            applyAppIconAppearance(this._artFallbackIcon, this._player?.gicon ?? null, this._appIconWhite);
            this._artFrame.set_child(this._artFallbackIcon);
        }

        this._onCoverArtResolved?.(localUri);
        this._updateBackdrop();
        this._applyAccentTheme();
    }

    _refreshPositionOnce(forceScroll = false, { driftThresholdUs = 0 } = {}) {
        if (this._destroyed || !this._player)
            return;
        if (!forceScroll && GLib.get_monotonic_time() < this._seekGuardUntilUs)
            return;

        if (forceScroll)
            this._pendingLyricsScroll = true;

        const targetPlayer = this._player;
        targetPlayer.fetchPositionUs(posUs => {
            if (this._destroyed || this._player !== targetPlayer || this._isDragging)
                return;

            if (this._shouldIgnoreSeekPosition(posUs, forceScroll))
                return;

            const prevIdx = this._lyrics.activeIndex;
            const wantScroll = prevIdx < 0 || this._pendingLyricsScroll;
            const immediate = this._pendingLyricsScroll;
            this._pendingLyricsScroll = false;
            this._setPositionAnchor(posUs);
            this._syncSliderAndTime();
            this._lyrics.highlightActive(wantScroll, immediate, immediate);
        }, { driftThresholdUs });
    }

    _syncSliderAndTime() {
        if (this._destroyed || !this._player || this._isDragging)
            return;

        const posUs = this._currentPositionUs();
        const lengthUs = this._getEffectiveLengthUs();
        const nextElapsed = formatTime(posUs);
        if (this._elapsedLabel.text !== nextElapsed)
            this._elapsedLabel.text = nextElapsed;
        const nextDuration = formatTime(lengthUs);
        if (this._durationLabel.text !== nextDuration)
            this._durationLabel.text = nextDuration;

        this._updatingSlider = true;
        if (lengthUs > 0)
            this._slider.value = Math.max(0, Math.min(1, posUs / lengthUs));
        else
            this._slider.value = 0;
        this._updatingSlider = false;
    }

    _commitSeek() {
        const lengthUs = this._getEffectiveLengthUs();
        if (!this._player?.canSeek || lengthUs <= 0)
            return;
        const targetUs = Math.round(this._slider.value * lengthUs);
        this._commitSeekTo(targetUs, { syncLayout: true });
    }

    _startPositionTimer() {
        if (this._destroyed || this._positionTimerId)
            return;

        const intervalMs = 200;
        this._dbusSyncTicks = 0;
        const syncEveryTicks = 25;
        const periodicDriftThresholdUs = 1_500_000;
        this._positionTimerId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, intervalMs, () => {
            if (this._destroyed || (!this._isOpen && !this._menu?.isOpen)) {
                this._positionTimerId = 0;
                return GLib.SOURCE_REMOVE;
            }
            try {
                if (this._player?.isPlaying && !this._isDragging) {
                    this._positionUs = this._currentPositionUs();
                    this._syncSliderAndTime();
                    this._lyrics.highlightActive(false);

                    this._dbusSyncTicks++;
                    if (this._dbusSyncTicks >= syncEveryTicks) {
                        this._dbusSyncTicks = 0;
                        this._refreshPositionOnce(false, { driftThresholdUs: periodicDriftThresholdUs });
                    }
                }
            } catch (e) {
                console.debug(`[AmazingMediaControl] Position timer error: ${e.message}`);
            }
            return GLib.SOURCE_CONTINUE;
        });
    }

    _restartPositionTimer() {
        this._stopPositionTimer();
        this._isOpen = Boolean(!this._destroyed && (this._isOpen || this._menu?.isOpen));
        if (this._isOpen)
            this._startPositionTimer();
    }

    _stopPositionTimer() {
        if (this._positionTimerId) {
            GLib.Source.remove(this._positionTimerId);
            this._positionTimerId = 0;
        }
    }

    destroy() {
        if (this._destroyed)
            return;
        this._destroyed = true;
        this._backdropGeneration++;

        this._stopPositionTimer();
        this._attachPlayerSeekSignal(null);
        if (this._layoutSyncIdleId) {
            GLib.Source.remove(this._layoutSyncIdleId);
            this._layoutSyncIdleId = 0;
        }
        if (this._postTrackRefreshId) {
            GLib.Source.remove(this._postTrackRefreshId);
            this._postTrackRefreshId = 0;
        }
        if (this._postSeekRefreshId) {
            GLib.Source.remove(this._postSeekRefreshId);
            this._postSeekRefreshId = 0;
        }
        if (this._artCancellable) {
            this._artCancellable.cancel();
            this._artCancellable = null;
        }
        if (this._backdropCancellable) {
            this._backdropCancellable.cancel();
            this._backdropCancellable = null;
        }

        this._disconnectSignalList(this._outputBtnSignals);
        this._disconnectSignalList(this._switcherBtnSignals);
        this._disconnectSignalList(this._uiSignals);

        if (this._menuOpenSigId && this._menu) {
            this._menu.disconnect(this._menuOpenSigId);
            this._menuOpenSigId = 0;
        }
        if (this._overviewSigId) {
            Main.overview.disconnect(this._overviewSigId);
            this._overviewSigId = 0;
        }
        for (const sigId of this._outputsSigIds) {
            try {
                this._audioOutputs?.disconnect(sigId);
            } catch {
                // Ignore.
            }
        }
        this._outputsSigIds = [];

        if (this._backdropLayers) {
            for (const layer of this._backdropLayers)
                layer?.remove_all_transitions();
            this._backdropLayers = null;
        }

        if (this._artFallbackIcon && !this._artFallbackIcon.get_parent())
            this._artFallbackIcon.destroy();
        this._artFallbackIcon = null;

        if (this._menu?.box) {
            this._menu.box.remove_style_class_name('amc-card-menu');
            this._menu.box.remove_style_class_name('amc-glass');
            this._menu.box.remove_style_class_name('amc-dual-menu');
            this._menu.box.style = null;
        }
        if (this._menu?.actor) {
            this._menu.actor.remove_style_class_name('amc-dual-boxpointer');
            this._menu.actor.style = null;
        }

        this._lyrics?.destroy();
        this._lyrics = null;
        this._popupSpectrum?.destroy();
        this._popupSpectrum = null;
        this._topSpectrum?.destroy();
        this._topSpectrum = null;
        this._section?.destroy();
        this._section = null;
        this._backdropMaker.destroy();
        this._coverService.destroy();

        this._player = null;
        this._players = [];
        this._menu = null;
        this._audioOutputs = null;
        this._spectrumAnalyzer = null;
        this._onSelectPlayer = null;
        this._onAccentChanged = null;
        this._onCoverArtResolved = null;
    }
}
