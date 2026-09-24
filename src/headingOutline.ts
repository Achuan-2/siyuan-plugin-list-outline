import { filterCollapsedEntries, findClosestHeadingOutlineTargetId, findEmbeddedOutlineTarget,
    flattenHeadingTree, getCollapsibleEntryIds, getHeadingOutlineTargetSelector, includeListsInHeadingTree,
    type HeadingEntry } from "./headingTree";
import { getDefaultSettings, MAX_DEPTH, type OutlineSettings } from "./defaultSettings";
import { createOutlineFoldButton, createOutlineRow, setOutlineCurrent } from "./outlineView";
import type { OpenInsertMenu } from "./outlineInsert";
import { HEADING_OUTLINE_ICON_ID } from "./icons";
import { applyListUpdateOperations, canDragListItem, createHeadingMovePlan, createListItemMovePlan,
    type HeadingDropPosition, type OutlineMoveOperation } from "./headingDrag";

export interface HeadingEditor {
    element: HTMLElement;
    content: HTMLElement;
    rootID: string;
    documentTitle?: string;
    notebook?: string;
    preview: boolean;
    disabled?: boolean;
    transaction?(operations: OutlineMoveOperation[], undoOperations: OutlineMoveOperation[]): void;
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
    newNodeID?(): string;
}

