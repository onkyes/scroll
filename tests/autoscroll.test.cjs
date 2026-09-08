const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const { resolve } = require("node:path");
const { readFileSync } = require("node:fs");
const { chromium } = require("playwright");

let context;

// Native media events must work across the extension's isolated world.
const wav = Buffer.alloc(44 + 8000 * 2 * 5);
wav.write("RIFF");
wav.writeUInt32LE(wav.length - 8, 4);
wav.write("WAVEfmt ", 8);
wav.writeUInt32LE(16, 16);
wav.writeUInt16LE(1, 20);
wav.writeUInt16LE(1, 22);
wav.writeUInt32LE(8000, 24);
wav.writeUInt32LE(16000, 28);
wav.writeUInt16LE(2, 32);
wav.writeUInt16LE(16, 34);
wav.write("data", 36);
wav.writeUInt32LE(wav.length - 44, 40);
const html = readFileSync(resolve(__dirname, "shorts.html"), "utf8")
    .replaceAll("__MEDIA__", "data:audio/wav;base64," + wav.toString("base64"));

before(async () => {
    const extension = resolve(__dirname, "..");
    const channel = process.env.SCROL_TEST_CHANNEL || "chromium";
    context = await chromium.launchPersistentContext("", {
        channel,
        headless: true,
        viewport: { width: 1000, height: 800 },
        args: channel === "chromium" ? [
            "--disable-extensions-except=" + extension,
            "--load-extension=" + extension,
        ] : [],
    });
    // Branded browsers cannot side-load extensions; this mode tests the content script only.
    if (channel !== "chromium") {
        await context.addInitScript({ path: resolve(extension, "content.js") });
    }
    // No requests reach YouTube or any other external site.
    await context.route("**/*", route => route.request().isNavigationRequest()
        ? route.fulfill({ contentType: "text/html", body: html })
        : route.abort());
});
after(async () => { await context?.close(); });

async function open(t, path = "/shorts/video-0") {
    const page = await context.newPage();
    page.setDefaultTimeout(6000);
    t.after(() => page.close());
    const errors = [];
    page.on("pageerror", error => errors.push(error.message));
    t.after(() => assert.deepEqual(errors, []));
    await page.goto("https://www.youtube.com" + path);
    await page.waitForFunction(() => [...document.querySelectorAll("video")]
        .every(video => Number.isFinite(video.duration)));
    if (path.startsWith("/shorts/")) {
        await page.waitForFunction(() => !document.querySelector("#v0").loop);
    }
    return page;
}

async function finish(page, index = 0) {
    await page.evaluate(async index => {
        const video = document.querySelector("#v" + index);
        video.currentTime = video.duration - 0.12;
        try {
            await video.play();
        } catch (error) {
            // A successful advance may pause this video before play() resolves.
            if (error.name !== "AbortError") throw error;
        }
    }, index);
}

async function clicks(page, expected) {
    await page.waitForFunction(n => fixture.clicks === n, expected);
    assert.equal(await page.evaluate(() => fixture.unrelated), 0);
}

test("loads automatically on direct visits and repeated page reloads", async t => {
    const page = await open(t);
    for (let i = 0; i < 3; i++) {
        await finish(page);
        await clicks(page, 1);
        await page.reload();
        await page.waitForFunction(() => !document.querySelector("#v0").loop);
    }
});

test("starts after homepage -> Shorts SPA navigation", async t => {
    const page = await open(t, "/");
    assert.equal(await page.locator("#v0").evaluate(v => v.loop), true);
    await page.evaluate(() => fixture.navigate("/shorts/video-0"));
    await page.waitForFunction(() => !document.querySelector("#v0").loop);
    await finish(page);
    await clicks(page, 1);
});

