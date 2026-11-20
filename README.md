# Amazing Media Control

A feature-rich **Now Playing** media controller extension for **GNOME Shell 51** featuring a real-time FFT audio spectrum visualizer, blurred cover-art popout with dynamic accent colors, synced lyrics panel, audio output switcher, and YouTube/browser source filtering.

## What It Does

### Bar & Floating Pill Widget
- **Flexible Placement**: Dock directly in the GNOME Top Bar / Dash to Panel (`left`, `center`, or `right` box) or run as a **Standalone Floating Bottom Bar** pill.
- **Customizable Layout**: Reorder bar elements (`app-logo`, `title`, `spectrum`, `controls`), choose thumbnail mode (`app-logo`, `cover-art`, or `both`), toggle inline playback controls, and customize font size (`10–24 px`) and max label width (`100–500 px`).
- **Smooth Animations**: Smooth marquee scrolling for overflowing titles, plus animated width resize & fade transitions when switching tracks or when playback starts/pauses (`animate-track-resize`).
- **Smart Visibility & Quick Actions**: Optionally hide when paused or inactive, middle-click the bar card to Play/Pause, click the app logo to raise/focus the player window, or toggle the popout with a global keyboard shortcut.

### Real-Time Audio Spectrum
- **Live 32-Band FFT Capture**: Captures system monitor audio via GStreamer (`pulsesrc`) with zero external app dependencies, plus an optional animated fallback when silent.
- **14 Visual Styles**: `bars`, `center-bars`, `wave`, `aurora`, `line`, `soundwave`, `dots`, `mirror`, `segments`, `matrix`, `ribbon`, `ring`, `pulse`, and `history`.
- **Top-of-Popout & Inside-Popout Visualizers**: Display a floating bars-only spectrum directly above the popout window (automatically expanding across both cards when Lyrics is open), and/or a wide spectrum inside the popout card.
- **Color & Tuning Controls**: Dynamic cover-art accent, classic red-peaks, green/yellow/red level gradient, or rainbow palette, plus configurable column count, dB range, peak hold, FPS (`10–60`), and frequency inversion.

### Expanded Now Playing Popout
- **Frosted Cover-Art Backdrop**: Blurred, darkened album-art backdrop with adaptive accent colors extracted from cover art, app logo, GNOME Shell accent, or classic white.
- **Full Transport & Audio Controls**: Interactive seek slider, Shuffle & Repeat toggles, optional `-10s` / `+10s` seek buttons, multi-player switcher chips, live volume slider, and audio output device selector.
- **Synced Lyrics Panel**: Collapsible side panel loading embedded tags, local `.lrc` files, or `lrclib.net` lyrics with active-line highlighting, auto-scroll, click-to-seek lines, and quick **Sync** button.

### Source & Browser Filtering
- Automatically tracks active `org.mpris.MediaPlayer2.*` players over D-Bus.
- Filter out all web browsers, restrict browser sources strictly to **YouTube / YouTube Music**, and define custom ignored or priority player lists.

---

## Requirements
- **GNOME Shell 51** (Wayland)
- `glib-compile-schemas` (GLib development/runtime tools)
- GStreamer (`Gst` GObject Introspection bindings + `pulsesrc` with PulseAudio/PipeWire monitor) for live audio FFT capture (optional; falls back cleanly to simulated animation if unavailable)

---

## Installation

### Option 1: Install from source with the install script
Clone or copy the repository onto your GNOME 51 machine, then run:

```bash
chmod +x scripts/install.sh scripts/pack.sh
./scripts/install.sh
```

What `scripts/install.sh` does:
1. Compiles the GSettings schema (`glib-compile-schemas schemas/`).
2. Copies the extension files to `~/.local/share/gnome-shell/extensions/amazing-media-control@local/`.
3. Enables `amazing-media-control@local` via `gnome-extensions enable`.

### Option 2: Pack and install as a `.zip` bundle
```bash
chmod +x scripts/pack.sh
./scripts/pack.sh
gnome-extensions install --force amazing-media-control@local.shell-extension.zip
gnome-extensions enable amazing-media-control@local
```

### Finalize & Open Preferences
On Wayland, **log out and log back in** after installing (or updating schemas) so GNOME Shell loads the extension cleanly.

Open the settings window anytime with:
```bash
gnome-extensions prefs amazing-media-control@local
```
