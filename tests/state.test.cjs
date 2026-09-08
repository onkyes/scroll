const { test } = require("node:test");
const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { resolve } = require("node:path");
const { JSDOM } = require("jsdom");
const { createStorage } = require("./storage-mock.cjs");

const source = readFileSync(resolve(__dirname, "../content.js"), "utf8");
const html = readFileSync(resolve(__dirname, "shorts.html"), "utf8");

function setup(t, path = "/shorts/video-0", storage) {
    const dom = new JSDOM(html, {
        url: "https://www.youtube.com" + path,
        runScripts: "outside-only",
        pretendToBeVisual: true,
    });
    t.after(() => dom.window.close());
    const w = dom.window;
    const d = w.document;
    const videos = [...d.querySelectorAll("video")];
    const reels = d.querySelector("#reels");
    const intervals = [];
    const scheduled = [];
    let now = 0;
    const state = { clicks: 0, unrelated: 0, scrolls: 0 };
    w.innerWidth = 1000;
    w.innerHeight = 800;
    w.performance.now = () => now;
    w.setInterval = fn => { intervals.push(fn); };
    w.setTimeout = fn => { scheduled.push(fn); };
    w.console.warn = () => {};

    // jsdom has no layout or media engine. Model only geometry, playback state and time.
    function bounds(top = 0, left = 0, width = 1000, height = 800) {
        return { top, left, width, height, right: left + width, bottom: top + height };
    }
    for (const element of d.querySelectorAll("*")) {
        element.getBoundingClientRect = () => bounds();
        element.getClientRects = () => [element.getBoundingClientRect()];
    }
    reels.getBoundingClientRect = () => bounds(60, 20, 500, 500);
    Object.defineProperties(reels, {
        clientWidth: { value: 500 },
        clientHeight: { value: 500 },
    });
    videos.forEach((video, i) => {
        Object.defineProperties(video, Object.fromEntries(Object.entries({
            duration: 5, currentTime: 0, paused: i !== 0, ended: false,
            seeking: false, readyState: 4, playbackRate: 1,
        }).map(([key, value]) => [key, { value, writable: true }])));
        video.getBoundingClientRect = () => bounds(60 + i * 500 - reels.scrollTop, 20, 360, 500);
        video.parentElement.scrollIntoView = () => {
            state.scrolls++;
            reels.scrollTop = i * 500;
        };
    });
    for (const button of d.querySelectorAll("button")) {
        button.getBoundingClientRect = () => bounds(200, 550, 100, 50);
    }
    const next = d.querySelector("#navigation-button-down button");
    next.onclick = () => { state.clicks++; state.onNext?.(); };
    d.querySelector("#unrelated").onclick = () => state.unrelated++;

    const emit = (target, type) => target.dispatchEvent(new w.Event(type));
    async function flush() {
        for (let i = 0; i < 5; i++) {
            await Promise.resolve();
            scheduled.splice(0).forEach(fn => fn());
        }
    }
    async function tick(ms = 500) {
        now += ms;
        intervals.forEach(fn => fn());
        await flush();
    }
    async function navigate(path) {
        w.history.pushState({}, "", path);
        emit(d, "yt-navigate-finish");
        await flush();
    }
    async function end(i = 0) {
        Object.assign(videos[i], { currentTime: 5, paused: true, ended: true });
        emit(videos[i], "ended");
        await flush();
    }
    if (storage) w.chrome = storage.chrome;
    w.eval(source);
    return { w, d, videos, reels, next, state, emit, tick, navigate, end, flush };
}

test("manifest injects on all desktop YouTube pages, including homepage and watch", () => {
    const manifest = JSON.parse(readFileSync(resolve(__dirname, "../manifest.json"), "utf8"));
    assert.ok(manifest.content_scripts.some(s =>
        s.matches.includes("https://www.youtube.com/*") && s.js.includes("content.js")));
});

test("starts on direct visits without waiting for an interval", t => {
    const h = setup(t);
    assert.equal(h.videos[0].loop, false);
    assert.equal(h.videos[1].loop, true);
});

test("starts on homepage -> Shorts and remains idle on ordinary videos", async t => {
    const h = setup(t, "/");
    assert.equal(h.videos[0].loop, true);
    await h.end();
    assert.equal(h.state.clicks, 0);
    Object.assign(h.videos[0], { currentTime: 0, paused: false, ended: false });
    await h.navigate("/shorts/video-0");
    await h.end();
    assert.equal(h.state.clicks, 1);
    await h.navigate("/watch?v=ordinary");
    assert.equal(h.videos[0].loop, true);
    await h.tick(10000);
    assert.equal(h.state.clicks, 1);
});

