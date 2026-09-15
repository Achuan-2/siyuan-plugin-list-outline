import { strict as assert } from "node:assert";
import { test } from "node:test";
import { JSDOM } from "jsdom";
import { insertOutlineSibling, insertIntoOutlineEditor, type OutlineInsertTarget } from "../src/outlineInsert";

function setup(kind: "heading" | "list", subtype: string) {
    const dom = new JSDOM();
    Object.assign(globalThis, { DOMParser: dom.window.DOMParser });
    const target: OutlineInsertTarget = { id: "anchor", kind, editor: dom.window.document.body };
    const calls: { url: string; data: any }[] = [];
    let count = 0;
    const request = async (url: string, data: any) => {
        calls.push({ url, data });
        if (url.endsWith("getBlockDOM")) return { dom: `<div data-node-id="anchor" data-type="${kind === "heading" ? "NodeHeading" : "NodeListItem"}" data-subtype="${subtype}" data-marker="7." data-task="x" custom-test="keep"><div contenteditable="true">已有正文</div></div>` };
        if (url.endsWith("getHeadingDeleteTransaction")) return { doOperations: [{ id: "anchor", action: "delete" }, { id: "section-end", action: "delete" }] };
        return [{ doOperations: [{ action: "insert", id: "new-block" }] }];
    };
    return { dom, target, calls, request, newID: () => `20260915120000-aaaaaa${++count}` };
}

test("上方插入保持标题级别，下方插入锚定整个章节末尾", async () => {
    for (const direction of ["before", "after"] as const) {
        const env = setup("heading", "h3");
        try {
            assert.equal(await insertOutlineSibling(env.target, direction, env.request, env.newID, () => true), "new-block");
            const write = env.calls.at(-1)!;
            assert.equal(write.url, "/api/block/insertBlock");
            assert.equal(write.data[direction === "before" ? "nextID" : "previousID"], direction === "before" ? "anchor" : "section-end");
            const block = new env.dom.window.DOMParser().parseFromString(write.data.data, "text/html").body.firstElementChild!;
            assert.equal(block.getAttribute("data-subtype"), "h3");
            assert.equal(block.textContent, "");
            assert.ok(!write.data.data.includes("已有正文"));
            assert.ok(env.calls.every(call => !call.url.includes("deleteBlock") && !call.url.includes("transactions")));
        } finally { env.dom.window.close(); }
    }
});

test("列表上下插入同级项，保留类型、不复制正文子项和属性，任务未完成", async () => {
    for (const subtype of ["u", "o", "t"]) for (const direction of ["before", "after"] as const) {
        const env = setup("list", subtype);
        try {
            await insertOutlineSibling(env.target, direction, env.request, env.newID, () => true);
            const write = env.calls.at(-1)!.data;
            assert.equal(write[direction === "before" ? "nextID" : "previousID"], "anchor");
            const block = new env.dom.window.DOMParser().parseFromString(write.data, "text/html").body.firstElementChild!;
            assert.equal(block.getAttribute("data-type"), "NodeListItem");
            assert.equal(block.getAttribute("data-subtype"), subtype);
            assert.equal(block.querySelectorAll('[data-type="NodeParagraph"]').length, 1);
            assert.equal(block.querySelector('[contenteditable="true"]')!.textContent, "");
            assert.equal(block.hasAttribute("custom-test"), false);
            if (subtype === "t") assert.equal(block.getAttribute("data-task"), " ");
            if (subtype === "o") assert.equal(block.getAttribute("data-marker"), direction === "before" ? "7." : "8.");
            assert.equal(env.calls.length, 2);
        } finally { env.dom.window.close(); }
    }
});

test("插入前重新检查编辑权限和块类型，失败不提交写入", async () => {
    const env = setup("heading", "h2");
    try {
        await assert.rejects(insertOutlineSibling(env.target, "before", env.request, env.newID, () => false), /不可编辑/);
        assert.equal(env.calls.length, 1);
        await assert.rejects(insertOutlineSibling({ ...env.target, kind: "list" }, "after", env.request, env.newID, () => true), /类型已改变/);
        assert.equal(env.calls.length, 2);
    } finally { env.dom.window.close(); }
});

test("标题和列表上下插入立即渲染并定位，提交可撤销事务且不重复调用插入 API", async () => {
    for (const kind of ["heading", "list"] as const) for (const direction of ["before", "after"] as const) {
        const env = setup(kind, kind === "heading" ? "h3" : "u");
        try {
            env.dom.window.HTMLElement.prototype.scrollIntoView = () => {};
            const content = env.dom.window.document.body;
            content.innerHTML = '<div data-node-id="anchor"></div><div data-node-id="section-end"></div>';
            const transactions: any[] = [];
            const id = await insertOutlineSibling(env.target, direction, env.request, env.newID, () => true,
                operation => insertIntoOutlineEditor(content, operation, (insert, undo) => {
                    assert.ok(content.querySelector(`[data-node-id="${insert.id}"]`), "提交前已渲染新块");
                    transactions.push({ insert, undo });
                }));
            assert.equal(transactions.length, 1);
            assert.deepEqual(transactions[0].undo, { action: "delete", id });
            assert.ok(env.calls.every(call => !call.url.endsWith("insertBlock")));
            const block = content.querySelector(`[data-node-id="${id}"]`)!;
            assert.equal(direction === "before" ? block.nextElementSibling?.getAttribute("data-node-id")
                : block.previousElementSibling?.getAttribute("data-node-id"),
            kind === "heading" && direction === "after" ? "section-end" : "anchor");
            assert.ok(block.contains(env.dom.window.getSelection()!.anchorNode));
        } finally { env.dom.window.close(); }
    }
});

test("未加载或折叠锚点退回 API 插入，不向错误位置添加本地块", async () => {
    for (const html of ['', '<div fold="1"><div data-node-id="anchor"></div></div>']) {
        const env = setup("list", "t");
        try {
            env.dom.window.document.body.innerHTML = html;
            const id = await insertOutlineSibling(env.target, "after", env.request, env.newID, () => true,
                operation => insertIntoOutlineEditor(env.dom.window.document.body, operation, () => assert.fail("不应提交本地事务")));
            assert.equal(id, "new-block");
            assert.equal(env.calls.at(-1)!.url, "/api/block/insertBlock");
            assert.equal(env.dom.window.document.body.innerHTML, html);
        } finally { env.dom.window.close(); }
    }
});

test("本地事务同步失败时移除临时新块，不再次插入", async () => {
    const env = setup("list", "u");
    try {
        env.dom.window.document.body.innerHTML = '<div data-node-id="anchor"></div>';
        await assert.rejects(insertOutlineSibling(env.target, "after", env.request, env.newID, () => true,
            operation => insertIntoOutlineEditor(env.dom.window.document.body, operation, () => { throw new Error("事务失败"); })), /事务失败/);
        assert.equal(env.dom.window.document.body.children.length, 1);
        assert.ok(env.calls.every(call => !call.url.endsWith("insertBlock")));
    } finally { env.dom.window.close(); }
});
