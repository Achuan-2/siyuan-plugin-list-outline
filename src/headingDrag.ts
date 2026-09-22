import type { HeadingEntry } from "./headingTree";

export type HeadingDropPosition = "before" | "inside" | "after";

export interface HeadingMoveOperation {
    action: "moveOutlineHeading";
    id: string;
    previousID?: string;
    parentID?: string;
}

export interface ListUpdateOperation {
    action: "update";
    id: string;
    data: string;
}

export type OutlineMoveOperation = HeadingMoveOperation | ListUpdateOperation;

export interface HeadingMovePlan {
    operation: HeadingMoveOperation;
    undoOperation: HeadingMoveOperation;
}

export interface ListItemMovePlan {
    operations: ListUpdateOperation[];
    undoOperations: ListUpdateOperation[];
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

const LIST_SELECTOR = '[data-type="NodeList"][data-node-id]';
const LIST_ITEM_SELECTOR = '[data-type="NodeListItem"][data-node-id]';
const EMBED_SELECTOR = '[data-type="NodeBlockQueryEmbed"]';

function findListItem(root: Element, id: string) {
    return Array.from(root.querySelectorAll<HTMLElement>(LIST_ITEM_SELECTOR))
        .find(item => item.dataset.nodeId === id && !item.closest(EMBED_SELECTOR));
}

function directListItems(list: Element) {
    return Array.from(list.children).filter(child => child.matches(LIST_ITEM_SELECTOR)) as HTMLElement[];
}

function directChildLists(item: Element) {
    return Array.from(item.children).filter(child => child.matches(LIST_SELECTOR)) as HTMLElement[];
}

function rootList(item: Element, root: Element) {
    let list = item.parentElement?.closest<HTMLElement>(LIST_SELECTOR) || null;
    let result = list;
    while (list) {
        const parent = list.parentElement?.closest<HTMLElement>(LIST_SELECTOR) || null;
        if (!parent || !root.contains(parent)) break;
        result = parent;
        list = parent;
    }
    return result;
}

function previousListItem(item: Element) {
    let previous = item.previousElementSibling;
    while (previous && !previous.matches(LIST_ITEM_SELECTOR)) previous = previous.previousElementSibling;
    return previous as HTMLElement | null;
}

function listSubtype(list: Element) {
    const subtype = list.getAttribute("data-subtype") || "u";
    return ["u", "o", "t"].includes(subtype) ? subtype : "u";
}

function insertBeforeAttributes(parent: Element, child: Element) {
    const attributes = Array.from(parent.children)
        .find(element => element.classList.contains("protyle-attr"));
    if (attributes) attributes.before(child);
    else parent.append(child);
}

function orderedListStart(list: Element) {
    const marker = directListItems(list)[0]?.getAttribute("data-marker") || "1";
    const start = Number.parseInt(marker, 10);
    return Number.isFinite(start) ? start : 1;
}

function renumberOrderedList(list: Element, start = orderedListStart(list)) {
    if (listSubtype(list) !== "o") return;
    const items = directListItems(list);
    items.forEach((item, index) => {
        const marker = `${start + index}.`;
        item.setAttribute("data-marker", marker);
        const action = Array.from(item.children).find(child => child.classList.contains("protyle-action--order"));
        if (action) action.textContent = marker;
    });
}

/** 当前编辑器中存在的普通列表项才允许从 Dock 发起拖动。 */
export function canDragListItem(root: Element, id: string) {
    return !!findListItem(root, id);
}

/**
 * 将列表 update 事务先同步到当前编辑器 DOM，避免等待后端回写期间大纲和正文短暂错位。
 * 调用方可在事务提交失败时传入 undoOperations 原样回滚。
 */
export function applyListUpdateOperations(content: HTMLElement, operations: OutlineMoveOperation[]) {
    const replacements = operations.flatMap(operation => {
        if (operation.action !== "update") return [];
        const current = Array.from(content.querySelectorAll<HTMLElement>(LIST_SELECTOR))
            .find(list => list.dataset.nodeId === operation.id && !list.closest(EMBED_SELECTOR));
        const template = content.ownerDocument.createElement("template");
        template.innerHTML = operation.data.trim();
        const replacement = template.content.firstElementChild;
        if (!current || !(replacement instanceof HTMLElement)) {
            throw new Error(`无法在当前编辑器中更新列表 ${operation.id}`);
        }
        return [{ current, replacement }];
    });
    replacements.forEach(({ current, replacement }) => current.replaceWith(replacement));
}

/**
 * 在 BlockDOM 副本中移动列表项，并生成可撤销的根列表 update 事务。
 * 同一根列表支持排序、缩进和取消缩进；不同根列表在源列表仍非空时也可移动。
 */
export function createListItemMovePlan(
    root: Element,
    sourceID: string,
    targetID: string,
    position: HeadingDropPosition,
    newNodeID: () => string,
): ListItemMovePlan | null {
    if (sourceID === targetID) return null;
    const source = findListItem(root, sourceID);
    const target = findListItem(root, targetID);
    if (!source || !target || source.contains(target)) return null;
    const sourceRoot = rootList(source, root);
    const targetRoot = rootList(target, root);
    if (!sourceRoot?.dataset.nodeId || !targetRoot?.dataset.nodeId) return null;

    const sameRoot = sourceRoot === targetRoot;
    const sourceRootClone = sourceRoot.cloneNode(true) as HTMLElement;
    const targetRootClone = sameRoot ? sourceRootClone : targetRoot.cloneNode(true) as HTMLElement;
    const sourceClone = findListItem(sourceRootClone, sourceID);
    const targetClone = findListItem(targetRootClone, targetID);
    if (!sourceClone || !targetClone) return null;
    const sourceParent = sourceClone.parentElement;
    const targetParent = targetClone.parentElement;
    if (!sourceParent?.matches(LIST_SELECTOR) || !targetParent?.matches(LIST_SELECTOR)) return null;

    const subtype = listSubtype(sourceParent);
    const sourceStart = orderedListStart(sourceParent);
    const targetStart = orderedListStart(targetParent);
    let destination: HTMLElement = targetParent;
    let destinationStart = targetStart;
    if (position === "before" || position === "after") {
        if (listSubtype(targetParent) !== subtype) return null;
        if (sourceParent === targetParent &&
            (position === "before" ? previousListItem(targetClone) === sourceClone :
                previousListItem(sourceClone) === targetClone)) return null;
        if (position === "before") targetClone.before(sourceClone);
        else targetClone.after(sourceClone);
    } else {
        const childList = directChildLists(targetClone).find(list => listSubtype(list) === subtype);
        if (childList) {
            destination = childList;
            destinationStart = orderedListStart(childList);
        } else {
            const listID = newNodeID();
            if (!listID) return null;
            destination = root.ownerDocument.createElement("div");
            destination.className = "list";
            destination.dataset.type = "NodeList";
            destination.dataset.subtype = subtype;
            destination.dataset.nodeId = listID;
            const attributes = root.ownerDocument.createElement("div");
            attributes.className = "protyle-attr";
            attributes.setAttribute("contenteditable", "false");
            attributes.textContent = "\u200b";
            destination.append(attributes);
            insertBeforeAttributes(targetClone, destination);
            destinationStart = 1;
        }
        if (sourceParent === destination && directListItems(destination).at(-1) === sourceClone) {
            return null;
        }
        insertBeforeAttributes(destination, sourceClone);
    }

    if (!directListItems(sourceParent).length) {
        if (sourceParent === sourceRootClone) return null;
        sourceParent.remove();
    } else {
        renumberOrderedList(sourceParent, sourceStart);
    }
    renumberOrderedList(destination, sourceParent === destination ? sourceStart : destinationStart);

    if (sameRoot) {
        return {
            operations: [{ action: "update", id: sourceRoot.dataset.nodeId, data: sourceRootClone.outerHTML }],
            undoOperations: [{ action: "update", id: sourceRoot.dataset.nodeId, data: sourceRoot.outerHTML }],
        };
    }
    return {
        operations: [
            { action: "update", id: sourceRoot.dataset.nodeId, data: sourceRootClone.outerHTML },
            { action: "update", id: targetRoot.dataset.nodeId, data: targetRootClone.outerHTML },
        ],
        undoOperations: [
            { action: "update", id: targetRoot.dataset.nodeId, data: targetRoot.outerHTML },
            { action: "update", id: sourceRoot.dataset.nodeId, data: sourceRoot.outerHTML },
        ],
    };
}