test("ignores an ended video outside the clipped scroll container", async t => {
    const h = setup(t);
    await h.end(1);
    assert.equal(h.state.clicks, 0);
    assert.equal(h.videos[1].loop, true);
});

test("does not scroll during pause, seeking or unknown duration", async t => {
    const h = setup(t);
    const video = h.videos[0];
    for (const state of [
        { currentTime: 4.9, paused: true, seeking: false, duration: 5 },
        { currentTime: 4.9, paused: false, seeking: true, duration: 5 },
        { currentTime: 4.9, paused: false, seeking: false, duration: NaN },
    ]) {
        Object.assign(video, state);
        await h.tick(1000);
        assert.equal(h.state.clicks, 0);
    }
});

test("coalesces ended/timeupdate/interval into one attempt then retries a failed click", async t => {
    const h = setup(t);
    await h.end();
    h.emit(h.videos[0], "timeupdate");
    await h.tick(500);
    assert.equal(h.state.clicks, 1);
    await h.tick(1000);
    assert.equal(h.state.clicks, 1);
    assert.equal(h.state.scrolls, 1);
    assert.equal(h.reels.scrollTop, 500);
    assert.equal(h.state.unrelated, 0);
});

test("waits for media reset when URL changes before the old player", async t => {
    const h = setup(t);
    h.state.onNext = () => {
        h.w.history.pushState({}, "", "/shorts/next");
        h.emit(h.d, "yt-navigate-finish");
    };
    await h.end();
    await h.tick(7000);
    assert.equal(h.state.clicks, 1);
    Object.assign(h.videos[0], { currentTime: 0, paused: false, ended: false });
    await h.tick();
    await h.end();
    assert.equal(h.state.clicks, 2);
});

test("switches consecutive renderers without retaining the old completed state", async t => {
    const h = setup(t);
    for (let index = 0; index < 3; index++) {
        h.reels.scrollTop = index * 500;
        await h.navigate("/shorts/video-" + index);
        await h.end(index);
        assert.equal(h.state.clicks, index + 1);
    }
});

test("recovers if a site navigation event is missed", async t => {
    const h = setup(t, "/");
    h.w.history.pushState({}, "", "/shorts/video-0");
    await h.tick();
    assert.equal(h.videos[0].loop, false);
    await h.end();
    assert.equal(h.state.clicks, 1);
});

test("falls back from a disabled button and never clicks another player", async t => {
    const h = setup(t);
    h.next.disabled = true;
    await h.end();
    assert.equal(h.state.clicks, 0);
    assert.equal(h.state.scrolls, 1);
    assert.equal(h.state.unrelated, 0);
});

test("supports Russian fallback labels without navigation element ids", async t => {
    const h = setup(t);
    h.next.parentElement.removeAttribute("id");
    h.next.setAttribute("aria-label", "\u0421\u043b\u0435\u0434\u0443\u044e\u0449\u0435\u0435 \u0432\u0438\u0434\u0435\u043e");
    await h.end();
    assert.equal(h.state.clicks, 1);
});

test("does not start duplicate handlers if injected twice", async t => {
    const h = setup(t);
    h.w.eval(source);
    await h.end();
    assert.equal(h.state.clicks, 1);
});

test("re-disables looping if YouTube restores the loop attribute", async t => {
    const h = setup(t);
    h.videos[0].loop = true;
    await h.flush();
    assert.equal(h.videos[0].loop, false);
});

test("uses the active marker when two videos overlap", async t => {
    const h = setup(t);
    h.videos[1].getBoundingClientRect = h.videos[0].getBoundingClientRect;
    h.videos[1].parentElement.setAttribute("is-active", "");
    await h.flush();
    await h.end(1);
    assert.equal(h.state.clicks, 1);
});

test("visible video and controls still work when hidden from screen readers", async t => {
    const h = setup(t);
    h.videos[0].setAttribute("aria-hidden", "true");
    h.videos[0].parentElement.setAttribute("aria-hidden", "true");
    h.next.setAttribute("aria-hidden", "true");
    await h.end();
    assert.equal(h.state.clicks, 1);
});

