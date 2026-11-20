import GLib from 'gi://GLib';

export function easeOutCubic(t) {
    return 1 - Math.pow(1 - t, 3);
}

export function easeOutFade(t, fadePortion = 0.8) {
    const fadeP = Math.min(1, t / fadePortion);
    return 1 - Math.pow(1 - fadeP, 2);
}

export function startTween({
    durationMs,
    frameMs = 16,
    onFrame,
    onComplete = null,
    onCancel = null,
}) {
    let timerId = 0;
    let finished = false;
    const startUs = GLib.get_monotonic_time();

    timerId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, frameMs, () => {
        if (finished) {
            timerId = 0;
            return GLib.SOURCE_REMOVE;
        }
        const elapsedMs = (GLib.get_monotonic_time() - startUs) / 1000;
        const progress = Math.max(0, Math.min(1, elapsedMs / Math.max(1, durationMs)));
        const keepGoing = onFrame(progress);

        if (finished) {
            timerId = 0;
            return GLib.SOURCE_REMOVE;
        }
        if (keepGoing === false) {
            finished = true;
            timerId = 0;
            onCancel?.();
            return GLib.SOURCE_REMOVE;
        }
        if (progress >= 1) {
            finished = true;
            timerId = 0;
            onComplete?.();
            return GLib.SOURCE_REMOVE;
        }
        return GLib.SOURCE_CONTINUE;
    });

    return {
        isActive: () => timerId !== 0 && !finished,
        cancel: () => {
            if (timerId && !finished) {
                finished = true;
                GLib.Source.remove(timerId);
                timerId = 0;
                onCancel?.();
            }
        },
    };
}
