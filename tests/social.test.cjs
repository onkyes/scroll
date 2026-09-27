const { test } = require("node:test");
const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { resolve } = require("node:path");
const { JSDOM } = require("jsdom");
const { createStorage } = require("./storage-mock.cjs");

const source = ["settings.js", "social.js"].map(file =>
    readFileSync(resolve(__dirname, "..", file), "utf8")).join("\n");

function setup(t, site, options = {}) {
    const path = options.path ?? (site === "instagram" ? "/reels/DdrpHFhS_pk/" : "/foryou");
    const dom = new JSDOM(`<!doctype html><main><div id="feed" style="overflow-y:auto;scroll-snap-type:y mandatory">
        <article><video loop></video></article><article><video loop></video></article>
        <article><video loop></video></article></div></main>
        <div role="toolbar" aria-label="Reels navigation"><button id="next"></button></div>
        <button id="unrelated" aria-label="Next">Carousel</button>`, {
        url: `https://www.${site}.com${path}`, runScripts: "outside-only", pretendToBeVisual: true,
    });
    t.after(() => dom.window.close());
    const w = dom.window, d = w.document, feed = d.querySelector("#feed");
    const videos = [...d.querySelectorAll("video")];
    const next = d.querySelector("#next");
    if (site === "instagram") next.setAttribute("aria-label", "\u041a \u0441\u043b\u0435\u0434\u0443\u044e\u0449\u0435\u043c\u0443 \u0432\u0438\u0434\u0435\u043e\u00a0Reels");
    else next.setAttribute("data-e2e", "arrow-right");
    const state = { clicks: 0, scrolls: 0, unrelated: 0 };
    const intervals = [], scheduled = [];
    let now = 0;
    w.innerWidth = 1000; w.innerHeight = 800;
    w.performance.now = () => now;
    w.setInterval = fn => intervals.push(fn);
    w.setTimeout = fn => scheduled.push(fn);
    const bounds = (top = 0, left = 0, width = 1000, height = 800) =>
        ({ top, left, width, height, bottom: top + height, right: left + width });
    for (const node of d.querySelectorAll("*")) {
        node.getBoundingClientRect = () => bounds();
        node.getClientRects = () => [node.getBoundingClientRect()];
    }
    feed.getBoundingClientRect = () => bounds(40, 20, 400, 600);
    Object.defineProperties(feed, {
        clientHeight: { value: 600 }, clientWidth: { value: 400 }, scrollHeight: { value: 1800 },
    });
    feed.scrollBy = ({ top }) => { state.scrolls++; feed.scrollTop += top; };
    videos.forEach((video, i) => {
        Object.defineProperties(video, Object.fromEntries(Object.entries({
            duration: 5, currentTime: 0, paused: i !== 0, ended: false, seeking: false,
            readyState: 4, playbackRate: 1, error: null,
        }).map(([key, value]) => [key, { value, writable: true }])));
        video.getBoundingClientRect = () => bounds(40 + i * 600 - feed.scrollTop, 20, 360, 600);
        video.parentElement.getBoundingClientRect = video.getBoundingClientRect;
        video.parentElement.scrollIntoView = () => { state.scrolls++; feed.scrollTop = i * 600; };
    });
    next.getBoundingClientRect = () => bounds(300, 500, 40, 40);
    next.onclick = () => { state.clicks++; state.onNext?.(); };
    d.querySelector("#unrelated").onclick = () => state.unrelated++;
    const storage = options.storage || createStorage({ [site]: true });
    w.chrome = storage.chrome;
    const emit = (target, type) => target.dispatchEvent(new w.Event(type));
    async function flush() {
        for (let i = 0; i < 4; i++) {
            await Promise.resolve();
            scheduled.splice(0).forEach(fn => fn());
        }
    }
    async function tick(ms = 500) { now += ms; intervals.forEach(fn => fn()); await flush(); }
    async function end(i = 0) {
        Object.assign(videos[i], { currentTime: 5, ended: true, paused: true });
        emit(videos[i], "ended"); await flush();
    }
    w.eval(source);
    if (!options.deferRead) storage.resolveReads();
    return { w, d, feed, videos, next, state, storage, emit, tick, end, flush };
}

