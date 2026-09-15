import { strict as assert } from "node:assert";
import { test } from "node:test";
import { JSDOM } from "jsdom";
import { compile } from "sass";
import { fileURLToPath } from "node:url";
import { blockDepth, DEPTH_ATTRIBUTE, extractOutline, findList, truncateText } from "../src/outline";
import { normalizeSettings } from "../src/defaultSettings";
import { ListOutlineController } from "../src/listOutline";

const paragraph = (text: string) => `<div data-type="NodeParagraph"><div contenteditable="true">${text}</div></div>`;
const item = (id: string, text: string, children = "") => `<div data-type="NodeListItem" data-node-id="${id}"><div class="protyle-action">1.</div>${paragraph(text)}${children}<div class="protyle-attr">备注</div></div>`;
const list = (id: string, children: string) => `<div data-type="NodeList" data-node-id="${id}">${children}</div>`;
const quote = (children: string) => `<div data-type="NodeBlockquote">${children}</div>`;
const outlineCss = compile(fileURLToPath(new URL("../src/index.scss", import.meta.url))).css;
const nested = list("root", item("one", "父项 <strong>加粗</strong>", paragraph("附加段落不应进入标题") +
    list("child-list", item("two", "子项", '<div data-type="NodeSuperBlock">' + list("grand-list", item("three", "孙项")) + '</div>'))) + item("four", "兄弟项"));

test("仅列表项生成层级，父标题不包含子列表、附加段落和块属性", () => {
    const document = new JSDOM(nested).window.document;
    assert.deepEqual(extractOutline(document.body.firstElementChild as HTMLElement, 3), [
        { id: "one", text: "父项 加粗", depth: 1 },
        { id: "two", text: "子项", depth: 2 },
        { id: "three", text: "孙项", depth: 3 },
        { id: "four", text: "兄弟项", depth: 1 },
    ]);
    assert.deepEqual(extractOutline(document.body.firstElementChild as HTMLElement, 1).map(entry => entry.id), ["one", "four"]);
});

test("空项、图片、公式、任务标记与 HTML 文本", () => {
    const document = new JSDOM(list("root", item("empty", "\u200b") + item("image", '<img alt="图片说明">') +
        item("math", '<span data-type="inline-math" data-content="x+y"><span>渲染副本</span></span>') + item("html", '&lt;img onerror=alert(1)&gt;'))).window.document;
    assert.deepEqual(extractOutline(document.body.firstElementChild as HTMLElement, 2).map(entry => entry.text), [
        "（空列表项）", "图片说明", "x+y", "<img onerror=alert(1)>",
    ]);
});

test("跳过引述块中的列表及其后代，保留正常子列表", () => {
    const document = new JSDOM(list("root", item("parent", "父项", quote(
        list("quoted", item("excluded", "引述列表", list("deep-quote", item("excluded-deep", "引述后代"))))) +
        list("normal", item("included", "正常子项"))))).window.document;
    assert.deepEqual(extractOutline(document.body.firstElementChild as HTMLElement, 3), [
        { id: "parent", text: "父项", depth: 1 }, { id: "included", text: "正常子项", depth: 2 },
    ]);
    assert.deepEqual(extractOutline(document.querySelector('[data-node-id="quoted"]')!, 3), []);
});

test("引述中的文字不会作为列表项标题，独立引述列表不触发大纲", () => {
    const document = new JSDOM(`<div class="protyle-wysiwyg">${quote(list("quoted", item("excluded", "引述列表")))}${list("root",
        `<div data-type="NodeListItem" data-node-id="parent">${quote(paragraph("引述文字"))}${paragraph("自己的标题")}</div>`)}${list("outer", item("outer-item", "外部列表", quote(list("inner-quote", item("quoted-item", "引述中的子列表")))))}</div>`).window.document;
    assert.equal(findList(document.querySelector('[data-node-id="excluded"]')!), null);
    assert.equal(findList(document.querySelector('[data-node-id="quoted-item"]')!)?.dataset.nodeId, "outer");
    assert.equal(extractOutline(document.querySelector('[data-node-id="root"]')!, 3)[0].text, "自己的标题");
});

test("截断中文和完整 emoji，等长不加省略号", () => {
    assert.equal(truncateText("中文测试", 2), "中文…");
    assert.equal(truncateText("中文", 2), "中文");
    assert.equal(truncateText("👨‍👩‍👧‍👦你好", 2), "👨‍👩‍👧‍👦你…");
    assert.equal(truncateText("e\u0301xy", 1), "e\u0301…");
});