test("a CSS-hidden player cannot advance the visible Shorts feed", async t => {
    const h = setup(t);
    h.videos[0].style.display = "none";
    await h.end();
    assert.equal(h.state.clicks, 0);
});

test("zero-height body with viewport overflow does not hide the YouTube player", async t => {
    const h = setup(t);
    h.d.body.style.overflowY = "hidden";
    h.d.body.getBoundingClientRect = () => ({ top: 0, left: 0, right: 1000, bottom: 0, width: 1000, height: 0 });
    await h.end();
    assert.equal(h.state.clicks, 1);
});

test("status distinguishes playback from a user pause", async t => {
    const h = setup(t);
    const host = h.d.querySelector("#yt-shorts-autoscroll-status");
    assert.equal(host.dataset.state, "playing");
    assert.ok(host.shadowRoot.textContent.includes("1.2.0"));
    h.videos[0].paused = true;
    await h.tick();
    assert.equal(host.dataset.state, "paused");
});

test("status reports a missing player instead of silently doing nothing", async t => {
    const h = setup(t);
    h.videos.forEach(video => video.remove());
    await h.tick();
    assert.equal(h.d.querySelector("#yt-shorts-autoscroll-status").dataset.state, "video-missing");
});

test("status disappears when leaving Shorts", async t => {
    const h = setup(t);
    await h.navigate("/");
    assert.equal(h.d.querySelector("#yt-shorts-autoscroll-status"), null);
});

test("saved off is respected before and after the asynchronous read", async t => {
    const storage = createStorage({ enabled: false });
    const h = setup(t, "/shorts/video-0", storage);
    await h.end();
    assert.equal(h.state.clicks, 0);
    assert.equal(h.videos[0].loop, true);
    storage.resolveReads();
    await h.tick(10000);
    assert.equal(h.state.clicks, 0);
    assert.equal(h.state.scrolls, 0);
});

test("a missing saved preference preserves automatic startup", async t => {
    const storage = createStorage();
    const h = setup(t, "/shorts/video-0", storage);
    storage.resolveReads();
    await h.end();
    assert.equal(h.state.clicks, 1);
});

test("turning off cancels retries, restores looping and allows a clean restart", async t => {
    const storage = createStorage();
    const h = setup(t, "/shorts/video-0", storage);
    storage.resolveReads();
    await h.end();
    storage.change(false);
    assert.equal(h.videos[0].loop, true);
    assert.equal(h.d.querySelector("#yt-shorts-autoscroll-status"), null);
    await h.tick(10000);
    assert.equal(h.state.clicks, 1);
    assert.equal(h.state.scrolls, 0);
    Object.assign(h.videos[0], { currentTime: 0, paused: false, ended: false });
    storage.change(true);
    assert.equal(h.videos[0].loop, false);
    await h.end();
    assert.equal(h.state.clicks, 2);
});

test("saved off applies to a new tab and setting changes reach both tabs", async t => {
    const storage = createStorage({ enabled: false });
    const first = setup(t, "/shorts/video-0", storage);
    const second = setup(t, "/shorts/video-0", storage);
    storage.resolveReads();
    await first.end();
    await second.end();
    assert.equal(first.state.clicks + second.state.clicks, 0);
    storage.change(true);
    assert.equal(first.state.clicks, 1);
    assert.equal(second.state.clicks, 1);
});

test("a delayed initial read cannot re-enable a newly disabled tab", async t => {
    const storage = createStorage({ enabled: true });
    const h = setup(t, "/shorts/video-0", storage);
    storage.change(false);
    storage.resolveReads();
    await h.end();
    assert.equal(h.state.clicks, 0);
});

test("unrelated settings do not affect the pending advance", async t => {
    const storage = createStorage();
    const h = setup(t, "/shorts/video-0", storage);
    storage.resolveReads();
    storage.change(false, "sync");
    storage.fire({ unrelated: { newValue: false } });
    await h.end();
    assert.equal(h.state.clicks, 1);
});

test("settings read failure is visible and does not start scrolling", async t => {
    const storage = createStorage({ enabled: false });
    const h = setup(t, "/shorts/video-0", storage);
    storage.failReads = true;
    storage.resolveReads();
    await h.end();
    assert.equal(h.state.clicks, 0);
    assert.equal(h.d.querySelector("#yt-shorts-autoscroll-status").dataset.state, "settings-error");
    storage.change(true);
    assert.equal(h.state.clicks, 1);
});