for (const site of ["instagram", "tiktok"]) {
    test(`${site}: starts on a selected site and deduplicates completion events`, async t => {
        const h = setup(t, site);
        assert.equal(h.videos[0].loop, false);
        assert.equal(h.videos[1].loop, true);
        await h.end();
        h.emit(h.videos[0], "timeupdate");
        await h.tick();
        assert.equal(h.state.clicks, 1);
        assert.equal(h.state.unrelated, 0);
    });

    test(`${site}: off, unselected and initial loading never touch the player`, async t => {
        for (const initial of [{ enabled: false, [site]: true }, { enabled: true, [site]: false }, {}]) {
            const h = setup(t, site, { storage: createStorage(initial), deferRead: true });
            await h.end();
            assert.equal(h.videos[0].loop, true);
            h.storage.resolveReads();
            await h.tick(10000);
            assert.equal(h.state.clicks + h.state.scrolls, 0);
            assert.equal(h.videos[0].loop, true);
        }
    });

    test(`${site}: site deselection cancels pending retries and can be re-enabled`, async t => {
        const h = setup(t, site);
        await h.end();
        h.storage.update({ [site]: false });
        assert.equal(h.videos[0].loop, true);
        assert.equal(h.d.querySelector("#social-autoscroll-status"), null);
        await h.tick(10000);
        assert.equal(h.state.clicks, 1);
        assert.equal(h.state.scrolls, 0);
        Object.assign(h.videos[0], { currentTime: 0, ended: false, paused: false });
        h.storage.update({ [site]: true });
        await h.end();
        assert.equal(h.state.clicks, 2);
        h.storage.change(false);
        await h.tick(10000);
        assert.equal(h.state.clicks, 2);
    });

    test(`${site}: ignores offscreen endings, pause, seeking, errors and live streams`, async t => {
        const h = setup(t, site);
        await h.end(1);
        for (const properties of [
            { currentTime: 4.95, paused: true },
            { paused: false, seeking: true },
            { seeking: false, error: { code: 3 } },
            { error: null, duration: Infinity },
            { duration: NaN },
        ]) {
            Object.assign(h.videos[0], properties);
            await h.tick(5000);
        }
        assert.equal(h.state.clicks + h.state.scrolls, 0);
    });

    test(`${site}: scroll fallback stays within the vertical feed`, async t => {
        const h = setup(t, site);
        h.next.disabled = true;
        await h.end();
        assert.equal(h.state.clicks, 0);
        assert.equal(h.state.scrolls, 1);
        assert.equal(h.feed.scrollTop, 600);
        assert.equal(h.state.unrelated, 0);
    });

    test(`${site}: retries a no-op click by scrolling, without double navigation`, async t => {
        const h = setup(t, site);
        await h.end();
        await h.tick(1500);
        assert.equal(h.state.clicks, 1);
        assert.equal(h.state.scrolls, 1);
        await h.tick(5000);
        assert.equal(h.state.scrolls, 1);
    });

    test(`${site}: consecutive videos and a URL-first player replacement`, async t => {
        const h = setup(t, site);
        h.state.onNext = () => h.w.history.pushState({}, "", site === "instagram" ? "/reel/next/" : "/@test/video/1234");
        await h.end();
        await h.tick(6000);
        assert.equal(h.state.clicks, 1);
        h.feed.scrollTop = 600;
        Object.assign(h.videos[1], { paused: false });
        await h.tick();
        await h.end(1);
        assert.equal(h.state.clicks, 2);
    });

    test(`${site}: a reused player waits for reset even when the source changes first`, async t => {
        const h = setup(t, site);
        h.state.onNext = () => h.videos[0].setAttribute("src", "next.mp4");
        await h.end();
        await h.tick(6000);
        assert.equal(h.state.clicks, 1);
        Object.assign(h.videos[0], { currentTime: 0, ended: false, paused: false });
        await h.tick();
        await h.end();
        assert.equal(h.state.clicks, 2);
    });

    test(`${site}: SPA entry starts and leaving the feed restores looping`, async t => {
        const h = setup(t, site, { path: site === "instagram" ? "/direct/inbox/" : "/messages" });
        assert.equal(h.videos[0].loop, true);
        await h.end();
        assert.equal(h.state.clicks, 0);
        Object.assign(h.videos[0], { currentTime: 0, paused: false, ended: false });
        h.w.history.pushState({}, "", site === "instagram" ? "/reels/" : "/foryou");
        await h.tick();
        assert.equal(h.videos[0].loop, false);
        h.w.history.pushState({}, "", "/accounts/login/");
        await h.tick();
        assert.equal(h.videos[0].loop, true);
    });

    test(`${site}: visible dialogs block navigation and duplicate injection is ignored`, async t => {
        const h = setup(t, site);
        h.w.eval(source);
        const dialog = h.d.createElement("div");
        dialog.setAttribute("role", "dialog");
        dialog.getBoundingClientRect = () => ({ top: 0, left: 0, right: 400, bottom: 400, width: 400, height: 400 });
        h.d.body.append(dialog);
        await h.end();
        assert.equal(h.state.clicks, 0);
        dialog.remove();
        await h.tick();
        assert.equal(h.state.clicks, 1);
    });

    test(`${site}: missing navigation is reported instead of scrolling unrelated content`, async t => {
        const h = setup(t, site);
        h.next.remove();
        h.feed.style.overflowY = "visible";
        await h.end();
        assert.equal(h.state.clicks + h.state.scrolls + h.state.unrelated, 0);
        assert.equal(h.d.querySelector("#social-autoscroll-status").dataset.state, "no-control");
    });
}

test("manifest isolates YouTube from new handlers and grants only the requested sites", () => {
    const manifest = JSON.parse(readFileSync(resolve(__dirname, "../manifest.json"), "utf8"));
    assert.deepEqual(manifest.permissions, ["storage"]);
    assert.deepEqual(manifest.content_scripts.map(item => item.matches).flat(), [
        "https://www.youtube.com/*", "https://www.tiktok.com/*", "https://www.instagram.com/*",
    ]);
    for (const item of manifest.content_scripts) {
        assert.equal(item.js[0], "settings.js");
        for (const file of item.js) assert.ok(readFileSync(resolve(__dirname, "..", file)).length > 0);
    }
});

test("one master switch reaches Instagram and TikTok tabs while preserving selections", async t => {
    const storage = createStorage({ instagram: true, tiktok: true, enabled: false });
    const ig = setup(t, "instagram", { storage });
    const tt = setup(t, "tiktok", { storage });
    await ig.end(); await tt.end();
    assert.equal(ig.state.clicks + tt.state.clicks, 0);
    storage.change(true);
    assert.equal(ig.state.clicks, 1);
    assert.equal(tt.state.clicks, 1);
    storage.change(false);
    await ig.tick(10000); await tt.tick(10000);
    assert.equal(ig.state.clicks + tt.state.clicks, 2);
    assert.equal(storage.data.instagram, true);
    assert.equal(storage.data.tiktok, true);
});