test("异常设置恢复默认，独立块层级只接受有效整数", () => {
    assert.deepEqual(normalizeSettings({ defaultDepth: 0, maxTextLength: NaN }), { defaultDepth: 3, maxTextLength: 20 });
    assert.deepEqual(normalizeSettings({ defaultDepth: 99, maxTextLength: 999 }), { defaultDepth: 20, maxTextLength: 200 });
    for (const value of [null, "", "0", "-1", "1.5", "21", "abc"]) assert.equal(blockDepth(value), null);
    assert.equal(blockDepth("4"), 4);
});

test("同一列表内移动保持根列表，非编辑器区域不触发", () => {
    const document = new JSDOM(`<div class="protyle-wysiwyg">${nested}</div>${list("outside", item("outside-item", "外部"))}`).window.document;
    assert.equal(findList(document.querySelector('[data-node-id="three"]')!)?.dataset.nodeId, "root");
    assert.equal(findList(document.querySelector('[data-node-id="outside-item"]')!), null);
});

function setup(request?: (url: string, data: any) => Promise<any>) {
    const dom = new JSDOM(`<div class="protyle-content"><div class="protyle-wysiwyg">${nested}${list("other", item("other-item", "另一列表"))}</div></div>`, { pretendToBeVisual: true });
    const win = dom.window;
    const style = win.document.createElement("style");
    style.textContent = outlineCss;
    win.document.head.append(style);
    for (const key of ["window", "document", "Element", "Node", "HTMLElement", "DOMParser", "MutationObserver", "Option"]) {
        Object.defineProperty(globalThis, key, { value: key === "window" ? win : (win as any)[key], configurable: true, writable: true });
    }
    Object.assign(globalThis, {
        requestAnimationFrame: win.requestAnimationFrame.bind(win),
        cancelAnimationFrame: win.cancelAnimationFrame.bind(win),
        ResizeObserver: class { observe() {} disconnect() {} },
    });
    win.HTMLElement.prototype.getClientRects = function () { return [this.getBoundingClientRect()] as any; };
    win.HTMLElement.prototype.getBoundingClientRect = () => ({ x: 40, y: 40, left: 40, right: 800, top: 40, bottom: 600, width: 760, height: 560, toJSON() {} });
    const writes: any[] = [];
    const errors: string[] = [];
    const controller = new ListOutlineController({
        getSettings: () => ({ defaultDepth: 3, maxTextLength: 4 }),
        request: request || (async (url, data) => {
            if (url.endsWith("setBlockAttrs")) { writes.push(data); return null; }
            if (url.endsWith("getBlockAttrs")) return {};
            return { dom: win.document.querySelector(`[data-node-id="${data.id}"]`)?.outerHTML };
        }),
        navigate: () => {}, reportError: message => errors.push(message),
    });
    const hover = (id: string) => win.document.querySelector(`[data-node-id="${id}"]`)!.dispatchEvent(new win.MouseEvent("pointerover", { bubbles: true }));
    const panel = win.document.querySelector<HTMLElement>(".list-outline-floating")!;
    const cleanup = () => { controller.destroy(); win.close(); };
    return { win, controller, hover, panel, writes, errors, cleanup };
}
const settle = () => new Promise(resolve => setTimeout(resolve, 30));

test("悬浮显示、独立层级保存及清除，卸载移除面板与监听", async () => {
    const env = setup();
    try {
        env.hover("one");
        await settle();
        assert.equal(env.panel.hidden, false);
        assert.equal(env.panel.querySelectorAll("button").length, 4);
        const select = env.panel.querySelector("select")!;
        select.value = "1";
        select.dispatchEvent(new env.win.Event("change"));
        await settle();
        assert.deepEqual(env.writes[0], { id: "root", attrs: { [DEPTH_ATTRIBUTE]: "1" } });
        assert.equal(env.panel.querySelectorAll("button").length, 2);
        select.value = "";
        select.dispatchEvent(new env.win.Event("change"));
        await settle();
        assert.equal(env.writes[1].attrs[DEPTH_ATTRIBUTE], "");
        assert.equal(env.panel.querySelectorAll("button").length, 4);
        env.controller.destroy();
        env.hover("one");
        assert.equal(env.win.document.querySelector(".list-outline-floating"), null);
    } finally { env.cleanup(); }
});

