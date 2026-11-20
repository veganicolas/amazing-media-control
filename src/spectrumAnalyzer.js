import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

import * as Volume from 'resource:///org/gnome/shell/ui/status/volume.js';

export const SPECTRUM_BANDS = 32;

const SPECTRUM_STALE_MS = 500;
const SPECTRUM_GRACE_MS = 3000;
const SPECTRUM_STEADY_MS = 10000;
const SPECTRUM_TRIES = 3;
const SPECTRUM_NO_CAPTURE = 2;

/**
 * Manages a lightweight `gjs -m spectrumHelper.js` subprocess while any
 * SpectrumWidget holds it active, streaming 32 real-time FFT audio bands
 * from the default output monitor (`pulsesrc device=@DEFAULT_MONITOR@`).
 */
export class SpectrumAnalyzer {
    /**
     * @param {string} helperPath Absolute path to `src/spectrumHelper.js`.
     */
    constructor(helperPath) {
        this._helperPath = helperPath;
        this._holders = new Set();
        this._proc = null;
        this._dyingProc = null;
        this._stdin = null;
        this._readCancellable = null;
        this._bands = null;
        this._receivedUs = 0;
        this._hasReceivedData = false;
        this._lastSilent = true;
        this._missing = false;
        this._failures = 0;
        this._startedUs = 0;
        this._graceId = 0;
        this._backoffId = 0;
        this._killId = 0;
        this._destroyed = false;
        this._mixer = null;
        this._sinkId = 0;
        this._sink = null;
    }

    /**
     * Latest 32 bands normalized to `0..1`, or null when stale/silent.
     *
     * @returns {Float32Array|null}
     */
    get bands() {
        if (this._bands === null)
            return null;
        if (GLib.get_monotonic_time() - this._receivedUs > SPECTRUM_STALE_MS * 1000)
            return null;
        return this._bands;
    }

    get listening() {
        return this._proc !== null || this._backoffId !== 0;
    }

    /**
     * True once at least one valid band line has been parsed from the current
     * or recent helper run, and reset when deaf/failed or fully stopped.
     */
    get hasReceivedData() {
        return this._hasReceivedData && !this.deaf;
    }

    /**
     * True when GStreamer/pulsesrc is unavailable or repeatedly failed.
     */
    get deaf() {
        return this._missing || (this._failures >= SPECTRUM_TRIES && !this.listening);
    }

    hold(holder) {
        if (this._destroyed)
            return;
        const first = this._holders.size === 0;
        this._holders.add(holder);

        if (this._graceId) {
            GLib.Source.remove(this._graceId);
            this._graceId = 0;
        }

        if (!this.listening) {
            if (first)
                this._missing = false;
            if (!this._missing) {
                this._failures = 0;
                this._start();
            }
        }
    }

