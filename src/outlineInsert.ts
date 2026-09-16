export interface OutlineInsertTarget {
    id: string;
    kind: "heading" | "list";
    editor: HTMLElement;
    notebook?: string;
}

export type OpenInsertMenu = (event: MouseEvent, target: OutlineInsertTarget, onInserted: () => void, onClose?: () => void) => void;
type Request = (url: string, data: Record<string, unknown>) => Promise<any>;
// 与思源原生空块一致，属性区需要零宽占位符，不能渲染为空 div。
const EMPTY_ATTR = '<div class="protyle-attr" contenteditable="false">\u200b</div>';
export interface OutlineInsertOperation {
    action: "insert";
    id: string;
    data: string;
    previousID?: string;
    nextID?: string;
}

/** 与原生大纲一致：先更新本地 DOM，再提交可撤销事务。不能重复调用块插入 API。 */
export function insertIntoOutlineEditor(content: HTMLElement, operation: OutlineInsertOperation,
    transaction: (operation: OutlineInsertOperation, undo: { action: "delete"; id: string }) => void): boolean {
    const anchorID = operation.nextID || operation.previousID;
    const anchor = Array.from(content.querySelectorAll<HTMLElement>("[data-node-id]"))
        .find(node => node.dataset.nodeId === anchorID && !node.closest('[data-type="NodeBlockQueryEmbed"]'));
    if (!anchor || anchor.closest('[fold="1"], .fn__none')) return false;
    const template = content.ownerDocument.createElement("template");
    template.innerHTML = operation.data;
    const block = template.content.firstElementChild as HTMLElement;
    if (operation.nextID) anchor.before(block);
    else anchor.after(block);
    block.scrollIntoView({ block: "center", behavior: "smooth" });
    const editable = block.querySelector<HTMLElement>('[contenteditable="true"]');
    if (editable) {
        editable.focus({ preventScroll: true });
        const range = content.ownerDocument.createRange();
        range.selectNodeContents(editable);
        range.collapse(true);
        const selection = content.ownerDocument.getSelection();
        selection?.removeAllRanges();
        selection?.addRange(range);
    }
    // 原生事务会读取当前选区；先把光标移入新块，避免沿用右键前的旧块选区。
    try {
        transaction(operation, { action: "delete", id: operation.id });
    } catch (error) {
        block.remove();
        throw error;
    }
    return true;
}

/** 只插入新块。标题下方锚点与思源 Outline.ts 的 insertSameLevelHeadingAfter 一致。 */
export async function insertOutlineSibling(target: OutlineInsertTarget, direction: "before" | "after", request: Request,
    newID: () => string, canInsert: () => boolean,
    insertInEditor?: (operation: OutlineInsertOperation) => boolean): Promise<string> {
    const context = target.notebook ? { notebook: target.notebook } : {};
    const response = await request("/api/block/getBlockDOM", { id: target.id, ...context });
    const parsed = new DOMParser().parseFromString(response?.dom || "", "text/html");
    const block = Array.from(parsed.querySelectorAll<HTMLElement>("[data-node-id]")).find(node => node.dataset.nodeId === target.id);
    const expected = target.kind === "heading" ? "NodeHeading" : "NodeListItem";
    if (block?.dataset.type !== expected) throw new Error("原条目已删除或类型已改变，请刷新大纲后重试。");
    let anchor = target.id;
    if (target.kind === "heading" && direction === "after") {
        // 此接口只读取章节范围，不提交返回的删除事务。
        const range = await request("/api/block/getHeadingDeleteTransaction", { id: target.id, ...context });
        anchor = range?.doOperations?.at(-1)?.id;
        if (!anchor) throw new Error("无法确定当前章节末尾，请刷新后重试。");
    }
    const id = newID();
    let data: string;
    // 思源通过 [spellcheck] 设置正文 min-height，空编辑区也必须带此属性以保留行高。
    if (target.kind === "heading") {
        const subtype = block.dataset.subtype;
        if (!/^h[1-6]$/.test(subtype || "")) throw new Error("标题级别无效。");
        data = `<div data-type="NodeHeading" data-subtype="${subtype}" data-node-id="${id}" class="${subtype}"><div contenteditable="true" spellcheck="false"></div>${EMPTY_ATTR}</div>`;
    } else {
        const subtype = block.dataset.subtype || "u";
        if (!["u", "o", "t"].includes(subtype)) throw new Error("列表类型无效。");
        const oldIndex = Number.parseInt(block.dataset.marker || "1", 10);
        const index = (Number.isFinite(oldIndex) ? oldIndex : 1) + (direction === "after" ? 1 : 0);
        const marker = subtype === "o" ? `${index}.` : "*";
        const action = subtype === "o" ? `<div class="protyle-action protyle-action--order" contenteditable="false">${marker}</div>`
            : `<div class="protyle-action${subtype === "t" ? " protyle-action--task" : ""}" contenteditable="false"><svg><use xlink:href="#${subtype === "t" ? "iconUncheck" : "iconDot"}"></use></svg></div>`;
        // 仅插入一个列表项，沿用类型和父列表；任务始终从未完成状态开始。
        data = `<div data-type="NodeListItem" data-subtype="${subtype}" data-marker="${marker}"${subtype === "t" ? ' data-task=" "' : ""} data-node-id="${id}" class="li">${action}<div data-type="NodeParagraph" data-node-id="${newID()}" class="p"><div contenteditable="true" spellcheck="false"></div>${EMPTY_ATTR}</div>${EMPTY_ATTR}</div>`;
    }
    if (!canInsert()) throw new Error("当前文档不可编辑或大纲已关闭。");
    const operation: OutlineInsertOperation = { action: "insert", id, data,
        [direction === "before" ? "nextID" : "previousID"]: anchor };
    if (insertInEditor?.(operation)) return id;
    const result = await request("/api/block/insertBlock", { dataType: "dom", data,
        [direction === "before" ? "nextID" : "previousID"]: anchor });
    const insertedOperation = result?.flatMap((transaction: any) => transaction.doOperations || [])
        .find((operation: any) => operation.action === "insert" && operation.id);
    if (!insertedOperation) throw new Error("插入请求已返回，但未取得新块 ID；请先检查文档，避免重复插入。");
    return insertedOperation.id;

}