test("快速切换列表时旧请求不能覆盖新面板", async () => {
    let resolveOld: (value: any) => void = () => {};
    const env = setup(async (url, data) => {
        if (url.endsWith("getBlockAttrs")) return {};
        if (data.id === "root") return await new Promise(resolve => { resolveOld = resolve; });
        return { dom: list("other", item("other-item", "另一列表")) };
    });
    try {
        env.hover("one");
        env.hover("other-item");
        await settle();
        resolveOld({ dom: nested });
        await settle();
        assert.equal(env.panel.querySelectorAll("button").length, 1);
        assert.equal(env.panel.querySelector("button")?.dataset.id, "other-item");
    } finally { env.cleanup(); }
});

test("保存失败恢复选择，不修改列表块属性", async () => {
    const env = setup(async url => {
        if (url.endsWith("setBlockAttrs")) throw new Error("模拟保存失败");
        if (url.endsWith("getBlockAttrs")) return {};
        return { dom: nested };
    });
    try {
        env.hover("one");
        await settle();
        const select = env.panel.querySelector("select")!;
        select.value = "2";
        select.dispatchEvent(new env.win.Event("change"));
        await settle();
        assert.equal(select.value, "");
        assert.equal(select.disabled, false);
        assert.equal(env.win.document.querySelector('[data-node-id="root"]')?.hasAttribute(DEPTH_ATTRIBUTE), false);
        assert.equal(env.errors.length, 1);
    } finally { env.cleanup(); }
});

test("编辑后刷新，离开后隐藏", async () => {
    const env = setup();
    try {
        env.hover("one");
        await settle();
        const text = env.win.document.querySelector('[data-node-id="one"] [contenteditable]')!;
        text.textContent = "修改后的标题";
        await settle();
        assert.equal(env.panel.querySelector("button")?.title, "修改后的标题");
        env.win.document.body.dispatchEvent(new env.win.MouseEvent("pointerover", { bubbles: true }));
        await new Promise(resolve => setTimeout(resolve, 280));
        assert.equal(env.panel.hidden, true);
    } finally { env.cleanup(); }
});

test("服务端快照补齐编辑器中尚未渲染的折叠子列表", async () => {
    const env = setup(async url => url.endsWith("getBlockAttrs") ? {} : { dom: nested });
    try {
        env.win.document.querySelector('[data-node-id="child-list"]')!.remove();
        env.hover("one");
        assert.equal(env.panel.querySelectorAll("button").length, 2);
        await settle();
        assert.equal(env.panel.querySelectorAll("button").length, 4);
    } finally { env.cleanup(); }
});

test("鼠标移入悬浮面板不会关闭大纲", async () => {
    const env = setup();
    try {
        env.hover("one");
        env.win.document.querySelector('[data-node-id="one"]')!.dispatchEvent(
            new env.win.MouseEvent("pointerout", { bubbles: true, relatedTarget: env.panel }));
        env.panel.dispatchEvent(new env.win.MouseEvent("pointerover", { bubbles: true }));
        await new Promise(resolve => setTimeout(resolve, 280));
        assert.equal(env.panel.hidden, false);
    } finally { env.cleanup(); }
});

test("默认只显示层级线条，悬停展开文字和设置，离开后恢复线条且右边缘固定", async () => {
    const env = setup();
    try {
        env.hover("one");
        await settle();
        const header = env.panel.querySelector<HTMLElement>(".list-outline-floating__header")!;
        const text = env.panel.querySelector<HTMLElement>(".list-outline-floating__text")!;
        const line = env.panel.querySelector<HTMLElement>(".list-outline-floating__line")!;
        const right = () => parseFloat(env.panel.style.left) + parseFloat(env.panel.style.width);
        const compactRight = right();
        assert.equal(env.panel.style.width, "48px");
        assert.equal(env.win.getComputedStyle(header).display, "none");
        assert.equal(env.win.getComputedStyle(text).display, "none");
        assert.notEqual(env.win.getComputedStyle(line).display, "none");
        env.panel.dispatchEvent(new env.win.MouseEvent("pointerover", { bubbles: true }));
        assert.equal(env.panel.style.width, "300px");
        assert.equal(right(), compactRight);
        assert.equal(env.win.getComputedStyle(header).display, "flex");
        assert.equal(env.win.getComputedStyle(text).display, "block");
        assert.equal(env.win.getComputedStyle(line).display, "none");
        env.panel.dispatchEvent(new env.win.MouseEvent("pointerout", { bubbles: true,
            relatedTarget: env.win.document.querySelector('[data-node-id="one"]') }));
        assert.equal(env.panel.hidden, false);
        assert.equal(env.panel.style.width, "48px");
        assert.equal(right(), compactRight);
        assert.equal(env.win.getComputedStyle(text).display, "none");
    } finally { env.cleanup(); }
});
