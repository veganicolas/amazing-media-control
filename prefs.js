import Adw from 'gi://Adw';
import Gdk from 'gi://Gdk';
import Gio from 'gi://Gio';
import GObject from 'gi://GObject';
import Gtk from 'gi://Gtk';

import {ExtensionPreferences} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

import {DEFAULT_BAR_ORDER, normalizeBarOrder} from './src/barOrderUtils.js';

function connectManagedSetting(settings, keys, callback, cleanups = null, destroyOwner = null) {
    const keyList = Array.isArray(keys) ? keys : [keys];
    const ids = keyList.map((key) => settings.connect(`changed::${key}`, callback));
    let disconnected = false;
    const cleanup = () => {
        if (disconnected)
            return;
        disconnected = true;
        for (const id of ids)
            settings.disconnect(id);
    };
    if (cleanups)
        cleanups.push(cleanup);
    destroyOwner?.connect('destroy', cleanup);
    return cleanup;
}

function connectSensitivity(widget, settings, keys, predicate, cleanups = null, destroyOwner = widget) {
    const update = () => widget.set_sensitive(Boolean(predicate()));
    update();
    return connectManagedSetting(settings, keys, update, cleanups, destroyOwner);
}

function addCombo(group, settings, key, title, subtitle, options, cleanups = null) {
    const labels = options.map((o) => o[1]);
    const values = options.map((o) => o[0]);

    const row = new Adw.ComboRow({
        title,
        subtitle,
        use_markup: false,
        model: Gtk.StringList.new(labels),
    });

    const syncFromSettings = () => {
        const cur = settings.get_string(key);
        const idx = values.indexOf(cur);
        row.set_selected(idx >= 0 ? idx : 0);
    };

    syncFromSettings();

    row.connect('notify::selected', () => {
        const idx = row.get_selected();
        if (idx >= 0 && idx < values.length && settings.get_string(key) !== values[idx])
            settings.set_string(key, values[idx]);
    });

    connectManagedSetting(settings, key, syncFromSettings, cleanups, row);

    group.add(row);
    return row;
}

function addSwitch(group, settings, key, title, subtitle) {
    const row = new Adw.SwitchRow({
        title,
        subtitle,
        use_markup: false,
    });
    settings.bind(key, row, 'active', Gio.SettingsBindFlags.DEFAULT);
    group.add(row);
    return row;
}

function addSpin(group, settings, key, title, subtitle, min, max, step = 1) {
    const row = new Adw.SpinRow({
        title,
        subtitle,
        use_markup: false,
        adjustment: new Gtk.Adjustment({
            lower: min,
            upper: max,
            step_increment: step,
            page_increment: step * 2,
        }),
    });

    settings.bind(key, row, 'value', Gio.SettingsBindFlags.DEFAULT);
    group.add(row);
    return row;
}

function addEntry(group, settings, key, title, tooltipText) {
    const row = new Adw.EntryRow({
        title,
        use_markup: false,
        tooltip_text: tooltipText,
    });
    settings.bind(key, row, 'text', Gio.SettingsBindFlags.DEFAULT);
    group.add(row);
    return row;
}

function formatAccelerator(accel) {
    if (!accel)
        return null;
    const [ok, keyval, mods] = Gtk.accelerator_parse(accel);
    if (!ok || !keyval)
        return accel;
    return Gtk.accelerator_get_label(keyval, mods) || accel;
}

