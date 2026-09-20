import { filterCollapsedEntries, findClosestHeadingOutlineTargetId, findEmbeddedOutlineTarget,
    flattenHeadingTree, getCollapsibleEntryIds, getHeadingOutlineTargetSelector, includeListsInHeadingTree,
    type HeadingEntry } from "./headingTree";
import { getDefaultSettings, MAX_DEPTH, type OutlineSettings } from "./defaultSettings";
import { createOutlineFoldButton, createOutlineRow, setOutlineCurrent } from "./outlineView";
import type { OpenInsertMenu } from "./outlineInsert";
import { HEADING_OUTLINE_ICON_ID } from "./icons";

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
    isMobile?(): boolean;
}

const DESKTOP_FLOATING_RIGHT_GAP = 48;

/** 数据与跳转流程参考思源 layout/dock/Outline.ts；面板使用插件自己的悬浮视图。 */
export class HeadingOutlineController {
    private panel = document.createElement("aside");
    private body = document.createElement("div");
    private status = document.createElement("div");
    private listDepthSelect = document.createElement("select");
    private editor: HeadingEditor | null = null;
    private entries: HeadingEntry[] = [];
    private collapsedEntryIds = new Set<string>();
    private expanded = false;
    private menuOpen = false;
    private disposed = false;
    private version = 0;
    private timer?: ReturnType<typeof setTimeout>;
    private heartbeat: ReturnType<typeof setInterval>;
    private frame = 0;
    private readonly mobile: boolean;
    private observer = new MutationObserver(records => {
        // 文本修改只关心标题；插入、删除和容器移动也可能改变标题树。
        if (records.some(record => this.settings.headingListDepth > 0 || record.type !== "characterData" ||
            record.target.parentElement?.closest('[data-type="NodeHeading"],h1,h2,h3,h4,h5,h6'))) this.scheduleRefresh();
    });

    constructor(private options: Options) {
        this.mobile = options.isMobile?.() ?? false;
        this.panel.className = "list-outline-floating heading-outline-floating";
        this.panel.classList.toggle("heading-outline-floating--mobile", this.mobile);
        this.syncDisplayMode();
        this.panel.setAttribute("aria-label", "悬浮大纲增强");
        const toggle = document.createElement("button");
        toggle.type = "button";
        toggle.className = "heading-outline-floating__toggle";
        toggle.setAttribute("aria-expanded", "false");
        toggle.setAttribute("aria-label", "打开大纲增强");
        toggle.title = "打开大纲增强";
        const toggleIcon = document.createElementNS("http://www.w3.org/2000/svg", "svg");
        toggleIcon.classList.add("heading-outline-floating__toggle-icon");
        toggleIcon.setAttribute("aria-hidden", "true");
        const toggleUse = document.createElementNS("http://www.w3.org/2000/svg", "use");
        toggleUse.setAttribute("href", `#${HEADING_OUTLINE_ICON_ID}`);
        toggleIcon.append(toggleUse);
        toggle.append(toggleIcon);
        toggle.addEventListener("click", event => {
            event.stopPropagation();
            this.setExpanded(!this.expanded);
        });
        const header = document.createElement("div");
        header.className = "list-outline-floating__header";
        const title = document.createElement("span");
        title.textContent = "大纲增强";
        const createActionButton = (iconId: string, label: string) => {
            const button = document.createElement("button");
            button.type = "button";
            button.className = "b3-button b3-button--outline heading-outline-floating__action";
            button.setAttribute("aria-label", label);
            button.title = label;
            const icon = document.createElementNS("http://www.w3.org/2000/svg", "svg");
            icon.classList.add("heading-outline-floating__action-icon");
            icon.setAttribute("aria-hidden", "true");
            const use = document.createElementNS("http://www.w3.org/2000/svg", "use");
            use.setAttribute("href", `#${iconId}`);
            icon.append(use);
            button.append(icon);
            return button;
        };
        const locate = createActionButton("iconFocus", "定位当前位置");
        locate.addEventListener("click", () => this.locateCurrent());
        const refresh = createActionButton("iconRefresh", "刷新大纲增强");
        refresh.addEventListener("click", () => void this.refresh());
        this.listDepthSelect.className = "b3-select";
        this.listDepthSelect.setAttribute("aria-label", "大纲增强列表层级");
        this.listDepthSelect.title = "选择大纲增强中显示的列表层级";
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
        this.panel.append(toggle, header, this.body, this.status);
        this.panel.hidden = true;
        document.body.append(this.panel);
        if (!this.mobile) {
            this.panel.addEventListener("pointerenter", () => this.setExpanded(true));
            this.panel.addEventListener("pointerleave", () => {
                if (this.menuOpen) return;
                this.setExpanded(false);
            });
        } else {
            document.addEventListener("click", this.onDocumentClick);
        }
        if (!this.mobile) {
            this.panel.addEventListener("focusin", () => this.setExpanded(true));
            this.panel.addEventListener("focusout", event => {
                if (this.menuOpen) return;
                if (!(event.relatedTarget instanceof Node && this.panel.contains(event.relatedTarget)) && !this.panel.matches(":hover")) this.setExpanded(false);
            });
        }
        this.body.addEventListener("click", this.onClick);
        this.body.addEventListener("contextmenu", this.onContextMenu);
        document.addEventListener("pointerover", this.onEditorPointer);
        document.addEventListener("focusin", this.onEditorPointer);
        document.addEventListener("click", this.onEditorPointer);
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
        this.collapsedEntryIds.clear();
        this.body.replaceChildren();
        this.status.textContent = "";
        this.setExpanded(false);
        this.panel.hidden = true;
        if (!editor) return;
        this.observer.observe(editor.content, { childList: true, subtree: true, characterData: true,
            attributes: true, attributeFilter: ["data-type", "data-subtype", "data-content", "custom-list-outline-depth", "src", "data-src", "alt", "title",
                "tabs-title", "tabs-active-id", "data-tabs-hidden"] });
        void this.refresh();
    }

