import { blockDepth, DEPTH_ATTRIBUTE, EMBED_RESULT_SELECTOR, extractOutline, findRootLists, OUTLINE_CONTAINER_SELECTOR, OUTLINE_ITEM_SELECTOR,
    type OutlineEntry } from "./outline";

// 对应思源 kernel/model/outline.go：顶层 Path 使用 name/blocks，子级 Block 使用 content/children。
export interface NativeHeading {
    id: string;
    name?: string;
    content?: string;
    nameIsHTML?: boolean;
    subType?: string;
    number?: string;
    blocks?: NativeHeading[];
    children?: NativeHeading[];
}

export interface HeadingEntry extends OutlineEntry {
    level: number;
    /** 所在查询嵌入块，用于点击时定位当前文档里的渲染副本。 */
    embedId?: string;
}

export function getHeadingOutlineTargetSelector(preview: boolean): string {
    return preview
        ? "h1[id],h2[id],h3[id],h4[id],h5[id],h6[id],li[id],p[id]"
        : '[data-type="NodeHeading"][data-node-id], [data-type="NodeListItem"][data-node-id], ' +
            '[data-type="NodeTabItem"][data-node-id], [data-type="NodeParagraph"][data-node-id]';
}

export function findClosestHeadingOutlineTargetId(element: Element, root: Element, ids: ReadonlySet<string>,
    preview: boolean): string {
    const selector = getHeadingOutlineTargetSelector(preview);
    let target = element.closest<HTMLElement>(selector);
    while (target && root.contains(target)) {
        const id = preview ? target.id : target.dataset.nodeId || "";
        if (ids.has(id)) return id;
        target = target.parentElement?.closest<HTMLElement>(selector) || null;
    }
    return "";
}

/** 标题、段落和列表项可以收起它们后方、层级更深的连续条目。 */
export function getCollapsibleEntryIds(entries: HeadingEntry[]): Set<string> {
    const ids = new Set<string>();
    for (let index = 0; index < entries.length - 1; index++) {
        const entry = entries[index];
        const supportsCollapse = !entry.kind || entry.kind === "heading" ||
            entry.kind === "paragraph" || entry.kind === "list";
        if (supportsCollapse && entries[index + 1].depth > entry.depth) ids.add(entry.id);
    }
    return ids;
}

/** 从扁平大纲中过滤掉已折叠条目的所有后代，遇到同级或更高层级时恢复显示。 */
export function filterCollapsedEntries(entries: HeadingEntry[], collapsedIds: ReadonlySet<string>): HeadingEntry[] {
    const visible: HeadingEntry[] = [];
    let hiddenBelowDepth: number | undefined;
    for (const entry of entries) {
        if (hiddenBelowDepth !== undefined) {
            if (entry.depth > hiddenBelowDepth) continue;
            hiddenBelowDepth = undefined;
        }
        visible.push(entry);
        if (collapsedIds.has(entry.id)) hiddenBelowDepth = entry.depth;
    }
    return visible;
}

const EMBED_SELECTOR = '[data-type="NodeBlockQueryEmbed"][data-node-id]';
const PARAGRAPH_SELECTOR = '[data-type="NodeParagraph"][data-node-id]';

/**
 * Kernel 的 BlockDOM 只有嵌入查询语句，不包含前端异步渲染出的查询结果。
 * 将当前编辑器中顶层嵌入块的结果复制到快照，既保留折叠内容，又能按文档顺序提取嵌入列表。
 */
function mergeRenderedEmbeds(document: Document, liveRoot?: Element | null) {
    if (!liveRoot) return;
    const liveEmbeds = Array.from(liveRoot.querySelectorAll<HTMLElement>(EMBED_SELECTOR))
        .filter(embed => !embed.closest(EMBED_RESULT_SELECTOR));
    for (const liveEmbed of liveEmbeds) {
        const id = liveEmbed.dataset.nodeId;
        if (!id) continue;
        const snapshotEmbed = Array.from(document.querySelectorAll<HTMLElement>(EMBED_SELECTOR))
            .find(embed => embed.dataset.nodeId === id);
        if (!snapshotEmbed) continue;
        for (const result of Array.from(liveEmbed.children).filter(child => child.matches(EMBED_RESULT_SELECTOR))) {
            snapshotEmbed.append(result.cloneNode(true));
        }
    }
}

