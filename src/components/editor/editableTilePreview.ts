import TilePreview from '../tilepreview/tilePreview';
import { GObject, St, Clutter, Mtk } from '../../gi/ext';
import Tile from '../layout/Tile';
import Slider from './slider';
import TileUtils from '../layout/TileUtils';
import { registerGObjectClass } from '../../utils/gjs';
import { buildTileGaps } from '../../utils/ui';
import { widgetOrientation } from '../../utils/gnomesupport';
import { formatPercentage, roundRatio } from './snapUtils';

export default class EditableTilePreview extends TilePreview {
    static { registerGObjectClass(this, {
        Signals: {
            'size-changed': {
                param_types: [Mtk.Rectangle.$gtype, Mtk.Rectangle.$gtype], // oldSize, newSize
            },
            'split-equal': {
                param_types: [GObject.TYPE_BOOLEAN, GObject.TYPE_INT], // horizontal, count
            },
        },
        GTypeName: 'EditableTilePreview',
    })};

    public static MIN_TILE_SIZE: number = 140;

    private readonly _btn: St.Button;
    private readonly _overlayBox: St.BoxLayout;
    private readonly _sizeLabel: St.Label;
    private readonly _actionsBox: St.BoxLayout;
    private readonly _splitH2Btn: St.Button;
    private readonly _splitH3Btn: St.Button;
    private readonly _splitV2Btn: St.Button;
    private readonly _splitV3Btn: St.Button;
    private readonly _containerRect: Mtk.Rectangle;

    private _sliders: (Slider | null)[];
    private _signals: (number | null)[];

    constructor(params: {
        tile: Tile;
        containerRect: Mtk.Rectangle;
        parent?: Clutter.Actor;
        rect?: Mtk.Rectangle;
        gaps?: Clutter.Margin;
    }) {
        super(params);
        this.add_style_class_name('editable-tile-preview');
        this._tile = params.tile;
        this._containerRect = params.containerRect;
        this._sliders = [null, null, null, null];
        this._signals = [null, null, null, null];
        this._btn = new St.Button({
            styleClass: 'editable-tile-preview-button',
            xExpand: true,
            trackHover: true,
        });
        this.add_child(this._btn);
        this._btn.set_size(this.innerWidth, this.innerHeight);
        // handle both left and right clicks
        this._btn.set_button_mask(St.ButtonMask.ONE | St.ButtonMask.THREE);

        this._overlayBox = new St.BoxLayout({
            styleClass: 'editable-tile-overlay',
            reactive: false,
            xAlign: Clutter.ActorAlign.CENTER,
            yAlign: Clutter.ActorAlign.CENTER,
            ...widgetOrientation(true),
        });
        this._overlayBox.set_size(this.innerWidth, this.innerHeight);
        this.add_child(this._overlayBox);

        this._sizeLabel = new St.Label({
            styleClass: 'editable-tile-size-label',
            reactive: false,
            xAlign: Clutter.ActorAlign.CENTER,
        });
        this._overlayBox.add_child(this._sizeLabel);

        this._actionsBox = new St.BoxLayout({
            styleClass: 'editable-tile-actions',
            reactive: false,
            xAlign: Clutter.ActorAlign.CENTER,
            ...widgetOrientation(false),
        });
        this._overlayBox.add_child(this._actionsBox);

        this._splitH2Btn = this._buildSplitActionButton('½ ↔', true, 2);
        this._splitH3Btn = this._buildSplitActionButton('⅓ ↔', true, 3);
        this._splitV2Btn = this._buildSplitActionButton('½ ↕', false, 2);
        this._splitV3Btn = this._buildSplitActionButton('⅓ ↕', false, 3);
        this._actionsBox.add_child(this._splitH2Btn);
        this._actionsBox.add_child(this._splitH3Btn);
        this._actionsBox.add_child(this._splitV2Btn);
        this._actionsBox.add_child(this._splitV3Btn);

        this._updateLabelText();

        this.connect('destroy', this._onDestroy.bind(this));
    }

    private _buildSplitActionButton(
        label: string,
        horizontal: boolean,
        count: number,
    ): St.Button {
        const btn = new St.Button({
            label,
            styleClass: 'editable-tile-action-button',
            reactive: true,
            trackHover: true,
            canFocus: false,
        });
        btn.connect('clicked', () => {
            this.emit('split-equal', horizontal, count);
        });
        return btn;
    }

    public override set gaps(newGaps: Clutter.Margin) {
        super.gaps = newGaps;
        this.updateBorderRadius(
            this._gaps.top > 0,
            this._gaps.right > 0,
            this._gaps.bottom > 0,
            this._gaps.left > 0,
        );
    }

    public getSlider(side: St.Side): Slider | null {
        return this._sliders[side];
    }

