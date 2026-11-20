import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Meta from 'gi://Meta';
import Shell from 'gi://Shell';

import { Extension } from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';

import { AudioOutputService } from './src/audioOutputService.js';
import { BottomBarHost, applyCardVisibility } from './src/bottomBarHost.js';
import { clearIconCaches } from './src/iconUtils.js';
import { MediaCard } from './src/mediaCard.js';
import { MprisManager } from './src/mprisManager.js';
import { NowPlayingPopup } from './src/nowPlayingPopup.js';
import { SpectrumAnalyzer } from './src/spectrumAnalyzer.js';
import { filterEligiblePlayers } from './src/youtubeFilter.js';

const PanelCardButton = GObject.registerClass(
class PanelCardButton extends PanelMenu.Button {
    _init(card) {
        super._init(0.5, 'Amazing Media Control', false);
        this.add_style_class_name('amc-panel-button');
        this._card = card;
        this.add_child(card);

        // Disable PanelMenu.Button's capture-phase ClickGesture so inline
        // control buttons or clickable logo never accidentally toggle the popup.
        if (Clutter.ClickGesture) {
            for (const action of this.get_actions()) {
                if (action instanceof Clutter.ClickGesture)
                    action.set_enabled(false);
            }
        }
    }

    vfunc_event(event) {
        const type = event.type();
        if (type === Clutter.EventType.BUTTON_PRESS) {
            if (event.get_button() === Clutter.BUTTON_MIDDLE) {
                this._card?.playPause();
                return Clutter.EVENT_STOP;
            }
            if (event.get_button() !== Clutter.BUTTON_PRIMARY)
                return super.vfunc_event(event);
        }

        const isPress = type === Clutter.EventType.BUTTON_PRESS ||
            type === Clutter.EventType.TOUCH_BEGIN;

        if (isPress) {
            if (this.menu && !this._card?.isOnInteractiveChild(event)) {
                this.menu.toggle();
                return Clutter.EVENT_STOP;
            }
            return Clutter.EVENT_PROPAGATE;
        }

        return super.vfunc_event(event);
    }
});

export default class AmazingMediaControlExtension extends Extension {
    enable() {
        this._settings = this.getSettings();
        this._mpris = new MprisManager();
        this._audioOutputs = new AudioOutputService();
        this._analyzer = new SpectrumAnalyzer(
            this.dir.get_child('src').get_child('spectrumHelper.js').get_path()
        );
        this._selectedBusName = null;
        this._userSelectedBusName = null;
        this._playingBusNames = new Set();
        this._lastAccentCss = '';
        this._lastCoverUri = '';

        this._host = null;
        this._panelMenuManager = null;
        this._card = null;
        this._popup = null;
        this._panelMode = null;
        this._isFreshHost = false;
        this._hostMenuSigId = 0;
        this._hideTimerId = 0;

        this._mprisSigId = this._mpris.connect('players-changed', () => {
            this._refresh();
        });

        this._focusWindowSigId = global.display.connect('notify::focus-window', () => {
            if (this._settings.get_boolean('browser-youtube-only') && this._mpris?.getPlayers().length > 0)
                this._refresh();
        });

        this._settingsSigId = this._settings.connect('changed', (_s, key) => {
            const config = this._readConfig();
            const rebuildForPanel = key === 'panel-mode' ||
                (this._panelMode !== 'bottom-bar' && (key === 'panel-box' || key === 'panel-index'));
            if (rebuildForPanel)
                this._rebuildHost(config);
            this._applySettings(config);
            this._refresh(config);
        });

        Main.wm.addKeybinding(
            'toggle-popup-shortcut',
            this._settings,
            Meta.KeyBindingFlags.IGNORE_AUTOREPEAT,
            Shell.ActionMode.NORMAL | Shell.ActionMode.OVERVIEW | Shell.ActionMode.POPUP,
            () => this._togglePopup()
        );

        const initialConfig = this._readConfig();
        this._rebuildHost(initialConfig);
        this._applySettings(initialConfig);
        this._refresh(initialConfig);
    }

