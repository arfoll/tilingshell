const GRID_STEP = 0.05; // 5% screen increments
const SCREEN_FRACTIONS = [1 / 3, 2 / 3];
const SPAN_FRACTIONS = [0.25, 1 / 3, 0.5, 2 / 3, 0.75];

export function roundRatio(value: number): number {
    const rounded4 = Math.round(value * 10000) / 10000;
    const rounded2 = Math.round(value * 100) / 100;
    if (Math.abs(rounded4 - rounded2) < 0.0005) return rounded2;
    return rounded4;
}

export function formatPercentage(ratio: number): string {
    const pct = ratio * 100;
    const roundedInt = Math.round(pct);
    if (Math.abs(pct - roundedInt) < 0.08) return `${roundedInt}%`;

    const oneDec = Math.round(pct * 10) / 10;
    return `${oneDec}%`;
}

export function snapRatio(params: {
    rawRatio: number;
    minRatio: number;
    maxRatio: number;
    spanStart: number;
    spanEnd: number;
    extraStops?: number[];
    freehand?: boolean;
}): number {
    const {
        rawRatio,
        minRatio,
        maxRatio,
        spanStart,
        spanEnd,
        extraStops = [],
        freehand = false,
    } = params;

    const clamped = Math.min(Math.max(rawRatio, minRatio), maxRatio);
    if (freehand) return roundRatio(clamped);

    const candidates: number[] = [];

    // 5% screen grid (naturally includes 25%, 50%, 75%)
    for (let i = 1; i < 20; i++) {
        candidates.push(roundRatio(i * GRID_STEP));
    }

    // Exact screen thirds
    for (const frac of SCREEN_FRACTIONS) {
        candidates.push(roundRatio(frac));
    }

    // Stops relative to the tile or combined span (halves, thirds, quarters)
    const spanSize = spanEnd - spanStart;
    if (spanSize > 0) {
        for (const frac of SPAN_FRACTIONS) {
            candidates.push(roundRatio(spanStart + spanSize * frac));
        }
    }

    // Additional context stops (e.g. matching neighbor tile sizes or midpoints)
    for (const stop of extraStops) {
        candidates.push(roundRatio(stop));
    }

    const eps = 1e-6;
    let bestStop: number | null = null;
    let bestDist = Number.POSITIVE_INFINITY;

    for (const stop of candidates) {
        if (stop < minRatio - eps || stop > maxRatio + eps) continue;
        const clampedStop = Math.min(Math.max(stop, minRatio), maxRatio);
        const dist = Math.abs(clampedStop - clamped);
        if (dist < bestDist) {
            bestDist = dist;
            bestStop = roundRatio(clampedStop);
        }
    }

    if (bestStop !== null) return bestStop;

    const midpoint = roundRatio((spanStart + spanEnd) / 2);
    if (midpoint >= minRatio && midpoint <= maxRatio) return midpoint;

    return roundRatio(clamped);
}

export function computeEqualSplits(
    start: number,
    size: number,
    count: number,
): { start: number; size: number }[] {
    const boundaries: number[] = [roundRatio(start)];
    for (let i = 1; i < count; i++) {
        boundaries.push(roundRatio(start + (size * i) / count));
    }
    boundaries.push(roundRatio(start + size));

    const segments: { start: number; size: number }[] = [];
    for (let i = 0; i < count; i++) {
        segments.push({
            start: boundaries[i],
            size: roundRatio(boundaries[i + 1] - boundaries[i]),
        });
    }
    return segments;
}
