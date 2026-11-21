import { registerGObjectClass } from '../../utils/gjs';
import { GLib, St, Clutter, Shell } from '../../gi/ext';
import EditableTilePreview from './editableTilePreview';
import { getScalingFactorOf } from '../../utils/ui';
import { formatPercentage } from './snapUtils';

export interface SplitPreviewInfo {
    ratio: number;
    coord: number;
    prevSizeRatio: number;
    nextSizeRatio: number;
}

export type SplitResolver = (
    _tile: EditableTilePreview,
    _x: number,
    _y: number,
    _splitHorizontally: boolean,
    _freehand: boolean,
) => SplitPreviewInfo | null;

export default class HoverLine extends St.Widget {
    static { registerGObjectClass(this) }

    private readonly _hoverTimer: number;
    private readonly _size: number;
    private readonly _resolveSplit: SplitResolver;
    private readonly _badge: St.Label;

    private _hoveredTile: EditableTilePreview | null;

    constructor(parent: Clutter.Actor, resolveSplit: SplitResolver) {
        super({ styleClass: 'hover-line', reactive: false });
        parent.add_child(this);

        this._resolveSplit = resolveSplit;
        this._hoveredTile = null;

        const [, scalingFactor] = getScalingFactorOf(this);
        this._size = 16 * scalingFactor;

        this._badge = new St.Label({
            styleClass: 'hover-line-label',
            reactive: false,
        });
        parent.add_child(this._badge);
        this._badge.hide();

        this.hide();

        this._hoverTimer = GLib.timeout_add(
            GLib.PRIORITY_DEFAULT_IDLE,
            100,
            this._handleModifierChange.bind(this),
        );

        this.connect('destroy', this._onDestroy.bind(this));
    }

    public handleTileDestroy(tile: EditableTilePreview) {
        if (this._hoveredTile === tile) {
            this._hoveredTile = null;
            this._hideAll();
        }
    }

    public handleMouseMove(tile: EditableTilePreview, x: number, y: number) {
        this._hoveredTile = tile;

        const modifier = Shell.Global.get().get_pointer()[2];

        // split horizontally when CTRL is NOT pressed, split vertically instead
        const splitHorizontally =
            (modifier & Clutter.ModifierType.CONTROL_MASK) === 0;
        const freehand = (modifier & Clutter.ModifierType.SHIFT_MASK) !== 0;
        this._drawLine(splitHorizontally, freehand, x, y);
    }

    private _hideAll() {
        this.hide();
        this._badge.hide();
    }

    private _handleModifierChange(): boolean {
        if (!this._hoveredTile) return GLib.SOURCE_CONTINUE;

        // if the button is not hovered, hide the split indicator
        if (!this._hoveredTile.hover) {
            this._hideAll();
            return GLib.SOURCE_CONTINUE;
        }

        const [x, y, modifier] = global.get_pointer();
        // split horizontally when CTRL is NOT pressed, split vertically instead
        const splitHorizontally =
            (modifier & Clutter.ModifierType.CONTROL_MASK) === 0;
        const freehand = (modifier & Clutter.ModifierType.SHIFT_MASK) !== 0;

        this._drawLine(
            splitHorizontally,
            freehand,
            x - (this.get_parent()?.x || 0),
            y - (this.get_parent()?.y || 0),
        );

        return GLib.SOURCE_CONTINUE;
    }

    private _drawLine(
        splitHorizontally: boolean,
        freehand: boolean,
        x: number,
        y: number,
    ) {
        if (!this._hoveredTile) return;

        const split = this._resolveSplit(
            this._hoveredTile,
            x,
            y,
            splitHorizontally,
            freehand,
        );
        if (!split) {
            this._hideAll();
            return;
        }

        const parent = this.get_parent();
        if (splitHorizontally) {
            const newX = Math.round(split.coord - this._size / 2);
            if (
                newX < this._hoveredTile.x ||
                newX + this._size >
                    this._hoveredTile.x + this._hoveredTile.width
            ) {
                this._hideAll();
                return;
            }

            this.set_size(this._size, this._hoveredTile.height);
            this.set_position(newX, this._hoveredTile.y);
            this._badge.text = `${formatPercentage(split.prevSizeRatio)} | ${formatPercentage(split.nextSizeRatio)}`;
        } else {
            const newY = Math.round(split.coord - this._size / 2);
            if (
                newY < this._hoveredTile.y ||
                newY + this._size >
                    this._hoveredTile.y + this._hoveredTile.height
            ) {
                this._hideAll();
                return;
            }

            this.set_size(this._hoveredTile.width, this._size);
            this.set_position(this._hoveredTile.x, newY);
            this._badge.text = `${formatPercentage(split.prevSizeRatio)} / ${formatPercentage(split.nextSizeRatio)}`;
        }

        if (parent) {
            parent.set_child_above_sibling(this, null);
            parent.set_child_above_sibling(this._badge, this);
        }

        this.show();
        this._badge.show();

        const [, badgeWidth] = this._badge.get_preferred_width(-1);
        const [, badgeHeight] = this._badge.get_preferred_height(-1);
        const parentW = parent ? parent.width : this._hoveredTile.x + this._hoveredTile.width;
        const parentH = parent ? parent.height : this._hoveredTile.y + this._hoveredTile.height;

        const rawBadgeX = splitHorizontally
            ? split.coord - badgeWidth / 2
            : this._hoveredTile.x + this._hoveredTile.width / 2 - badgeWidth / 2;
        const rawBadgeY = splitHorizontally
            ? this._hoveredTile.y + this._hoveredTile.height / 2 - badgeHeight / 2
            : split.coord - badgeHeight / 2;

        const clampedX = Math.round(
            Math.min(Math.max(rawBadgeX, 8), Math.max(8, parentW - badgeWidth - 8)),
        );
        const clampedY = Math.round(
            Math.min(Math.max(rawBadgeY, 8), Math.max(8, parentH - badgeHeight - 8)),
        );
        this._badge.set_position(clampedX, clampedY);
    }

    private _onDestroy() {
        GLib.Source.remove(this._hoverTimer);
        this._hoveredTile = null;
        this._badge.destroy();
    }
}