interface OutlineDragState {
    editor: HeadingEditor;
    sourceKind: "heading" | "list";
    sourceID: string;
    sourceRow: HTMLButtonElement;
    startX: number;
    startY: number;
    dragging: boolean;
    ghost?: HTMLElement;
    targetID?: string;
    position?: HeadingDropPosition;
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
    private currentEntryId = "";
    private expanded = false;
    private menuOpen = false;
    private disposed = false;
    private version = 0;
    private timer?: ReturnType<typeof setTimeout>;
    private heartbeat: ReturnType<typeof setInterval>;
    private frame = 0;
    private readonly mobile: boolean;
    private dragState?: OutlineDragState;
    private suppressClick = false;
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
        const close = createActionButton("iconClose", "关闭大纲增强");
        close.addEventListener("click", event => {
            event.stopPropagation();
            this.setExpanded(false);
        });
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
        header.append(locate, refresh, close);
        this.body.className = "list-outline-floating__body";
        this.status.className = "list-outline-floating__status";
        this.status.setAttribute("role", "status");
        this.panel.append(toggle, header, this.body, this.status);
        this.panel.hidden = true;
        document.body.append(this.panel);
        if (!this.mobile) {
            this.panel.addEventListener("pointerenter", () => this.setExpanded(true));
            this.panel.addEventListener("pointerleave", () => {
                if (this.menuOpen || this.dragState?.dragging) return;
                this.setExpanded(false);
            });
        } else {
            document.addEventListener("click", this.onDocumentClick);
        }
        if (!this.mobile) {
            this.panel.addEventListener("focusin", () => this.setExpanded(true));
            this.panel.addEventListener("focusout", event => {
                if (this.menuOpen || this.dragState?.dragging) return;
                if (!(event.relatedTarget instanceof Node && this.panel.contains(event.relatedTarget)) && !this.panel.matches(":hover")) this.setExpanded(false);
            });
        }
        this.body.addEventListener("click", this.onClick);
        this.body.addEventListener("contextmenu", this.onContextMenu);
        this.body.addEventListener("mousedown", this.onOutlineMouseDown);
        document.addEventListener("pointerover", this.onEditorPointer);
        document.addEventListener("focusin", this.onEditorPointer);
        document.addEventListener("click", this.onEditorPointer);
        document.addEventListener("keydown", this.onKeyDown);
        window.addEventListener("resize", this.schedulePosition);
        window.addEventListener("scroll", this.onScroll, true);
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
            const movabilityChanged = editor.disabled !== this.editor.disabled ||
                !!editor.transaction !== !!this.editor.transaction;
            this.editor.disabled = editor.disabled;
            this.editor.transaction = editor.transaction;
            if (movabilityChanged) this.render();
            this.position();
            return;
        }
        this.version++;
        clearTimeout(this.timer);
        this.observer.disconnect();
        this.editor = editor;
        this.entries = [];
        this.collapsedEntryIds.clear();
        this.currentEntryId = "";
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
            if (this.editor?.content.contains(event.target)) this.setCurrent(this.resolveEditorTarget(event.target));
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
            this.body.removeAttribute("data-loading");
        } catch (error) {
            if (this.disposed || version !== this.version) return;
            console.error("悬浮大纲增强：读取失败", error);
            this.status.textContent = "读取大纲增强失败，可点击刷新重试";
            this.render();
            this.body.removeAttribute("data-loading");
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
            const sourceKind = !entry.kind || entry.kind === "heading" ? "heading" :
                entry.kind === "list" && this.editor && canDragListItem(this.editor.content, entry.id) ? "list" : null;
            const movable = !!sourceKind && !entry.embedId && !this.mobile && !this.editor?.preview &&
                !this.editor?.disabled && !!this.editor?.transaction;
            if (movable) {
                row.dataset.draggableOutline = sourceKind;
                if (!entry.images?.length || entry.images.some(image => image.title)) {
                    row.title = `${entry.text}\n拖动可调整${sourceKind === "list" ? "列表项" : "标题"}顺序和层级`;
                }
            }
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
        if (this.suppressClick) {
            event.preventDefault();
            event.stopPropagation();
            this.suppressClick = false;
            return;
        }
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

    private createOutlineMovePlan(
        state: OutlineDragState,
        targetID: string,
        position: HeadingDropPosition,
        preview = false,
    ): { operations: OutlineMoveOperation[]; undoOperations: OutlineMoveOperation[] } | null {
        if (state.sourceKind === "heading") {
            const plan = createHeadingMovePlan(this.entries, state.sourceID, targetID, position);
            return plan ? { operations: [plan.operation], undoOperations: [plan.undoOperation] } : null;
        }
        return createListItemMovePlan(state.editor.content, state.sourceID, targetID, position,
            preview ? () => "drag-preview-list" : (this.options.newNodeID || (() => "")));
    }

    private onOutlineMouseDown = (event: MouseEvent) => {
        if (event.button !== 0 || this.body.dataset.loading === "true") return;
        const row = (event.target as Element).closest<HTMLButtonElement>("button[data-draggable-outline]");
        const editor = this.editor;
        if (!row?.dataset.id || !editor?.transaction || editor.disabled || editor.preview) return;
        const sourceKind = row.dataset.draggableOutline;
        if (sourceKind !== "heading" && sourceKind !== "list") return;
        if ((event.target as Element).closest("button[data-outline-toggle]")) return;
        this.cancelOutlineDrag();
        this.dragState = {
            editor,
            sourceKind,
            sourceID: row.dataset.id,
            sourceRow: row,
            startX: event.clientX,
            startY: event.clientY,
            dragging: false,
        };
        document.addEventListener("mousemove", this.onOutlineMouseMove);
        document.addEventListener("mouseup", this.onOutlineMouseUp, { once: true });
        window.addEventListener("blur", this.onOutlineDragBlur, { once: true });
    };

    private onOutlineMouseMove = (event: MouseEvent) => {
        const state = this.dragState;
        if (!state || this.editor !== state.editor || !state.sourceRow.isConnected) {
            this.cancelOutlineDrag();
            return;
        }
        if (!state.dragging && Math.abs(event.clientX - state.startX) < 3 &&
            Math.abs(event.clientY - state.startY) < 3) return;
        event.preventDefault();
        event.stopPropagation();
        if (!state.dragging) {
            state.dragging = true;
            state.sourceRow.style.opacity = "0.38";
            this.body.dataset.dragging = "true";
            const ghost = state.sourceRow.cloneNode(true) as HTMLElement;
            ghost.className = "list-outline-floating__item heading-outline-floating__item heading-outline-floating__drag-ghost";
            ghost.removeAttribute("data-id");
            ghost.removeAttribute("data-draggable-outline");
            ghost.style.width = `${Math.max(160, state.sourceRow.getBoundingClientRect().width)}px`;
            document.body.append(ghost);
            state.ghost = ghost;
        }
        state.ghost!.style.left = `${event.clientX + 10}px`;
        state.ghost!.style.top = `${event.clientY + 10}px`;
        this.scrollDuringOutlineDrag(event.clientY);
        this.clearOutlineDropIndicator();

        const eventTarget = event.target instanceof Element ? event.target : null;
        const target = eventTarget?.closest<HTMLButtonElement>(
            `button[data-draggable-outline="${state.sourceKind}"]`
        );
        if (target === state.sourceRow) {
            state.sourceRow.classList.add("dragover__current");
            return;
        }
        if (!target || !this.body.contains(target) || !target.dataset.id) return;
        const rect = target.getBoundingClientRect();
        const edge = rect.height * 0.2;
        const position: HeadingDropPosition = event.clientY < rect.top + edge ? "before" :
            event.clientY > rect.bottom - edge ? "after" : "inside";
        if (!this.createOutlineMovePlan(state, target.dataset.id, position, true)) {
            target.classList.add("dragover__current");
            return;
        }
        target.classList.add(position === "before" ? "dragover__top" :
            position === "after" ? "dragover__bottom" : "dragover");
        state.targetID = target.dataset.id;
        state.position = position;
    };

    private onOutlineMouseUp = () => {
        const state = this.dragState;
        const plan = state?.dragging && state.targetID && state.position
            ? this.createOutlineMovePlan(state, state.targetID, state.position)
            : null;
        const canCommit = !!plan && state?.editor === this.editor && state.editor.transaction;
        if (state?.dragging) {
            this.suppressClick = true;
            setTimeout(() => { this.suppressClick = false; }, 0);
        }
        this.cancelOutlineDrag();
        if (!canCommit || !state || !plan) return;
        let transactionSubmitted = false;
        try {
            this.body.dataset.loading = "true";
            if (state.sourceKind === "list") applyListUpdateOperations(state.editor.content, plan.operations);
            state.editor.transaction!(plan.operations, plan.undoOperations);
            transactionSubmitted = true;
            state.editor.content.querySelectorAll<HTMLElement>(
                '[data-type="NodeHeading"] [contenteditable="true"][spellcheck]'
            ).forEach(heading => heading.setAttribute("contenteditable", "false"));
            this.scheduleRefresh();
        } catch (error) {
            if (state.sourceKind === "list" && !transactionSubmitted) {
                try { applyListUpdateOperations(state.editor.content, plan.undoOperations); }
                catch (rollbackError) { console.error("悬浮大纲增强：恢复列表 DOM 失败", rollbackError); }
            }
            this.body.removeAttribute("data-loading");
            console.error("悬浮大纲增强：移动大纲条目失败", error);
            this.options.reportError("大纲条目移动失败，请重试。");
        }
    };

    private onOutlineDragBlur = () => this.cancelOutlineDrag();

    private scrollDuringOutlineDrag(clientY: number) {
        const rect = this.body.getBoundingClientRect();
        const edge = Math.min(36, rect.height / 4);
        if (clientY < rect.top + edge) this.body.scrollTop -= 12;
        else if (clientY > rect.bottom - edge) this.body.scrollTop += 12;
    }

    private clearOutlineDropIndicator() {
        this.body.querySelectorAll(".dragover__top, .dragover__bottom, .dragover, .dragover__current").forEach(item => {
            item.classList.remove("dragover__top", "dragover__bottom", "dragover", "dragover__current");
        });
        if (this.dragState) {
            this.dragState.targetID = undefined;
            this.dragState.position = undefined;
        }
    }

    private cancelOutlineDrag() {
        document.removeEventListener("mousemove", this.onOutlineMouseMove);
        document.removeEventListener("mouseup", this.onOutlineMouseUp);
        window.removeEventListener("blur", this.onOutlineDragBlur);
        this.clearOutlineDropIndicator();
        if (this.dragState) {
            this.dragState.sourceRow.style.opacity = "";
            this.dragState.ghost?.remove();
        }
        this.body.removeAttribute("data-dragging");
        this.dragState = undefined;
    }

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
        if (expanded && !wasExpanded) {
            const current = this.resolveCurrentLocation();
            if (current) this.setCurrent(current);
            this.scrollCurrentIntoView();
        }
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

    private onScroll = (event: Event) => {
        // 定位当前项会滚动悬浮大纲自身；这种内部滚动不能反过来覆盖当前高亮。
        if (event.target instanceof Node && this.panel.contains(event.target)) return;
        this.currentEntryId = "";
        this.schedulePosition();
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
        if (this.currentEntryId && this.entries.some(entry => entry.id === this.currentEntryId)) {
            setOutlineCurrent(this.body, this.currentEntryId);
        } else {
            this.highlightFromViewport(top);
        }
    }

    private resolveEditorTarget(target: Node): string {
        if (!this.editor) return "";
        const element = target instanceof Element ? target : target.parentElement;
        if (!element || !this.editor.content.contains(element)) return "";
        const ids = new Set(this.entries.map(entry => entry.id));
        const direct = findClosestHeadingOutlineTargetId(element, this.editor.content, ids, this.editor.preview);
        if (direct) return direct;

        // 普通正文块没有自己的大纲项时，沿用阅读位置语义，高亮它上方最近的大纲项。
        let preceding = "";
        const nodes = this.editor.content.querySelectorAll<HTMLElement>(
            getHeadingOutlineTargetSelector(this.editor.preview));
        for (const node of Array.from(nodes)) {
            const id = this.editor.preview ? node.id : node.dataset.nodeId!;
            if (!ids.has(id) || !node.getClientRects().length) continue;
            if (node.compareDocumentPosition(element) & Node.DOCUMENT_POSITION_FOLLOWING) preceding = id;
            else if (node.compareDocumentPosition(element) & Node.DOCUMENT_POSITION_PRECEDING) break;
        }
        return preceding;
    }

    private setCurrent(id: string) {
        this.currentEntryId = id && this.entries.some(entry => entry.id === id) ? id : "";
        setOutlineCurrent(this.body, this.currentEntryId);
    }

    private resolveCurrentLocation(): string {
        if (!this.editor || this.disposed) return "";
        const ids = new Set(this.entries.map(entry => entry.id));
        if (!ids.size) return "";

        // 优先检查光标所在位置或获得焦点的元素
        const selection = document.getSelection();
        const focusNode = selection?.focusNode || document.activeElement;
        if (focusNode && this.editor.content.contains(focusNode instanceof Node ? focusNode : null)) {
            const targetId = this.resolveEditorTarget(focusNode);
            if (targetId) return targetId;
        }

        // 如果光标不在编辑器内，回退到当前视口可见区域最顶部的标题
        const viewport = this.editor.content.closest(".protyle-content") || this.editor.content;
        const top = viewport.getBoundingClientRect().top;
        let targetId = "";
        const headings = this.editor.content.querySelectorAll<HTMLElement>(
            getHeadingOutlineTargetSelector(this.editor.preview));
        for (const heading of Array.from(headings)) {
            const id = this.editor.preview ? heading.id : heading.dataset.nodeId!;
            if (!ids.has(id) || !heading.getClientRects().length) continue;
            if (!targetId) targetId = id;
            if (heading.getBoundingClientRect().top <= top + 36) targetId = id;
        }
        return targetId;
    }

    locateCurrent(): string | null {
        const targetId = this.resolveCurrentLocation();

        if (!targetId) return null;

        this.setCurrent(targetId);
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

    private highlightFromViewport(top: number) {
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
        this.setCurrent(current);
    }

    destroy() {
        this.disposed = true;
        this.menuOpen = false;
        this.version++;
        clearTimeout(this.timer);
        clearInterval(this.heartbeat);
        cancelAnimationFrame(this.frame);
        this.observer.disconnect();
        this.cancelOutlineDrag();
        this.body.removeEventListener("mousedown", this.onOutlineMouseDown);
        document.removeEventListener("pointerover", this.onEditorPointer);
        document.removeEventListener("focusin", this.onEditorPointer);
        document.removeEventListener("click", this.onEditorPointer);
        document.removeEventListener("click", this.onDocumentClick);
        document.removeEventListener("keydown", this.onKeyDown);
        window.removeEventListener("resize", this.schedulePosition);
        window.removeEventListener("scroll", this.onScroll, true);
        this.panel.remove();
        this.editor = null;
    }
}
