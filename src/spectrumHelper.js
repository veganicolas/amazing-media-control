#!/usr/bin/env -S gjs -m
// SPDX-License-Identifier: GPL-2.0-or-later
//
// Captures the default PulseAudio/PipeWire monitor via GStreamer, computes a
// 2048-point Hann-windowed real FFT into 32 logarithmic bands (0..1000) every
// 33 ms, and prints them as space-separated integers on stdout until stdin closes.
// Exits with status 2 (NO_CAPTURE) when GStreamer or pulsesrc is unavailable.

import GLib from 'gi://GLib';
import System from 'system';

const NO_CAPTURE = 2;

const RATE = 24000;
const SIZE = 2048;
const HALF = SIZE / 2;
const TICK_MS = 33;
// Repeated lines are skipped, but not indefinitely: the shell treats ~500 ms
// without updates as silence.
const REPEAT = 8;

const BANDS = 32;
const LOWEST = 50;
const HIGHEST = RATE / 2;
// Decibels per octave added above 1 kHz and attenuated below it so bass does
// not saturate the display while treble stays legible.
const TILT = 2;
// Dynamic AGC ceiling tracks the loudest band down to QUIETEST; floor sits
// RANGE dB below top. Levels below SILENCE output zeros.
const RANGE = 48;
const QUIETEST = -60;
const SILENCE = -80;
const ATTACK = 0.3;
const RELEASE = 0.1;

const PIPELINE = [
    'pulsesrc device=@DEFAULT_MONITOR@ client-name="Amazing Media Control" latency-time=20000',
    'audioconvert',
    'audioresample',
    `audio/x-raw,format=F32LE,rate=${RATE},channels=1`,
    'appsink name=sink max-buffers=8 drop=true sync=false emit-signals=false',
].join(' ! ');

let Gst;
try {
    ({default: Gst} = await import('gi://Gst?version=1.0'));
    Gst.init(null);
} catch (e) {
    printerr(`amazing-media-control: spectrum helper missing Gst: ${e.message}`);
    System.exit(NO_CAPTURE);
}

if (!Gst.ElementFactory.find('pulsesrc')) {
    printerr('amazing-media-control: GStreamer pulsesrc plugin not found');
    System.exit(NO_CAPTURE);
}

// Ring buffer holding the newest SIZE samples; oldest sample is at pos.
const ring = new Float32Array(SIZE);
let pos = 0;

const hann = new Float64Array(SIZE);
for (let i = 0; i < SIZE; i++)
    hann[i] = 0.5 - 0.5 * Math.cos(2 * Math.PI * i / SIZE);

// SIZE real samples are packed into HALF complex samples (even -> real, odd -> imag)
// and unpacked after the HALF-point FFT.
const re = new Float64Array(HALF);
const im = new Float64Array(HALF);
const power = new Float64Array(HALF + 1);

const reversed = new Uint16Array(HALF);
const bits = Math.log2(HALF);
for (let i = 0; i < HALF; i++) {
    let r = 0;
    for (let b = 0; b < bits; b++)
        r |= ((i >> b) & 1) << (bits - 1 - b);
    reversed[i] = r;
}

const cosTurn = new Float64Array(HALF / 2);
const sinTurn = new Float64Array(HALF / 2);
for (let i = 0; i < HALF / 2; i++) {
    cosTurn[i] = Math.cos(2 * Math.PI * i / HALF);
    sinTurn[i] = -Math.sin(2 * Math.PI * i / HALF);
}

const cosSplit = new Float64Array(HALF);
const sinSplit = new Float64Array(HALF);
for (let k = 0; k < HALF; k++) {
    cosSplit[k] = Math.cos(Math.PI * k / HALF);
    sinSplit[k] = -Math.sin(Math.PI * k / HALF);
}

// Reference power so a full-scale centered sine measures 0 dB.
const FULL_SCALE = (SIZE / 4) ** 2;

// Fractional bin-overlap weights and per-band frequency tilt.
const BIN = RATE / SIZE;
const offsets = new Uint16Array(BANDS + 1);
const binList = [];
const weightList = [];
const tilts = new Float64Array(BANDS);
for (let band = 0; band < BANDS; band++) {
    const low = LOWEST * (HIGHEST / LOWEST) ** (band / BANDS);
    const high = LOWEST * (HIGHEST / LOWEST) ** ((band + 1) / BANDS);
    const from = low / BIN;
    const to = high / BIN;

    offsets[band] = binList.length;
    for (let k = Math.round(from); k <= Math.min(Math.round(to), HALF); k++) {
        const overlap = Math.min(to, k + 0.5) - Math.max(from, k - 0.5);
        if (overlap > 0) {
            binList.push(k);
            weightList.push(overlap);
        }
    }
    tilts[band] = TILT * Math.log2(Math.sqrt(low * high) / 1000);
}
offsets[BANDS] = binList.length;
const bins = Uint16Array.from(binList);
const weights = Float64Array.from(weightList);

const levels = new Float64Array(BANDS);
const values = new Uint16Array(BANDS);
const ZERO_LINE = new Array(BANDS).fill(0).join(' ');
let top = null;
let last = '';
let skipped = 0;

function isRingSilent() {
    let energy = 0;
    for (let i = 0; i < SIZE; i++) {
        const sample = ring[i];
        energy += sample * sample;
        if (energy >= 1e-9)
            return false;
    }
    return true;
}

function push(data) {
    let n = data.length;
    let start = 0;
    if (n > SIZE) {
        start = n - SIZE;
        n = SIZE;
    }

    const first = Math.min(n, SIZE - pos);
    ring.set(data.subarray(start, start + first), pos);
    if (first < n)
        ring.set(data.subarray(start + first, start + n), 0);
    pos = (pos + n) % SIZE;
}

