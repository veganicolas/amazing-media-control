import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import { AppIconResolver } from './appIconResolver.js';
import {
    comparePlayersByActivity,
    isLikelyBrowserPlayer,
    matchPlayerWindows,
    stripArtistFromTitle,
} from './playerUtils.js';

const MPRIS_PREFIX = 'org.mpris.MediaPlayer2.';
const MPRIS_OBJECT_PATH = '/org/mpris/MediaPlayer2';
const MPRIS_PLAYER_IFACE = 'org.mpris.MediaPlayer2.Player';

const BUS_TLD_PREFIXES = new Set([
    'org', 'com', 'net', 'io', 'app', 'de', 'uk', 'me', 'dev', 'one',
]);
const BUS_VENDOR_PREFIXES = new Set([
    'mozilla', 'chromium', 'google', 'spotify', 'videolan', 'kde', 'gnome', 'github', 'gitlab',
]);
const BUS_GENERIC_TAILS = new Set([
    'client', 'application', 'desktop',
]);

const ROOT_XML = `
<node>
  <interface name="org.mpris.MediaPlayer2">
    <method name="Raise"/>
    <property name="CanRaise" type="b" access="read"/>
    <property name="Identity" type="s" access="read"/>
    <property name="DesktopEntry" type="s" access="read"/>
  </interface>
</node>`;

const PLAYER_XML = `
<node>
  <interface name="org.mpris.MediaPlayer2.Player">
    <method name="Next"/>
    <method name="Previous"/>
    <method name="Pause"/>
    <method name="PlayPause"/>
    <method name="Stop"/>
    <method name="Play"/>
    <method name="Seek">
      <arg name="Offset" type="x" direction="in"/>
    </method>
    <method name="SetPosition">
      <arg name="TrackId" type="o" direction="in"/>
      <arg name="Position" type="x" direction="in"/>
    </method>
    <signal name="Seeked">
      <arg name="Position" type="x"/>
    </signal>
    <property name="PlaybackStatus" type="s" access="read"/>
    <property name="LoopStatus" type="s" access="readwrite"/>
    <property name="Shuffle" type="b" access="readwrite"/>
    <property name="Metadata" type="a{sv}" access="read"/>
    <property name="Position" type="x" access="read"/>
    <property name="Volume" type="d" access="readwrite"/>
    <property name="CanControl" type="b" access="read"/>
    <property name="CanGoNext" type="b" access="read"/>
    <property name="CanGoPrevious" type="b" access="read"/>
    <property name="CanPlay" type="b" access="read"/>
    <property name="CanPause" type="b" access="read"/>
    <property name="CanSeek" type="b" access="read"/>
  </interface>
</node>`;

const DBUS_XML = `
<node>
  <interface name="org.freedesktop.DBus">
    <method name="ListNames">
      <arg name="names" type="as" direction="out"/>
    </method>
    <signal name="NameOwnerChanged">
      <arg name="name" type="s"/>
      <arg name="old_owner" type="s"/>
      <arg name="new_owner" type="s"/>
    </signal>
  </interface>
</node>`;

const RootProxy = Gio.DBusProxy.makeProxyWrapper(ROOT_XML);
const PlayerProxy = Gio.DBusProxy.makeProxyWrapper(PLAYER_XML);
const DBusProxy = Gio.DBusProxy.makeProxyWrapper(DBUS_XML);

/**
 * Unpack an MPRIS Metadata a{sv} dictionary safely into plain JS fields.
 *
 * @param {Record<string, GLib.Variant>|null|undefined} raw
 * @returns {object}
 */
