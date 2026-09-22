import type { HeadingEntry } from "./headingTree";

export type HeadingDropPosition = "before" | "inside" | "after";

export interface HeadingMoveOperation {
    action: "moveOutlineHeading";
    id: string;
    previousID?: string;
    parentID?: string;
}

export interface HeadingMovePlan {
    operation: HeadingMoveOperation;
    undoOperation: HeadingMoveOperation;
}

interface HeadingRelation {
    entry: HeadingEntry;
    parentID?: string;
    previousID?: string;
    nextID?: string;
    lastChildID?: string;
    descendants: Set<string>;
}

function isMovableHeading(entry: HeadingEntry) {
    return (!entry.kind || entry.kind === "heading") && !entry.embedId;
}

/**
 * 将扁平标题列表还原成原生大纲使用的父子/同级关系。
 * 列表项和段落只是插件的附加目录项，不参与标题移动关系计算。
 */
function buildRelations(entries: HeadingEntry[]) {
    const headings = entries.filter(isMovableHeading);
    const relations = new Map<string, HeadingRelation>();
    const stack: HeadingEntry[] = [];
    const lastChildByParent = new Map<string, string>();

    for (const entry of headings) {
        while (stack.length && stack[stack.length - 1].depth >= entry.depth) stack.pop();
        const parentID = stack.at(-1)?.id;
        const parentKey = parentID || "";
        const previousID = lastChildByParent.get(parentKey);
        const relation: HeadingRelation = { entry, parentID, previousID, descendants: new Set() };
        relations.set(entry.id, relation);
        if (previousID) relations.get(previousID)!.nextID = entry.id;
        lastChildByParent.set(parentKey, entry.id);
        if (parentID) relations.get(parentID)!.lastChildID = entry.id;
        for (const ancestor of stack) relations.get(ancestor.id)!.descendants.add(entry.id);
        stack.push(entry);
    }
    return relations;
}

/**
 * 生成与思源原生大纲一致的 moveOutlineHeading 正向/撤销事务。
 * 返回 null 表示目标会形成循环、位置未改变，或源/目标不是普通标题。
 */
export function createHeadingMovePlan(
    entries: HeadingEntry[],
    sourceID: string,
    targetID: string,
    position: HeadingDropPosition,
): HeadingMovePlan | null {
    if (sourceID === targetID) return null;
    const relations = buildRelations(entries);
    const source = relations.get(sourceID);
    const target = relations.get(targetID);
    if (!source || !target || source.descendants.has(targetID)) return null;

    let previousID: string | undefined;
    let parentID: string | undefined;
    if (position === "inside") {
        parentID = targetID;
        previousID = target.lastChildID;
        if (source.parentID === targetID && source.nextID === undefined) return null;
    } else if (position === "before") {
        parentID = target.parentID;
        previousID = target.previousID;
        if (target.previousID === sourceID) return null;
    } else {
        previousID = targetID;
        if (source.previousID === targetID && source.parentID === target.parentID) return null;
    }

    return {
        operation: {
            action: "moveOutlineHeading",
            id: sourceID,
            ...(previousID ? { previousID } : {}),
            ...(parentID ? { parentID } : {}),
        },
        undoOperation: {
            action: "moveOutlineHeading",
            id: sourceID,
            ...(source.previousID ? { previousID: source.previousID } : {}),
            ...(source.parentID ? { parentID: source.parentID } : {}),
        },
    };
}
