import { registerGObjectClass } from '../../utils/gjs';
import { GObject, GLib, St, Clutter, Mtk, Meta } from '../../gi/ext';
import EditableTilePreview from './editableTilePreview';
import { getScalingFactorOf } from '../../utils/ui';
import { getEventCoords } from '../../utils/gnomesupport';
import { roundRatio, snapRatio } from './snapUtils';

const DOUBLE_CLICK_USEC = 350000; // 350ms

export default class Slider extends St.Button {
    static { registerGObjectClass(this, {
        Signals: {
            slide: {
                param_types: [GObject.TYPE_INT], // movement
            },
        },
        GTypeName: 'Slider',
    })};

    private readonly _sliderSize: number = 48;
    private readonly _groupId: number;
    private readonly _signals: Map<EditableTilePreview, number[]>;
    private readonly _containerRect: Mtk.Rectangle;
    private readonly _getReferenceSizes?: (_horizontal: boolean) => number[];

    private _dragging: boolean;
    private _grab: any;
    private _horizontalDir: boolean;
    private _ratio: number;
    private _dragOffset: number;
    private _lastPressTime: number;

    private _previousTiles: EditableTilePreview[];
    private _nextTiles: EditableTilePreview[];
    private _minTileCoord: number;
    private _maxTileCoord: number;
    private _scalingFactor: number;

    constructor(
        parent: Clutter.Actor,
        groupId: number,
        x: number,
        y: number,
        horizontal: boolean,
        containerRect: Mtk.Rectangle,
        initialRatio: number,
        getReferenceSizes?: (_horizontal: boolean) => number[],
    ) {
        super({
            styleClass: 'layout-editor-slider',
            canFocus: true,
            xExpand: false,
            trackHover: true,
        });
        parent.add_child(this);

        this._signals = new Map<EditableTilePreview, number[]>();

        this._groupId = groupId;
        this._horizontalDir = horizontal;
        this._containerRect = containerRect;
        this._ratio = roundRatio(initialRatio);
        this._getReferenceSizes = getReferenceSizes;

        const [, scalingFactor] = getScalingFactorOf(this);
        this._scalingFactor = scalingFactor;
        this.set_width(this.desiredWidth);
        this.set_height(this.desiredHeight);

        this._previousTiles = [];
        this._nextTiles = [];
        this._minTileCoord = Number.MAX_VALUE;
        this._maxTileCoord = Number.MIN_VALUE;

        this._dragging = false;
        this._dragOffset = 0;
        this._lastPressTime = 0;
        this.set_position(
            Math.round(Math.round(x - this.width / 2)),
            Math.round(y - this.height / 2),
        );

        this.connect('notify::hover', () => this._setPreferredCursor());
        this.connect('destroy', this._onDestroy.bind(this));
    }

    public get groupId(): number {
        return this._groupId;
    }

    public get ratio(): number {
        return this._ratio;
    }

    private get _containerSpan(): number {
        return this._horizontalDir
            ? this._containerRect.width
            : this._containerRect.height;
    }

    private get desiredWidth(): number {
        return (
            (this._horizontalDir ? 12 : this._sliderSize) * this._scalingFactor
        );
    }

    private get desiredHeight(): number {
        return (
            (this._horizontalDir ? this._sliderSize : 12) * this._scalingFactor
        );
    }

    private get preferredCursor(): Meta.Cursor {
        // These constants were renamed in Gnome 48 from NORTH/WEST_* to N/W_*
        // @ts-expect-error "WEST_RESIZE is valid for GNOME < 48"
        const horizCursor = Meta.Cursor.WEST_RESIZE ?? Meta.Cursor.W_RESIZE;
        // @ts-expect-error "NORTH_RESIZE is valid for GNOME < 48"
        const vertCursor = Meta.Cursor.NORTH_RESIZE ?? Meta.Cursor.N_RESIZE;

        return this.hover || this._dragging
            ? this._horizontalDir
                ? horizCursor
                : vertCursor
            : Meta.Cursor.DEFAULT;
    }

