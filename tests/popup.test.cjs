const { test } = require("node:test");
const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { resolve } = require("node:path");
const { JSDOM } = require("jsdom");
const { createStorage } = require("./storage-mock.cjs");

const html = readFileSync(resolve(__dirname, "../popup.html"), "utf8");
const script = readFileSync(resolve(__dirname, "../settings.js"), "utf8") + "\n" +
    readFileSync(resolve(__dirname, "../popup.js"), "utf8");

function open(t, storage) {
    const dom = new JSDOM(html, { runScripts: "outside-only" });
    t.after(() => dom.window.close());
    dom.window.chrome = storage.chrome;
    dom.window.eval(script);
    return {
        button: dom.window.document.querySelector("#toggle"),
        hint: dom.window.document.querySelector("#hint"),
        networks: Object.fromEntries([...dom.window.document.querySelectorAll("[data-network]")]
            .map(button => [button.dataset.network, button])),
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

test("old preferences default to YouTube only without resetting the switch", t => {
    const storage = createStorage({ enabled: false });
    const popup = open(t, storage);
    storage.resolveReads();
    assert.equal(popup.networks.youtube.getAttribute("aria-pressed"), "true");
    assert.equal(popup.networks.tiktok.getAttribute("aria-pressed"), "false");
    assert.equal(popup.networks.instagram.getAttribute("aria-pressed"), "false");
    assert.equal(popup.button.getAttribute("aria-checked"), "false");
    assert.equal(storage.writes.length, 0);
});

test("all eight selections persist independently of the master switch", async t => {
    const storage = createStorage();
    const popup = open(t, storage);
    storage.resolveReads();
    const keys = ["youtube", "tiktok", "instagram"];
    for (let mask = 0; mask < 8; mask++) {
        for (let i = 0; i < keys.length; i++) {
            const button = popup.networks[keys[i]];
            const selected = Boolean(mask & (1 << i));
            if ((button.getAttribute("aria-pressed") === "true") !== selected) {
                button.click();
                await Promise.resolve();
            }
            assert.equal(button.getAttribute("aria-pressed"), String(selected));
        }
        const reopened = open(t, storage);
        storage.resolveReads();
        for (const key of keys) assert.equal(reopened.networks[key].getAttribute("aria-pressed"),
            popup.networks[key].getAttribute("aria-pressed"));
        assert.equal(popup.button.getAttribute("aria-checked"), "true");
    }
    popup.button.click();
    await Promise.resolve();
    assert.equal(storage.data.enabled, false);
    for (const key of keys) assert.equal(storage.data[key], true);
    popup.button.click();
    await Promise.resolve();
    assert.equal(storage.data.enabled, true);
});

test("empty selection explains inactivity and cannot turn on with nothing selected", async t => {
    const storage = createStorage({ enabled: false, youtube: false });
    const popup = open(t, storage);
    storage.resolveReads();
    assert.equal(popup.button.disabled, true);
    assert.match(popup.hint.textContent, /Выберите соцсет/);
    popup.networks.instagram.click();
    await Promise.resolve();
    assert.equal(popup.button.disabled, false);
    assert.equal(storage.data.enabled, false);
});

test("simultaneous changes in two popups do not erase each other's network choices", async t => {
    const storage = createStorage();
    const first = open(t, storage), second = open(t, storage);
    storage.resolveReads();
    first.networks.instagram.click();
    second.networks.tiktok.click();
    await Promise.resolve();
    assert.equal(storage.data.instagram, true);
    assert.equal(storage.data.tiktok, true);
    for (const popup of [first, second]) {
        assert.equal(popup.networks.instagram.getAttribute("aria-pressed"), "true");
        assert.equal(popup.networks.tiktok.getAttribute("aria-pressed"), "true");
    }
});

test("failed site selection is not shown as saved and does not change global enabled", async t => {
    const storage = createStorage({ enabled: false });
    const popup = open(t, storage);
    storage.resolveReads();
    storage.failWrites = true;
    popup.networks.tiktok.click();
    await Promise.resolve();
    assert.equal(popup.networks.tiktok.getAttribute("aria-pressed"), "false");
    assert.equal(popup.networks.tiktok.disabled, false);
    assert.equal(storage.data.enabled, false);
});

test("pending reads reconcile global and per-site changes without resetting either", t => {
    const storage = createStorage({ enabled: false, youtube: false, instagram: true });
    const popup = open(t, storage);
    storage.update({ tiktok: true });
    assert.equal(popup.networks.youtube.disabled, true);
    storage.resolveReads();
    assert.equal(popup.button.getAttribute("aria-checked"), "false");
    assert.equal(popup.networks.youtube.getAttribute("aria-pressed"), "false");
    assert.equal(popup.networks.tiktok.getAttribute("aria-pressed"), "true");
    assert.equal(popup.networks.instagram.getAttribute("aria-pressed"), "true");
});
