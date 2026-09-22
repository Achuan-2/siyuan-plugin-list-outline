import { strict as assert } from "node:assert";
import { test } from "node:test";
import { JSDOM } from "jsdom";
import { normalizeSettings } from "../src/defaultSettings";
import { HeadingOutlineDockView } from "../src/headingDock";
import type { HeadingEditor } from "../src/headingOutline";
import { createHeadingMovePlan, createListItemMovePlan } from "../src/headingDrag";

const tree = [{ id: "h1", name: "<strong>一级标题</strong>", subType: "h1", number: "1.", blocks: [
    { id: "h3", name: "", content: "三级标题", subType: "h3", children: [{ id: "h6", name: "自定义块名", content: "六级标题", subType: "h6" }] },
] }, { id: "h2", name: "第二章", subType: "h2" }];

const settle = () => new Promise(resolve => setTimeout(resolve, 30));

function setup(request?: (url: string, data: Record<string, unknown>) => Promise<any>, mobile = false) {
    const dom = new JSDOM('<div class="protyle"><div class="protyle-content"><div class="protyle-wysiwyg"><div data-type="NodeHeading" data-node-id="h1"><div contenteditable="true">标题</div></div></div></div></div>', { pretendToBeVisual: true });
    const win = dom.window;
    for (const key of ["window", "document", "Element", "Node", "HTMLElement", "DOMParser", "MutationObserver"]) {
        Object.defineProperty(globalThis, key, { value: key === "window" ? win : (win as any)[key], configurable: true, writable: true });
    }
    Object.assign(globalThis, { requestAnimationFrame: win.requestAnimationFrame.bind(win), cancelAnimationFrame: win.cancelAnimationFrame.bind(win) });
    win.HTMLElement.prototype.getClientRects = function () { return [this.getBoundingClientRect()] as any; };
    win.HTMLElement.prototype.getBoundingClientRect = () => ({ x: 40, y: 40, left: 40, right: 800, top: 40, bottom: 600, width: 760, height: 560, toJSON() {} });

    const calls: { url: string; data: Record<string, unknown> }[] = [];
    const navigations: { id: string; folded: boolean }[] = [];
    const transactions: any[] = [];
    const editors: HeadingEditor[] = [{
        element: win.document.querySelector('.protyle')!,
        content: win.document.querySelector('.protyle-wysiwyg')!,
        rootID: "doc1",
        notebook: "notebook1",
        preview: false,
        transaction: (operations, undoOperations) => transactions.push({ operations, undoOperations }),
    }];
    const menus: any[] = [];
    const levelMenus: { currentLevel: number; selectLevel(level: number): void }[] = [];
    let settings = normalizeSettings({ enableHeadingDock: true });

    const container = win.document.createElement("div");
    win.document.body.append(container);

    const dock = new HeadingOutlineDockView(container, {
        getEditors: () => editors,
        getSettings: () => settings,
        setListDepth: async depth => { settings = { ...settings, headingListDepth: depth }; },
        request: async (url, data) => {
            calls.push({ url, data });
            return request ? request(url, data) : url.endsWith("checkBlockFold") ? { isFolded: true } : tree;
        },
        navigate: (id, folded) => navigations.push({ id, folded }),
        reportError: () => {},
        openInsertMenu: (event, target) => { event.preventDefault(); menus.push(target); },
        openHeadingLevelMenu: (_target, currentLevel, selectLevel) => levelMenus.push({ currentLevel, selectLevel }),
        isMobile: () => mobile,
        newNodeID: () => "new-child-list",
    });

    return {
        win, editors, calls, navigations, transactions, menus, levelMenus, dock, container,
        setSettings: (value: Parameters<typeof normalizeSettings>[0]) => {
            settings = normalizeSettings(value);
            dock.refreshSettings();
        },
        cleanup: () => {
            dock.destroy();
            win.close();
        },
    };
}

