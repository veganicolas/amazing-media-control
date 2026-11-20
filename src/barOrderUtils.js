export const DEFAULT_BAR_ORDER = ['app-logo', 'title', 'spectrum', 'controls'];

export function normalizeBarOrder(order) {
    const out = [];
    if (Array.isArray(order)) {
        for (const rawItem of order) {
            const item = rawItem === 'logo' ? 'app-logo' : rawItem;
            if (DEFAULT_BAR_ORDER.includes(item) && !out.includes(item))
                out.push(item);
        }
    }
    for (const item of DEFAULT_BAR_ORDER) {
        if (!out.includes(item))
            out.push(item);
    }
    return out;
}
