import Gio from 'gi://Gio';
import GObject from 'gi://GObject';
import Gvc from 'gi://Gvc';

import * as Volume from 'resource:///org/gnome/shell/ui/status/volume.js';

function symbolicIcon(iconName) {
    const base = iconName?.replace(/-symbolic$/, '') || 'audio-speakers';
    return Gio.ThemedIcon.new_with_default_fallbacks(`${base}-symbolic`);
}

function disconnectSignals(owner, signalIds) {
    for (const sigId of signalIds) {
        try {
            owner?.disconnect(sigId);
        } catch {
            // Ignore disposed object errors.
        }
    }
    signalIds.length = 0;
}

/**
 * Tracks system sound outputs (speakers, headphones, HDMI, Bluetooth) and
 * the active default sink's volume & mute state via GNOME Shell's shared MixerControl.
 */
export const AudioOutputService = GObject.registerClass({
    Signals: {
        'changed': {},
        'volume-changed': {},
    },
}, class AudioOutputService extends GObject.Object {
    _init() {
        super._init();

        this._outputs = new Map();
        this._activeId = null;
        this._sink = null;
        this._sinkSignals = [];
        this._controlSignals = [];
        this._destroyed = false;

        this._control = Volume.getMixerControl();
        if (!this._control)
            return;

        this._controlSignals = [
            this._control.connect('state-changed', (_c, state) => {
                if (this._destroyed)
                    return;
                if (state === Gvc.MixerControlState.READY) {
                    const seeded = this._seedExistingOutputs();
                    this._bindDefaultSink(seeded);
                } else {
                    disconnectSignals(this._sink, this._sinkSignals);
                    this._sink = null;
                    this._activeId = null;
                    this._outputs.clear();
                    this.emit('changed');
                    this.emit('volume-changed');
                }
            }),
            this._control.connect('output-added', (_c, id) => this._addOutput(id)),
            this._control.connect('output-removed', (_c, id) => this._removeOutput(id)),
            this._control.connect('active-output-update', (_c, id) => this._setActiveOutput(id)),
            this._control.connect('default-sink-changed', () => this._bindDefaultSink()),
        ];

        if (this._control.get_state?.() === Gvc.MixerControlState.READY) {
            const seeded = this._seedExistingOutputs();
            this._bindDefaultSink(seeded);
        }
    }

    get outputs() {
        return [...this._outputs.values()];
    }

    get activeId() {
        return this._activeId;
    }

    get active() {
        return this._outputs.get(this._activeId) ?? null;
    }

    get volume() {
        if (!this._sink || !this._control)
            return 0;
        if (this._sink.get_is_muted())
            return 0;
        const maxNorm = this._control.get_vol_max_norm() || 65536;
        return Math.max(0, Math.min(1, this._sink.get_volume() / maxNorm));
    }

    get muted() {
        return Boolean(this._sink?.get_is_muted?.());
    }

    setVolume(fraction) {
        if (!this._sink || !this._control || !Number.isFinite(fraction))
            return;
        const clamped = Math.max(0, Math.min(1, fraction));
        const maxNorm = this._control.get_vol_max_norm() || 65536;
        const target = Math.round(clamped * maxNorm);

        if (target > 0 && this._sink.get_is_muted())
            this._sink.change_is_muted(false);
        this._sink.set_volume(target);
        this._sink.push_volume();
    }

    toggleMute() {
        if (!this._sink)
            return;
        this._sink.change_is_muted(!this._sink.get_is_muted());
    }

    selectOutput(id) {
        if (!this._control)
            return;
        const device = this._control.lookup_output_id(id);
        if (device)
            this._control.change_output(device);
    }

    _seedExistingOutputs() {
        if (this._destroyed || !this._control)
            return false;

        let seeded = false;
        const sinks = this._control.get_sinks?.() ?? [];
        for (const sink of sinks) {
            const dev = this._control.lookup_device_from_stream?.(sink);
            const id = dev?.get_id?.();
            if (typeof id === 'number' && id > 0 && this._addOutput(id, false))
                seeded = true;
        }

        for (let id = 1; id <= 64; id++) {
            if (this._control.lookup_output_id?.(id) && this._addOutput(id, false))
                seeded = true;
        }
        return seeded;
    }

    _bindDefaultSink(seeded = false) {
        if (this._destroyed)
            return;
        disconnectSignals(this._sink, this._sinkSignals);
        this._sink = this._control?.get_default_sink?.() ?? null;

        let activeChanged = Boolean(seeded);
        if (this._sink) {
            this._sinkSignals = [
                this._sink.connect('notify::volume', () => {
                    if (!this._destroyed)
                        this.emit('volume-changed');
                }),
                this._sink.connect('notify::is-muted', () => {
                    if (!this._destroyed)
                        this.emit('volume-changed');
                }),
            ];

            const activeDev = this._control?.lookup_device_from_stream?.(this._sink);
            const devId = activeDev?.get_id?.();
            if (typeof devId === 'number' && devId > 0) {
                if (!this._outputs.has(devId)) {
                    this._addOutput(devId, false);
                    activeChanged = true;
                }
                if (this._activeId !== devId) {
                    this._activeId = devId;
                    activeChanged = true;
                }
            }
        }

        if (activeChanged)
            this.emit('changed');
        this.emit('volume-changed');
    }

    _addOutput(id, emitChange = true) {
        if (this._destroyed)
            return false;
        const device = this._control?.lookup_output_id?.(id);
        if (!device)
            return false;

        this._outputs.set(id, {
            id,
            name: device.get_description() ?? '',
            gicon: symbolicIcon(device.get_icon_name()),
        });
        if (emitChange)
            this.emit('changed');
        return true;
    }

    _removeOutput(id) {
        if (this._destroyed)
            return;
        if (this._activeId === id)
            this._activeId = null;
        if (this._outputs.delete(id))
            this.emit('changed');
    }

    _setActiveOutput(id) {
        if (this._destroyed || id === this._activeId)
            return;
        this._activeId = id;
        this.emit('changed');
    }

    destroy() {
        if (this._destroyed)
            return;
        this._destroyed = true;

        disconnectSignals(this._sink, this._sinkSignals);
        this._sink = null;

        if (this._control) {
            disconnectSignals(this._control, this._controlSignals);
            this._control = null;
        }
        this._outputs.clear();
    }
});
