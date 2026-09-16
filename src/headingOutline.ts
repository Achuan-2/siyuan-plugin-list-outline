import { flattenHeadingTree, includeListsInHeadingTree, type HeadingEntry } from "./headingTree";
import { getDefaultSettings, MAX_DEPTH, type OutlineSettings } from "./defaultSettings";
import { createOutlineRow, setOutlineCurrent } from "./outlineView";
import type { OpenInsertMenu } from "./outlineInsert";

export interface HeadingEditor {
    element: HTMLElement;
    content: HTMLElement;
    rootID: string;
    notebook?: string;
    preview: boolean;
}

interface Options {
    getEditors(): HeadingEditor[];
    request(url: string, data: Record<string, unknown>): Promise<any>;
    navigate(id: string, folded: boolean): void;
    reportError(message: string): void;
    openInsertMenu?: OpenInsertMenu;
    getSettings?(): OutlineSettings;
    setListDepth?(depth: number): Promise<unknown>;
}

/** 数据与跳转流程参考思源 layout/dock/Outline.ts；面板使用插件自己的悬浮视图。 */
export class HeadingOutlineController {
    private panel = document.createElement("aside");
    private body = document.createElement("div");
    private status = document.createElement("div");
    private listDepthSelect = document.createElement("select");
    private editor: HeadingEditor | null = null;
    private entries: HeadingEntry[] = [];
    private expanded = false;
    private menuOpen = false;
    private disposed = false;
    private version = 0;
    private timer?: ReturnType<typeof setTimeout>;
    private heartbeat: ReturnType<typeof setInterval>;
    private frame = 0;
    private observer = new MutationObserver(records => {
        // 文本修改只关心标题；插入、删除和容器移动也可能改变标题树。
        if (records.some(record => this.settings.headingListDepth > 0 || record.type !== "characterData" ||
            record.target.parentElement?.closest('[data-type="NodeHeading"],h1,h2,h3,h4,h5,h6'))) this.scheduleRefresh();
    });

    constructor(private options: Options) {
        this.panel.className = "list-outline-floating heading-outline-floating";
        this.panel.setAttribute("aria-label", "悬浮标题大纲");
        const header = document.createElement("div");
        header.className = "list-outline-floating__header";
        const title = document.createElement("span");
        title.textContent = "标题大纲";
        const locate = document.createElement("button");
        locate.className = "b3-button b3-button--outline";
        locate.textContent = "定位";
        locate.title = "定位当前位置";
        locate.addEventListener("click", () => this.locateCurrent());
        const refresh = document.createElement("button");
        refresh.className = "b3-button b3-button--outline";
        refresh.textContent = "刷新";
        refresh.addEventListener("click", () => void this.refresh());
        this.listDepthSelect.className = "b3-select";
        this.listDepthSelect.setAttribute("aria-label", "标题大纲列表层级");
        this.listDepthSelect.title = "选择标题大纲中显示的列表层级";
        for (let depth = 0; depth <= MAX_DEPTH; depth++) {
            const option = document.createElement("option");
            option.value = String(depth);
            option.textContent = depth === 0 ? "不显示列表" : `列表 ${depth} 层`;
            this.listDepthSelect.add(option);
        }
        this.listDepthSelect.value = String(this.settings.headingListDepth);
        this.listDepthSelect.addEventListener("change", async () => {
            this.listDepthSelect.disabled = true;
            try {
                await this.options.setListDepth?.(Number(this.listDepthSelect.value));
                if (!this.disposed) await this.refresh();
            } catch (error) {
                if (!this.disposed) this.options.reportError("列表层级设置保存失败，请重试。");
            } finally {
                this.listDepthSelect.disabled = false;
                this.listDepthSelect.value = String(this.settings.headingListDepth);
            }
        });
        header.append(title);
        if (options.setListDepth) header.append(this.listDepthSelect);
        header.append(locate, refresh);
        this.body.className = "list-outline-floating__body";
        this.status.className = "list-outline-floating__status";
        this.status.setAttribute("role", "status");
        this.panel.append(header, this.body, this.status);
        this.panel.hidden = true;
        document.body.append(this.panel);
        this.panel.addEventListener("pointerenter", () => this.setExpanded(true));
        this.panel.addEventListener("pointerleave", () => {
            if (this.menuOpen) return;
            this.setExpanded(false);
        });
        this.panel.addEventListener("focusin", () => this.setExpanded(true));
        this.panel.addEventListener("focusout", event => {
            if (this.menuOpen) return;
            if (!(event.relatedTarget instanceof Node && this.panel.contains(event.relatedTarget)) && !this.panel.matches(":hover")) this.setExpanded(false);
        });
        this.body.addEventListener("click", this.onClick);
        this.body.addEventListener("contextmenu", this.onContextMenu);
        document.addEventListener("pointerover", this.onEditorPointer);
        document.addEventListener("focusin", this.onEditorPointer);
        document.addEventListener("keydown", this.onKeyDown);
        window.addEventListener("resize", this.schedulePosition);
        window.addEventListener("scroll", this.schedulePosition, true);
        // 补充处理标签隐藏、分屏布局与编辑器 DOM 被替换，无需轮询接口。
        this.heartbeat = setInterval(() => this.syncEditors(), 500);
        this.syncEditors();
    }