function addShortcutRow(group, settings, key, title, subtitle, cleanups = null) {
    const row = new Adw.ActionRow({
        title,
        subtitle,
        use_markup: false,
    });

    const box = new Gtk.Box({
        orientation: Gtk.Orientation.HORIZONTAL,
        spacing: 6,
        valign: Gtk.Align.CENTER,
    });

    const captureLabel = new Gtk.Label({xalign: 0.5});
    const captureBtn = new Gtk.Button({
        child: captureLabel,
        valign: Gtk.Align.CENTER,
        focusable: true,
        tooltip_text: 'Click then press a key combination (Esc cancels, BackSpace clears)',
    });

    const clearBtn = new Gtk.Button({
        icon_name: 'edit-clear-symbolic',
        valign: Gtk.Align.CENTER,
        css_classes: ['flat'],
        tooltip_text: 'Disable shortcut',
    });

    let capturing = false;

    const updateView = () => {
        if (capturing) {
            captureLabel.set_label('Press shortcut (Esc cancels)...');
            captureLabel.remove_css_class('dim-label');
            captureBtn.add_css_class('suggested-action');
            return;
        }

        captureBtn.remove_css_class('suggested-action');
        const list = settings.get_strv(key);
        const accel = list?.[0] ?? '';
        const pretty = formatAccelerator(accel);
        if (pretty) {
            captureLabel.set_label(pretty);
            captureLabel.remove_css_class('dim-label');
            clearBtn.set_sensitive(true);
        } else {
            captureLabel.set_label('Disabled');
            captureLabel.add_css_class('dim-label');
            clearBtn.set_sensitive(false);
        }
    };

    captureBtn.connect('clicked', () => {
        capturing = !capturing;
        updateView();
        if (capturing)
            captureBtn.grab_focus();
    });

    clearBtn.connect('clicked', () => {
        capturing = false;
        settings.set_strv(key, []);
        updateView();
    });

    const keyController = new Gtk.EventControllerKey();
    keyController.connect('key-pressed', (_ctrl, keyval, _keycode, state) => {
        if (!capturing)
            return false;

        const mods = state & Gtk.accelerator_get_default_mod_mask();

        if (keyval === Gdk.KEY_Escape && mods === 0) {
            capturing = false;
            updateView();
            return true;
        }

        if (keyval === Gdk.KEY_BackSpace && mods === 0) {
            capturing = false;
            settings.set_strv(key, []);
            updateView();
            return true;
        }

        const isStandaloneKey =
            (keyval >= Gdk.KEY_F1 && keyval <= Gdk.KEY_F35) ||
            keyval === Gdk.KEY_Pause ||
            keyval > 0x10000000;

        if ((mods !== 0 || isStandaloneKey) && Gtk.accelerator_valid(keyval, mods)) {
            const accel = Gtk.accelerator_name(keyval, mods);
            if (accel)
                settings.set_strv(key, [accel]);
            capturing = false;
            updateView();
        }

        return true;
    });

    const focusController = new Gtk.EventControllerFocus();
    focusController.connect('leave', () => {
        if (capturing) {
            capturing = false;
            updateView();
        }
    });

    captureBtn.add_controller(keyController);
    captureBtn.add_controller(focusController);

    connectManagedSetting(settings, key, updateView, cleanups, row);

    updateView();

    box.append(captureBtn);
    box.append(clearBtn);
    row.add_suffix(box);
    row.set_activatable_widget(captureBtn);
    group.add(row);
    return row;
}

const SPECTRUM_STYLE_OPTIONS = [
    ['bars', 'Bars'],
    ['center-bars', 'Centered Bass Bars'],
    ['wave', 'Smooth Wave'],
    ['aurora', 'Aurora Gradient'],
    ['line', 'Oscilloscope Line'],
    ['soundwave', 'Soundwave'],
    ['dots', 'Dots'],
    ['mirror', 'Mirrored Bars'],
    ['segments', 'LED Segments'],
    ['matrix', 'LED Matrix'],
    ['ribbon', 'Filled Ribbon'],
    ['ring', 'Radial Ring'],
    ['pulse', 'Bass Pulse'],
    ['history', 'Waveform History'],
];

const BAR_ELEMENT_META = {
    'app-logo': {
        title: 'App Logo',
        subtitle: 'Playing app icon or mini cover art thumbnail',
        icon: 'image-x-generic-symbolic',
    },
    'spectrum': {
        title: 'Spectrum',
        subtitle: 'Live audio frequency visualizer',
        icon: 'audio-x-generic-symbolic',
    },
    'title': {
        title: 'Track Title',
        subtitle: 'Scrolling song title and artist label',
        icon: 'font-x-generic-symbolic',
    },
    'controls': {
        title: 'Media Controls',
        subtitle: 'Previous / Play-Pause / Next buttons',
        icon: 'media-playback-start-symbolic',
    },
};

