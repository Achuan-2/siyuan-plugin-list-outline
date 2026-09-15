export interface OutlineSettings {
    defaultDepth: number;
    maxTextLength: number;
}

export const MAX_DEPTH = 20;
export const getDefaultSettings = (): OutlineSettings => ({ defaultDepth: 3, maxTextLength: 20 });

export function normalizeSettings(value: Partial<OutlineSettings> = {}): OutlineSettings {
    const defaults = getDefaultSettings();
    const integer = (input: unknown, fallback: number, max: number) => {
        const number = Number(input);
        return Number.isFinite(number) && number >= 1 ? Math.min(max, Math.floor(number)) : fallback;
    };
    return {
        defaultDepth: integer(value.defaultDepth, defaults.defaultDepth, MAX_DEPTH),
        maxTextLength: integer(value.maxTextLength, defaults.maxTextLength, 200),
    };
}