    private visible(editor: HeadingEditor) {
        return editor.element.isConnected && !editor.element.closest('.fn__none, [hidden]') &&
            editor.content.getClientRects().length > 0;
    }

    syncEditors(preferred?: HTMLElement) {
        if (this.disposed) return;
        const editors = this.options.getEditors().filter(editor => this.visible(editor));
        const editor = editors.find(item => preferred && (item.element === preferred || item.element.contains(preferred))) ||
            editors.find(item => item.element === this.editor?.element) ||
            editors.find(item => document.activeElement && item.element.contains(document.activeElement)) || editors[0] || null;
        if (editor?.element === this.editor?.element && editor?.rootID === this.editor?.rootID &&
            editor?.preview === this.editor?.preview && editor?.content === this.editor?.content) {
            this.position();
            return;
        }
        this.version++;
        clearTimeout(this.timer);
        this.observer.disconnect();
        this.editor = editor;
        this.entries = [];
        this.body.replaceChildren();
        this.status.textContent = "";
        this.setExpanded(false);
        this.panel.hidden = true;
        if (!editor) return;
        this.observer.observe(editor.content, { childList: true, subtree: true, characterData: true,
            attributes: true, attributeFilter: ["data-type", "data-subtype", "data-content", "custom-list-outline-depth"] });
        void this.refresh();
    }

    private onEditorPointer = (event: Event) => {
        if (this.menuOpen) return;
        if (event.target instanceof HTMLElement && !this.panel.contains(event.target)) this.syncEditors(event.target);
    };

    private onKeyDown = (event: KeyboardEvent) => {
        if (event.key === "Escape") {
            if (this.menuOpen) return;
            this.setExpanded(false);
        }
    };

    scheduleRefresh() {
        if (this.disposed || !this.editor) return;
        this.version++;
        clearTimeout(this.timer);
        this.timer = setTimeout(() => void this.refresh(), 600);
    }

    async refresh() {
        if (this.disposed || !this.editor) return;
        clearTimeout(this.timer);
        const editor = this.editor;
        const version = ++this.version;
        const settings = this.settings;
        try {
            const [nodes, snapshot] = await Promise.all([this.options.request("/api/outline/getDocOutline", {
                id: editor.rootID, preview: editor.preview, ...(editor.notebook ? { notebook: editor.notebook } : {}),
            }), settings.headingListDepth > 0 ? this.options.request("/api/block/getBlockDOM", {
                id: editor.rootID, ...(editor.notebook ? { notebook: editor.notebook } : {}),
            }) : Promise.resolve(null)]);
            if (this.disposed || version !== this.version) return;
            this.entries = flattenHeadingTree(nodes);
            if (settings.headingListDepth > 0) {
                this.entries = includeListsInHeadingTree(this.entries, snapshot?.dom || "", settings.headingListDepth);
            }
            this.status.textContent = "";
            this.render();
        } catch (error) {
            if (this.disposed || version !== this.version) return;
            console.error("悬浮标题大纲：读取失败", error);
            this.status.textContent = "读取标题大纲失败，可点击刷新重试";
            this.render();
        }
    }

    private get settings() { return this.options.getSettings?.() || getDefaultSettings(); }

    refreshSettings() {
        this.listDepthSelect.value = String(this.settings.headingListDepth);
        if (this.settings.headingListDepth === 0) {
            this.entries = this.entries.filter(entry => entry.kind !== "list");
            this.render();
        }
        // 立即使旧请求失效，避免关闭列表后被未完成的混合大纲请求覆盖。
        void this.refresh();
    }