function transform() {
    for (let i = 0; i < HALF; i++) {
        let even = pos + 2 * i;
        if (even >= SIZE)
            even -= SIZE;
        let odd = even + 1;
        if (odd >= SIZE)
            odd -= SIZE;

        const j = reversed[i];
        re[j] = ring[even] * hann[2 * i];
        im[j] = ring[odd] * hann[2 * i + 1];
    }

    for (let len = 2, step = HALF / 2; len <= HALF; len *= 2, step /= 2) {
        const half = len / 2;
        for (let i = 0; i < HALF; i += len) {
            for (let k = 0; k < half; k++) {
                const wr = cosTurn[k * step];
                const wi = sinTurn[k * step];
                const x = i + k;
                const y = x + half;
                const tr = re[y] * wr - im[y] * wi;
                const ti = re[y] * wi + im[y] * wr;
                re[y] = re[x] - tr;
                im[y] = im[x] - ti;
                re[x] += tr;
                im[x] += ti;
            }
        }
    }

    power[0] = (re[0] + im[0]) ** 2;
    power[HALF] = (re[0] - im[0]) ** 2;
    for (let k = 1; k < HALF; k++) {
        const n = HALF - k;
        const evenRe = (re[k] + re[n]) / 2;
        const evenIm = (im[k] - im[n]) / 2;
        const oddRe = (im[k] + im[n]) / 2;
        const oddIm = (re[n] - re[k]) / 2;
        const xr = evenRe + oddRe * cosSplit[k] - oddIm * sinSplit[k];
        const xi = evenIm + oddRe * sinSplit[k] + oddIm * cosSplit[k];
        power[k] = xr * xr + xi * xi;
    }
}

function report() {
    let line;
    if (isRingSilent()) {
        values.fill(0);
        line = ZERO_LINE;
    } else {
        transform();

        let loudest = -Infinity;
        for (let band = 0; band < BANDS; band++) {
            let sum = 0;
            for (let j = offsets[band]; j < offsets[band + 1]; j++)
                sum += power[bins[j]] * weights[j];

            levels[band] = 10 * Math.log10(sum / FULL_SCALE + 1e-12) + tilts[band];
            loudest = Math.max(loudest, levels[band]);
        }

        if (loudest < SILENCE) {
            values.fill(0);
            line = ZERO_LINE;
        } else {
            if (top === null)
                top = loudest;
            else if (loudest > top)
                top += (loudest - top) * ATTACK;
            else
                top = Math.max(top - RELEASE, loudest);
            top = Math.max(top, QUIETEST);

            const floor = top - RANGE;
            for (let band = 0; band < BANDS; band++) {
                const value = (levels[band] - floor) / RANGE;
                values[band] = Math.round(Math.min(Math.max(value, 0), 1) * 1000);
            }
            line = values.join(' ');
        }
    }

    if (line !== last || ++skipped >= REPEAT) {
        print(line);
        last = line;
        skipped = 0;
    }
}

function listen(pipeline) {
    const sink = pipeline.get_by_name('sink');
    const loop = new GLib.MainLoop(null, false);
    let status = 0;

    const stop = code => {
        status = code;
        loop.quit();
    };

    const bus = pipeline.get_bus();
    bus.add_signal_watch();
    const errorId = bus.connect('message::error', (_bus, message) => {
        const [error] = message.parse_error();
        printerr(`amazing-media-control: spectrum Gst error: ${error.message}`);
        stop(1);
    });
    const eosId = bus.connect('message::eos', () => stop(1));

    // The shell never writes to stdin; it closes stdin or exits on teardown.
    const stdin = GLib.IOChannel.unix_new(0);
    let stdinId = GLib.io_add_watch(stdin, GLib.PRIORITY_DEFAULT,
        GLib.IOCondition.IN | GLib.IOCondition.HUP | GLib.IOCondition.ERR,
        () => {
            stdinId = 0;
            stop(0);
            return GLib.SOURCE_REMOVE;
        });

    let silentTicks = 0;
    const tickId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, TICK_MS, () => {
        let fresh = false;
        for (;;) {
            const sample = sink.emit('try-pull-sample', 0);
            if (!sample)
                break;

            const buffer = sample.get_buffer();
            if (!buffer)
                continue;
            const size = buffer.get_size();
            if (size < 4)
                continue;

            const bytes = buffer.extract_dup(0, size);
            const sampleCount = bytes.byteLength >> 2;
            if (sampleCount <= 0)
                continue;
            const floats = (bytes.byteOffset & 3) === 0
                ? new Float32Array(bytes.buffer, bytes.byteOffset, sampleCount)
                : new Float32Array(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + (sampleCount << 2)));
            push(floats);
            fresh = true;
        }

        if (fresh) {
            silentTicks = 0;
            report();
        } else if (++silentTicks >= 3) {
            ring.fill(0);
            report();
        }
        return GLib.SOURCE_CONTINUE;
    });

    if (pipeline.set_state(Gst.State.PLAYING) === Gst.StateChangeReturn.FAILURE) {
        printerr('amazing-media-control: failed to start GStreamer spectrum pipeline');
        status = 1;
    } else {
        loop.run();
    }
    pipeline.set_state(Gst.State.NULL);

    GLib.source_remove(tickId);
    if (stdinId)
        GLib.source_remove(stdinId);
    bus.disconnect(errorId);
    bus.disconnect(eosId);
    bus.remove_signal_watch();
    return status;
}

let pipeline;
try {
    pipeline = Gst.parse_launch(PIPELINE);
} catch (e) {
    printerr(`amazing-media-control: spectrum pipeline error: ${e.message}`);
    System.exit(NO_CAPTURE);
}

System.exit(listen(pipeline));