    private _setPreferredCursor(): void {
        if ('set_cursor_type' in this) {
            // @ts-expect-error "CursorType is available on GNOME 51+"
            const CursorType = Clutter.CursorType;
            const cursor =
                this.hover || this._dragging
                    ? this._horizontalDir
                        ? CursorType.W_RESIZE
                        : CursorType.N_RESIZE
                    : CursorType.DEFAULT;
            // @ts-expect-error "set_cursor_type is available on GNOME 51+"
            this.set_cursor_type(cursor);
        } else {
            global.display.set_cursor(this.preferredCursor);
        }
    }

    public addTile(tile: EditableTilePreview) {
        const isNext = this._horizontalDir
            ? this.x <= tile.rect.x
            : this.y <= tile.rect.y;
        if (isNext) this._nextTiles.push(tile);
        else this._previousTiles.push(tile);

        const side = this._horizontalDir
            ? isNext
                ? St.Side.LEFT
                : St.Side.RIGHT
            : isNext
              ? St.Side.TOP
              : St.Side.BOTTOM;
        tile.addSlider(this, side);

        this._minTileCoord = Math.min(
            this._minTileCoord,
            this._horizontalDir ? tile.rect.y : tile.rect.x,
        );
        this._maxTileCoord = Math.max(
            this._maxTileCoord,
            this._horizontalDir
                ? tile.rect.y + tile.rect.height
                : tile.rect.x + tile.rect.width,
        );

        this._updatePosition();

        this._createTileSignals(tile);
    }

    private _onTileSizeChanged(
        tile: EditableTilePreview,
        oldSize: Mtk.Rectangle,
        newSize: Mtk.Rectangle,
    ) {
        if (this._horizontalDir) {
            if (
                this._minTileCoord !== oldSize.y &&
                this._maxTileCoord !== oldSize.y + oldSize.height
            )
                return;

            if (this._minTileCoord === oldSize.y)
                this._minTileCoord = newSize.y;

            if (this._maxTileCoord === oldSize.y + oldSize.height)
                this._maxTileCoord = newSize.y + newSize.height;
        } else {
            if (
                this._minTileCoord !== oldSize.x &&
                this._maxTileCoord !== oldSize.x + oldSize.width
            )
                return;

            if (this._minTileCoord === oldSize.x)
                this._minTileCoord = newSize.x;

            if (this._maxTileCoord === oldSize.x + oldSize.width)
                this._maxTileCoord = newSize.x + newSize.width;
        }

        this._updatePosition();
    }

    private _updatePosition() {
        this.set_width(this.desiredWidth);
        this.set_height(this.desiredHeight);
        const newCoord = (this._minTileCoord + this._maxTileCoord) / 2;
        if (this._horizontalDir)
            this.set_y(Math.round(newCoord - this.height / 2));
        else this.set_x(Math.round(newCoord - this.width / 2));
    }

    private _onTileDeleted(tile: EditableTilePreview) {
        const isNext = this._horizontalDir
            ? this.x <= tile.rect.x
            : this.y <= tile.rect.y;
        const array = isNext ? this._nextTiles : this._previousTiles;
        const index = array.indexOf(tile, 0);
        if (index >= 0) array.splice(index, 1);

        // remove all the signals related to the tile
        const sig = this._signals.get(tile);
        if (sig) {
            sig.forEach((id) => tile.disconnect(id));
            this._signals.delete(tile);
        }
    }

    public onTileSplit(
        tileToRemove: EditableTilePreview,
        newTiles: EditableTilePreview[],
    ) {
        if (newTiles.length === 0) return;

        const isNext = this._horizontalDir
            ? this.x <= tileToRemove.rect.x
            : this.y <= tileToRemove.rect.y;
        const array = isNext ? this._nextTiles : this._previousTiles;
        // find in the array the tile to remove
        const index = array.indexOf(tileToRemove);
        if (index < 0) return;

        const side = this._horizontalDir
            ? isNext
                ? St.Side.LEFT
                : St.Side.RIGHT
            : isNext
              ? St.Side.TOP
              : St.Side.BOTTOM;

        // remove the signal of the tile to remove
        const sig = this._signals.get(tileToRemove);
        if (sig) {
            sig.forEach((id) => tileToRemove.disconnect(id));
            this._signals.delete(tileToRemove);
        }

        // put the first new tile in place of the tile to remove
        array[index] = newTiles[0];
        newTiles[0].addSlider(this, side);
        this._createTileSignals(newTiles[0]);

        // add all the other tiles
        for (let i = 1; i < newTiles.length; i++) {
            const tile = newTiles[i];
            array.push(tile);
            tile.addSlider(this, side);
            this._createTileSignals(tile);
        }
    }

