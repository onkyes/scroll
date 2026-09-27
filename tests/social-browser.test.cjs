const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { resolve, join } = require("node:path");
const { pathToFileURL } = require("node:url");
const { tmpdir } = require("node:os");
const { chromium } = require("playwright");
const { createStorage } = require("./storage-mock.cjs");

const root = resolve(__dirname, "..");
const source = ["settings.js", "social.js"].map(file => readFileSync(join(root, file), "utf8")).join("\n");
const wav = Buffer.alloc(44 + 8000 * 2 * 5);
wav.write("RIFF"); wav.writeUInt32LE(wav.length - 8, 4); wav.write("WAVEfmt ", 8);
wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22);
wav.writeUInt32LE(8000, 24); wav.writeUInt32LE(16000, 28);
wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34);
wav.write("data", 36); wav.writeUInt32LE(wav.length - 44, 40);
const baseHTML = readFileSync(join(__dirname, "shorts.html"), "utf8")
    .replaceAll("ytd-reel-video-renderer", "article").replaceAll("ytd-shorts", "main")
    .replaceAll("__MEDIA__", "data:audio/wav;base64," + wav.toString("base64"));
let browser;

before(async () => {
    browser = await chromium.launch({ channel: process.env.SCROL_TEST_CHANNEL || "chromium", headless: true });
});
after(async () => { await browser?.close(); });

async function open(t, site, { settings = { [site]: true }, path, mode = "normal" } = {}) {
    const context = await browser.newContext({ viewport: { width: 1000, height: 800 } });
    t.after(() => context.close());
    const prefix = site === "instagram" ? "/reels/" : "/@test/video/";
    const page = await context.newPage();
    page.setDefaultTimeout(6000);
    const errors = [];
    page.on("pageerror", error => errors.push(error.message));
    t.after(() => assert.deepEqual(errors, []));
    const html = baseHTML.replaceAll("/shorts/video-", prefix).replaceAll("/shorts/new-url", prefix + "42")
        .replaceAll("/shorts/reused-", prefix)
        .replace('aria-label="Weiter"', site === "instagram" ? 'aria-label="Next reel"' : 'data-e2e="arrow-right"');
    await context.route("**/*", route => route.request().isNavigationRequest()
        ? route.fulfill({ contentType: "text/html", body: html }) : route.abort());
    await context.addInitScript({ content: `
        window.testStorage = (${createStorage.toString()})(${JSON.stringify(settings)});
        window.chrome = window.testStorage.chrome;
        ${source}
        window.testStorage.resolveReads();
    ` });
    await page.goto(`https://www.${site}.com` + (path ?? prefix + "0"));
    await page.waitForFunction(() => [...document.querySelectorAll("video")].every(v => Number.isFinite(v.duration)));
    await page.evaluate(mode => { fixture.mode = mode; }, mode);
    return page;
}

async function finish(page, index = 0) {
    await page.evaluate(async index => {
        const video = document.querySelector("#v" + index);
        video.currentTime = video.duration - 0.1;
        try { await video.play(); } catch (error) { if (error.name !== "AbortError") throw error; }
    }, index);
}

