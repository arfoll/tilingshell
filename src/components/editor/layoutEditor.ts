import { registerGObjectClass } from '../../utils/gjs';
import { GObject, St, Clutter, Mtk, Meta, Shell } from '../../gi/ext';
import Settings from '../../settings/settings';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import {
    buildMargin,
    buildRectangle,
    buildTileGaps,
    enableScalingFactorSupport,
    getMonitorScalingFactor,
    getWindowsOfMonitor,
} from '../../utils/ui';
import Layout from '../layout/Layout';
import TileUtils from '../layout/TileUtils';
import Slider from './slider';
import EditableTilePreview from './editableTilePreview';
import Tile from '../layout/Tile';
import HoverLine, { SplitPreviewInfo } from './hoverLine';
import { Monitor } from 'resource:///org/gnome/shell/ui/layout.js';
import { getEventCoords } from '../../utils/gnomesupport';
import { computeEqualSplits, roundRatio, snapRatio } from './snapUtils';

export default class LayoutEditor extends St.Widget {
    static { registerGObjectClass(this) }
    
    private _layout: Layout;
    private _containerRect: Mtk.Rectangle;
    private _innerGaps: Clutter.Margin;
    private _outerGaps: Clutter.Margin;
    private _hoverWidget: HoverLine;
    private _sliders: Slider[];

    private _minimizedWindows: Meta.Window[];

    constructor(layout: Layout, monitor: Monitor, enableScaling: boolean) {
        super({ styleClass: 'layout-editor' });

        Main.layoutManager.addChrome(this);
        global.windowGroup.bind_property(
            'visible',
            this,
            'visible',
            GObject.BindingFlags.DEFAULT,
        );

        if (enableScaling) {
            const scalingFactor = getMonitorScalingFactor(monitor.index);
            enableScalingFactorSupport(this, scalingFactor);
        }

        const workArea = Main.layoutManager.getWorkAreaForMonitor(
            monitor.index,
        );
        this.set_position(workArea.x, workArea.y);
        this.set_size(workArea.width, workArea.height);
        this._innerGaps = buildMargin(Settings.get_inner_gaps());
        this._outerGaps = buildMargin(Settings.get_outer_gaps());
        this._sliders = [];
        this._containerRect = buildRectangle({
            x: 0,
            y: 0,
            width: workArea.width,
            height: workArea.height,
        });

        this._minimizedWindows = getWindowsOfMonitor(monitor).filter(
            (win) => !win.is_hidden(),
        );
        this._minimizedWindows.forEach(
            (win) => win.can_minimize() && win.minimize(),
        );

        this._hoverWidget = new HoverLine(this, this._resolveSplit.bind(this));

        this._layout = layout;
        this._drawEditor();
        this.grab_key_focus();

        this.connect('destroy', this._onDestroy.bind(this));
    }

    public get layout(): Layout {
        return this._layout;
    }

    public set layout(newLayout: Layout) {
        // cleanup
        this.destroy_all_children();
        this._sliders = [];
        this._hoverWidget = new HoverLine(this, this._resolveSplit.bind(this));

        // change layout
        this._layout = newLayout;

        this._drawEditor();
    }