function createBarOrderGroup(settings, cleanups = null) {
    const orderGroup = new Adw.PreferencesGroup({
        title: 'Panel Element Order',
        description: 'Drag and drop the rows to reorder App Logo, Spectrum, Track Title, and Media Controls in the bar. Changes take effect immediately.',
    });

    const resetBtn = new Gtk.Button({
        icon_name: 'view-refresh-symbolic',
        valign: Gtk.Align.CENTER,
        css_classes: ['flat'],
        tooltip_text: 'Reset default element order',
    });
    resetBtn.connect('clicked', () => {
        settings.set_strv('bar-elements-order', DEFAULT_BAR_ORDER);
    });
    orderGroup.set_header_suffix(resetBtn);

    const listBox = new Gtk.ListBox({
        css_classes: ['boxed-list'],
        selection_mode: Gtk.SelectionMode.NONE,
    });
    orderGroup.add(listBox);

    const moveItemByOffset = (id, delta) => {
        const order = normalizeBarOrder(settings.get_strv('bar-elements-order'));
        const idx = order.indexOf(id);
        const nextIdx = idx + delta;
        if (idx < 0 || nextIdx < 0 || nextIdx >= order.length)
            return;
        order.splice(idx, 1);
        order.splice(nextIdx, 0, id);
        settings.set_strv('bar-elements-order', order);
    };

    const moveItemToTarget = (draggedId, targetId) => {
        if (!draggedId || !targetId || draggedId === targetId)
            return false;
        const order = normalizeBarOrder(settings.get_strv('bar-elements-order'));
        const fromIdx = order.indexOf(draggedId);
        const origTargetIdx = order.indexOf(targetId);
        if (fromIdx < 0 || origTargetIdx < 0)
            return false;

        const next = order.filter((item) => item !== draggedId);
        const curTargetIdx = next.indexOf(targetId);
        const insertIdx = curTargetIdx + (fromIdx < origTargetIdx ? 1 : 0);
        next.splice(insertIdx, 0, draggedId);
        settings.set_strv('bar-elements-order', next);
        return true;
    };

    const rebuildList = () => {
        while (listBox.get_first_child())
            listBox.remove(listBox.get_first_child());

        const order = normalizeBarOrder(settings.get_strv('bar-elements-order'));
        const controlsHidden = settings.get_string('controls-position') === 'hidden';

        order.forEach((id, index) => {
            const meta = BAR_ELEMENT_META[id];
            const isHiddenControls = id === 'controls' && controlsHidden;

            const row = new Adw.ActionRow({
                title: isHiddenControls ? `${meta.title} (Hidden)` : meta.title,
                subtitle: meta.subtitle,
                use_markup: false,
                activatable: false,
            });
            if (isHiddenControls)
                row.add_css_class('dim-label');

            row.add_prefix(new Gtk.Image({
                icon_name: 'list-drag-handle-symbolic',
                pixel_size: 16,
                valign: Gtk.Align.CENTER,
                margin_end: 6,
                css_classes: ['dim-label'],
            }));

            row.add_prefix(new Gtk.Image({
                icon_name: meta.icon,
                pixel_size: 20,
                valign: Gtk.Align.CENTER,
            }));

            const arrowsBox = new Gtk.Box({
                orientation: Gtk.Orientation.HORIZONTAL,
                spacing: 2,
                valign: Gtk.Align.CENTER,
            });
            const upBtn = new Gtk.Button({
                icon_name: 'go-up-symbolic',
                css_classes: ['flat'],
                sensitive: index > 0,
                tooltip_text: 'Move left',
            });
            upBtn.connect('clicked', () => moveItemByOffset(id, -1));

            const downBtn = new Gtk.Button({
                icon_name: 'go-down-symbolic',
                css_classes: ['flat'],
                sensitive: index < order.length - 1,
                tooltip_text: 'Move right',
            });
            downBtn.connect('clicked', () => moveItemByOffset(id, 1));

            arrowsBox.append(upBtn);
            arrowsBox.append(downBtn);
            row.add_suffix(arrowsBox);

            // GTK4 Drag & Drop source
            const dragSource = new Gtk.DragSource({actions: Gdk.DragAction.MOVE});
            dragSource.connect('prepare', () => {
                const value = new GObject.Value();
                value.init(GObject.TYPE_STRING);
                value.set_string(id);
                return Gdk.ContentProvider.new_for_value(value);
            });
            dragSource.connect('drag-begin', (src) => {
                const paintable = new Gtk.WidgetPaintable({widget: row});
                src.set_icon(paintable, 24, 24);
                row.add_css_class('dim-label');
            });
            dragSource.connect('drag-end', () => {
                if (id === 'controls' && settings.get_string('controls-position') === 'hidden')
                    row.add_css_class('dim-label');
                else
                    row.remove_css_class('dim-label');
            });
            row.add_controller(dragSource);

            // GTK4 Drag & Drop target
            const dropTarget = Gtk.DropTarget.new(GObject.TYPE_STRING, Gdk.DragAction.MOVE);
            dropTarget.connect('enter', () => {
                row.add_css_class('accent');
                return Gdk.DragAction.MOVE;
            });
            dropTarget.connect('leave', () => {
                row.remove_css_class('accent');
            });
            dropTarget.connect('drop', (_target, value) => {
                row.remove_css_class('accent');
                const draggedId = typeof value === 'string' ? value : value?.get_string?.();
                return moveItemToTarget(draggedId, id);
            });
            row.add_controller(dropTarget);

            listBox.append(row);
        });
    };

    connectManagedSetting(settings, ['bar-elements-order', 'controls-position'], rebuildList, cleanups, orderGroup);

    rebuildList();
    return orderGroup;
}

