export interface OutlineSettings {
    enableListOutline: boolean;
    enableHeadingOutline: boolean;
    headingIncludeLists: boolean;
    listOutlineRequireChildren: boolean;
    defaultDepth: number;
}

export const MAX_DEPTH = 20;
export const getDefaultSettings = (): OutlineSettings => ({
    enableListOutline: true,
    enableHeadingOutline: true,
    headingIncludeLists: false,
    listOutlineRequireChildren: false,
    defaultDepth: 3,
});

export function normalizeSettings(value: Partial<OutlineSettings> = {}): OutlineSettings {
    const defaults = getDefaultSettings();
    const integer = (input: unknown, fallback: number, max: number) => {
        const number = Number(input);
        return Number.isFinite(number) && number >= 1 ? Math.min(max, Math.floor(number)) : fallback;
    };
    return {
        enableListOutline: typeof value.enableListOutline === "boolean" ? value.enableListOutline : defaults.enableListOutline,
        enableHeadingOutline: typeof value.enableHeadingOutline === "boolean" ? value.enableHeadingOutline : defaults.enableHeadingOutline,
        headingIncludeLists: typeof value.headingIncludeLists === "boolean" ? value.headingIncludeLists : defaults.headingIncludeLists,
        listOutlineRequireChildren: typeof value.listOutlineRequireChildren === "boolean" ? value.listOutlineRequireChildren : defaults.listOutlineRequireChildren,
        defaultDepth: integer(value.defaultDepth, defaults.defaultDepth, MAX_DEPTH),
    };
}