    private _drawEditor() {
        const groups = new Map<number, EditableTilePreview[]>();

        // render layout's tile and group tiles
        this._layout.tiles.forEach((tile) => {
            const rect = TileUtils.apply_props(tile, this._containerRect);
            const prev = this._buildEditableTile(tile, rect);
            tile.groups.forEach((id) => {
                if (!groups.has(id)) groups.set(id, []);
                groups.get(id)?.push(prev);
            });
        });

        // build a slider for each group
        groups.forEach((tiles, groupdId) => {
            // sweep-line algorithm to check if it is a horizontal group
            let lines = tiles
                .flatMap((t) => [
                    {
                        c: Math.round(t.tile.x * 1000) / 1000,
                        exactC: t.tile.x,
                        end: false,
                        r: t.rect.x,
                    },
                    {
                        c: Math.round((t.tile.x + t.tile.width) * 1000) / 1000,
                        exactC: t.tile.x + t.tile.width,
                        end: true,
                        r: t.rect.x + t.rect.width,
                    },
                ])
                .sort((a, b) => (a.c - b.c !== 0 ? a.c - b.c : a.end ? -1 : 1));

            let count = 0;
            let coord = -1;
            let ratio = 0;
            let horizontal = false;
            for (const line of lines) {
                count += line.end ? -1 : 1;
                if (count === 0 && line !== lines[lines.length - 1]) {
                    coord = line.r;
                    ratio = line.exactC;
                    horizontal = true;
                    break;
                }
            }

            if (coord === -1) {
                // sweep-line algorithm to check if it is a vertical group
                lines = tiles
                    .flatMap((t) => [
                        {
                            c: Math.round(t.tile.y * 1000) / 1000,
                            exactC: t.tile.y,
                            end: false,
                            r: t.rect.y,
                        },
                        {
                            c:
                                Math.round((t.tile.y + t.tile.height) * 1000) /
                                1000,
                            exactC: t.tile.y + t.tile.height,
                            end: true,
                            r: t.rect.y + t.rect.height,
                        },
                    ])
                    .sort((a, b) =>
                        a.c - b.c !== 0 ? a.c - b.c : a.end ? -1 : 1,
                    );
                count = 0;
                for (const line of lines) {
                    count += line.end ? -1 : 1;
                    if (count === 0 && line !== lines[lines.length - 1]) {
                        coord = line.r;
                        ratio = line.exactC;
                        break;
                    }
                }
            }
            const slider = this._buildSlider(horizontal, coord, ratio, groupdId);
            this._sliders.push(slider);
            tiles.forEach((editable) => slider.addTile(editable));
        });
    }

    private _buildEditableTile(
        tile: Tile,
        rect: Mtk.Rectangle,
    ): EditableTilePreview {
        const gaps = buildTileGaps(
            rect,
            this._innerGaps,
            this._outerGaps,
            this._containerRect,
        ).gaps;
        const editableTile = new EditableTilePreview({
            parent: this,
            tile,
            containerRect: this._containerRect,
            rect,
            gaps,
        });
        editableTile.open();
        editableTile.connect('clicked', (_, clicked_button: number) => {
            // St.ButtonMask.ONE is left click. 3 is right click (but for some reason St.ButtonMask.THREE is equal to 4, so we cannot use it)
            if (clicked_button === St.ButtonMask.ONE)
                this.splitTile(editableTile);
            else if (clicked_button === 3) this.deleteTile(editableTile);
        });
        editableTile.connect(
            'split-equal',
            (_, horizontal: boolean, count: number) => {
                this.splitTileEqual(editableTile, horizontal, count);
            },
        );
        editableTile.connect('motion-event', (_, event: Clutter.Event) => {
            const [stageX, stageY] = getEventCoords(event);
            this._hoverWidget.handleMouseMove(
                editableTile,
                stageX - this.x,
                stageY - this.y,
            );
            return Clutter.EVENT_PROPAGATE;
        });
        editableTile.connect('notify::hover', () => {
            const [stageX, stageY] = Shell.Global.get().get_pointer();
            this._hoverWidget.handleMouseMove(
                editableTile,
                stageX - this.x,
                stageY - this.y,
            );
        });
        if (this._sliders.length > 0)
            this.set_child_below_sibling(editableTile, this._sliders[0]);
        return editableTile;
    }

    private _getReferenceSizes(horizontal: boolean, excludeTile?: Tile): number[] {
        const sizes: number[] = [];
        for (const tile of this._layout.tiles) {
            if (tile === excludeTile) continue;
            const size = roundRatio(horizontal ? tile.width : tile.height);
            if (size <= 0 || size >= 0.99) continue;
            if (!sizes.some((s) => Math.abs(s - size) < 0.001)) {
                sizes.push(size);
            }
        }
        return sizes;
    }

