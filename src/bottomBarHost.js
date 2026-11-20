import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import Shell from 'gi://Shell';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';

/**
 * Shared reveal/conceal visibility transition for both panel and bottom-bar hosts.
 * Returns true if the host is visible after applying the requested state.
 *
 * @param {Clutter.Actor|null} actor
 * @param {import('./mediaCard.js').MediaCard|null} card
 * @param {PopupMenu.PopupMenu|null} menu
 * @param {boolean} visible
 */
export function applyCardVisibility(actor, card, menu, visible) {
    if (!actor || !card || card._destroyed)
        return false;

    if (visible) {
        actor._amcVisGen = (actor._amcVisGen ?? 0) + 1;
        const wasHidden = !actor.visible || card.isConcealing();
        actor.visible = true;
        if (wasHidden)
            card.reveal(true);
        return true;
    }

    if (menu?.isOpen)
        menu.close(false);
    if (!actor.visible || card.isConcealing())
        return false;

    const gen = (actor._amcVisGen ?? 0) + 1;
    actor._amcVisGen = gen;
    card.conceal(true, () => {
        if (actor._amcVisGen !== gen || card._destroyed)
            return;
        try {
            if (actor && actor.get_stage())
                actor.visible = false;
        } catch (_) {
            // Actor already disposed
        }
    });
    return false;
}

/**
 * Hosts the MediaCard inside a standalone floating bottom pill anchored to
 * Main.layoutManager.primaryMonitor, with an upward-opening PopupMenu.
 */
export class BottomBarHost {
    /**
     * @param {import('./mediaCard.js').MediaCard} card
     */
    constructor(card) {
        this._card = card;
        this._alignment = 'center';
        this._bottomMargin = 10;
        this._desiredVisible = true;
        this._lastX = null;
        this._lastY = null;
        this._repositionIdleId = 0;

        this.actor = new St.BoxLayout({
            style_class: 'amc-bottom-bar-pill',
            reactive: true,
            track_hover: true,
            y_align: Clutter.ActorAlign.CENTER,
        });
        this.actor.add_child(this._card);

        this.menu = new PopupMenu.PopupMenu(this.actor, 0.5, St.Side.BOTTOM);
        this.menu.actor.hide();
        Main.uiGroup.add_child(this.menu.actor);

        this._menuManager = new PopupMenu.PopupMenuManager(this.actor, {
            actionMode: Shell.ActionMode.NORMAL | Shell.ActionMode.OVERVIEW | Shell.ActionMode.POPUP,
        });
        this._menuManager.addMenu(this.menu);

        Main.layoutManager.addChrome(this.actor, {
            affectsStruts: false,
            trackFullscreen: true,
        });

        this._cardClickSigId = this._card.connect('card-clicked', () => {
            this.menu.toggle();
        });
        this._allocSigId = this.actor.connect('notify::allocation', () => {
            this._scheduleReposition();
        });
        this._visibleSigId = this.actor.connect('notify::visible', () => {
            if (!this.actor)
                return;
            if ((!this._desiredVisible && !this._card?.isConcealing()) ||
                (this._isInFullscreen() && !this.menu?.isOpen)) {
                if (this.actor.visible)
                    this.actor.visible = false;
                return;
            }
            if (this._desiredVisible && this.actor.visible)
                this._scheduleReposition();
        });
        this._fullscreenSigId = Main.layoutManager.connect('fullscreen-changed', () => {
            this._syncFullscreenVisibility();
        });
        this._monitorsSigId = Main.layoutManager.connect('monitors-changed', () => {
            this._lastX = null;
            this._lastY = null;
            this._reposition();
        });

        this._reposition();
    }

    get visible() {
        return Boolean(this._desiredVisible && this.actor?.visible);
    }

    _isInFullscreen() {
        return Boolean(Main.layoutManager.primaryMonitor?.inFullscreen && !Main.overview.visible);
    }

    _syncFullscreenVisibility() {
        if (!this.actor || !this._card || this._card._destroyed)
            return;
        if (this._isInFullscreen() && !this.menu?.isOpen) {
            this.actor.visible = false;
            return;
        }
        if (this._desiredVisible) {
            if (applyCardVisibility(this.actor, this._card, this.menu, true))
                this._reposition();
        } else if (!this._card.isConcealing()) {
            this.actor.visible = false;
        }
    }

    setLayout({ panelBox, bottomMargin }) {
        this._alignment = panelBox;
        this._bottomMargin = bottomMargin;
        this._reposition();
    }

    setVisible(visible) {
        this._desiredVisible = Boolean(visible);
        if (this._desiredVisible && this._isInFullscreen() && !this.menu?.isOpen) {
            this.actor.visible = false;
            return;
        }
        if (applyCardVisibility(this.actor, this._card, this.menu, this._desiredVisible))
            this._reposition();
    }

    _scheduleReposition() {
        if (this._repositionIdleId || !this.actor)
            return;
        this._repositionIdleId = GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
            this._repositionIdleId = 0;
            this._reposition();
            return GLib.SOURCE_REMOVE;
        });
    }

    _reposition() {
        const monitor = Main.layoutManager.primaryMonitor;
        if (!monitor || !this.actor?.visible)
            return;

        const [, natWidth] = this.actor.get_preferred_width(-1);
        const [, natHeight] = this.actor.get_preferred_height(-1);
        const edgePad = 16;

        let x = monitor.x + Math.round((monitor.width - natWidth) / 2);
        if (this._alignment === 'left')
            x = monitor.x + edgePad;
        else if (this._alignment === 'right')
            x = monitor.x + monitor.width - natWidth - edgePad;

        const y = monitor.y + monitor.height - natHeight - this._bottomMargin;
        if (this._lastX !== x || this._lastY !== y) {
            this._lastX = x;
            this._lastY = y;
            this.actor.set_position(x, y);
        }
    }

    destroy() {
        if (this._repositionIdleId) {
            GLib.Source.remove(this._repositionIdleId);
            this._repositionIdleId = 0;
        }
        if (this._cardClickSigId && this._card) {
            this._card.disconnect(this._cardClickSigId);
            this._cardClickSigId = 0;
        }
        if (this._allocSigId && this.actor) {
            this.actor.disconnect(this._allocSigId);
            this._allocSigId = 0;
        }
        if (this._visibleSigId && this.actor) {
            this.actor.disconnect(this._visibleSigId);
            this._visibleSigId = 0;
        }
        if (this._fullscreenSigId) {
            Main.layoutManager.disconnect(this._fullscreenSigId);
            this._fullscreenSigId = 0;
        }
        if (this._monitorsSigId) {
            Main.layoutManager.disconnect(this._monitorsSigId);
            this._monitorsSigId = 0;
        }

        if (this.menu?.isOpen)
            this.menu.close(false);

        if (this._menuManager) {
            if (this.menu)
                this._menuManager.removeMenu(this.menu);
            this._menuManager = null;
        }

        if (this.menu) {
            this.menu.destroy();
            this.menu = null;
        }

        if (this.actor) {
            if (this._card?.get_parent() === this.actor)
                this.actor.remove_child(this._card);
            Main.layoutManager.removeChrome(this.actor);
            this.actor.destroy();
            this.actor = null;
        }
        this._card = null;
    }
}