test("标题拖动计划：支持同级排序、成为子标题并拒绝循环移动", () => {
    const entries = [
        { id: "h1", text: "一级", depth: 1, level: 1 },
        { id: "h3", text: "三级", depth: 2, level: 3 },
        { id: "h6", text: "六级", depth: 3, level: 6 },
        { id: "h2", text: "二级", depth: 1, level: 2 },
    ];
    assert.deepEqual(createHeadingMovePlan(entries, "h2", "h1", "before"), {
        operation: { action: "moveOutlineHeading", id: "h2" },
        undoOperation: { action: "moveOutlineHeading", id: "h2", previousID: "h1" },
    });
    assert.deepEqual(createHeadingMovePlan(entries, "h2", "h3", "inside"), {
        operation: { action: "moveOutlineHeading", id: "h2", previousID: "h6", parentID: "h3" },
        undoOperation: { action: "moveOutlineHeading", id: "h2", previousID: "h1" },
    });
    assert.deepEqual(createHeadingMovePlan(entries, "h3", "h2", "after"), {
        operation: { action: "moveOutlineHeading", id: "h3", previousID: "h2" },
        undoOperation: { action: "moveOutlineHeading", id: "h3", parentID: "h1" },
    });
    assert.equal(createHeadingMovePlan(entries, "h1", "h3", "inside"), null);
    assert.equal(createHeadingMovePlan(entries, "h6", "h3", "inside"), null);
});

test("列表项拖动计划：支持排序、缩进、取消缩进并拒绝循环移动", () => {
    const dom = new JSDOM('<div class="protyle-wysiwyg"><div class="list" data-type="NodeList" data-subtype="u" data-node-id="root-list">' +
        '<div data-type="NodeListItem" data-node-id="one"><div data-type="NodeParagraph">第一项</div>' +
        '<div class="list" data-type="NodeList" data-subtype="u" data-node-id="child-list">' +
        '<div data-type="NodeListItem" data-node-id="child-one"><div data-type="NodeParagraph">子项</div></div>' +
        '<div class="protyle-attr"></div></div></div>' +
        '<div data-type="NodeListItem" data-node-id="two"><div data-type="NodeParagraph">第二项</div></div>' +
        '<div data-type="NodeListItem" data-node-id="three"><div data-type="NodeParagraph">第三项</div></div>' +
        '<div class="protyle-attr"></div></div></div>');
    const root = dom.window.document.querySelector(".protyle-wysiwyg")!;
    const directItemIDs = (list: Element) => Array.from(list.children)
        .filter(child => child.matches('[data-type="NodeListItem"]'))
        .map(item => (item as HTMLElement).dataset.nodeId);
    const updatedRoot = (data: string) => new dom.window.DOMParser().parseFromString(data, "text/html")
        .body.firstElementChild!;

    const reordered = createListItemMovePlan(root, "three", "one", "before", () => "unused")!;
    assert.deepEqual(directItemIDs(updatedRoot(reordered.operations[0].data)), ["three", "one", "two"]);
    assert.equal(reordered.undoOperations[0].data, root.firstElementChild!.outerHTML);

    const indented = createListItemMovePlan(root, "three", "one", "inside", () => "unused")!;
    const indentedRoot = updatedRoot(indented.operations[0].data);
    const childList = indentedRoot.querySelector('[data-node-id="one"] > [data-type="NodeList"]')!;
    assert.deepEqual(directItemIDs(childList), ["child-one", "three"]);

    const outdented = createListItemMovePlan(root, "child-one", "two", "after", () => "unused")!;
    const outdentedRoot = updatedRoot(outdented.operations[0].data);
    assert.deepEqual(directItemIDs(outdentedRoot), ["one", "two", "child-one", "three"]);
    assert.equal(outdentedRoot.querySelector('[data-node-id="child-list"]'), null);

    assert.equal(createListItemMovePlan(root, "one", "child-one", "inside", () => "unused"), null);
    dom.window.close();
});

test("列表项拖动计划：有序列表排序后保留原起始编号", () => {
    const dom = new JSDOM('<div><div data-type="NodeList" data-subtype="o" data-node-id="ordered">' +
        '<div data-type="NodeListItem" data-node-id="five" data-marker="5."></div>' +
        '<div data-type="NodeListItem" data-node-id="six" data-marker="6."></div>' +
        '<div data-type="NodeListItem" data-node-id="seven" data-marker="7."></div></div></div>');
    const root = dom.window.document.querySelector("div")!;
    const plan = createListItemMovePlan(root, "five", "seven", "after", () => "unused")!;
    const updated = new dom.window.DOMParser().parseFromString(plan.operations[0].data, "text/html");
    const items = Array.from(updated.querySelectorAll<HTMLElement>('[data-type="NodeListItem"]'));
    assert.deepEqual(items.map(item => item.dataset.nodeId), ["six", "seven", "five"]);
    assert.deepEqual(items.map(item => item.dataset.marker), ["5.", "6.", "7."]);
    dom.window.close();
});