    private _resolveSplit(
        editableTile: EditableTilePreview,
        x: number,
        y: number,
        splitHorizontally: boolean,
        freehand: boolean,
    ): SplitPreviewInfo | null {
        const tile = editableTile.tile;
        const containerSpan = splitHorizontally
            ? this._containerRect.width
            : this._containerRect.height;
        const tileStart = splitHorizontally ? tile.x : tile.y;
        const tileSize = splitHorizontally ? tile.width : tile.height;
        const tileEnd = roundRatio(tileStart + tileSize);

        const minSizeRatio = EditableTilePreview.MIN_TILE_SIZE / containerSpan;
        const minRatio = tileStart + minSizeRatio;
        const maxRatio = tileEnd - minSizeRatio;
        if (minRatio > maxRatio) return null;

        const rawRatio = (splitHorizontally ? x : y) / containerSpan;
        const refSizes = this._getReferenceSizes(splitHorizontally, tile);
        const extraStops: number[] = [];
        for (const size of refSizes) {
            extraStops.push(tileStart + size);
            extraStops.push(tileEnd - size);
        }

        const ratio = snapRatio({
            rawRatio,
            minRatio,
            maxRatio,
            spanStart: tileStart,
            spanEnd: tileEnd,
            extraStops,
            freehand,
        });

        const prevSizeRatio = roundRatio(ratio - tileStart);
        const nextSizeRatio = roundRatio(tileEnd - ratio);
        if (
            Math.round(prevSizeRatio * containerSpan) <
                EditableTilePreview.MIN_TILE_SIZE ||
            Math.round(nextSizeRatio * containerSpan) <
                EditableTilePreview.MIN_TILE_SIZE
        )
            return null;

        return {
            ratio,
            coord: Math.round(ratio * containerSpan),
            prevSizeRatio,
            nextSizeRatio,
        };
    }

    private _applySplit(
        editableTile: EditableTilePreview,
        newTiles: Tile[],
        splitHorizontally: boolean,
    ) {
        const oldTile = editableTile.tile;
        const index = this._layout.tiles.indexOf(oldTile);
        if (index < 0 || newTiles.length < 2) return;

        const newRects = newTiles.map((t) =>
            TileUtils.apply_props(t, this._containerRect),
        );
        for (const rect of newRects) {
            if (
                rect.height < EditableTilePreview.MIN_TILE_SIZE ||
                rect.width < EditableTilePreview.MIN_TILE_SIZE
            )
                return;
        }

        this._layout.tiles[index] = newTiles[0];
        for (let i = 1; i < newTiles.length; i++) {
            this._layout.tiles.push(newTiles[i]);
        }

        const newEditableTiles = newTiles.map((t, i) =>
            this._buildEditableTile(t, newRects[i]),
        );

        // Create sliders between each adjacent pair of new tiles
        for (let i = 0; i < newEditableTiles.length - 1; i++) {
            const prevEditable = newEditableTiles[i];
            const nextEditable = newEditableTiles[i + 1];
            const sliderRatio = splitHorizontally
                ? nextEditable.tile.x
                : nextEditable.tile.y;
            const sliderCoord = splitHorizontally
                ? nextEditable.rect.x
                : nextEditable.rect.y;
            const slider = this._buildSlider(
                splitHorizontally,
                sliderCoord,
                sliderRatio,
            );
            this._sliders.push(slider);
            slider.addTile(prevEditable);
            slider.addTile(nextEditable);
        }

        const firstEditable = newEditableTiles[0];
        const lastEditable = newEditableTiles[newEditableTiles.length - 1];

        if (splitHorizontally) {
            editableTile
                .getSlider(St.Side.TOP)
                ?.onTileSplit(editableTile, newEditableTiles);
            editableTile
                .getSlider(St.Side.BOTTOM)
                ?.onTileSplit(editableTile, newEditableTiles);
            editableTile
                .getSlider(St.Side.LEFT)
                ?.onTileSplit(editableTile, [firstEditable]);
            editableTile
                .getSlider(St.Side.RIGHT)
                ?.onTileSplit(editableTile, [lastEditable]);
        } else {
            editableTile
                .getSlider(St.Side.LEFT)
                ?.onTileSplit(editableTile, newEditableTiles);
            editableTile
                .getSlider(St.Side.RIGHT)
                ?.onTileSplit(editableTile, newEditableTiles);
            editableTile
                .getSlider(St.Side.TOP)
                ?.onTileSplit(editableTile, [firstEditable]);
            editableTile
                .getSlider(St.Side.BOTTOM)
                ?.onTileSplit(editableTile, [lastEditable]);
        }

        this._hoverWidget.handleTileDestroy(editableTile);
        editableTile.destroy();
    }