    private render() {
        if (this.disposed) return;
        const fragment = document.createDocumentFragment();
        for (const entry of this.entries) {
            const row = createOutlineRow(entry);
            const icon = document.createElementNS("http://www.w3.org/2000/svg", "svg");
            icon.classList.add("heading-outline-floating__icon");
            icon.setAttribute("aria-hidden", "true");
            const use = document.createElementNS("http://www.w3.org/2000/svg", "use");
            use.setAttribute("href", entry.kind === "list" ? "#iconList" : `#iconH${entry.level}`);
            icon.append(use);
            row.insertBefore(icon, row.lastChild);
            fragment.append(row);
        }
        if (!this.entries.length && this.status.textContent) {
            const retry = createOutlineRow({ id: "", depth: 1, text: "重新读取标题大纲" });
            fragment.append(retry);
        }
        const scrollTop = this.body.scrollTop;
        this.body.replaceChildren(fragment);
        this.body.scrollTop = scrollTop;
        this.position();
    }

    private onClick = async (event: MouseEvent) => {
        const row = (event.target as Element).closest<HTMLButtonElement>("button[data-id]");
        const editor = this.editor;
        if (!row || !editor) return;
        const id = row.dataset.id!;
        if (!id) { void this.refresh(); return; }
        if (editor.preview) {
            const heading = Array.from(editor.content.querySelectorAll<HTMLElement>("[id]")).find(node => node.id === id);
            if (heading) { heading.scrollIntoView({ block: "start" }); return; }
        }
        try {
            // 与原生 Outline 的 checkFold 流程一致，折叠标题需要完整块上下文。
            const result = await this.options.request("/api/block/checkBlockFold", { id,
                ...(editor.notebook ? { notebook: editor.notebook } : {}) });
            if (!this.disposed && this.editor === editor) this.options.navigate(id, !!result?.isFolded);
        } catch (error) {
            console.error("悬浮标题大纲：定位失败", error);
            if (!this.disposed) this.options.reportError("大纲条目定位失败，请重试。");
        }
    };

    private onContextMenu = (event: MouseEvent) => {
        const row = (event.target as Element).closest<HTMLButtonElement>("button[data-id]");
        if (!row?.dataset.id || !this.editor) return;
        const rootID = this.editor.rootID;
        const kind = this.entries.find(entry => entry.id === row.dataset.id)?.kind || "heading";
        this.menuOpen = true;
        this.setExpanded(true);
        this.options.openInsertMenu?.(event, { id: row.dataset.id, kind, editor: this.editor.element,
            notebook: this.editor.notebook }, () => {
            if (!this.disposed && this.editor?.rootID === rootID) void this.refresh();
        }, () => {
            this.menuOpen = false;
            if (this.disposed) return;
            if (!this.panel.matches(":hover") && !(document.activeElement && this.panel.contains(document.activeElement))) {
                this.setExpanded(false);
            }
        });
    };

    private setExpanded(expanded: boolean) {
        this.expanded = expanded;
        this.panel.classList.toggle("list-outline-floating--expanded", expanded);
        if (!expanded) this.body.scrollTop = 0;
        this.position();
    }

    private schedulePosition = () => {
        if (!this.frame && !this.disposed) this.frame = requestAnimationFrame(() => {
            this.frame = 0;
            this.position();
        });
    };

    private position() {
        if (!this.editor || !this.visible(this.editor) || (!this.entries.length && !this.status.textContent)) {
            this.panel.hidden = true;
            return;
        }
        const viewport = this.editor.content.closest(".protyle-content") || this.editor.content;
        const rect = viewport.getBoundingClientRect();
        const left = Math.max(8, rect.left);
        const right = Math.min(window.innerWidth - 8, rect.right - 6);
        const top = Math.max(8, rect.top + 12);
        const bottom = Math.min(window.innerHeight - 8, rect.bottom - 8);
        if (right <= left || bottom - top < 30) { this.panel.hidden = true; return; }
        this.panel.hidden = false;
        const width = Math.min(this.expanded ? 300 : 48, right - left);
        Object.assign(this.panel.style, { width: `${width}px`, left: `${right - width}px`,
            top: `${top}px`, maxHeight: `${Math.min(480, bottom - top)}px` });
        this.highlight(top);
    }

