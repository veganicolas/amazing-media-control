import Gio from 'gi://Gio';
import GioUnix from 'gi://GioUnix';
import Shell from 'gi://Shell';

import { getDefaultAppIcon, getIconTheme, setBoundedCache } from './iconUtils.js';
import {
    GENERIC_PLAYER_TOKENS,
    KNOWN_PLAYER_ALIASES,
    matchPlayerWindows,
    tokenizePlayerIdentity,
} from './playerUtils.js';

const MAX_ICON_CACHE = 64;

function normalizeAlphaNum(text) {
    return (text || '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

function slugify(text) {
    return (text || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

function idNamesApp(id, wanted) {
    const segments = id.replace(/\.desktop$/, '').split(/[._-]/).map(normalizeAlphaNum).filter(Boolean);
    for (let start = 0; start < segments.length; start++) {
        let run = '';
        for (let end = start; end < segments.length; end++) {
            run += segments[end];
            if (run === wanted)
                return true;
        }
    }
    return false;
}

export class AppIconResolver {
    constructor() {
        this._cache = new Map();
        this._allAppInfos = null;
        this._fallbackIcon = getDefaultAppIcon();
        this._destroyed = false;
        this._appSystem = Shell.AppSystem.get_default();
        this._installedChangedId = this._appSystem?.connect?.('installed-changed', () => {
            this._allAppInfos = null;
            this._cache.clear();
        }) ?? 0;
    }

    _lookupDesktopIcon(appSystem, name) {
        if (!name)
            return null;
        const id = name.endsWith('.desktop') ? name : `${name}.desktop`;
        const shellApp = appSystem.lookup_app(id);
        if (shellApp?.get_icon())
            return shellApp.get_icon();
        const info = GioUnix.DesktopAppInfo.new(id);
        return info?.get_icon() ?? null;
    }

    _lookupSearchedIcon(name) {
        const wanted = normalizeAlphaNum(name);
        if (!wanted || GENERIC_PLAYER_TOKENS.has(wanted))
            return null;
        for (const group of GioUnix.DesktopAppInfo.search(name)) {
            for (const id of group) {
                if (!idNamesApp(id, wanted))
                    continue;
                const app = GioUnix.DesktopAppInfo.new(id);
                const icon = app?.get_icon();
                if (icon)
                    return icon;
            }
        }
        return null;
    }

    _resolveFromOpenWindows({ busSuffix, slug, desktopEntry, identity, trackTitle }) {
        const matches = matchPlayerWindows({
            busName: busSuffix,
            appSlug: slug,
            desktopEntry,
            identity,
            metadata: { title: trackTitle },
        }, {
            includeTitleFallback: (trackTitle || '').trim().length >= 4,
            minTitleLength: 4,
        });

        let titleFallbackIcon = null;
        for (const match of matches) {
            const icon = match.app?.get_icon?.();
            if (!icon)
                continue;
            if (match.appMatches)
                return { icon, byTitle: false };
            if (!titleFallbackIcon && match.titleMatches)
                titleFallbackIcon = icon;
        }

        if (titleFallbackIcon)
            return { icon: titleFallbackIcon, byTitle: true };
        return null;
    }

    resolve({ busSuffix = '', slug = '', desktopEntry = '', identity = '', trackTitle = '' }) {
        if (this._destroyed)
            return this._fallbackIcon;

        const iconTheme = getIconTheme();
        const rawEntry = (desktopEntry || '').trim();
        const rawIdentity = (identity || '').trim();
        const titleNeedle = (trackTitle || '').trim().toLowerCase();
        const cacheKey = `${busSuffix}|${slug}|${rawEntry}|${rawIdentity}`;
        if (this._cache.has(cacheKey))
            return this._cache.get(cacheKey);
        const titleCacheKey = `${cacheKey}|${titleNeedle.length >= 4 ? titleNeedle : ''}`;
        if (this._cache.has(titleCacheKey))
            return this._cache.get(titleCacheKey);

        const appSystem = this._appSystem ?? Shell.AppSystem.get_default();
        const identityTokens = [
            ...tokenizePlayerIdentity(rawEntry),
            ...tokenizePlayerIdentity(rawIdentity),
        ];
        const primaryHints = [
            rawEntry,
            slugify(rawIdentity),
            ...identityTokens,
            busSuffix,
            slug,
        ].filter(Boolean);

        for (const hint of primaryHints) {
            const icon = this._lookupDesktopIcon(appSystem, hint) ??
                (iconTheme.has_icon(hint) ? Gio.ThemedIcon.new(hint) : null) ??
                this._lookupSearchedIcon(hint);
            if (icon) {
                setBoundedCache(this._cache, cacheKey, icon, MAX_ICON_CACHE);
                return icon;
            }
        }

        const identityStr = `${rawEntry} ${rawIdentity}`.toLowerCase();
        const fullHintStr = `${identityStr} ${busSuffix} ${slug}`.toLowerCase();
        for (const scopeStr of [identityStr, fullHintStr]) {
            for (const [key, list] of KNOWN_PLAYER_ALIASES) {
                if (!scopeStr.includes(key))
                    continue;
                for (const alias of list) {
                    const icon = this._lookupDesktopIcon(appSystem, alias) ??
                        (iconTheme.has_icon(alias) ? Gio.ThemedIcon.new(alias) : null);
                    if (icon) {
                        setBoundedCache(this._cache, cacheKey, icon, MAX_ICON_CACHE);
                        return icon;
                    }
                }
            }
        }

        const allTokens = [
            ...identityTokens,
            ...tokenizePlayerIdentity(busSuffix),
            ...tokenizePlayerIdentity(slug),
        ];

        if (allTokens.length > 0 && typeof appSystem.get_running === 'function') {
            for (const app of appSystem.get_running()) {
                const haystack = [
                    app.get_id?.() || '',
                    app.get_name?.() || '',
                    app.get_app_info?.()?.get_executable?.() || '',
                ].join(' ').toLowerCase();
                if (allTokens.some(tok => haystack.includes(tok))) {
                    const icon = app.get_icon?.();
                    if (icon) {
                        setBoundedCache(this._cache, cacheKey, icon, MAX_ICON_CACHE);
                        return icon;
                    }
                }
            }
        }

        const windowMatch = this._resolveFromOpenWindows({
            busSuffix,
            slug,
            desktopEntry: rawEntry,
            identity: rawIdentity,
            trackTitle,
        });
        if (windowMatch?.icon) {
            if (!windowMatch.byTitle)
                setBoundedCache(this._cache, cacheKey, windowMatch.icon, MAX_ICON_CACHE);
            else
                setBoundedCache(this._cache, titleCacheKey, windowMatch.icon, MAX_ICON_CACHE);
            return windowMatch.icon;
        }

        if (allTokens.length > 0) {
            if (!this._allAppInfos)
                this._allAppInfos = Gio.AppInfo.get_all();
            for (const appInfo of this._allAppInfos) {
                const haystack = [
                    appInfo.get_id?.() || '',
                    appInfo.get_name?.() || '',
                    appInfo.get_display_name?.() || '',
                    appInfo.get_executable?.() || '',
                ].join(' ').toLowerCase();
                if (allTokens.some(tok => haystack.includes(tok))) {
                    const icon = appInfo.get_icon?.();
                    if (icon) {
                        setBoundedCache(this._cache, cacheKey, icon, MAX_ICON_CACHE);
                        return icon;
                    }
                }
            }
        }

        setBoundedCache(this._cache, titleCacheKey, this._fallbackIcon, MAX_ICON_CACHE);
        return this._fallbackIcon;
    }

    destroy() {
        this._destroyed = true;
        if (this._installedChangedId && this._appSystem) {
            try {
                this._appSystem.disconnect(this._installedChangedId);
            } catch {
                // Ignore if already disposed.
            }
            this._installedChangedId = 0;
        }
        this._appSystem = null;
        this._cache.clear();
        this._allAppInfos = null;
    }
}