    private splitTile(editableTile: EditableTilePreview) {
        const oldTile = editableTile.tile;
        const [x, y, modifier] = global.get_pointer();
        // split horizontally when CTRL is NOT pressed, split vertically instead
        const splitHorizontally =
            (modifier & Clutter.ModifierType.CONTROL_MASK) === 0;
        const freehand = (modifier & Clutter.ModifierType.SHIFT_MASK) !== 0;

        const split = this._resolveSplit(
            editableTile,
            x - this.x,
            y - this.y,
            splitHorizontally,
            freehand,
        );
        if (!split) return;

        const prevTile = new Tile({
            x: oldTile.x,
            y: oldTile.y,
            width: splitHorizontally ? split.prevSizeRatio : oldTile.width,
            height: splitHorizontally ? oldTile.height : split.prevSizeRatio,
            groups: [],
        });

        const nextTile = new Tile({
            x: splitHorizontally ? split.ratio : oldTile.x,
            y: splitHorizontally ? oldTile.y : split.ratio,
            width: splitHorizontally ? split.nextSizeRatio : oldTile.width,
            height: splitHorizontally ? oldTile.height : split.nextSizeRatio,
            groups: [],
        });

        this._applySplit(editableTile, [prevTile, nextTile], splitHorizontally);
    }

    private splitTileEqual(
        editableTile: EditableTilePreview,
        splitHorizontally: boolean,
        count: number,
    ) {
        const oldTile = editableTile.tile;
        const start = splitHorizontally ? oldTile.x : oldTile.y;
        const size = splitHorizontally ? oldTile.width : oldTile.height;
        const segments = computeEqualSplits(start, size, count);

        const newTiles = segments.map(
            (seg) =>
                new Tile({
                    x: splitHorizontally ? seg.start : oldTile.x,
                    y: splitHorizontally ? oldTile.y : seg.start,
                    width: splitHorizontally ? seg.size : oldTile.width,
                    height: splitHorizontally ? oldTile.height : seg.size,
                    groups: [],
                }),
        );

        this._applySplit(editableTile, newTiles, splitHorizontally);
    }

    private deleteTile(editableTile: EditableTilePreview) {
        for (const slider of editableTile.getAllSliders()) {
            if (slider === null) continue;

            const success = slider.deleteSlider(
                editableTile,
                this._innerGaps,
                this._outerGaps,
            );
            if (success) {
                this._layout.tiles = this._layout.tiles.filter(
                    (tile) => tile !== editableTile.tile,
                );
                this._sliders = this._sliders.filter((sl) => sl !== slider);
                this._hoverWidget.handleTileDestroy(editableTile);
                editableTile.destroy();
                slider.destroy();
                return;
            }
        }
    }

    private _buildSlider(
        isHorizontal: boolean,
        coord: number,
        ratio: number,
        groupId?: number,
    ): Slider {
        if (!groupId) {
            const groups = this._sliders.map((slider) => slider.groupId).sort();
            groupId = groups.length === 0 ? 1 : groups[groups.length - 1] + 1;
            for (let i = 1; i < groups.length; i++) {
                if (groups[i - 1] + 1 < groups[i]) {
                    groupId = groups[i - 1] + 1;
                    break;
                }
            }
        }
        return new Slider(
            this,
            groupId,
            coord,
            coord,
            isHorizontal,
            this._containerRect,
            ratio,
            (horiz) => this._getReferenceSizes(horiz),
        );
    }

    private _onDestroy() {
        this._minimizedWindows.forEach((win) => win.unminimize());

        this.destroy_all_children();
        this._sliders = [];

        super.destroy();
    }
}