    private onEditorPointer = (event: Event) => {
        if (this.menuOpen) return;
        if (event.target instanceof HTMLElement && !this.panel.contains(event.target)) {
            this.syncEditors(event.target);
            if ((event.type === "click" || event.type === "focusin") && this.editor?.content.contains(event.target)) {
                const current = findClosestHeadingOutlineTargetId(event.target, this.editor.content,
                    new Set(this.entries.map(entry => entry.id)), this.editor.preview);
                if (current) setOutlineCurrent(this.body, current);
            }
        }
    };

    private onDocumentClick = (event: MouseEvent) => {
        if (!this.mobile || !this.expanded || !(event.target instanceof Node) || this.panel.contains(event.target)) return;
        this.setExpanded(false);
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
                this.entries = includeListsInHeadingTree(this.entries, snapshot?.dom || "", settings.headingListDepth,
                    editor.content);
            }
            this.status.textContent = "";
            this.render();
        } catch (error) {
            if (this.disposed || version !== this.version) return;
            console.error("悬浮大纲增强：读取失败", error);
            this.status.textContent = "读取大纲增强失败，可点击刷新重试";
            this.render();
        }
    }

    private get settings() { return this.options.getSettings?.() || getDefaultSettings(); }

    private get iconMode() {
        return !this.mobile && this.settings.headingOutlineDisplayMode === "icon";
    }

    private syncDisplayMode() {
        this.panel.classList.toggle("heading-outline-floating--icon",
            this.iconMode);
    }

    refreshSettings() {
        this.syncDisplayMode();
        this.listDepthSelect.value = String(this.settings.headingListDepth);
        if (this.settings.headingListDepth === 0) {
            this.entries = this.entries.filter(entry => !["paragraph", "list", "tab"].includes(entry.kind || ""));
            this.render();
        }
        // 立即使旧请求失效，避免关闭列表后被未完成的混合大纲请求覆盖。
        void this.refresh();
    }

    private render() {
        if (this.disposed) return;
        const fragment = document.createDocumentFragment();
        const collapsibleIds = getCollapsibleEntryIds(this.entries);
        for (const id of this.collapsedEntryIds) {
            if (!collapsibleIds.has(id)) this.collapsedEntryIds.delete(id);
        }
        for (const entry of filterCollapsedEntries(this.entries, this.collapsedEntryIds)) {
            const container = document.createElement("div");
            container.className = "heading-outline-floating__entry";
            container.style.setProperty("--outline-indent", `${10 + (entry.depth - 1) * 14}px`);
            const row = createOutlineRow(entry);
            row.classList.add("heading-outline-floating__item");
            if (entry.embedId) row.dataset.embedId = entry.embedId;
            const icon = document.createElementNS("http://www.w3.org/2000/svg", "svg");
            icon.classList.add("heading-outline-floating__icon");
            icon.setAttribute("aria-hidden", "true");
            const use = document.createElementNS("http://www.w3.org/2000/svg", "use");
            use.setAttribute("href", entry.kind === "tab" ? "#iconTabItem" :
                entry.kind === "paragraph" ? "#iconParagraph" :
                entry.kind === "list" ? "#iconListItem" : `#iconH${entry.level}`);
            icon.append(use);
            row.insertBefore(icon, row.lastChild);
            if (collapsibleIds.has(entry.id)) {
                container.append(createOutlineFoldButton(entry, !this.collapsedEntryIds.has(entry.id),
                    "heading-outline-floating__fold"));
            }
            container.append(row);
            fragment.append(container);
        }
        if (!this.entries.length && this.status.textContent) {
            const retry = createOutlineRow({ id: "", depth: 1, text: "重新读取大纲增强" });
            fragment.append(retry);
        }
        const scrollTop = this.body.scrollTop;
        this.body.replaceChildren(fragment);
        this.body.scrollTop = scrollTop;
        this.position();
    }

    private onClick = async (event: MouseEvent) => {
        const toggle = (event.target as Element).closest<HTMLButtonElement>("button[data-outline-toggle]");
        if (toggle) {
            event.preventDefault();
            event.stopPropagation();
            const id = toggle.dataset.outlineToggle!;
            if (this.collapsedEntryIds.has(id)) this.collapsedEntryIds.delete(id);
            else this.collapsedEntryIds.add(id);
            this.render();
            return;
        }
        const row = (event.target as Element).closest<HTMLButtonElement>("button[data-id]");
        const editor = this.editor;
        if (!row || !editor) return;
        const id = row.dataset.id!;
        if (!id) { void this.refresh(); return; }
        if (row.dataset.embedId) {
            const target = findEmbeddedOutlineTarget(editor.content, id, row.dataset.embedId);
            if (target?.getClientRects().length) {
                target.scrollIntoView({ block: "center", behavior: "smooth" });
                target.animate?.([{ backgroundColor: "var(--b3-theme-primary-light)" },
                    { backgroundColor: "transparent" }], { duration: 1000 });
                if (this.mobile || this.iconMode) this.setExpanded(false);
                return;
            }
        }
        if (editor.preview) {
            const heading = Array.from(editor.content.querySelectorAll<HTMLElement>("[id]")).find(node => node.id === id);
            if (heading) {
                heading.scrollIntoView({ block: "start" });
                if (this.mobile || this.iconMode) this.setExpanded(false);
                return;
            }
        }
        try {
            // 与原生 Outline 的 checkFold 流程一致，折叠标题需要完整块上下文。
            const result = await this.options.request("/api/block/checkBlockFold", { id,
                ...(editor.notebook ? { notebook: editor.notebook } : {}) });
            if (!this.disposed && this.editor === editor) {
                this.options.navigate(id, !!result?.isFolded);
                if (this.mobile || this.iconMode) this.setExpanded(false);
            }
        } catch (error) {
            console.error("悬浮大纲增强：定位失败", error);
            if (!this.disposed) this.options.reportError("大纲条目定位失败，请重试。");
        }
    };

    private onContextMenu = (event: MouseEvent) => {
        const row = (event.target as Element).closest<HTMLButtonElement>("button[data-id]");
        if (!row?.dataset.id || !this.editor) return;
        const rootID = this.editor.rootID;
        const kind = this.entries.find(entry => entry.id === row.dataset.id && entry.embedId === row.dataset.embedId)?.kind || "heading";
        if (kind === "tab" || kind === "paragraph" || row.dataset.embedId) {
            event.preventDefault();
            event.stopPropagation();
            return;
        }
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
        const wasExpanded = this.expanded;
        this.expanded = expanded;
        this.panel.classList.toggle("list-outline-floating--expanded", expanded);
        const toggle = this.panel.querySelector<HTMLButtonElement>(".heading-outline-floating__toggle");
        if (toggle) {
            toggle.setAttribute("aria-expanded", String(expanded));
            toggle.setAttribute("aria-label", expanded ? "关闭大纲增强" : "打开大纲增强");
            toggle.title = expanded ? "关闭大纲增强" : "打开大纲增强";
            toggle.hidden = (this.mobile || this.iconMode) && expanded;
        }
        if (!expanded) this.body.scrollTop = 0;
        this.position();
        if (expanded && !wasExpanded) this.scrollCurrentIntoView();
    }

    private scrollCurrentIntoView() {
        const current = this.body.querySelector<HTMLElement>(".list-outline-floating__current");
        current?.scrollIntoView?.({ block: "center", behavior: "auto" });
    }

    private schedulePosition = () => {
        if (!this.frame && !this.disposed) this.frame = requestAnimationFrame(() => {
            this.frame = 0;
            this.position();
        });
    };

    private getMobileTop(viewport: Element, fallback: number) {
        const protyle = viewport.closest<HTMLElement>(".protyle");
        const breadcrumb = protyle?.querySelector<HTMLElement>(":scope > .protyle-breadcrumb");
        const breadcrumbRect = breadcrumb?.getBoundingClientRect();
        return breadcrumbRect && breadcrumbRect.bottom > fallback ? breadcrumbRect.bottom + 8 : fallback;
    }

    private position() {
        if (!this.editor || !this.visible(this.editor) || (!this.entries.length && !this.status.textContent)) {
            this.panel.hidden = true;
            return;
        }
        const viewport = this.editor.content.closest(".protyle-content") || this.editor.content;
        const rect = viewport.getBoundingClientRect();
        const left = Math.max(8, rect.left);
        const right = Math.min(window.innerWidth - 8,
            rect.right - 6 - (this.mobile ? 0 : DESKTOP_FLOATING_RIGHT_GAP));
        let top = Math.max(8, rect.top + 12);
        if (this.mobile) top = this.getMobileTop(viewport, top);
        const bottom = Math.min(window.innerHeight - 8, rect.bottom - 8);
        if (right <= left || bottom - top < (this.mobile ? 52 : 30)) { this.panel.hidden = true; return; }
        this.panel.hidden = false;
        const compactButton = this.mobile || this.iconMode;
        const width = Math.min(this.expanded ? (this.mobile ? 320 : 300) : (compactButton ? 52 : 48), right - left);
        const maxHeight = Math.min(480, bottom - top);
        if (compactButton) {
            Object.assign(this.panel.style, { width: `${width}px`, left: `${right - width}px`,
                top: `${top}px`, bottom: "auto",
                height: this.expanded ? "auto" : "52px", maxHeight: `${maxHeight}px` });
        } else {
            Object.assign(this.panel.style, { width: `${width}px`, left: `${right - width}px`,
                top: `${top}px`, bottom: "auto", height: "auto", maxHeight: `${maxHeight}px` });
        }
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
                const selector = getHeadingOutlineTargetSelector(this.editor.preview);
                // 1. 如果光标直接在标题、列表项、页签或作为列表父级的大纲段落上
                const blockId = findClosestHeadingOutlineTargetId(focusElement, this.editor.content, ids,
                    this.editor.preview);
                if (blockId) {
                    targetId = blockId;
                } else {
                    // 2. 如果光标在普通段落或子块中，查找该块上方最近的标题
                    const cursorTop = focusElement.getBoundingClientRect().top;
                    const headings = Array.from(this.editor.content.querySelectorAll<HTMLElement>(selector)).filter(h => {
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
            const selector = getHeadingOutlineTargetSelector(this.editor.preview);
            const headings = Array.from(this.editor.content.querySelectorAll<HTMLElement>(selector)).filter(h => {
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
        const headings = this.editor.content.querySelectorAll<HTMLElement>(
            getHeadingOutlineTargetSelector(this.editor.preview));
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
        document.removeEventListener("click", this.onEditorPointer);
        document.removeEventListener("click", this.onDocumentClick);
        document.removeEventListener("keydown", this.onKeyDown);
        window.removeEventListener("resize", this.schedulePosition);
        window.removeEventListener("scroll", this.schedulePosition, true);
        this.panel.remove();
        this.editor = null;
    }
}