    _readConfig() {
        return {
            panelMode: this._settings.get_string('panel-mode'),
            panelBox: this._settings.get_string('panel-box'),
            panelIndex: this._settings.get_int('panel-index'),
            bottomMargin: this._settings.get_int('bottom-margin'),
            barFontSize: this._settings.get_int('bar-font-size'),
            barMaxWidth: this._settings.get_int('bar-max-width'),
            scrollingText: this._settings.get_boolean('scrolling-text'),
            animateTrackResize: this._settings.get_boolean('animate-track-resize'),
            barIconMode: this._settings.get_string('bar-icon-mode'),
            barTextFormat: this._settings.get_string('bar-text-format'),
            controlsPosition: this._settings.get_string('controls-position'),
            barElementsOrder: this._settings.get_strv('bar-elements-order'),
            controlsOnlyWhenPlaying: this._settings.get_boolean('controls-only-when-playing'),
            hideWhenPaused: this._settings.get_boolean('hide-when-paused'),
            hideWhenInactive: this._settings.get_boolean('hide-when-inactive'),
            appIconWhite: this._settings.get_boolean('app-icon-white'),
            logoClickRaises: this._settings.get_boolean('logo-click-raises'),
            popupBlur: this._settings.get_boolean('popup-blur'),
            accentSource: this._settings.get_string('accent-source'),
            popupWidth: this._settings.get_int('popup-width'),
            popupOpacity: this._settings.get_int('popup-opacity'),
            showShuffleRepeat: this._settings.get_boolean('show-shuffle-repeat'),
            showSeekButtons: this._settings.get_boolean('show-seek-buttons'),
            showVolumeOutput: this._settings.get_boolean('show-volume-output'),
            showLyrics: this._settings.get_boolean('show-lyrics'),
            showPopupSpectrum: this._settings.get_boolean('show-popup-spectrum'),
            popupSpectrumStyle: this._settings.get_string('popup-spectrum-style'),
            showPopupTopSpectrum: this._settings.get_boolean('show-popup-top-spectrum'),
            showSpectrum: this._settings.get_boolean('show-spectrum'),
            spectrumStyle: this._settings.get_string('spectrum-style'),
            spectrumColors: this._settings.get_string('spectrum-colors'),
            accentApplySpectrum: this._settings.get_boolean('accent-apply-spectrum'),
            spectrumColumns: this._settings.get_int('spectrum-columns'),
            spectrumWidth: this._settings.get_int('spectrum-width'),
            spectrumRange: this._settings.get_int('spectrum-range'),
            spectrumPeaks: this._settings.get_boolean('spectrum-peaks'),
            spectrumAllSound: this._settings.get_boolean('spectrum-all-sound'),
            spectrumFps: this._settings.get_int('spectrum-fps'),
            spectrumInvert: this._settings.get_boolean('spectrum-invert'),
            spectrumDemoAnimation: this._settings.get_boolean('spectrum-demo-animation'),
            hideAllBrowsers: this._settings.get_boolean('hide-all-browsers'),
            browserYoutubeOnly: this._settings.get_boolean('browser-youtube-only'),
            includeYoutubeMusic: this._settings.get_boolean('include-youtube-music'),
            ignoredPlayers: this._settings.get_string('ignored-players'),
            priorityPlayers: this._settings.get_string('priority-players'),
        };
    }

    _togglePopup() {
        const menu = this._host?.menu;
        if (!menu)
            return;
        if (menu.isOpen) {
            menu.close(true);
            return;
        }
        if (!this._host.visible) {
            this._cancelHideTimer();
            this._applyHostVisibility(true);
        }
        menu.toggle();
    }

    _cancelHideTimer() {
        if (this._hideTimerId) {
            GLib.Source.remove(this._hideTimerId);
            this._hideTimerId = 0;
        }
    }

    _destroyHost() {
        this._cancelHideTimer();
        if (this._hostMenuSigId && this._host?.menu) {
            this._host.menu.disconnect(this._hostMenuSigId);
            this._hostMenuSigId = 0;
        }
        this._host?.menu?.close?.(false);
        if (this._panelMenuManager) {
            if (this._host?.menu)
                this._panelMenuManager.removeMenu(this._host.menu);
            this._panelMenuManager = null;
        }
        if (this._popup) {
            this._popup.destroy();
            this._popup = null;
        }
        if (this._card)
            this._card.get_parent()?.remove_child(this._card);
        if (this._host) {
            this._host.destroy();
            this._host = null;
        }
        if (this._card) {
            this._card.destroy();
            this._card = null;
        }
        this._panelMode = null;
        this._isFreshHost = false;
    }