    private _createTileSignals(tile: EditableTilePreview) {
        if (this._signals.has(tile)) return;

        this._signals.set(tile, []);
        this._signals
            .get(tile)
            ?.push(
                tile.connect(
                    'size-changed',
                    this._onTileSizeChanged.bind(this),
                ),
            );
        this._signals
            .get(tile)
            ?.push(tile.connect('destroy', this._onTileDeleted.bind(this)));
    }

    public deleteSlider(
        tileToDelete: EditableTilePreview,
        innerGaps: Clutter.Margin,
        outerGaps: Clutter.Margin,
    ): boolean {
        const isNext = this._horizontalDir
            ? this.x <= tileToDelete.rect.x
            : this.y <= tileToDelete.rect.y;
        const array = isNext ? this._nextTiles : this._previousTiles;

        if (array.length > 1 || array[0] !== tileToDelete) return false;

        array.pop();

        const oppositeSide = this._horizontalDir
            ? isNext
                ? St.Side.RIGHT
                : St.Side.LEFT
            : isNext
              ? St.Side.BOTTOM
              : St.Side.TOP;
        // extend the tiles on the opposite side of the tile to be deleted
        const extendTilesArray = isNext ? this._previousTiles : this._nextTiles;
        extendTilesArray.forEach((tileToExtend) => {
            tileToExtend.updateTile({
                x:
                    !isNext && this._horizontalDir
                        ? tileToDelete.tile.x
                        : tileToExtend.tile.x,
                y:
                    !isNext && !this._horizontalDir
                        ? tileToDelete.tile.y
                        : tileToExtend.tile.y,
                width: this._horizontalDir
                    ? roundRatio(tileToExtend.tile.width + tileToDelete.tile.width)
                    : tileToExtend.tile.width,
                height: this._horizontalDir
                    ? tileToExtend.tile.height
                    : roundRatio(tileToExtend.tile.height + tileToDelete.tile.height),
                innerGaps,
                outerGaps,
            });
            tileToExtend.removeSlider(oppositeSide);
            tileToDelete.getSlider(oppositeSide)?.addTile(tileToExtend);
        });

        return true;
    }

    private _getBounds(): {
        minRatio: number;
        maxRatio: number;
        spanStart: number;
        spanEnd: number;
        extraStops: number[];
    } {
        const minSizeRatio = EditableTilePreview.MIN_TILE_SIZE / this._containerSpan;
        let spanStart = 0;
        let spanEnd = 1;
        let minRatio = minSizeRatio;
        let maxRatio = 1 - minSizeRatio;

        const prevStarts: number[] = [];
        const nextEnds: number[] = [];

        for (const prevTile of this._previousTiles) {
            const start = this._horizontalDir ? prevTile.tile.x : prevTile.tile.y;
            prevStarts.push(start);
            minRatio = Math.max(minRatio, start + minSizeRatio);
            spanStart = Math.max(spanStart, start);
        }

        for (const nextTile of this._nextTiles) {
            const end = this._horizontalDir
                ? nextTile.tile.x + nextTile.tile.width
                : nextTile.tile.y + nextTile.tile.height;
            nextEnds.push(end);
            maxRatio = Math.min(maxRatio, end - minSizeRatio);
            spanEnd = Math.min(spanEnd, end);
        }

        const extraStops: number[] = [];

        // Midpoints for every adjacent pair (equalizes tiles on both sides)
        for (const start of prevStarts) {
            for (const end of nextEnds) {
                extraStops.push((start + end) / 2);
            }
        }

        // Match existing tile sizes in the layout
        if (this._getReferenceSizes) {
            const refSizes = this._getReferenceSizes(this._horizontalDir);
            for (const size of refSizes) {
                extraStops.push(spanStart + size);
                extraStops.push(spanEnd - size);
            }
        }

        return { minRatio, maxRatio, spanStart, spanEnd, extraStops };
    }

