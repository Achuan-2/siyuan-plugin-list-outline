import { MAX_DEPTH } from "./defaultSettings";

export const DEPTH_ATTRIBUTE = "custom-list-outline-depth";
export const LIST_SELECTOR = '[data-type="NodeList"][data-node-id]';
const ITEM_SELECTOR = '[data-type="NodeListItem"]';
const QUOTE_SELECTOR = '[data-type="NodeBlockquote"], blockquote';

export interface OutlineEntry {
    id: string;
    text: string;
    depth: number;
}

export function blockDepth(value: string | null): number | null {
    if (!value || !/^\d+$/.test(value)) return null;
    const depth = Number(value);
    return depth >= 1 && depth <= MAX_DEPTH ? depth : null;
}

export function findList(target: Element): HTMLElement | null {
    const editor = target.closest(".protyle-wysiwyg");
    if (!editor) return null;
    let list = target.closest<HTMLElement>(LIST_SELECTOR);
    let result: HTMLElement | null = null;
    // 子列表属于同一份大纲；在子项间移动时不切换悬浮面板。
    while (list && editor.contains(list)) {
        if (!list.closest(QUOTE_SELECTOR)) result = list;
        list = list.parentElement?.closest<HTMLElement>(LIST_SELECTOR);
    }
    return result;
}

export function extractOutline(root: HTMLElement, maxDepth: number): OutlineEntry[] {
    const entries: OutlineEntry[] = [];
    function visit(list: Element, depth: number) {
        if (depth > maxDepth || list.closest(QUOTE_SELECTOR)) return;
        for (const item of Array.from(list.children)) {
            if (!item.matches(ITEM_SELECTOR)) continue;
            // 仅取本列表项自己的首个文本块，不把子列表和附加段落拼入标题。
            const content = Array.from(item.querySelectorAll<HTMLElement>('[contenteditable="true"]'))
                .find(element => element.closest(ITEM_SELECTOR) === item &&
                    !element.closest(QUOTE_SELECTOR) &&
                    !element.closest('.protyle-attr, .protyle-action, [data-type="NodeCodeBlock"], [data-type="NodeTable"]'));
            const clone = content?.cloneNode(true) as HTMLElement | undefined;
            clone?.querySelectorAll('.protyle-attr, .protyle-action, script, style, .img__net').forEach(node => node.remove());
            clone?.querySelectorAll('img').forEach(img => img.replaceWith(img.getAttribute('alt') || "图片"));
            clone?.querySelectorAll('[data-type="inline-math"]').forEach(math => math.replaceWith(math.getAttribute("data-content") || math.textContent || ""));
            const text = (clone?.textContent || "").replace(/[\u200b\ufeff]/g, "").replace(/\s+/g, " ").trim();
            const id = item.getAttribute("data-node-id");
            if (id) entries.push({ id, text: text || "（空列表项）", depth });
            // 只有嵌套列表增加层级；引述块中的列表整体跳过。
            for (const child of Array.from(item.querySelectorAll(LIST_SELECTOR))) {
                if (child.parentElement?.closest(ITEM_SELECTOR) === item &&
                    child.parentElement?.closest(LIST_SELECTOR) === list) visit(child, depth + 1);
            }
        }
    }
    visit(root, 1);
    return entries;
}