test("大纲增强 Dock：拖到标题中部后提交成为子标题的可撤销事务", async () => {
    const env = setup();
    try {
        await settle();
        const source = env.container.querySelector<HTMLButtonElement>('button[data-id="h2"]')!;
        const target = env.container.querySelector<HTMLButtonElement>('button[data-id="h3"]')!;
        target.getBoundingClientRect = () => ({
            x: 40, y: 100, left: 40, right: 300, top: 100, bottom: 128, width: 260, height: 28, toJSON() {},
        });

        source.dispatchEvent(new env.win.MouseEvent("mousedown", {
            bubbles: true, button: 0, clientX: 60, clientY: 50,
        }));
        target.dispatchEvent(new env.win.MouseEvent("mousemove", {
            bubbles: true, clientX: 80, clientY: 114,
        }));
        assert.equal(target.classList.contains("dragover"), true);
        env.win.document.dispatchEvent(new env.win.MouseEvent("mouseup", { bubbles: true }));

        assert.deepEqual(env.transactions, [{
            operations: [{ action: "moveOutlineHeading", id: "h2", previousID: "h6", parentID: "h3" }],
            undoOperations: [{ action: "moveOutlineHeading", id: "h2", previousID: "h1" }],
        }]);
        assert.equal(env.container.querySelector(".heading-outline-dock__body")?.getAttribute("data-loading"), "true");
        source.click();
        assert.equal(env.navigations.length, 0);
    } finally { env.cleanup(); }
});

test("大纲增强 Dock：列表项拖到另一项中部后提交缩进事务", async () => {
    const snapshot = '<div data-type="NodeHeading" data-node-id="h1"></div>' +
        '<div class="list" data-type="NodeList" data-subtype="u" data-node-id="root-list">' +
        '<div data-type="NodeListItem" data-node-id="one"><div data-type="NodeParagraph"><div contenteditable="true">第一项</div></div></div>' +
        '<div data-type="NodeListItem" data-node-id="two"><div data-type="NodeParagraph"><div contenteditable="true">第二项</div></div></div>' +
        '<div class="protyle-attr"></div></div>';
    const env = setup(async url => url.endsWith("getBlockDOM") ? { dom: snapshot } : tree.slice(0, 1));
    try {
        env.editors[0].content.innerHTML = snapshot;
        env.setSettings({ enableHeadingDock: true, headingListDepth: 2 });
        await new Promise(resolve => setTimeout(resolve, 680));
        const source = env.container.querySelector<HTMLButtonElement>('button[data-id="two"]')!;
        const target = env.container.querySelector<HTMLButtonElement>('button[data-id="one"]')!;
        const originalRootHTML = env.editors[0].content.querySelector('[data-node-id="root-list"]')!.outerHTML;
        assert.equal(source.dataset.draggableOutline, "list");
        target.getBoundingClientRect = () => ({
            x: 40, y: 100, left: 40, right: 300, top: 100, bottom: 128, width: 260, height: 28, toJSON() {},
        });

        source.dispatchEvent(new env.win.MouseEvent("mousedown", {
            bubbles: true, button: 0, clientX: 60, clientY: 50,
        }));
        target.dispatchEvent(new env.win.MouseEvent("mousemove", {
            bubbles: true, clientX: 80, clientY: 114,
        }));
        assert.equal(target.classList.contains("dragover"), true);
        env.win.document.dispatchEvent(new env.win.MouseEvent("mouseup", { bubbles: true }));

        assert.equal(env.transactions.length, 1);
        assert.equal(env.transactions[0].operations[0].action, "update");
        assert.equal(env.transactions[0].operations[0].id, "root-list");
        const updated = new env.win.DOMParser().parseFromString(
            env.transactions[0].operations[0].data, "text/html"
        );
        const nested = updated.querySelector('[data-node-id="one"] > [data-type="NodeList"]')!;
        assert.equal((nested as HTMLElement).dataset.nodeId, "new-child-list");
        assert.deepEqual(Array.from(nested.children)
            .filter(child => child.matches('[data-type="NodeListItem"]'))
            .map(item => (item as HTMLElement).dataset.nodeId), ["two"]);
        assert.equal(env.transactions[0].undoOperations[0].data, originalRootHTML);
        assert.ok(env.editors[0].content.querySelector(
            '[data-node-id="one"] > [data-node-id="new-child-list"] > [data-node-id="two"]'
        ));
    } finally { env.cleanup(); }
});