export default class AmazingMediaControlPreferences extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        const settings = this.getSettings();
        const cleanups = [];
        window.connect('close-request', () => {
            while (cleanups.length > 0)
                cleanups.pop()();
            return false;
        });

        window.set_title('Amazing Media Control');
        window.set_default_size(740, 740);
        window.set_resizable(true);

        // =====================================================================
        // Tab 1 (Default): Panel — modeled after advanced-media-controller General
        // =====================================================================
        const panelPage = new Adw.PreferencesPage({
            title: 'Panel',
            icon_name: 'preferences-system-symbolic',
        });

        // 1. Panel Placement
        const placementGroup = new Adw.PreferencesGroup({
            title: 'Panel Placement',
            description: 'Where the media indicator sits and when it stays visible.',
        });

        addCombo(placementGroup, settings, 'panel-mode',
            'Placement Mode',
            'Integrate inside Top Bar / Dash to Panel, or float as a standalone bottom pill.',
            [
                ['panel', 'Top Bar / Dash to Panel'],
                ['bottom-bar', 'Standalone Bottom Pill'],
            ],
            cleanups);

        addCombo(placementGroup, settings, 'panel-box',
            'Panel Position',
            'Horizontal alignment inside the Top Bar or along the bottom edge.',
            [
                ['left', 'Left'],
                ['center', 'Center'],
                ['right', 'Right'],
            ],
            cleanups);

        const panelIndexRow = addSpin(placementGroup, settings, 'panel-index',
            'Panel Box Index',
            'Insertion index inside the selected Top Bar box (0 = first).',
            0, 20, 1);

        const bottomMarginRow = addSpin(placementGroup, settings, 'bottom-margin',
            'Bottom Margin (px)',
            'Distance from the bottom screen edge in standalone bottom pill mode.',
            0, 64, 2);

        addSwitch(placementGroup, settings, 'hide-when-paused',
            'Hide When Paused',
            'Hide the entire bar widget whenever playback is paused or stopped.');

        addSwitch(placementGroup, settings, 'hide-when-inactive',
            'Hide When No Active Player',
            'Hide the bar widget when no eligible MPRIS player is running.');

        connectSensitivity(
            panelIndexRow,
            settings,
            'panel-mode',
            () => settings.get_string('panel-mode') !== 'bottom-bar',
            cleanups,
            panelPage
        );

        connectSensitivity(
            bottomMarginRow,
            settings,
            'panel-mode',
            () => settings.get_string('panel-mode') === 'bottom-bar',
            cleanups,
            panelPage
        );

        panelPage.add(placementGroup);

        // 2. Panel Label & Icon
        const labelGroup = new Adw.PreferencesGroup({
            title: 'Panel Label and Icon',
            description: 'Track metadata format and application/cover thumbnail shown in the bar.',
        });

        addCombo(labelGroup, settings, 'bar-icon-mode',
            'Bar Thumbnail Mode',
            'Display the playing app logo, a mini album cover thumbnail, or both.',
            [
                ['app-logo', 'App logo only'],
                ['cover-art', 'Cover art only'],
                ['both', 'App logo + Cover art'],
            ],
            cleanups);

        addSwitch(labelGroup, settings, 'app-icon-white',
            'White App Logo',
            'Render the playing app icon in monochrome white instead of full color.');

        addCombo(labelGroup, settings, 'bar-text-format',
            'Track Label Format',
            'Order and metadata shown in the bar track label.',
            [
                ['title-artist', 'Title - Artist'],
                ['artist-title', 'Artist - Title'],
                ['title-only', 'Title only'],
            ],
            cleanups);

        addSpin(labelGroup, settings, 'bar-font-size',
            'Panel Font Size (px)',
            'Font size of the track title and artist label in the bar.',
            10, 24, 1);

        panelPage.add(labelGroup);

        // 3. Panel Scrolling
        const scrollGroup = new Adw.PreferencesGroup({
            title: 'Panel Scrolling',
            description: 'Marquee scrolling and width of the track label in the bar.',
        });

        addSwitch(scrollGroup, settings, 'scrolling-text',
            'Enable Panel Label Scrolling',
            'Smoothly scroll overflowing song titles horizontally instead of cutting them off.');

        addSwitch(scrollGroup, settings, 'animate-track-resize',
            'Animate Bar Resize on Track Change',
            'Smoothly ease the bar width and fade the track label when switching songs.');

        addSpin(scrollGroup, settings, 'bar-max-width',
            'Panel Label Width (px)',
            'Maximum pixel width allocated to the track label in the bar.',
            100, 500, 10);

        panelPage.add(scrollGroup);

        // 4. Inline Playback Controls
        const controlsGroup = new Adw.PreferencesGroup({
            title: 'Inline Playback Controls',
            description: 'Show or hide inline playback buttons directly on the bar card.',
        });

        const showControlsRow = new Adw.SwitchRow({
            title: 'Show Inline Playback Controls',
            subtitle: 'Display Previous / Play-Pause / Next buttons inside the bar widget.',
            use_markup: false,
        });
        controlsGroup.add(showControlsRow);

        const onlyPlayingRow = addSwitch(controlsGroup, settings, 'controls-only-when-playing',
            'Show Only While Playing',
            'Hide inline playback buttons when music is paused or stopped.');

        let syncingControls = false;
        const syncControlsSwitch = () => {
            syncingControls = true;
            const visible = settings.get_string('controls-position') !== 'hidden';
            showControlsRow.set_active(visible);
            onlyPlayingRow.set_sensitive(visible);
            syncingControls = false;
        };
        syncControlsSwitch();

        showControlsRow.connect('notify::active', () => {
            if (syncingControls)
                return;
            const active = showControlsRow.get_active();
            settings.set_string('controls-position', active ? 'right' : 'hidden');
            onlyPlayingRow.set_sensitive(active);
        });

        connectManagedSetting(settings, 'controls-position', syncControlsSwitch, cleanups, panelPage);

        panelPage.add(controlsGroup);

        // 5. Panel Element Order (4 draggable rows)
        panelPage.add(createBarOrderGroup(settings, cleanups));

        // 6. System Integration & Interactions
        const systemGroup = new Adw.PreferencesGroup({
            title: 'System Integration and Interactions',
            description: 'Middle-click on the bar toggles Play/Pause; configure window focus and global shortcut.',
        });

        addSwitch(systemGroup, settings, 'logo-click-raises',
            'Raise Player on Logo Click',
            'Clicking the app icon in the bar or popout brings the media player window to focus.');

        addShortcutRow(systemGroup, settings, 'toggle-popup-shortcut',
            'Toggle Popout Shortcut',
            'Global keyboard shortcut to open or close the Now Playing popout.',
            cleanups);

        panelPage.add(systemGroup);

        // =====================================================================
        // Tab 2: Popout — modeled after advanced-media-controller Popup Player
        // =====================================================================
        const popoutPage = new Adw.PreferencesPage({
            title: 'Popout',
            icon_name: 'media-playback-start-symbolic',
        });

        const popoutSizeGroup = new Adw.PreferencesGroup({
            title: 'Popup Size and Backdrop',
            description: 'Dimensions and blurred cover-art backdrop of the popup media player.',
        });

        addSpin(popoutSizeGroup, settings, 'popup-width',
            'Popup Width (px)',
            'Width in pixels of the expanded Now Playing popup card.',
            320, 520, 10);

        addSpin(popoutSizeGroup, settings, 'popup-opacity',
            'Backdrop Opacity (%)',
            'Opacity of the popout glass surface and blurred album-art backdrop.',
            40, 100, 5);

        addSwitch(popoutSizeGroup, settings, 'popup-blur',
            'Blurred Album-Art Backdrop',
            'Render a blurred, saturated cover-art backdrop inside the Now Playing popup.');

        popoutPage.add(popoutSizeGroup);

        const popoutAppearanceGroup = new Adw.PreferencesGroup({
            title: 'Popup Appearance',
            description: 'Dynamic highlight accent coloring derived from album art, app icon, or GNOME Shell.',
        });

        addCombo(popoutAppearanceGroup, settings, 'accent-source',
            'Accent Color Source',
            'Choose where the popout buttons, slider, and optional spectrum draw their accent color.',
            [
                ['cover', 'Song cover art (Dynamic)'],
                ['app-logo', 'App logo color'],
                ['shell', 'GNOME Shell accent'],
                ['white', 'Classic white'],
            ],
            cleanups);

        popoutPage.add(popoutAppearanceGroup);

        const popoutModulesGroup = new Adw.PreferencesGroup({
            title: 'Playback Controls and Modules',
            description: 'Extra transport buttons, volume/audio output selector, and synced lyrics inside the popout.',
        });

        addSwitch(popoutModulesGroup, settings, 'show-shuffle-repeat',
            'Show Shuffle and Repeat Buttons',
            'Display Shuffle and Repeat toggles when supported by the active player.');

        addSwitch(popoutModulesGroup, settings, 'show-seek-buttons',
            'Show -10s / +10s Seek Buttons',
            'Display quick 10-second backward and forward seek buttons around Play/Pause.');

        addSwitch(popoutModulesGroup, settings, 'show-volume-output',
            'Show Volume Slider and Audio Output Switcher',
            'Display live volume slider, mute toggle, and selectable audio output devices.');

        addSwitch(popoutModulesGroup, settings, 'show-lyrics',
            'Enable Synced Lyrics Panel',
            'Show the collapsible synced lyrics toggle in the popout header (embedded tags, local .lrc, or lrclib.net).');

        addSwitch(popoutModulesGroup, settings, 'show-popup-spectrum',
            'Show Popout Spectrum Visualizer',
            'Display a wide live audio spectrum bar inside the expanded Now Playing popout.');

        const popSpectrumStyleRow = addCombo(popoutModulesGroup, settings, 'popup-spectrum-style',
            'Popout Spectrum Style',
            'Visual renderer used for the spectrum inside the Now Playing popout.',
            SPECTRUM_STYLE_OPTIONS,
            cleanups);

        connectSensitivity(
            popSpectrumStyleRow,
            settings,
            'show-popup-spectrum',
            () => settings.get_boolean('show-popup-spectrum'),
            cleanups,
            popoutPage
        );

        addSwitch(popoutModulesGroup, settings, 'show-popup-top-spectrum',
            'Show Spectrum Above Popout Window',
            'Display floating audio bars physically above the top edge of the Now Playing popout window (bars only).');

        popoutPage.add(popoutModulesGroup);

        // =====================================================================
        // Tab 3: Spectrum
        // =====================================================================
        const spectrumPage = new Adw.PreferencesPage({
            title: 'Spectrum',
            icon_name: 'audio-x-generic-symbolic',
        });

        const spectrumCaptureGroup = new Adw.PreferencesGroup({
            title: 'Audio Capture',
            description: 'Real-time FFT audio capture for the bar spectrum visualizer.',
        });

        addSwitch(spectrumCaptureGroup, settings, 'show-spectrum',
            'Show Spectrum Graphic',
            'Display the live audio frequency spectrum in the bar widget.');

        addSwitch(spectrumCaptureGroup, settings, 'spectrum-all-sound',
            'Listen to All System Audio',
            'Keep capturing system audio even when playback is paused or no MPRIS player is running.');

        addSwitch(spectrumCaptureGroup, settings, 'spectrum-demo-animation',
            'Simulate Animated Spectrum (VM / Silent)',
            'Run the built-in animated fallback wave whenever live audio capture receives silence (useful in virtual machines).');

        spectrumPage.add(spectrumCaptureGroup);

        const spectrumStyleGroup = new Adw.PreferencesGroup({
            title: 'Spectrum Appearance',
            description: 'Visual style, color palette, and accent color synchronization.',
        });

        addCombo(spectrumStyleGroup, settings, 'spectrum-style',
            'Spectrum Visual Style',
            'Visual renderer used for the audio frequency spectrum.',
            SPECTRUM_STYLE_OPTIONS,
            cleanups);

        addCombo(spectrumStyleGroup, settings, 'spectrum-colors',
            'Spectrum Color Palette',
            'Color mapping applied across frequency columns and peak levels.',
            [
                ['accent', 'Follow Accent / Theme'],
                ['classic', 'Classic (White / Red peaks)'],
                ['level', 'VU Meter (Green / Yellow / Red)'],
                ['rainbow', 'Rainbow'],
            ],
            cleanups);

        addSwitch(spectrumStyleGroup, settings, 'accent-apply-spectrum',
            'Apply Accent Color to Spectrum',
            'Tint the spectrum graphic when using the Follow Accent / Theme palette.');

        spectrumPage.add(spectrumStyleGroup);

        const spectrumGeometryGroup = new Adw.PreferencesGroup({
            title: 'Geometry and Dynamics',
            description: 'Frequency band count, sensitivity headroom, refresh rate, and peak markers.',
        });

        addSpin(spectrumGeometryGroup, settings, 'spectrum-columns',
            'Frequency Columns',
            'Number of frequency bands and automatic horizontal density across all spectrum styles.',
            4, 24, 1);

        addSpin(spectrumGeometryGroup, settings, 'spectrum-width',
            'Spectrum Width (px)',
            'Fixed panel width in pixels for all spectrum styles (0 = automatic from font size and columns).',
            0, 220, 4);

        addSpin(spectrumGeometryGroup, settings, 'spectrum-range',
            'Dynamic Sensitivity Range (dB)',
            'Smaller values amplify quieter tracks; larger values give smoother headroom.',
            12, 48, 2);

        addSpin(spectrumGeometryGroup, settings, 'spectrum-fps',
            'Refresh Rate (FPS)',
            'Target animation frame rate for the live spectrum canvas.',
            10, 60, 5);

        addSwitch(spectrumGeometryGroup, settings, 'spectrum-peaks',
            'Peak Hold Indicators',
            'Draw falling peak markers above active spectrum columns.');

        addSwitch(spectrumGeometryGroup, settings, 'spectrum-invert',
            'Invert Frequency Direction',
            'Mirror frequencies so treble is on the left and bass is on the right.');

        spectrumPage.add(spectrumGeometryGroup);

        // =====================================================================
        // Tab 4: Player Filter — modeled after advanced-media-controller
        // =====================================================================
        const filterPage = new Adw.PreferencesPage({
            title: 'Player Filter',
            icon_name: 'view-list-symbolic',
        });

        const browserGroup = new Adw.PreferencesGroup({
            title: 'Browser Filtering',
            description: 'Control how web browser MPRIS media sessions are handled.',
        });

        addSwitch(browserGroup, settings, 'hide-all-browsers',
            'Hide All Browser Players',
            'Ignore all web browser MPRIS sources and show only dedicated desktop media apps.');

        const ytOnlyRow = addSwitch(browserGroup, settings, 'browser-youtube-only',
            'Only Show YouTube From Browsers',
            'Ignore browser media sessions unless the active tab is playing YouTube.');

        const ytMusicRow = addSwitch(browserGroup, settings, 'include-youtube-music',
            'Include YouTube Music',
            'Treat music.youtube.com as YouTube when the YouTube-only filter is enabled.');

        connectSensitivity(
            ytOnlyRow,
            settings,
            'hide-all-browsers',
            () => !settings.get_boolean('hide-all-browsers'),
            cleanups,
            filterPage
        );
        connectSensitivity(
            ytMusicRow,
            settings,
            ['hide-all-browsers', 'browser-youtube-only'],
            () => !settings.get_boolean('hide-all-browsers') && settings.get_boolean('browser-youtube-only'),
            cleanups,
            filterPage
        );

        filterPage.add(browserGroup);

        const rulesGroup = new Adw.PreferencesGroup({
            title: 'Player Priority and Ignore Rules',
            description: 'Enter comma-separated player names, desktop IDs, or bus suffixes (e.g. "spotify, vlc, firefox").',
        });

        addEntry(rulesGroup, settings, 'priority-players',
            'Priority Players',
            'Preferred players ranked first when multiple players are active or idle');

        addEntry(rulesGroup, settings, 'ignored-players',
            'Ignored Players',
            'Players completely excluded from both the bar widget and the popout switcher');

        filterPage.add(rulesGroup);

        window.add(panelPage);
        window.add(popoutPage);
        window.add(spectrumPage);
        window.add(filterPage);
        window.set_visible_page(panelPage);
    }
}