    public getAllSliders(): (Slider | null)[] {
        return [...this._sliders];
    }

    public get hover(): boolean {
        return this._btn.hover;
    }

    public addSlider(slider: Slider, side: St.Side) {
        // if there were another slider on that side, disconnect the signal
        const sig = this._signals[side];
        if (sig) this._sliders[side]?.disconnect(sig);

        // add this slider
        this._sliders[side] = slider;
        this._signals[side] = slider.connect('slide', () =>
            this._onSliderMove(side),
        );

        // update tile's groups
        this._tile.groups = [];
        this._sliders.forEach((sl) => sl && this._tile.groups.push(sl.groupId));
    }

    public removeSlider(side: St.Side) {
        if (this._sliders[side] === null) return;

        // disconnect signals
        const sig = this._signals[side];
        if (sig) this._sliders[side]?.disconnect(sig);

        // remove slider
        this._sliders[side] = null;

        // update tile's groups
        this._tile.groups = [];
        this._sliders.forEach((sl) => sl && this._tile.groups.push(sl.groupId));
    }

    public updateTile({
        x,
        y,
        width,
        height,
        innerGaps,
        outerGaps,
    }: {
        x: number;
        y: number;
        width: number;
        height: number;
        innerGaps?: Clutter.Margin;
        outerGaps?: Clutter.Margin;
    }) {
        const oldSize = this._rect.copy();
        this._tile.x = roundRatio(x);
        this._tile.y = roundRatio(y);
        this._tile.width = roundRatio(width);
        this._tile.height = roundRatio(height);
        this._rect = TileUtils.apply_props(this._tile, this._containerRect);
        if (innerGaps && outerGaps) {
            this.gaps = buildTileGaps(
                this._rect,
                innerGaps,
                outerGaps,
                this._containerRect,
            ).gaps;
        }

        this.set_size(this.innerWidth, this.innerHeight);
        this.set_position(this.innerX, this.innerY);

        this._btn.set_size(this.width, this.height);
        this._overlayBox.set_size(this.width, this.height);
        this._updateLabelText();

        const newSize = this._rect.copy();
        this.emit('size-changed', oldSize, newSize);
    }

    public connect(_id: string, _callback: (..._args: any[]) => any): number;
    public connect(_signal: 'size-changed', _callback: (_source: this, _oldSize: Mtk.Rectangle, _newSize: Mtk.Rectangle) => void): number;
    public connect(_signal: 'split-equal', _callback: (_source: this, _horizontal: boolean, _count: number) => void): number;
    public connect(_signal: 'notify::hover', _callback: (_source: this) => void): number;
    public connect(_signal: 'clicked', _callback: (_source: this, _clicked_button: number) => void): number;
    public connect(signal: string, callback: never): number {
        if (
            signal === 'clicked' ||
            signal === 'notify::hover' ||
            signal === 'motion-event'
        )
            return this._btn.connect(signal, callback);

        return super.connect(signal, callback);
    }

    private _updateLabelText() {
        this._sizeLabel.text = `${formatPercentage(this._tile.width)} × ${formatPercentage(this._tile.height)}`;

        const canH2 = this._rect.width / 2 >= EditableTilePreview.MIN_TILE_SIZE;
        const canH3 = this._rect.width / 3 >= EditableTilePreview.MIN_TILE_SIZE;
        const canV2 = this._rect.height / 2 >= EditableTilePreview.MIN_TILE_SIZE;
        const canV3 = this._rect.height / 3 >= EditableTilePreview.MIN_TILE_SIZE;

        this._splitH2Btn.visible = canH2;
        this._splitH3Btn.visible = canH3;
        this._splitV2Btn.visible = canV2;
        this._splitV3Btn.visible = canV3;

        const hasRoom = this.innerWidth >= 150 && this.innerHeight >= 90;
        this._actionsBox.visible =
            hasRoom && (canH2 || canH3 || canV2 || canV3);
    }

    private _onSliderMove(side: St.Side) {
        const slider = this._sliders[side];
        if (slider === null) return;

        const pos = slider.ratio;
        switch (side) {
            case St.Side.TOP:
                this._tile.height = roundRatio(
                    this._tile.height + this._tile.y - pos,
                );
                this._tile.y = pos;
                break;
            case St.Side.RIGHT:
                this._tile.width = roundRatio(pos - this._tile.x);
                break;
            case St.Side.BOTTOM:
                this._tile.height = roundRatio(pos - this._tile.y);
                break;
            case St.Side.LEFT:
                this._tile.width = roundRatio(
                    this._tile.width + this._tile.x - pos,
                );
                this._tile.x = pos;
                break;
        }

        this.updateTile({ ...this._tile });
    }

    private _onDestroy(): void {
        this._signals.forEach(
            (id, side) => id && this._sliders[side]?.disconnect(id),
        );
    }
}
