export interface OutlineSettings {
    enableListOutline: boolean;
    enableHeadingOutline: boolean;
    enableHeadingDock: boolean;
    headingOutlineDisplayMode: "compact" | "icon";
    headingListDepth: number;
    listOutlineRequireChildren: boolean;
    defaultDepth: number;
}

export const MAX_DEPTH = 20;
export const getDefaultSettings = (): OutlineSettings => ({
    enableListOutline: true,
    enableHeadingOutline: true,
    enableHeadingDock: false,
    headingOutlineDisplayMode: "compact",
    headingListDepth: 0,
    listOutlineRequireChildren: false,
    defaultDepth: 3,
});

export function normalizeSettings(value: Partial<OutlineSettings> & { headingIncludeLists?: boolean } = {}): OutlineSettings {
    const defaults = getDefaultSettings();
    const integer = (input: unknown, fallback: number, max: number) => {
        const number = Number(input);
        return Number.isFinite(number) && number >= 1 ? Math.min(max, Math.floor(number)) : fallback;
    };
    const headingListDepth = value.headingListDepth === undefined
        ? (value.headingIncludeLists ? integer(value.defaultDepth, defaults.defaultDepth, MAX_DEPTH) : defaults.headingListDepth)
        : Math.max(0, integer(value.headingListDepth, defaults.headingListDepth, MAX_DEPTH));
    return {
        enableListOutline: typeof value.enableListOutline === "boolean" ? value.enableListOutline : defaults.enableListOutline,
        enableHeadingOutline: typeof value.enableHeadingOutline === "boolean" ? value.enableHeadingOutline : defaults.enableHeadingOutline,
        enableHeadingDock: typeof value.enableHeadingDock === "boolean" ? value.enableHeadingDock : defaults.enableHeadingDock,
        headingOutlineDisplayMode: value.headingOutlineDisplayMode === "icon" ? "icon" : defaults.headingOutlineDisplayMode,
        headingListDepth,
        listOutlineRequireChildren: typeof value.listOutlineRequireChildren === "boolean" ? value.listOutlineRequireChildren : defaults.listOutlineRequireChildren,
        defaultDepth: integer(value.defaultDepth, defaults.defaultDepth, MAX_DEPTH),
    };
}