    _rebuildHost(config = this._readConfig()) {
        this._destroyHost();

        this._panelMode = config.panelMode;
        this._isFreshHost = true;

        const popupCallbacks = {
            audioOutputs: this._audioOutputs,
            spectrumAnalyzer: this._analyzer,
            onSelectPlayer: busName => {
                this._selectedBusName = busName;
                this._userSelectedBusName = busName;
                this._refresh();
            },
            onAccentChanged: accentCss => {
                if (this._isFreshHost && accentCss === '#ffffff' && this._lastAccentCss)
                    return;
                this._lastAccentCss = accentCss;
                this._syncSpectrumAccent();
            },
            onCoverArtResolved: localUri => {
                this._lastCoverUri = localUri || '';
                this._card?.setCoverArtUri(this._lastCoverUri);
            },
        };

        if (config.panelMode === 'bottom-bar') {
            this._card = new MediaCard({ enableClickGesture: true });
            this._card.setSpectrumAnalyzer(this._analyzer);
            this._host = new BottomBarHost(this._card);
            this._popup = new NowPlayingPopup(this._host.menu, popupCallbacks);
        } else {
            this._card = new MediaCard({ enableClickGesture: false });
            this._card.setSpectrumAnalyzer(this._analyzer);
            this._host = new PanelCardButton(this._card);
            Main.panel.addToStatusArea(
                this.uuid,
                this._host,
                config.panelIndex,
                config.panelBox
            );
            Main.panel.menuManager?.removeMenu(this._host.menu);
            this._panelMenuManager = new PopupMenu.PopupMenuManager(this._host, {
                actionMode: Shell.ActionMode.NORMAL | Shell.ActionMode.OVERVIEW | Shell.ActionMode.POPUP,
            });
            this._panelMenuManager.addMenu(this._host.menu);
            this._popup = new NowPlayingPopup(this._host.menu, popupCallbacks);
        }

        this._card.setCoverArtUri(this._lastCoverUri);
        if (this._host?.menu) {
            this._hostMenuSigId = this._host.menu.connect('open-state-changed', (_m, isOpen) => {
                if (!isOpen)
                    this._refresh();
            });
        }
    }

    _syncSpectrumAccent(config = null) {
        if (!this._card || !this._settings)
            return;
        const apply = config?.accentApplySpectrum ?? this._settings.get_boolean('accent-apply-spectrum');
        this._card.setSpectrumAccentColor(apply ? this._lastAccentCss : '');
    }

    _applySettings(config = this._readConfig()) {
        this._card?.applySettings(config);
        this._popup?.applySettings(config);
        this._syncSpectrumAccent(config);
        if (this._panelMode === 'bottom-bar')
            this._host?.setLayout(config);
    }

    _pickActivePlayer(eligiblePlayers) {
        const newlyPlaying = eligiblePlayers.find(
            p => p.isPlaying && !this._playingBusNames?.has(p.busName)
        );
        this._playingBusNames = new Set(
            eligiblePlayers.filter(p => p.isPlaying).map(p => p.busName)
        );
        if (newlyPlaying && newlyPlaying.busName !== this._userSelectedBusName)
            this._userSelectedBusName = null;

        if (eligiblePlayers.length === 0) {
            this._userSelectedBusName = null;
            return null;
        }

        if (this._selectedBusName) {
            const pinned = eligiblePlayers.find(p => p.busName === this._selectedBusName);
            if (pinned) {
                if (this._userSelectedBusName === pinned.busName)
                    return pinned;
                const playingOther = eligiblePlayers.find(p => p.isPlaying && p.busName !== pinned.busName);
                if (pinned.isPlaying || !playingOther)
                    return pinned;
            } else if (this._userSelectedBusName === this._selectedBusName) {
                this._userSelectedBusName = null;
            }
        }

        const picked = eligiblePlayers[0];
        this._selectedBusName = picked.busName;
        return picked;
    }