function unpackMetadata(raw) {
    if (!raw || typeof raw !== 'object') {
        return {
            title: '',
            rawTitle: '',
            artist: '',
            album: '',
            artUrl: '',
            url: '',
            trackId: '',
            lengthUs: 0,
            lyrics: '',
        };
    }

    const unwrap = key => {
        const val = raw[key];
        if (val === undefined || val === null)
            return null;
        return typeof val.recursiveUnpack === 'function' ? val.recursiveUnpack() : val;
    };

    const rawTitle = unwrap('xesam:title');
    const rawArtist = unwrap('xesam:artist');
    const rawAlbum = unwrap('xesam:album');
    const rawArtUrl = unwrap('mpris:artUrl');
    const rawUrl = unwrap('xesam:url');
    const rawTrackId = unwrap('mpris:trackid');
    const rawLength = unwrap('mpris:length');
    const rawLyrics = unwrap('xesam:asText');

    let artist = '';
    if (Array.isArray(rawArtist))
        artist = rawArtist.filter(Boolean).join(', ');
    else if (typeof rawArtist === 'string')
        artist = rawArtist;

    const trimmedArtist = artist.trim();
    const rawCleanTitle = typeof rawTitle === 'string' ? rawTitle.trim() : '';
    const title = stripArtistFromTitle(rawCleanTitle, trimmedArtist);

    return {
        title,
        rawTitle: rawCleanTitle,
        artist: trimmedArtist,
        album: typeof rawAlbum === 'string' ? rawAlbum.trim() : '',
        artUrl: typeof rawArtUrl === 'string' ? rawArtUrl.trim() : '',
        url: typeof rawUrl === 'string' ? rawUrl.trim() : '',
        trackId: typeof rawTrackId === 'string' ? rawTrackId : '',
        lengthUs: typeof rawLength === 'number' && Number.isFinite(rawLength) ? Math.max(0, rawLength) : 0,
        lyrics: typeof rawLyrics === 'string' ? rawLyrics : '',
    };
}

/**
 * Derive a fallback application identifier from an MPRIS bus name.
 * E.g. "org.mpris.MediaPlayer2.org.mozilla.firefox.instance123" -> "firefox"
 *
 * @param {string} busName
 * @returns {string}
 */
function busNameToAppSlug(busName) {
    const suffix = (busName || '').startsWith(MPRIS_PREFIX)
        ? busName.slice(MPRIS_PREFIX.length)
        : (busName || '');
    const parts = suffix
        .split('.')
        .map(p => p.trim().toLowerCase())
        .filter(p => p && !p.startsWith('instance') && !BUS_GENERIC_TAILS.has(p));
    let idx = 0;
    while (
        idx < parts.length - 1 &&
        (BUS_TLD_PREFIXES.has(parts[idx]) || BUS_VENDOR_PREFIXES.has(parts[idx]))
    ) {
        idx++;
    }
    return parts[idx] ?? '';
}