    private _applyRatio(newRatio: number) {
        const rounded = roundRatio(newRatio);
        if (rounded === this._ratio) return;

        const oldCoord = this._horizontalDir
            ? this.x + this.width / 2
            : this.y + this.height / 2;
        const newCoord = Math.round(rounded * this._containerSpan);
        const delta = Math.round(newCoord - oldCoord);

        this._ratio = rounded;
        if (this._horizontalDir) {
            this.set_x(Math.round(newCoord - this.width / 2));
        } else {
            this.set_y(Math.round(newCoord - this.height / 2));
        }

        this.emit('slide', delta);
    }

    private _equalize() {
        const { minRatio, maxRatio, spanStart, spanEnd } = this._getBounds();
        if (minRatio > maxRatio) return;

        const midpoint = roundRatio((spanStart + spanEnd) / 2);
        const clamped = Math.min(Math.max(midpoint, minRatio), maxRatio);
        this._applyRatio(clamped);
    }

    vfunc_button_press_event(event: Clutter.ButtonEvent) {
        const now = GLib.get_monotonic_time();
        if (now - this._lastPressTime <= DOUBLE_CLICK_USEC) {
            this._lastPressTime = 0;
            this._equalize();
            return Clutter.EVENT_STOP;
        }
        this._lastPressTime = now;
        return this._startDragging(event);
    }

    vfunc_button_release_event() {
        if (this._dragging) return this._endDragging();

        return Clutter.EVENT_PROPAGATE;
    }

    vfunc_motion_event(event: Clutter.MotionEvent) {
        if (this._dragging) {
            const [stageX, stageY] = getEventCoords(event);
            const [, , state] = global.get_pointer();
            const freehand = (state & Clutter.ModifierType.SHIFT_MASK) !== 0;
            this._move(stageX, stageY, freehand);
            return Clutter.EVENT_STOP;
        }

        return Clutter.EVENT_PROPAGATE;
    }

    private _startDragging(event: Clutter.ButtonEvent) {
        if (this._dragging) return Clutter.EVENT_PROPAGATE;

        this._dragging = true;
        this.add_style_class_name('layout-editor-slider-dragging');
        this._setPreferredCursor();

        this._grab = global.stage.grab(this);

        const [stageX, stageY] = getEventCoords(event);
        const parent = this.get_parent();
        const localPointer = this._horizontalDir
            ? stageX - (parent ? parent.x : 0)
            : stageY - (parent ? parent.y : 0);
        const sliderCenter = this._horizontalDir
            ? this.x + this.width / 2
            : this.y + this.height / 2;
        this._dragOffset = sliderCenter - localPointer;

        return Clutter.EVENT_STOP;
    }

    private _endDragging() {
        if (this._dragging) {
            if (this._grab) {
                this._grab.dismiss();
                this._grab = null;
            }

            this._dragging = false;
            this._dragOffset = 0;
            this.remove_style_class_name('layout-editor-slider-dragging');
        }
        this._setPreferredCursor();
        return Clutter.EVENT_STOP;
    }

    private _move(eventX: number, eventY: number, freehand: boolean) {
        const parent = this.get_parent();
        const localPointer = this._horizontalDir
            ? eventX - (parent ? parent.x : 0)
            : eventY - (parent ? parent.y : 0);
        const targetCenter = localPointer + this._dragOffset;
        const rawRatio = targetCenter / this._containerSpan;

        const { minRatio, maxRatio, spanStart, spanEnd, extraStops } =
            this._getBounds();
        if (minRatio > maxRatio) return;

        const targetRatio = snapRatio({
            rawRatio,
            minRatio,
            maxRatio,
            spanStart,
            spanEnd,
            extraStops,
            freehand,
        });

        this._applyRatio(targetRatio);
    }

    private _onDestroy(): void {
        this._signals.forEach((ids, tile) =>
            ids.forEach((id) => tile.disconnect(id)),
        );
        this._minTileCoord = Number.MAX_VALUE;
        this._maxTileCoord = Number.MIN_VALUE;
        this._previousTiles = [];
        this._nextTiles = [];
        this._dragOffset = 0;
        this._endDragging();
    }
}