    _applyHostVisibility(visible) {
        if (!this._host)
            return;

        if (this._panelMode === 'bottom-bar') {
            this._host.setVisible(visible);
            return;
        }

        applyCardVisibility(this._host, this._card, this._host.menu, visible);
    }

    _setHostVisible(visible, hideDelayMs = 700) {
        if (!this._host)
            return;

        // Never auto-close or hide the host while the user has the popout open
        // (prevents YouTube/browser track transitions from slamming the popout shut).
        if (this._host.menu?.isOpen) {
            this._cancelHideTimer();
            this._applyHostVisibility(true);
            return;
        }

        if (visible) {
            this._cancelHideTimer();
            this._applyHostVisibility(true);
            return;
        }

        if (!this._host.visible && !this._card?.isConcealing()) {
            this._cancelHideTimer();
            this._applyHostVisibility(false);
            return;
        }

        if (hideDelayMs <= 0) {
            this._cancelHideTimer();
            this._applyHostVisibility(false);
            return;
        }

        if (!this._hideTimerId) {
            this._hideTimerId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, hideDelayMs, () => {
                this._hideTimerId = 0;
                if (!this._host?.menu?.isOpen)
                    this._applyHostVisibility(false);
                return GLib.SOURCE_REMOVE;
            });
        }
    }

    _refresh(config = this._readConfig()) {
        if (!this._mpris || !this._card || !this._popup)
            return;

        const allPlayers = this._mpris.getPlayers();
        const eligiblePlayers = filterEligiblePlayers(allPlayers, {
            hideAllBrowsers: config.hideAllBrowsers,
            browserYoutubeOnly: config.browserYoutubeOnly,
            includeYoutubeMusic: config.includeYoutubeMusic,
            ignoredPlayers: config.ignoredPlayers,
            priorityPlayers: config.priorityPlayers,
        });

        const activePlayer = this._pickActivePlayer(eligiblePlayers);

        let shouldShow = true;
        let hideDelayMs = 700;
        if (config.spectrumAllSound || config.spectrumDemoAnimation) {
            shouldShow = true;
        } else if (!activePlayer) {
            shouldShow = !config.hideWhenInactive;
        } else if (config.hideWhenPaused && !activePlayer.isPlaying) {
            shouldShow = false;
            // Debounce brief Paused flickers during track skips so bar animations survive.
            if (activePlayer.playbackStatus === 'Paused')
                hideDelayMs = 250;
        } else if (config.hideWhenInactive && !activePlayer.isActive) {
            shouldShow = false;
        }

        this._card.updatePlayer(activePlayer);
        this._popup.update(activePlayer, eligiblePlayers);

        const isInitialRefresh = Boolean(this._isFreshHost);
        this._isFreshHost = false;
        if (isInitialRefresh && !shouldShow) {
            this._cancelHideTimer();
            if (this._panelMode === 'bottom-bar') {
                if (this._host?.actor)
                    this._host.actor.visible = false;
                this._host?.setVisible(false);
            } else if (this._host) {
                this._host.visible = false;
            }
            return;
        }

        this._setHostVisible(shouldShow, hideDelayMs);
    }

    disable() {
        Main.wm.removeKeybinding('toggle-popup-shortcut');

        if (this._settingsSigId && this._settings) {
            this._settings.disconnect(this._settingsSigId);
            this._settingsSigId = 0;
        }
        if (this._focusWindowSigId) {
            global.display.disconnect(this._focusWindowSigId);
            this._focusWindowSigId = 0;
        }
        if (this._mprisSigId && this._mpris) {
            this._mpris.disconnect(this._mprisSigId);
            this._mprisSigId = 0;
        }

        this._destroyHost();

        if (this._analyzer) {
            this._analyzer.destroy();
            this._analyzer = null;
        }
        if (this._audioOutputs) {
            this._audioOutputs.destroy();
            this._audioOutputs = null;
        }
        if (this._mpris) {
            this._mpris.destroy();
            this._mpris = null;
        }
        clearIconCaches();

        this._settings = null;
        this._selectedBusName = null;
        this._userSelectedBusName = null;
        this._playingBusNames = null;
        this._lastAccentCss = '';
        this._lastCoverUri = '';
    }
}