    release(holder) {
        if (!this._holders.delete(holder) || this._holders.size > 0)
            return;

        if (this._backoffId) {
            GLib.Source.remove(this._backoffId);
            this._backoffId = 0;
        }

        if (this._proc !== null && this._graceId === 0) {
            this._graceId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, SPECTRUM_GRACE_MS, () => {
                this._graceId = 0;
                if (this._holders.size === 0)
                    this._stop();
                return GLib.SOURCE_REMOVE;
            });
        } else if (this._proc === null) {
            this._unwatchSink();
            this._hasReceivedData = false;
        }
    }

    _start() {
        if (this._missing || !this._helperPath || this._destroyed)
            return;

        let proc;
        try {
            proc = Gio.Subprocess.new(
                ['gjs', '-m', this._helperPath],
                Gio.SubprocessFlags.STDIN_PIPE | Gio.SubprocessFlags.STDOUT_PIPE
            );
        } catch (e) {
            console.debug(`amazing-media-control: spectrum spawn failed: ${e.message}`);
            this._missing = true;
            this._hasReceivedData = false;
            this._notifyWake();
            return;
        }

        this._proc = proc;
        this._startedUs = GLib.get_monotonic_time();
        this._hasReceivedData = false;
        this._lastSilent = true;
        this._readCancellable = new Gio.Cancellable();
        this._stdin = proc.get_stdin_pipe();

        const stream = new Gio.DataInputStream({
            base_stream: proc.get_stdout_pipe(),
            close_base_stream: true,
        });
        const readCancellable = this._readCancellable;
        this._readLine(stream, proc, readCancellable);
        proc.wait_async(null, (_proc, result) => this._onExit(proc, result));
        this._watchSink();
    }

    _readLine(stream, proc, cancellable) {
        stream.read_line_async(GLib.PRIORITY_DEFAULT, cancellable, (_stream, result) => {
            let line = null;
            try {
                [line] = stream.read_line_finish_utf8(result);
            } catch (e) {
                if (!e.matches(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED))
                    console.debug(`amazing-media-control: spectrum read error: ${e.message}`);
            }

            if (line === null || cancellable.is_cancelled() || this._destroyed) {
                stream.close_async(GLib.PRIORITY_DEFAULT, null, null);
                if (proc === this._proc && !cancellable.is_cancelled() && !this._destroyed)
                    this._killProc(proc);
                return;
            }

            this._parseLine(line);
            this._readLine(stream, proc, cancellable);
        });
    }

    _killProc(proc, immediate = false) {
        try {
            this._stdin?.close_async(GLib.PRIORITY_DEFAULT, null, null);
        } catch {
            // Ignore stream close errors.
        }
        this._stdin = null;

        if (this._killId) {
            GLib.Source.remove(this._killId);
            this._killId = 0;
        }
        if (this._dyingProc && this._dyingProc !== proc) {
            try {
                this._dyingProc.force_exit();
            } catch {
                // Ignore process already exited.
            }
        }
        this._dyingProc = null;

        if (!proc)
            return;

        if (immediate) {
            try {
                proc.force_exit();
            } catch {
                // Ignore process already exited.
            }
            return;
        }

        this._dyingProc = proc;
        this._killId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 250, () => {
            this._killId = 0;
            this._dyingProc = null;
            try {
                proc.force_exit();
            } catch {
                // Ignore process already exited.
            }
            return GLib.SOURCE_REMOVE;
        });
    }

    _parseLine(line) {
        const parts = line.trim().split(' ');
        if (parts.length !== SPECTRUM_BANDS)
            return;

        let silent = true;
        const bands = new Float32Array(SPECTRUM_BANDS);
        for (let i = 0; i < SPECTRUM_BANDS; i++) {
            const value = Number(parts[i]);
            if (!Number.isFinite(value))
                return;
            const norm = Math.min(Math.max(value / 1000, 0), 1);
            bands[i] = norm;
            if (norm > 0.001)
                silent = false;
        }

        const nowUs = GLib.get_monotonic_time();
        const wasStale = this._receivedUs > 0 && (nowUs - this._receivedUs > SPECTRUM_STALE_MS * 1000);
        const wasSilent = this._lastSilent || wasStale;
        const firstData = !this._hasReceivedData;
        this._lastSilent = silent;
        this._hasReceivedData = true;
        this._bands = bands;
        this._receivedUs = nowUs;
        this._holders.forEach(holder => holder.hear?.(bands));
        if (firstData || (wasSilent && !silent))
            this._notifyWake();
    }

    _onExit(proc, result) {
        try {
            proc.wait_finish(result);
        } catch (e) {
            if (!e.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED))
                console.debug(`amazing-media-control: spectrum wait error: ${e.message}`);
        }

        if (this._dyingProc === proc) {
            this._dyingProc = null;
            if (this._killId) {
                GLib.Source.remove(this._killId);
                this._killId = 0;
            }
        }

        if (this._destroyed || proc !== this._proc)
            return;

        const status = proc.get_if_exited() ? proc.get_exit_status() : -1;
        const ranUs = GLib.get_monotonic_time() - this._startedUs;
        this._proc = null;
        this._hasReceivedData = false;
        this._stop(true);

        if (status === SPECTRUM_NO_CAPTURE) {
            this._missing = true;
            this._unwatchSink();
            this._notifyWake();
            return;
        }

        this._failures = ranUs >= SPECTRUM_STEADY_MS * 1000 ? 1 : this._failures + 1;
        this._notifyWake();

        if (this._holders.size === 0 || this._failures >= SPECTRUM_TRIES)
            return;

        const delayMs = 1000 * (2 ** (this._failures - 1));
        this._backoffId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, delayMs, () => {
            this._backoffId = 0;
            if (this._holders.size > 0)
                this._start();
            return GLib.SOURCE_REMOVE;
        });
    }

    _notifyWake() {
        this._holders.forEach(holder => holder.wake?.());
    }

    _watchSink() {
        if (this._sinkId && this._mixer)
            return;
        try {
            this._mixer = Volume.getMixerControl();
            this._sink = this._mixer?.get_default_sink()?.id ?? null;
            this._sinkId = this._mixer?.connect('default-sink-changed', (_mixer, id) => {
                if (id !== this._sink) {
                    this._sink = id;
                    this._failures = 0;
                    this._restart();
                }
            }) ?? 0;
        } catch {
            this._mixer = null;
            this._sinkId = 0;
        }
    }

    _unwatchSink() {
        if (this._sinkId && this._mixer) {
            try {
                this._mixer.disconnect(this._sinkId);
            } catch {
                // Ignore if mixer already disposed.
            }
        }
        this._sinkId = 0;
        this._mixer = null;
    }

    _restart() {
        this._stop();
        if (this._holders.size > 0)
            this._start();
    }

    _stop(immediate = false) {
        const proc = this._proc;
        this._proc = null;

        this._readCancellable?.cancel();
        this._readCancellable = null;

        this._killProc(proc, immediate);

        if (this._holders.size === 0 || this._destroyed || this._missing)
            this._unwatchSink();
        this._hasReceivedData = false;
        this._bands = null;
        this._lastSilent = true;

        if (this._graceId) {
            GLib.Source.remove(this._graceId);
            this._graceId = 0;
        }
        if (this._backoffId) {
            GLib.Source.remove(this._backoffId);
            this._backoffId = 0;
        }
    }

    destroy() {
        if (this._destroyed)
            return;
        this._destroyed = true;
        this._holders.clear();
        this._helperPath = null;
        this._stop(true);
    }
}