test("advances several videos without double clicks", async t => {
    const page = await open(t);
    for (let index = 0; index < 3; index++) {
        await finish(page, index);
        await clicks(page, index + 1);
        await page.waitForFunction(i => fixture.index === i &&
            !document.querySelector("#v" + i).loop, index + 1);
    }
    await page.waitForTimeout(700);
    assert.equal(await page.evaluate(() => fixture.clicks), 3);
});

test("ignores the ended offscreen video and unrelated next buttons", async t => {
    const page = await open(t);
    await finish(page, 1);
    await page.waitForTimeout(700);
    assert.equal(await page.evaluate(() => fixture.clicks + fixture.unrelated), 0);
    assert.equal(await page.locator("#v1").evaluate(v => v.loop), true);
});

test("does not advance a video paused near its end", async t => {
    const page = await open(t);
    await page.locator("#v0").evaluate(v => { v.currentTime = v.duration - 0.1; });
    await page.waitForTimeout(700);
    assert.equal(await page.evaluate(() => fixture.clicks), 0);
});

test("recovers from a no-op click by scrolling to the next renderer", async t => {
    const page = await open(t);
    await page.evaluate(() => { fixture.mode = "noop"; });
    await finish(page);
    await clicks(page, 1);
    await page.waitForFunction(() => fixture.index === 1);
    assert.equal(await page.evaluate(() => fixture.clicks), 1);
});

test("falls back to scrolling when the next control is disabled", async t => {
    const page = await open(t);
    await page.locator("#navigation-button-down button").evaluate(b => { b.disabled = true; });
    await finish(page);
    await page.waitForFunction(() => fixture.index === 1);
    assert.equal(await page.evaluate(() => fixture.clicks), 0);
});

test("does not treat a URL update as a second completed video", async t => {
    const page = await open(t);
    await page.evaluate(() => { fixture.mode = "url-first"; });
    await finish(page);
    await clicks(page, 1);
    await page.waitForTimeout(2100);
    assert.equal(await page.evaluate(() => fixture.clicks), 1);
    await page.evaluate(async () => {
        fixture.mode = "normal";
        const video = document.querySelector("#v0");
        video.currentTime = 0;
        await video.play();
    });
    await page.waitForTimeout(100);
    await finish(page);
    await clicks(page, 2);
});

test("handles a reused video element with the same duration and source", async t => {
    const page = await open(t);
    await page.evaluate(() => { fixture.mode = "reuse"; });
    for (let i = 1; i <= 3; i++) {
        await finish(page);
        await clicks(page, i);
        await page.waitForFunction(() => document.querySelector("#v0").currentTime < 1);
        await page.waitForTimeout(100);
    }
});

test("stops outside Shorts and restarts on history navigation", async t => {
    const page = await open(t);
    await page.evaluate(() => fixture.navigate("/watch?v=normal"));
    await page.waitForFunction(() => document.querySelector("#v0").loop);
    await finish(page);
    await page.waitForTimeout(700);
    assert.equal(await page.evaluate(() => fixture.clicks), 0);
    await page.goBack();
    await page.waitForFunction(() => !document.querySelector("#v0").loop);
    await finish(page);
    await clicks(page, 1);
});

test("binds a replacement player inserted after startup", async t => {
    const page = await open(t);
    await page.evaluate(() => {
        const old = document.querySelector("#v0");
        old.replaceWith(old.cloneNode(true));
    });
    await page.waitForFunction(() => Number.isFinite(document.querySelector("#v0").duration));
    await finish(page);
    await clicks(page, 1);
});

test("uses Russian labels as a fallback when the structural selector is absent", async t => {
    const page = await open(t);
    await page.locator("#navigation-button-down").evaluate(control => {
        control.style.cssText = "position:fixed;left:550px;top:200px";
        control.removeAttribute("id");
        control.querySelector("button").setAttribute("aria-label",
            "\u0421\u043b\u0435\u0434\u0443\u044e\u0449\u0435\u0435 \u0432\u0438\u0434\u0435\u043e");
    });
    await finish(page);
    await clicks(page, 1);
});