test("大纲增强 Dock：关闭设置时不再显示禁用提示", async () => {
    const env = setup();
    try {
        await settle();
        let rows = env.container.querySelectorAll<HTMLButtonElement>("button.heading-outline-dock__item");
        assert.equal(rows.length, 4);
        assert.equal(env.container.querySelector(".heading-outline-dock__header .block__logo use"), null);

        // Dock 的注册/移除由插件生命周期处理，视图本身不再渲染“已禁用”提示。
        env.setSettings({ enableHeadingDock: false });
        await settle();
        rows = env.container.querySelectorAll<HTMLButtonElement>("button.heading-outline-dock__item");
        const status = env.container.querySelector<HTMLElement>(".heading-outline-dock__status")!;
        assert.equal(rows.length, 4);
        assert.equal(status.textContent?.includes("关闭"), false);
    } finally { env.cleanup(); }
});

test("大纲增强 Dock：搜索过滤、高亮匹配项及 Esc 清空", async () => {
    const env = setup();
    try {
        await settle();
        const searchInput = env.container.querySelector<HTMLInputElement>(".heading-outline-dock__search-input")!;
        assert.ok(searchInput);

        // 搜索 "三级"
        searchInput.value = "三级";
        searchInput.dispatchEvent(new env.win.Event("input"));
        await settle();

        let rows = env.container.querySelectorAll<HTMLButtonElement>("button.heading-outline-dock__item");
        assert.equal(rows.length, 1);
        assert.equal(rows[0].dataset.id, "h3");
        const match = rows[0].querySelector<HTMLElement>(".list-outline-floating__match")!;
        assert.ok(match);
        assert.equal(match.textContent, "三级");

        // 搜索无匹配
        searchInput.value = "无结果关键词";
        searchInput.dispatchEvent(new env.win.Event("input"));
        await settle();
        rows = env.container.querySelectorAll<HTMLButtonElement>("button.heading-outline-dock__item");
        assert.equal(rows.length, 0);
        const status = env.container.querySelector<HTMLElement>(".heading-outline-dock__status")!;
        assert.equal(status.textContent, "无匹配结果");

        // 按 Escape 清空
        searchInput.dispatchEvent(new env.win.KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
        await settle();
        assert.equal(searchInput.value, "");
        rows = env.container.querySelectorAll<HTMLButtonElement>("button.heading-outline-dock__item");
        assert.equal(rows.length, 4);
    } finally { env.cleanup(); }
});

test("大纲增强 Dock：点击定位与右键菜单插入同级", async () => {
    const env = setup();
    try {
        await settle();
        const row = env.container.querySelector<HTMLButtonElement>('button[data-id="h3"]')!;
        assert.ok(row);

        // 点击定位
        row.click();
        await settle();
        assert.deepEqual(env.navigations.at(-1), { id: "h3", folded: true });

        // 右键插入菜单
        row.dispatchEvent(new env.win.MouseEvent("contextmenu", { bubbles: true }));
        assert.equal(env.menus.at(-1)?.id, "h3");
        assert.equal(env.menus.at(-1)?.kind, "heading");
    } finally { env.cleanup(); }
});

test("大纲增强 Dock：用箭头折叠和展开标题后代，搜索时仍可找到隐藏标题", async () => {
    const env = setup();
    try {
        await settle();
        const visibleIds = () => Array.from(env.container.querySelectorAll<HTMLButtonElement>("button[data-id]"))
            .map(row => row.dataset.id);
        let toggle = env.container.querySelector<HTMLButtonElement>('button[data-outline-toggle="h3"]')!;
        assert.ok(toggle);
        assert.equal(toggle.getAttribute("aria-expanded"), "true");
        assert.equal(toggle.querySelector("use")?.getAttribute("href"), "#iconDown");

        toggle.click();
        assert.deepEqual(visibleIds(), ["h1", "h3", "h2"]);
        assert.equal(env.navigations.length, 0);
        toggle = env.container.querySelector<HTMLButtonElement>('button[data-outline-toggle="h3"]')!;
        assert.equal(toggle.getAttribute("aria-expanded"), "false");
        assert.equal(toggle.querySelector("use")?.getAttribute("href"), "#iconRight");

        const searchInput = env.container.querySelector<HTMLInputElement>(".heading-outline-dock__search-input")!;
        searchInput.value = "六级";
        searchInput.dispatchEvent(new env.win.Event("input"));
        assert.deepEqual(visibleIds(), ["h6"]);
        assert.equal(env.container.querySelector("[data-outline-toggle]"), null);

        searchInput.value = "";
        searchInput.dispatchEvent(new env.win.Event("input"));
        toggle = env.container.querySelector<HTMLButtonElement>('button[data-outline-toggle="h3"]')!;
        toggle.click();
        assert.deepEqual(visibleIds(), ["h1", "h3", "h6", "h2"]);
    } finally { env.cleanup(); }
});

test("大纲增强 Dock：支持全部折叠、全部展开和按实际标题级别展开", async () => {
    const env = setup();
    try {
        await settle();
        const visibleIds = () => Array.from(env.container.querySelectorAll<HTMLButtonElement>("button[data-id]"))
            .map(row => row.dataset.id);
        const toolbar = env.container.querySelector(".heading-outline-dock__header")!;

        const collapseAll = toolbar.querySelector<HTMLButtonElement>('button[data-action="collapse-all"]')!;
        const expandAll = toolbar.querySelector<HTMLButtonElement>('button[data-action="expand-all"]')!;
        const expandLevel = toolbar.querySelector<HTMLButtonElement>('button[data-action="expand-level"]')!;
        const minimize = toolbar.querySelector<HTMLButtonElement>('button[data-action="minimize"]')!;
        assert.equal(collapseAll.querySelector("use")?.getAttribute("href"), "#iconContract");
        assert.equal(expandAll.querySelector("use")?.getAttribute("href"), "#iconExpand");
        assert.equal(expandLevel.querySelector("use")?.getAttribute("href"), "#iconExpandLevel");
        assert.equal(minimize.querySelector("use")?.getAttribute("href"), "#iconMin");
        assert.equal(minimize.dataset.type, "min");
        let delegatedMinimizeClicks = 0;
        env.container.addEventListener("click", event => {
            if ((event.target as Element).closest('[data-type="min"]')) delegatedMinimizeClicks++;
        });
        minimize.click();
        assert.equal(delegatedMinimizeClicks, 1);

        collapseAll.click();
        assert.deepEqual(visibleIds(), ["h1", "h2"]);

        expandAll.click();
        assert.deepEqual(visibleIds(), ["h1", "h3", "h6", "h2"]);

        let expandLevelClickBubbled = false;
        const onDocumentClick = () => { expandLevelClickBubbled = true; };
        env.win.document.addEventListener("click", onDocumentClick);
        expandLevel.click();
        env.win.document.removeEventListener("click", onDocumentClick);
        assert.equal(expandLevelClickBubbled, false);
        assert.equal(env.levelMenus.at(-1)?.currentLevel, 6);
        env.levelMenus.at(-1)!.selectLevel(3);
        assert.deepEqual(visibleIds(), ["h1", "h3", "h2"]);

        expandLevel.click();
        assert.equal(env.levelMenus.at(-1)?.currentLevel, 3);
        env.levelMenus.at(-1)!.selectLevel(4);
        assert.deepEqual(visibleIds(), ["h1", "h3", "h6", "h2"]);
    } finally { env.cleanup(); }
});

test("大纲增强 Dock：移动端不显示最小化按钮", async () => {
    const env = setup(undefined, true);
    try {
        await settle();
        assert.equal(env.container.querySelector('button[data-action="minimize"]'), null);
    } finally { env.cleanup(); }
});

test("大纲增强 Dock：支持分别折叠段落和列表项的子项", async () => {
    const headings = [
        { id: "h1", name: "章节一", subType: "h1" },
        { id: "h2", name: "章节二", subType: "h2" },
    ];
    const snapshot = '<div data-type="NodeHeading" data-node-id="h1"></div>' +
        '<div data-type="NodeParagraph" data-node-id="list-parent"><div contenteditable="true">列表说明</div></div>' +
        '<div data-type="NodeList" data-node-id="list"><div data-type="NodeListItem" data-node-id="one">' +
        '<div data-type="NodeParagraph"><div contenteditable="true">第一项</div></div>' +
        '<div data-type="NodeList" data-node-id="child"><div data-type="NodeListItem" data-node-id="two">' +
        '<div data-type="NodeParagraph"><div contenteditable="true">子项</div></div></div></div></div>' +
        '<div data-type="NodeListItem" data-node-id="three"><div data-type="NodeParagraph">' +
        '<div contenteditable="true">同级项</div></div></div></div>' +
        '<div data-type="NodeHeading" data-node-id="h2"></div>';
    const env = setup(async url => url.endsWith("getBlockDOM") ? { dom: snapshot } : headings);
    try {
        env.setSettings({ enableHeadingDock: true, headingListDepth: 3 });
        await settle();
        const visibleIds = () => Array.from(env.container.querySelectorAll<HTMLButtonElement>("button[data-id]"))
            .map(row => row.dataset.id);

        env.container.querySelector<HTMLButtonElement>('button[data-outline-toggle="one"]')!.click();
        assert.deepEqual(visibleIds(), ["h1", "list-parent", "one", "three", "h2"]);

        env.container.querySelector<HTMLButtonElement>('button[data-outline-toggle="list-parent"]')!.click();
        assert.deepEqual(visibleIds(), ["h1", "list-parent", "h2"]);

        env.container.querySelector<HTMLButtonElement>('button[data-outline-toggle="list-parent"]')!.click();
        assert.deepEqual(visibleIds(), ["h1", "list-parent", "one", "three", "h2"]);

        env.container.querySelector<HTMLButtonElement>('button[data-outline-toggle="one"]')!.click();
        assert.deepEqual(visibleIds(), ["h1", "list-parent", "one", "two", "three", "h2"]);
    } finally { env.cleanup(); }
});

test("大纲增强 Dock：鼠标移入只更新高亮，点击时才滚动到对应条目", async () => {
    const env = setup();
    try {
        await settle();
        assert.equal(env.container.querySelector('button[aria-label="定位当前位置"]'), null);
        const h1El = env.win.document.querySelector<HTMLElement>('[data-node-id="h1"]')!;
        h1El.dispatchEvent(new env.win.MouseEvent("pointerover", { bubbles: true }));
        assert.equal(env.container.querySelector<HTMLButtonElement>("button.b3-list-item--focus")?.dataset.id, "h1");

        const h3El = env.win.document.createElement("div");
        h3El.dataset.type = "NodeHeading";
        h3El.dataset.nodeId = "h3";
        h3El.innerHTML = '<div contenteditable="true">三级标题</div>';
        h3El.getBoundingClientRect = () => ({ ...h1El.getBoundingClientRect(), top: 200 });
        env.editors[0].content.append(h3El);
        let scrolled = false;
        env.container.querySelector<HTMLElement>('button[data-id="h3"]')!.scrollIntoView = () => { scrolled = true; };
        h3El.firstElementChild!.dispatchEvent(new env.win.MouseEvent("pointerover", { bubbles: true }));
        env.dock.syncEditors();
        assert.equal(env.container.querySelector<HTMLButtonElement>("button.b3-list-item--focus")?.dataset.id, "h3");
        assert.equal(scrolled, false);
        h3El.firstElementChild!.dispatchEvent(new env.win.MouseEvent("click", { bubbles: true }));
        assert.equal(env.container.querySelector<HTMLButtonElement>("button.b3-list-item--focus")?.dataset.id, "h3");
        assert.equal(scrolled, true);

        const paragraph = env.win.document.createElement("div");
        paragraph.dataset.type = "NodeParagraph";
        paragraph.innerHTML = '<div contenteditable="true">普通段落</div>';
        env.editors[0].content.append(paragraph);
        h1El.click();
        paragraph.firstElementChild!.dispatchEvent(new env.win.MouseEvent("pointerover", { bubbles: true }));
        assert.equal(env.container.querySelector<HTMLButtonElement>("button.b3-list-item--focus")?.dataset.id, "h3");
        paragraph.firstElementChild!.dispatchEvent(new env.win.MouseEvent("click", { bubbles: true }));
        assert.equal(env.container.querySelector<HTMLButtonElement>("button.b3-list-item--focus")?.dataset.id, "h3");
    } finally { env.cleanup(); }
});

test("大纲增强 Dock：鼠标位于空列表项时直接高亮空列表项", async () => {
    const snapshot = '<div data-type="NodeHeading" data-node-id="h1"></div>' +
        '<div data-type="NodeList" data-node-id="list">' +
        '<div data-type="NodeListItem" data-node-id="filled"><div data-type="NodeParagraph" data-node-id="filled-p">' +
        '<div contenteditable="true">已有内容</div></div></div>' +
        '<div data-type="NodeListItem" data-node-id="empty"><div data-type="NodeParagraph" data-node-id="empty-p">' +
        '<div contenteditable="true"><br></div></div></div></div>';
    const env = setup(async url => url.endsWith("getBlockDOM") ? { dom: snapshot } : tree.slice(0, 1));
    try {
        env.editors[0].content.innerHTML = snapshot;
        env.setSettings({ enableHeadingDock: true, headingListDepth: 1 });
        await new Promise(resolve => setTimeout(resolve, 680));
        const emptyContent = env.editors[0].content.querySelector<HTMLElement>(
            '[data-node-id="empty"] [contenteditable="true"]'
        )!;

        emptyContent.dispatchEvent(new env.win.MouseEvent("pointerover", { bubbles: true }));

        const current = env.container.querySelector<HTMLButtonElement>("button.b3-list-item--focus");
        assert.equal(current?.dataset.id, "empty");
        assert.equal(current?.textContent, "（空列表项）");
    } finally { env.cleanup(); }
});

test("大纲增强 Dock：聚焦列表前的父级段落时高亮该段落而非前一项", async () => {
    const snapshot = '<div data-type="NodeHeading" data-node-id="h1"></div>' +
        '<div data-type="NodeParagraph" data-node-id="list-parent"><div contenteditable="true">列表说明</div></div>' +
        '<div data-type="NodeList" data-node-id="list">' +
        '<div data-type="NodeListItem" data-node-id="one"><div data-type="NodeParagraph">' +
        '<div contenteditable="true">第一项</div></div></div></div>';
    const env = setup(async url => url.endsWith("getBlockDOM") ? { dom: snapshot } : tree.slice(0, 1));
    try {
        env.editors[0].content.innerHTML = snapshot;
        env.setSettings({ enableHeadingDock: true, headingListDepth: 1 });
        await new Promise(resolve => setTimeout(resolve, 680));
        const content = env.editors[0].content.querySelector<HTMLElement>('[data-node-id="list-parent"] [contenteditable="true"]')!;

        content.dispatchEvent(new env.win.FocusEvent("focusin", { bubbles: true }));

        assert.equal(env.container.querySelector<HTMLButtonElement>("button.b3-list-item--focus")?.dataset.id,
            "list-parent");
    } finally { env.cleanup(); }
});

test("大纲增强 Dock：同步高亮不强制滚动列表到当前标题", async () => {
    const env = setup();
    try {
        await settle();
        const body = env.container.querySelector<HTMLElement>(".heading-outline-dock__body")!;
        const currentRow = env.container.querySelector<HTMLElement>('button[data-id="h1"]')!;
        let scrolled = false;
        currentRow.scrollIntoView = () => { scrolled = true; };
        body.scrollTop = 80;

        env.dock.syncEditors();

        assert.equal(scrolled, false);
        assert.equal(body.scrollTop, 80);
        assert.equal(currentRow.classList.contains("b3-list-item--focus"), true);
    } finally { env.cleanup(); }
});

test("大纲增强 Dock：列表下拉框选择不显示或具体显示层级", async () => {
    const snapshot = '<div data-type="NodeHeading" data-node-id="h1"></div>' +
        '<div data-type="NodeList" data-node-id="list"><div data-type="NodeListItem" data-node-id="l1">' +
        '<div data-type="NodeParagraph"><div contenteditable="true">一级列表</div></div>' +
        '<div data-type="NodeList" data-node-id="child"><div data-type="NodeListItem" data-node-id="l2">' +
        '<div data-type="NodeParagraph"><div contenteditable="true">二级列表</div></div></div></div></div></div>' +
        '<div class="tabs" data-type="NodeTabs" data-node-id="tabs"><div class="tab-item" data-type="NodeTabItem" data-node-id="tab-one">' +
        '<div class="tab-item-info"><div data-type="NodeParagraph" tabs-title="true"><div class="tab-item-title" contenteditable="true">实验数据</div></div></div>' +
        '<div class="tab-item-content"><div data-type="NodeParagraph"><div contenteditable="true">正文不显示</div></div></div></div></div>';
    const env = setup(async url => url.endsWith("getBlockDOM") ? { dom: snapshot } : tree);
    try {
        await settle();
        const select = env.container.querySelector<HTMLSelectElement>('select[aria-label="大纲增强列表层级"]')!;
        assert.equal(select.value, "0");
        assert.equal(env.calls.some(call => call.url.endsWith("getBlockDOM")), false);

        select.value = "1";
        select.dispatchEvent(new env.win.Event("change"));
        await settle();
        assert.ok(env.container.querySelector('[data-id="l1"]'));
        assert.equal(env.container.querySelector('[data-id="l2"]'), null);
        const tabRow = env.container.querySelector<HTMLButtonElement>('[data-id="tab-one"]')!;
        assert.equal(tabRow.querySelector("use")?.getAttribute("href"), "#iconTabItem");
        assert.equal(tabRow.querySelector(".heading-outline-dock__text")?.textContent, "实验数据");

        env.editors[0].content.innerHTML = snapshot;
        const listContent = env.editors[0].content.querySelector('[data-node-id="l1"] [contenteditable]')!;
        listContent.dispatchEvent(new env.win.MouseEvent("pointerover", { bubbles: true }));
        assert.equal(env.container.querySelector<HTMLButtonElement>("button.b3-list-item--focus")?.dataset.id, "l1");
        listContent.dispatchEvent(new env.win.MouseEvent("click", { bubbles: true }));
        assert.equal(env.container.querySelector<HTMLButtonElement>("button.b3-list-item--focus")?.dataset.id, "l1");

        select.value = "0";
        select.dispatchEvent(new env.win.Event("change"));
        await settle();
        assert.equal(env.container.querySelector('[data-id="l1"]'), null);
        assert.equal(env.container.querySelector('[data-id="tab-one"]'), null);
    } finally { env.cleanup(); }
});

test("大纲增强 Dock：纯图片列表项显示图片，alt 不作为可见文本", async () => {
    const snapshot = '<div data-type="NodeList" data-node-id="list"><div data-type="NodeListItem" data-node-id="image-only">' +
        '<div data-type="NodeParagraph"><div contenteditable="true"><span data-type="img" class="img">' +
        '<img src="assets/result.png" alt="不显示的文件名"></span></div></div></div></div>';
    const env = setup(async url => url.endsWith("getBlockDOM") ? { dom: snapshot } : tree);
    try {
        await settle();
        env.setSettings({ enableHeadingDock: true, headingListDepth: 1 });
        await settle();
        const row = env.container.querySelector<HTMLButtonElement>('button[data-id="image-only"]')!;
        assert.ok(row);
        assert.equal(row.querySelector("img")?.getAttribute("src"), "assets/result.png");
        assert.equal(row.querySelector(".heading-outline-dock__text")?.textContent, "");
    } finally { env.cleanup(); }
});

test("大纲增强 Dock：显示并定位嵌入块里的列表项", async () => {
    const snapshot = '<div data-type="NodeHeading" data-node-id="h1"></div>' +
        '<div data-type="NodeBlockQueryEmbed" data-node-id="embed-one"></div>';
    const env = setup(async url => url.endsWith("getBlockDOM") ? { dom: snapshot } : tree);
    try {
        env.editors[0].content.innerHTML = '<div data-type="NodeHeading" data-node-id="h1"></div>' +
            '<div data-type="NodeBlockQueryEmbed" data-node-id="embed-one"><div class="protyle-wysiwyg__embed">' +
            '<div data-type="NodeList" data-node-id="embedded-list"><div data-type="NodeListItem" data-node-id="embedded-item">' +
            '<div data-type="NodeParagraph"><div contenteditable="true">嵌入列表项</div></div></div></div></div></div>';
        const target = env.editors[0].content.querySelector<HTMLElement>('[data-node-id="embedded-item"]')!;
        let scrolled = false;
        target.scrollIntoView = () => { scrolled = true; };
        env.setSettings({ enableHeadingDock: true, headingListDepth: 2 });
        await new Promise(resolve => setTimeout(resolve, 680));

        const row = env.container.querySelector<HTMLButtonElement>('[data-id="embedded-item"]')!;
        assert.ok(row);
        assert.equal(row.dataset.embedId, "embed-one");
        row.click();
        await settle();
        assert.equal(scrolled, true);
        assert.equal(env.navigations.length, 0);

        const event = new env.win.MouseEvent("contextmenu", { bubbles: true, cancelable: true });
        row.dispatchEvent(event);
        assert.equal(event.defaultPrevented, true);
        assert.equal(env.menus.length, 0);
    } finally { env.cleanup(); }
});