function extractParagraphText(paragraph: HTMLElement): string {
    const content = paragraph.querySelector<HTMLElement>('[contenteditable="true"]');
    const clone = (content || paragraph).cloneNode(true) as HTMLElement;
    clone.querySelectorAll('.protyle-attr, .protyle-action, .protyle-action__title, script, style, .img__net')
        .forEach(node => node.remove());
    clone.querySelectorAll('[data-type="inline-math"]').forEach(math =>
        math.replaceWith(math.getAttribute("data-content") || math.textContent || ""));
    clone.querySelectorAll('img').forEach(img => img.replaceWith(img.getAttribute('alt') || "图片"));
    return (clone.textContent || "").replace(/[\u200b\ufeff]/g, "").replace(/\s+/g, " ").trim() || "（空段落）";
}

export function findEmbeddedOutlineTarget(root: Element, id: string, embedId: string): HTMLElement | null {
    const embed = Array.from(root.querySelectorAll<HTMLElement>(EMBED_SELECTOR))
        .find(node => node.dataset.nodeId === embedId);
    return Array.from(embed?.querySelectorAll<HTMLElement>(OUTLINE_ITEM_SELECTOR) || [])
        .find(node => node.dataset.nodeId === id) || null;
}

/** 用完整文档 DOM 确定列表和页签位置，标题文字及层级仍沿用思源原生大纲。 */
export function includeListsInHeadingTree(headings: HeadingEntry[], dom: string, defaultDepth: number,
    liveRoot?: Element | null): HeadingEntry[] {
    const document = new DOMParser().parseFromString(dom, "text/html");
    mergeRenderedEmbeds(document, liveRoot);
    const headingMap = new Map(headings.map(entry => [entry.id, entry]));
    const listItems = new Map<string, HeadingEntry>();
    const entries: HeadingEntry[] = [];
    const seen = new Set<string>();
    const seenParagraphs = new Set<string>();
    const rootContainers = new Set(findRootLists(document.body));
    let headingDepth = 0;
    const selector = `[data-type="NodeHeading"], ${PARAGRAPH_SELECTOR}, ${OUTLINE_CONTAINER_SELECTOR}, ${OUTLINE_ITEM_SELECTOR}`;
    for (const node of Array.from(document.querySelectorAll<HTMLElement>(selector))) {
        const id = node.dataset.nodeId || "";
        const heading = headingMap.get(id);
        if (heading) {
            entries.push(heading);
            seen.add(id);
            headingDepth = heading.depth;
        } else if (node.matches(OUTLINE_CONTAINER_SELECTOR) && rootContainers.has(node) &&
            (!node.closest('[data-type="NodeBlockQueryEmbed"]') || node.closest(EMBED_RESULT_SELECTOR))) {
            const depth = blockDepth(node.getAttribute(DEPTH_ATTRIBUTE)) ?? defaultDepth;
            const embed = node.closest<HTMLElement>(EMBED_SELECTOR);
            const embedId = embed?.dataset.nodeId;
            const directParagraph = node.previousElementSibling?.matches(PARAGRAPH_SELECTOR)
                ? node.previousElementSibling as HTMLElement : null;
            const embedParagraph = !directParagraph && node.closest(EMBED_RESULT_SELECTOR) &&
                embed?.previousElementSibling?.matches(PARAGRAPH_SELECTOR)
                ? embed.previousElementSibling as HTMLElement : null;
            const paragraphOwner = embedParagraph?.parentElement?.closest<HTMLElement>(OUTLINE_ITEM_SELECTOR);
            const ownerEntry = listItems.get(paragraphOwner?.dataset.nodeId || "");
            const baseDepth = ownerEntry?.depth ?? headingDepth;
            // 嵌入结果以独立根列表提取；此时父段落位于查询嵌入块之前，而不是列表结果内部。
            // 若嵌入块本身位于普通列表项正文中，则不重复加入该列表项的正文段落。
            const paragraph = embedParagraph && paragraphOwner?.matches('[data-type="NodeListItem"]')
                ? null : directParagraph || embedParagraph;
            const paragraphId = paragraph?.dataset.nodeId || "";
            const paragraphEmbedId = paragraph?.closest<HTMLElement>(EMBED_SELECTOR)?.dataset.nodeId;
            if (paragraph && !seenParagraphs.has(paragraphId)) {
                seenParagraphs.add(paragraphId);
                entries.push({ id: paragraphId, text: extractParagraphText(paragraph),
                    depth: baseDepth + 1, level: 0, kind: "paragraph",
                    ...(paragraphEmbedId ? { embedId: paragraphEmbedId } : {}) });
            }
            for (const entry of extractOutline(node, depth)) {
                listItems.set(entry.id, { ...entry, depth: baseDepth + entry.depth + (paragraph ? 1 : 0), level: 0,
                    kind: entry.kind === "tab" ? "tab" : "list", ...(embedId ? { embedId } : {}) });
            }
        } else if (node.matches(PARAGRAPH_SELECTOR)) {
            const list = node.nextElementSibling?.matches('[data-type="NodeList"][data-node-id]')
                ? node.nextElementSibling as HTMLElement : null;
            const owner = list?.parentElement?.closest<HTMLElement>(OUTLINE_ITEM_SELECTOR);
            // 根列表的前置段落已在上方处理；这里仅补齐页签正文中嵌套列表的父段落。
            if (!list || rootContainers.has(list) || !owner?.matches('[data-type="NodeTabItem"]')) continue;
            const firstItem = Array.from(list.children)
                .find(child => child.matches('[data-type="NodeListItem"][data-node-id]')) as HTMLElement | undefined;
            const firstEntry = firstItem ? listItems.get(firstItem.dataset.nodeId || "") : undefined;
            if (!firstEntry) continue;
            const embedId = list.closest<HTMLElement>(EMBED_SELECTOR)?.dataset.nodeId;
            entries.push({ id, text: extractParagraphText(node), depth: firstEntry.depth, level: 0,
                kind: "paragraph", ...(embedId ? { embedId } : {}) });
            for (const item of Array.from(list.querySelectorAll<HTMLElement>(OUTLINE_ITEM_SELECTOR))) {
                const entry = listItems.get(item.dataset.nodeId || "");
                if (entry) entry.depth++;
            }
        } else if (listItems.has(id)) {
            entries.push(listItems.get(id)!);
        }
    }
    // 快照与原生大纲短暂不同步时，不丢失已有标题。
    entries.push(...headings.filter(entry => !seen.has(entry.id)));
    return entries;
}