    locateCurrent(): string | null {
        if (!this.editor || this.disposed) return null;
        const ids = new Set(this.entries.map(entry => entry.id));
        if (!ids.size) return null;

        let targetId = "";

        // 优先检查光标所在位置或获得焦点的元素
        const selection = document.getSelection();
        const focusNode = selection?.focusNode || document.activeElement;
        if (focusNode && this.editor.content.contains(focusNode instanceof Node ? focusNode : null)) {
            const focusElement = focusNode instanceof Element ? focusNode : focusNode.parentElement;
            if (focusElement) {
                // 1. 如果光标直接在标题或列表项上
                const block = focusElement.closest<HTMLElement>(
                    this.editor.preview ? "h1[id],h2[id],h3[id],h4[id],h5[id],h6[id],li[id]"
                        : '[data-type="NodeHeading"][data-node-id], [data-type="NodeListItem"][data-node-id]'
                );
                const blockId = block ? (this.editor.preview ? block.id : block.dataset.nodeId) : null;
                if (blockId && ids.has(blockId)) {
                    targetId = blockId;
                } else {
                    // 2. 如果光标在普通段落或子块中，查找该块上方最近的标题
                    const cursorTop = focusElement.getBoundingClientRect().top;
                    const headings = Array.from(this.editor.content.querySelectorAll<HTMLElement>(
                        this.editor.preview ? "h1[id],h2[id],h3[id],h4[id],h5[id],h6[id],li[id]"
                            : '[data-type="NodeHeading"][data-node-id], [data-type="NodeListItem"][data-node-id]'
                    )).filter(h => {
                        const id = this.editor!.preview ? h.id : h.dataset.nodeId!;
                        return ids.has(id) && h.getClientRects().length > 0;
                    });
                    for (const heading of headings) {
                        if (heading.getBoundingClientRect().top <= cursorTop + 10) {
                            targetId = this.editor.preview ? heading.id : heading.dataset.nodeId!;
                        } else {
                            break;
                        }
                    }
                }
            }
        }

        // 如果光标不在编辑器内，回退到当前视口可见区域最顶部的标题
        if (!targetId) {
            const viewport = this.editor.content.closest(".protyle-content") || this.editor.content;
            const top = viewport.getBoundingClientRect().top;
            const headings = Array.from(this.editor.content.querySelectorAll<HTMLElement>(
                this.editor.preview ? "h1[id],h2[id],h3[id],h4[id],h5[id],h6[id],li[id]"
                    : '[data-type="NodeHeading"][data-node-id], [data-type="NodeListItem"][data-node-id]'
            )).filter(h => {
                const id = this.editor!.preview ? h.id : h.dataset.nodeId!;
                return ids.has(id) && h.getClientRects().length > 0;
            });
            for (const heading of headings) {
                const id = this.editor.preview ? heading.id : heading.dataset.nodeId!;
                if (!targetId) targetId = id;
                if (heading.getBoundingClientRect().top <= top + 36) targetId = id;
            }
        }

        if (!targetId) return null;

        setOutlineCurrent(this.body, targetId);
        const targetRow = this.body.querySelector<HTMLElement>(`button[data-id="${targetId}"]`);
        if (targetRow) {
            targetRow.scrollIntoView?.({ block: "center", behavior: "smooth" });
            if (typeof targetRow.animate === "function") {
                targetRow.animate([
                    { backgroundColor: "var(--b3-theme-primary-light)" },
                    { backgroundColor: "transparent" },
                ], { duration: 1000 });
            }
        }
        return targetId;
    }

    private highlight(top: number) {
        if (!this.editor) return;
        const ids = new Set(this.entries.map(entry => entry.id));
        let current = "";
        const headings = this.editor.content.querySelectorAll<HTMLElement>(this.editor.preview ? "h1[id],h2[id],h3[id],h4[id],h5[id],h6[id],li[id]" : '[data-type="NodeHeading"][data-node-id], [data-type="NodeListItem"][data-node-id]');
        for (const heading of Array.from(headings)) {
            const id = this.editor.preview ? heading.id : heading.dataset.nodeId!;
            if (!ids.has(id) || !heading.getClientRects().length) continue;
            if (!current) current = id;
            if (heading.getBoundingClientRect().top <= top + 36) current = id;
        }
        setOutlineCurrent(this.body, current);
    }

    destroy() {
        this.disposed = true;
        this.menuOpen = false;
        this.version++;
        clearTimeout(this.timer);
        clearInterval(this.heartbeat);
        cancelAnimationFrame(this.frame);
        this.observer.disconnect();
        document.removeEventListener("pointerover", this.onEditorPointer);
        document.removeEventListener("focusin", this.onEditorPointer);
        document.removeEventListener("keydown", this.onKeyDown);
        window.removeEventListener("resize", this.schedulePosition);
        window.removeEventListener("scroll", this.schedulePosition, true);
        this.panel.remove();
        this.editor = null;
    }
}