for (const site of ["instagram", "tiktok"]) {
    test(`${site}: native media endings advance three consecutive videos`, async t => {
        const page = await open(t, site);
        for (let i = 0; i < 3; i++) {
            await page.waitForFunction(i => !document.querySelector("#v" + i).loop, i);
            await finish(page, i);
            await page.waitForFunction(n => fixture.clicks === n && fixture.index === n, i + 1);
        }
        assert.equal(await page.evaluate(() => fixture.unrelated), 0);
    });

    test(`${site}: SPA entry, reload and master switch recover without reinstalling`, async t => {
        const page = await open(t, site, { path: "/messages" });
        assert.equal(await page.locator("#v0").evaluate(v => v.loop), true);
        await page.evaluate(path => fixture.navigate(path), site === "instagram" ? "/reels/" : "/foryou");
        await page.waitForFunction(() => !document.querySelector("#v0").loop);
        await page.evaluate(() => testStorage.change(false));
        await page.waitForFunction(() => document.querySelector("#v0").loop);
        await page.evaluate(() => testStorage.change(true));
        await page.waitForFunction(() => !document.querySelector("#v0").loop);
        await page.reload();
        await page.waitForFunction(() => !document.querySelector("#v0").loop);
        await finish(page);
        await page.waitForFunction(() => fixture.clicks === 1);
    });

    test(`${site}: disabled or ineffective next button falls back to the actual scroll container`, async t => {
        for (const mode of ["disabled", "noop"]) {
            const page = await open(t, site, { mode });
            if (mode === "disabled") await page.locator("#navigation-button-down button").evaluate(b => { b.disabled = true; });
            await finish(page);
            await page.waitForFunction(() => fixture.index === 1);
            assert.equal(await page.evaluate(() => fixture.clicks), mode === "disabled" ? 0 : 1);
            assert.equal(await page.evaluate(() => fixture.unrelated), 0);
        }
    });

    test(`${site}: saved off, pause and offscreen media never navigate`, async t => {
        const page = await open(t, site, { settings: { [site]: true, enabled: false } });
        await finish(page);
        await page.waitForTimeout(600);
        assert.equal(await page.evaluate(() => fixture.clicks), 0);
        await page.evaluate(() => {
            fixture.video(0).pause(); fixture.video(0).currentTime = 0;
            testStorage.change(true);
        });
        await finish(page, 1);
        await page.waitForTimeout(600);
        assert.equal(await page.evaluate(() => fixture.clicks), 0);
        await page.locator("#v0").evaluate(v => { v.currentTime = v.duration - 0.1; });
        await page.waitForTimeout(600);
        assert.equal(await page.evaluate(() => fixture.clicks), 0);
    });

    test(`${site}: early URL changes do not skip a second video`, async t => {
        const page = await open(t, site, { mode: "url-first" });
        await finish(page);
        await page.waitForFunction(() => fixture.clicks === 1);
        await page.waitForTimeout(1900);
        assert.equal(await page.evaluate(() => fixture.clicks), 1);
    });
}

test("popup keeps its dimensions for every selection and supports keyboard controls", async t => {
    const context = await browser.newContext({ viewport: { width: 300, height: 340 } });
    t.after(() => context.close());
    const page = await context.newPage();
    await page.addInitScript({ content: `
        window.testStorage = (${createStorage.toString()})({});
        window.chrome = window.testStorage.chrome;
        document.addEventListener('DOMContentLoaded', () => testStorage.resolveReads());
    ` });
    await page.goto(pathToFileURL(join(root, "popup.html")).href);
    const geometry = () => page.evaluate(() => ({
        width: document.body.getBoundingClientRect().width,
        height: document.body.getBoundingClientRect().height,
        headingTop: document.querySelector('h1').getBoundingClientRect().top,
        buttonTop: document.querySelector('#toggle').getBoundingClientRect().top,
        overflow: document.documentElement.scrollWidth > innerWidth,
    }));
    const before = await geometry();
    assert.equal(before.width, 300);
    assert.equal(before.height, 314.5);
    assert.equal(before.overflow, false);
    for (let mask = 0; mask < 8; mask++) {
        await page.evaluate(mask => testStorage.update({
            youtube: Boolean(mask & 1), tiktok: Boolean(mask & 2), instagram: Boolean(mask & 4),
        }), mask);
        assert.deepEqual(await geometry(), before);
    }
    const youtube = page.locator('[data-network="youtube"]');
    const selectedColor = await youtube.evaluate(b => getComputedStyle(b).backgroundColor);
    assert.equal(selectedColor, "rgb(102, 98, 102)");
    assert.equal(await page.locator(".donation-link").getAttribute("href"),
        "https://www.donationalerts.com/c/onkyes");
    assert.equal(await page.locator(".telegram-link").getAttribute("href"), "https://t.me/user74999");
    assert.equal(await page.locator(".footer-link").count(), 2);
    assert.equal(await page.locator(".network-icon").count(), 3);
    await youtube.press("Space");
    assert.equal(await youtube.getAttribute("aria-pressed"), "false");
    await page.locator("#toggle").press("Space");
    assert.equal(await page.locator("#toggle").getAttribute("aria-checked"), "false");
    assert.deepEqual(await geometry(), before);
    await page.evaluate(() => testStorage.update({ enabled: true, youtube: true }));
    const screenshot = join(tmpdir(), "scrol-social-popup.png");
    await page.locator("body").screenshot({ path: screenshot });
    console.log("Popup geometry:", before, "Preview:", screenshot);
});