const MprisPlayer = GObject.registerClass({
    Signals: {
        'changed': {},
        'seeked': { param_types: [GObject.TYPE_INT64] },
    },
}, class MprisPlayer extends GObject.Object {
    _init(busName, iconResolver = null) {
        super._init();
        this.busName = busName;
        this._iconResolver = iconResolver;
        this._cancellable = new Gio.Cancellable();
        this._destroyed = false;

        this.identity = '';
        this.desktopEntry = '';
        this.gicon = null;
        this.playbackStatus = 'Stopped';
        this.metadata = unpackMetadata(null);
        this.canGoNext = false;
        this.canGoPrevious = false;
        this.canPlay = false;
        this.canPause = false;
        this.canSeek = false;
        this.lastActiveUs = GLib.get_monotonic_time();

        this._estPosUs = 0;
        this._estAnchorMonoUs = GLib.get_monotonic_time();
        this._estPlaying = false;
        this._estTrackKey = '';

        this._rootProxy = null;
        this._playerProxy = null;
        this._rootSigId = 0;
        this._playerSigId = 0;
        this._seekedSigId = 0;

        this._initProxies();
    }

    _initProxies() {
        // GNOME 51: makeProxyWrapper returns a Gio.DBusProxy subclass; instantiate with `new`.
        new RootProxy(
            Gio.DBus.session,
            this.busName,
            MPRIS_OBJECT_PATH,
            (proxy, error) => {
                if (this._destroyed || error || !proxy)
                    return;
                this._rootProxy = proxy;
                this._rootSigId = proxy.connect('g-properties-changed', () => {
                    this._syncRootProperties();
                });
                this._syncRootProperties();
            },
            this._cancellable,
            Gio.DBusProxyFlags.NONE
        );

        new PlayerProxy(
            Gio.DBus.session,
            this.busName,
            MPRIS_OBJECT_PATH,
            (proxy, error) => {
                if (this._destroyed || error || !proxy)
                    return;
                this._playerProxy = proxy;
                this._playerSigId = proxy.connect('g-properties-changed', () => {
                    this._syncPlayerProperties();
                });
                this._seekedSigId = proxy.connectSignal('Seeked', (_p, _sender, [posUs]) => {
                    const safePos = Number(posUs);
                    if (Number.isFinite(safePos) && safePos >= 0) {
                        const roundedPos = Math.round(safePos);
                        this._setEstimatedPosition(roundedPos, this.isPlaying);
                        this.emit('seeked', roundedPos);
                    }
                });
                this._syncPlayerProperties();
            },
            this._cancellable,
            Gio.DBusProxyFlags.NONE
        );
    }

    _syncRootProperties() {
        if (this._destroyed || !this._rootProxy)
            return;

        this.identity = this._rootProxy.Identity || busNameToAppSlug(this.busName);
        this.desktopEntry = this._rootProxy.DesktopEntry || '';
        this.gicon = this._resolveAppIcon();
        this.emit('changed');
    }

    _syncPlayerProperties() {
        if (this._destroyed || !this._playerProxy)
            return;

        const prevStatus = this.playbackStatus;
        const prevMeta = this.metadata;
        const prevCanSeek = this.canSeek;
        const nextStatus = this._playerProxy.PlaybackStatus || 'Stopped';
        this.playbackStatus = nextStatus;

        if ((nextStatus === 'Playing' && prevStatus !== 'Playing') ||
            (prevStatus === 'Playing' && nextStatus === 'Paused')) {
            this.lastActiveUs = GLib.get_monotonic_time();
        }

        const nextMeta = unpackMetadata(this._playerProxy.Metadata);
        const sameTrack = Boolean(
            prevMeta?.title &&
            nextMeta.title === prevMeta.title &&
            nextMeta.artist === prevMeta.artist
        );
        if (sameTrack) {
            if (nextMeta.lengthUs <= 0 && prevMeta.lengthUs > 0)
                nextMeta.lengthUs = prevMeta.lengthUs;
            if (!nextMeta.artUrl && prevMeta.artUrl)
                nextMeta.artUrl = prevMeta.artUrl;
            if (!nextMeta.trackId && prevMeta.trackId)
                nextMeta.trackId = prevMeta.trackId;
        }
        this.metadata = nextMeta;

        this.canGoNext = Boolean(this._playerProxy.CanGoNext);
        this.canGoPrevious = Boolean(this._playerProxy.CanGoPrevious);
        this.canPlay = Boolean(this._playerProxy.CanPlay);
        this.canPause = Boolean(this._playerProxy.CanPause);
        const rawCanSeek = Boolean(this._playerProxy.CanSeek);
        this.canSeek = rawCanSeek || (sameTrack && prevCanSeek && nextStatus !== 'Stopped');

        const wasInitialSync = this._estTrackKey === '';
        const nextEstTrackKey = `${this.metadata.title}|${this.metadata.artist}`;
        const estTrackChanged = nextEstTrackKey !== this._estTrackKey;
        this._estTrackKey = nextEstTrackKey;
        if (!this.isActive) {
            this._setEstimatedPosition(0, false);
        } else if (estTrackChanged) {
            const seedPos = wasInitialSync ? Number(this._playerProxy.Position ?? this._estPosUs ?? 0) : 0;
            this._setEstimatedPosition(
                Number.isFinite(seedPos) && seedPos > 0 ? seedPos : 0,
                nextStatus === 'Playing'
            );
        } else if (prevStatus !== nextStatus) {
            this._setEstimatedPosition(this.getEstimatedPositionUs(), nextStatus === 'Playing');
        }

        if (!this.identity)
            this.identity = busNameToAppSlug(this.busName);
        this.gicon = this._resolveAppIcon();

        this.emit('changed');
    }

    _resolveAppIcon() {
        const slug = busNameToAppSlug(this.busName);
        const busSuffix = this.busName.startsWith(MPRIS_PREFIX)
            ? this.busName.slice(MPRIS_PREFIX.length).replace(/\.instance.*$/i, '')
            : slug;
        if (!this._iconResolver)
            return Gio.ThemedIcon.new('audio-x-generic-symbolic');
        return this._iconResolver.resolve({
            busSuffix,
            slug,
            desktopEntry: this.desktopEntry,
            identity: this.identity,
            trackTitle: this.metadata?.rawTitle || this.metadata?.title || '',
        });
    }

    get appSlug() {
        return busNameToAppSlug(this.busName);
    }

    get displayName() {
        const displayOverrides = {
            'mozilla zen': 'Zen Browser',
            'zen': 'Zen Browser',
            'zen-browser': 'Zen Browser',
            'zen browser': 'Zen Browser',
            'app.zen_browser.zen': 'Zen Browser',
        };

        const rawIdentity = (this.identity || '').trim();
        const rawEntry = (this.desktopEntry || '').trim().toLowerCase();
        if (rawIdentity) {
            const override = displayOverrides[rawIdentity.toLowerCase()] ?? displayOverrides[rawEntry];
            if (override)
                return override;
            return rawIdentity;
        }
        const slug = this.appSlug;
        if (slug && displayOverrides[slug])
            return displayOverrides[slug];
        return slug ? slug.charAt(0).toUpperCase() + slug.slice(1) : 'Media Player';
    }

    get isPlaying() {
        return this.playbackStatus === 'Playing';
    }

    get isActive() {
        return this.playbackStatus === 'Playing' || this.playbackStatus === 'Paused';
    }

    _callRemote(methodName) {
        const fn = this._playerProxy?.[`${methodName}Remote`];
        if (typeof fn !== 'function')
            return;
        fn.call(this._playerProxy, (_res, err) => {
            if (err)
                console.debug(`[AmazingMediaControl] ${methodName} error: ${err.message}`);
        });
    }

    _setPlayerProp(propName, value) {
        if (!this._playerProxy)
            return;
        try {
            this._playerProxy[propName] = value;
        } catch (e) {
            console.debug(`[AmazingMediaControl] ${propName} error: ${e.message}`);
        }
    }

    playPause() {
        this._callRemote('PlayPause');
    }

    next() {
        this._callRemote('Next');
    }

    previous() {
        this._callRemote('Previous');
    }

    get loopStatus() {
        const status = this._playerProxy?.LoopStatus;
        return typeof status === 'string' ? status : null;
    }

    get canLoop() {
        return this.loopStatus !== null;
    }

    get shuffle() {
        const val = this._playerProxy?.Shuffle;
        return typeof val === 'boolean' ? val : null;
    }

    get canShuffle() {
        return this.shuffle !== null;
    }

    get volume() {
        const val = this._playerProxy?.Volume;
        return typeof val === 'number' && Number.isFinite(val) ? val : null;
    }

    get canSetVolume() {
        return this.volume !== null && !isLikelyBrowserPlayer(this) && (this._playerProxy?.CanControl ?? true);
    }

    _setEstimatedPosition(posUs, isPlaying = this.isPlaying) {
        const len = this.metadata?.lengthUs || 0;
        const clamped = len > 0
            ? Math.max(0, Math.min(len, posUs || 0))
            : Math.max(0, posUs || 0);
        this._estPosUs = clamped;
        this._estAnchorMonoUs = GLib.get_monotonic_time();
        this._estPlaying = Boolean(isPlaying);
    }

    getEstimatedPositionUs() {
        if (!this.isActive)
            return 0;
        const nowUs = GLib.get_monotonic_time();
        const elapsed = this._estPlaying ? Math.max(0, nowUs - this._estAnchorMonoUs) : 0;
        const base = this._estPosUs + elapsed;
        const len = this.metadata?.lengthUs || 0;
        return len > 0 ? Math.min(len, Math.max(0, base)) : Math.max(0, base);
    }

    seek(offsetUs) {
        if (!this._playerProxy || !this.canSeek)
            return;
        this._setEstimatedPosition(this.getEstimatedPositionUs() + offsetUs, this.isPlaying);
        this._playerProxy.SeekRemote(Math.round(offsetUs), (_res, err) => {
            if (err)
                console.debug(`[AmazingMediaControl] Seek error: ${err.message}`);
        });
    }

    setLoopStatus(status) {
        if (this.canLoop)
            this._setPlayerProp('LoopStatus', status);
    }

    cycleLoopStatus() {
        const order = ['None', 'Playlist', 'Track'];
        const idx = order.indexOf(this.loopStatus);
        this.setLoopStatus(order[(idx + 1) % order.length]);
    }

    setShuffle(enabled) {
        if (this.canShuffle)
            this._setPlayerProp('Shuffle', Boolean(enabled));
    }

    setVolume(fraction) {
        if (this.canSetVolume)
            this._setPlayerProp('Volume', Math.max(0, Math.min(1, fraction)));
    }

    setPosition(positionUs) {
        if (!this._playerProxy || !this.canSeek)
            return;
        const clamped = Math.max(0, Math.min(Math.round(positionUs), this.metadata.lengthUs || positionUs));
        const prevEstUs = this.getEstimatedPositionUs();
        const offsetUs = clamped - prevEstUs;
        const trackId = this.metadata.trackId || '';
        if (!trackId || !GLib.variant_is_object_path(trackId)) {
            this.seek(offsetUs);
            return;
        }

        this._setEstimatedPosition(clamped, this.isPlaying);
        try {
            this._playerProxy.SetPositionRemote(trackId, clamped, (_res, err) => {
                if (err && !this._destroyed && this._playerProxy) {
                    console.debug(`[AmazingMediaControl] SetPosition error: ${err.message}`);
                    this._playerProxy.SeekRemote(Math.round(offsetUs), (_seekRes, seekErr) => {
                        if (seekErr)
                            console.debug(`[AmazingMediaControl] Seek fallback error: ${seekErr.message}`);
                    });
                }
            });
        } catch (e) {
            console.debug(`[AmazingMediaControl] SetPosition error: ${e.message}`);
            this._setEstimatedPosition(prevEstUs, this.isPlaying);
            this.seek(offsetUs);
        }
    }

    _activateMatchingWindow() {
        const matches = matchPlayerWindows(this, {
            includeTitleFallback: true,
            minTitleLength: 4,
        });
        const target = matches.find(m => m.appMatches && m.titleMatches) ??
            matches.find(m => m.appMatches) ??
            matches.find(m => m.titleMatches);
        if (target?.metaWin)
            Main.activateWindow(target.metaWin);
    }

    raise() {
        if (this._rootProxy?.CanRaise) {
            this._rootProxy.RaiseRemote((_res, err) => {
                if (err && !this._destroyed)
                    this._activateMatchingWindow();
            });
            return;
        }

        this._activateMatchingWindow();
    }

    /**
     * Asynchronously query live Position property over D-Bus (avoiding stale proxy cache).
     *
     * @param {(posUs: number) => void} callback
     * @param {{ driftThresholdUs?: number }} [options]
     */
    fetchPositionUs(callback, { driftThresholdUs = 0 } = {}) {
        if (this._destroyed)
            return;

        const applyReading = posUs => {
            if (!Number.isFinite(posUs) || posUs < 0) {
                callback(this.getEstimatedPositionUs());
                return;
            }
            if (posUs === 0 && this.isActive && this._estPosUs > 3_000_000) {
                callback(this.getEstimatedPositionUs());
                return;
            }
            const estUs = this.getEstimatedPositionUs();
            if (driftThresholdUs > 0 && this.isPlaying && Math.abs(posUs - estUs) < driftThresholdUs) {
                callback(estUs);
                return;
            }
            this._setEstimatedPosition(posUs, this.isPlaying);
            callback(posUs);
        };

        Gio.DBus.session.call(
            this.busName,
            MPRIS_OBJECT_PATH,
            'org.freedesktop.DBus.Properties',
            'Get',
            new GLib.Variant('(ss)', [MPRIS_PLAYER_IFACE, 'Position']),
            new GLib.VariantType('(v)'),
            Gio.DBusCallFlags.NONE,
            1000,
            this._cancellable,
            (conn, res) => {
                if (this._destroyed)
                    return;
                try {
                    const out = conn.call_finish(res);
                    const [innerVariant] = out.deepUnpack();
                    const raw = typeof innerVariant?.unpack === 'function'
                        ? innerVariant.unpack()
                        : innerVariant;
                    applyReading(Number(raw));
                } catch (_e) {
                    const cached = Number(this._playerProxy?.Position ?? 0);
                    if (Number.isFinite(cached) && cached >= 0 && (cached > 0 || !(this.isActive && this._estPosUs > 3_000_000))) {
                        applyReading(cached);
                    } else if (this.isActive) {
                        callback(this.getEstimatedPositionUs());
                    } else {
                        callback(0);
                    }
                }
            }
        );
    }

    destroy() {
        this._destroyed = true;
        this._cancellable.cancel();

        if (this._rootProxy && this._rootSigId) {
            this._rootProxy.disconnect(this._rootSigId);
            this._rootSigId = 0;
        }
        if (this._playerProxy && this._playerSigId) {
            this._playerProxy.disconnect(this._playerSigId);
            this._playerSigId = 0;
        }
        if (this._playerProxy && this._seekedSigId) {
            this._playerProxy.disconnectSignal(this._seekedSigId);
            this._seekedSigId = 0;
        }

        this._rootProxy = null;
        this._playerProxy = null;
    }
});