export function flattenHeadingTree(nodes: NativeHeading[] | null): HeadingEntry[] {
    const entries: HeadingEntry[] = [];
    const seen = new Set<string>();
    function visit(items: NativeHeading[], depth: number) {
        for (const node of items) {
            if (!node || !node.id || seen.has(node.id)) continue;
            seen.add(node.id);
            // Block.name 是块命名属性（常为空），不是子标题正文；原生 Tree.genBlockHTML 读取 content。
            const isBlock = typeof node.content === "string";
            let text = isBlock ? node.content! : node.name ?? "";
            if (isBlock || node.nameIsHTML !== false) {
                const parsed = new DOMParser().parseFromString(text, "text/html");
                parsed.querySelectorAll("script,style").forEach(element => element.remove());
                parsed.querySelectorAll("img").forEach(element => element.replaceWith(element.alt || "图片"));
                parsed.querySelectorAll('[data-type="inline-math"]').forEach(element =>
                    element.replaceWith(element.getAttribute("data-content") || element.textContent || ""));
                text = parsed.body.textContent || "";
            }
            text = text.replace(/[\u200b\ufeff]/g, "").replace(/\s+/g, " ").trim() || "（空标题）";
            entries.push({ id: node.id, text: node.number ? `${node.number} ${text}` : text, depth,
                level: /^h[1-6]$/.test(node.subType || "") ? Number(node.subType![1]) : Math.min(depth, 6) });
            visit([...(node.blocks || []), ...(node.children || [])], depth + 1);
        }
    }
    visit(Array.isArray(nodes) ? nodes : [], 1);
    return entries;
}
