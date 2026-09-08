const { test } = require("node:test");
const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { resolve } = require("node:path");
const { JSDOM } = require("jsdom");
const { createStorage } = require("./storage-mock.cjs");

const html = readFileSync(resolve(__dirname, "../popup.html"), "utf8");
const script = readFileSync(resolve(__dirname, "../popup.js"), "utf8");

function open(t, storage) {
    const dom = new JSDOM(html, { runScripts: "outside-only" });
    t.after(() => dom.window.close());
    dom.window.chrome = storage.chrome;
    dom.window.eval(script);
    return {
        button: dom.window.document.querySelector("#toggle"),
        hint: dom.window.document.querySelector("#hint"),
    };
}

test("popup waits for the saved preference before allowing a click", t => {
    const storage = createStorage({ enabled: false });
    const popup = open(t, storage);
    assert.equal(popup.button.disabled, true);
    popup.button.click();
    assert.equal(storage.writes.length, 0);
    storage.resolveReads();
    assert.equal(popup.button.getAttribute("aria-checked"), "false");
    assert.equal(popup.button.disabled, false);
});

test("popup toggles once, persists the choice and restores it when reopened", async t => {
    const storage = createStorage();
    const popup = open(t, storage);
    storage.resolveReads();
    assert.equal(popup.button.getAttribute("aria-checked"), "true");
    assert.equal(popup.button.textContent, "Включено");
    popup.button.click();
    popup.button.click();
    assert.equal(popup.button.disabled, true);
    await Promise.resolve();
    assert.equal(storage.writes.length, 1);
    assert.equal(storage.data.enabled, false);
    assert.equal(popup.button.getAttribute("aria-checked"), "false");
    assert.equal(popup.button.textContent, "Выключено");
    const reopened = open(t, storage);
    storage.resolveReads();
    assert.equal(reopened.button.getAttribute("aria-checked"), "false");
    reopened.button.click();
    await Promise.resolve();
    assert.equal(storage.data.enabled, true);
    assert.equal(popup.button.getAttribute("aria-checked"), "true");
    assert.equal(popup.button.textContent, "Включено");
});

test("failed save leaves the previous state and allows retry", async t => {
    const storage = createStorage({ enabled: false });
    const popup = open(t, storage);
    storage.resolveReads();
    storage.failWrites = true;
    popup.button.click();
    await Promise.resolve();
    assert.equal(storage.data.enabled, false);
    assert.equal(popup.button.getAttribute("aria-checked"), "false");
    assert.equal(popup.button.disabled, false);
    assert.match(popup.hint.textContent, /\u041d\u0435 \u0443\u0434\u0430\u043b\u043e\u0441\u044c/);
    storage.failWrites = false;
    popup.button.click();
    await Promise.resolve();
    assert.equal(storage.data.enabled, true);
});

test("an older initial read does not override a newer change", t => {
    const storage = createStorage({ enabled: true });
    const popup = open(t, storage);
    storage.change(false);
    storage.resolveReads();
    assert.equal(popup.button.getAttribute("aria-checked"), "false");
});

test("a failed initial read cannot overwrite the saved preference", t => {
    const storage = createStorage({ enabled: false });
    const popup = open(t, storage);
    storage.failReads = true;
    storage.resolveReads();
    assert.equal(popup.button.disabled, true);
    assert.equal(storage.writes.length, 0);
});