export const MprisManager = GObject.registerClass({
    Signals: {
        'players-changed': {},
    },
}, class MprisManager extends GObject.Object {
    _init() {
        super._init();
        this._players = new Map();
        this._playerSignals = new Map();
        this._removedDuringInit = new Set();
        this._initDone = false;
        this._iconResolver = new AppIconResolver();
        this._cancellable = new Gio.Cancellable();
        this._destroyed = false;
        this._dbusProxy = null;
        this._nameOwnerSigId = 0;

        this._initBusWatcher();
    }

    _onNameOwnerChanged(busName, oldOwner, newOwner) {
        if (this._destroyed || !busName?.startsWith(MPRIS_PREFIX))
            return;

        if (oldOwner && newOwner) {
            this._removePlayer(busName);
            this._removedDuringInit?.delete(busName);
            this._addPlayer(busName);
        } else if (newOwner) {
            this._removedDuringInit?.delete(busName);
            this._addPlayer(busName);
        } else {
            if (!this._initDone)
                this._removedDuringInit?.add(busName);
            this._removePlayer(busName);
        }
    }

    _initBusWatcher() {
        new DBusProxy(
            Gio.DBus.session,
            'org.freedesktop.DBus',
            '/org/freedesktop/DBus',
            (proxy, error) => {
                if (this._destroyed || error || !proxy)
                    return;

                this._dbusProxy = proxy;
                this._nameOwnerSigId = proxy.connectSignal(
                    'NameOwnerChanged',
                    (_p, _sender, [name, oldOwner, newOwner]) => {
                        this._onNameOwnerChanged(name, oldOwner, newOwner);
                    }
                );

                proxy.ListNamesRemote(([names], listErr) => {
                    const removedDuringInit = this._removedDuringInit;
                    this._removedDuringInit = null;
                    this._initDone = true;
                    if (this._destroyed || listErr || !Array.isArray(names))
                        return;
                    for (const name of names) {
                        if (this._destroyed)
                            return;
                        if (name.startsWith(MPRIS_PREFIX) && !removedDuringInit?.has(name))
                            this._addPlayer(name);
                    }
                });
            },
            this._cancellable,
            Gio.DBusProxyFlags.NONE
        );
    }

    _addPlayer(busName) {
        if (this._destroyed || this._players.has(busName))
            return;

        const player = new MprisPlayer(busName, this._iconResolver);
        const sigId = player.connect('changed', () => {
            if (!this._destroyed)
                this.emit('players-changed');
        });
        this._players.set(busName, player);
        this._playerSignals.set(busName, sigId);
        this.emit('players-changed');
    }

    _removePlayer(busName) {
        const player = this._players.get(busName);
        if (!player)
            return;

        const sigId = this._playerSignals.get(busName);
        if (sigId)
            player.disconnect(sigId);

        this._playerSignals.delete(busName);
        this._players.delete(busName);
        player.destroy();
        this.emit('players-changed');
    }

    /**
     * Return all tracked MPRIS players sorted by playing state & recency.
     *
     * @returns {MprisPlayer[]}
     */
    getPlayers() {
        return Array.from(this._players.values()).sort(comparePlayersByActivity);
    }

    destroy() {
        this._destroyed = true;
        this._cancellable.cancel();
        this._removedDuringInit = null;

        if (this._dbusProxy && this._nameOwnerSigId) {
            this._dbusProxy.disconnectSignal(this._nameOwnerSigId);
            this._nameOwnerSigId = 0;
        }
        this._dbusProxy = null;

        for (const [busName, player] of this._players.entries()) {
            const sigId = this._playerSignals.get(busName);
            if (sigId)
                player.disconnect(sigId);
            player.destroy();
        }
        this._players.clear();
        this._playerSignals.clear();
        this._iconResolver?.destroy();
        this._iconResolver = null;
    }
});
