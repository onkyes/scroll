(() => {
    "use strict";

    const site = location.hostname === "www.instagram.com" ? "instagram"
        : location.hostname === "www.tiktok.com" ? "tiktok" : null;
    if (!site || globalThis.__socialAutoScrollInstalled) return;
    globalThis.__socialAutoScrollInstalled = true;

    let enabled = false;
    let settingsError = false;
    let current = null;
    let scheduled = false;
    let statusHost = null;
    let statusText = null;
    let lastError = "";

    function supportedPage() {
        return site === "instagram"
            ? /^\/(?:reels?(?:\/|$)|[^/]+\/reel\/[^/]+)/.test(location.pathname)
            : /^(?:\/(?:foryou|following|friends)?\/?|\/@[^/]+\/video\/\d+\/?)$/.test(location.pathname);
    }

    function setStatus(state, message) {
        if (!document.body) return;
        if (!statusHost) {
            statusHost = document.createElement("div");
            statusHost.id = "social-autoscroll-status";
            statusHost.style.cssText = "position:fixed;left:16px;bottom:16px;z-index:2147483647;pointer-events:none";
            statusText = document.createElement("div");
            statusText.style.cssText = "padding:8px 12px;border-radius:6px;background:#17211f;color:#e0f3ec;font:12px/1.4 sans-serif;max-width:300px";
            statusHost.attachShadow({ mode: "open" }).append(statusText);
        }
        if (!statusHost.isConnected) document.body.append(statusHost);
        statusHost.dataset.state = state;
        const text = (site === "instagram" ? "Instagram" : "TikTok") + " \u00b7 \u0410\u0432\u0442\u043e\u0441\u043a\u0440\u043e\u043b\u043b: " + message;
        if (statusText.textContent !== text) statusText.textContent = text;
    }

    function visibleArea(element) {
        if (element.closest("[hidden], [inert]")) return 0;
        const rect = element.getBoundingClientRect();
        let left = Math.max(rect.left, 0), right = Math.min(rect.right, innerWidth);
        let top = Math.max(rect.top, 0), bottom = Math.min(rect.bottom, innerHeight);
        for (let node = element; node; node = node.parentElement) {
            const style = getComputedStyle(node);
            if (style.display === "none" || style.visibility === "hidden" ||
                style.visibility === "collapse" || style.opacity === "0") return 0;
            if (node === element || node === document.body || node === document.documentElement) continue;
            const bounds = node.getBoundingClientRect();
            if (/hidden|clip|auto|scroll/.test(style.overflowX)) {
                left = Math.max(left, bounds.left + node.clientLeft);
                right = Math.min(right, bounds.left + node.clientLeft + node.clientWidth);
            }
            if (/hidden|clip|auto|scroll/.test(style.overflowY)) {
                top = Math.max(top, bounds.top + node.clientTop);
                bottom = Math.min(bottom, bounds.top + node.clientTop + node.clientHeight);
            }
        }
        return Math.max(0, right - left) * Math.max(0, bottom - top);
    }

    function findVideo() {
        let best = null;
        let bestArea = 0;
        for (const video of document.querySelectorAll("video")) {
            const rect = video.getBoundingClientRect();
            const area = visibleArea(video);
            // Ignore previews, offscreen preloads and the edge of the neighbouring reel.
            if (rect.width < 120 || rect.height < 120 || area <= 0 ||
                area < Math.min(rect.width, innerWidth) * Math.min(rect.height, innerHeight) / 2) continue;
            if (area > bestArea) { best = video; bestArea = area; }
        }
        return best;
    }

    function blocked(video) {
        if (document.activeElement?.matches('input, textarea, [contenteditable="true"]')) return true;
        return [...document.querySelectorAll('[role="dialog"], [aria-modal="true"], #loginModalContentContainer')]
            .some(dialog => visibleArea(dialog) > 0 && !dialog.contains(video));
    }

    function nextButton(video) {
        const videoDialog = video.closest('[role="dialog"], [aria-modal="true"]');
        const root = videoDialog || video.closest('main, [role="main"]');
        const buttons = [...document.querySelectorAll('button, [role="button"]')];
        const isStructural = button => site === "tiktok" &&
            /^(arrow-right|arrow-down)$/.test(button.getAttribute("data-e2e"));
        buttons.sort((a, b) => Number(isStructural(b)) - Number(isStructural(a)));
        for (const button of buttons) {
            if (button.closest('[disabled], [aria-disabled="true"]') || visibleArea(button) <= 0) continue;
            const buttonDialog = button.closest('[role="dialog"], [aria-modal="true"]');
            if (buttonDialog !== videoDialog) continue;
            const structural = isStructural(button);
            const label = (button.getAttribute("aria-label") ||
                button.querySelector("svg[aria-label]")?.getAttribute("aria-label") ||
                button.querySelector("svg title")?.textContent || "").replace(/\s+/g, " ").trim();
            const next = /^(?:(?:go|scroll) to )?next(?: (?:video|reel))?$|^(?:\u043a )?\u0441\u043b\u0435\u0434\u0443\u044e\u0449(?:\u0435\u0435|\u0438\u0439|\u0435\u043c\u0443)(?: \u0432\u0438\u0434\u0435\u043e)?(?: reels)?$/i.test(label);
            const reelControl = /reel/i.test(label) ||
                /reel/i.test(button.closest('[role="toolbar"]')?.getAttribute("aria-label") || "");
            if (structural || (next && (site === "tiktok" ? root?.contains(button) : reelControl))) return button;
        }
        return null;
    }

    function scrollNext(video) {
        // Use the video's own vertical feed, never the comment panel or an arbitrary page scroll.
        let item = video;
        for (let parent = video.parentElement; parent; item = parent, parent = parent.parentElement) {
            const style = getComputedStyle(parent);
            if (!/auto|scroll/.test(style.overflowY) || parent.clientHeight <= 0 ||
                parent.scrollHeight <= parent.clientHeight + 1) continue;
            for (let next = item.nextElementSibling; next; next = next.nextElementSibling) {
                if (!next.querySelector("video") || next.getClientRects().length === 0) continue;
                const here = item.getBoundingClientRect(), there = next.getBoundingClientRect();
                if (there.top < here.bottom - 20 || Math.abs(there.left - here.left) > here.width / 2) continue;
                next.scrollIntoView({ behavior: "instant", block: "center" });
                return true;
            }
            // Virtualized snap feeds may only mount the next video after a scroll.
            if (/^y\b/.test(style.scrollSnapType) && parent.scrollTop + parent.clientHeight < parent.scrollHeight - 1) {
                parent.scrollBy({ top: item.getBoundingClientRect().height || parent.clientHeight, behavior: "instant" });
                return true;
            }
            return false;
        }
        return false;
    }

    function release() {
        if (current?.restoreLoop) current.video.loop = true;
        current = null;
    }

    function advance(state) {
        const now = performance.now();
        if (now < state.retryAt) return;
        state.retryAt = now + Math.min(1500 * (state.attempts + 1), 5000);
        state.attempts += 1;
        const click = () => {
            const button = nextButton(state.video);
            if (!button) return false;
            button.click();
            return true;
        };
        const acted = state.attempts % 2 === 0
            ? scrollNext(state.video) || click() : click() || scrollNext(state.video);
        setStatus(acted ? "switching" : "no-control", acted
            ? "\u043f\u0435\u0440\u0435\u043a\u043b\u044e\u0447\u0435\u043d\u0438\u0435"
            : "\u043d\u0435 \u043d\u0430\u0439\u0434\u0435\u043d \u043f\u0435\u0440\u0435\u0445\u043e\u0434 \u043a \u0441\u043b\u0435\u0434\u0443\u044e\u0449\u0435\u043c\u0443 \u0432\u0438\u0434\u0435\u043e");
    }

    function check(event) {
        try {
            if (!supportedPage() || !enabled) {
                release();
                if (settingsError && supportedPage()) setStatus("settings-error", "\u041e\u0431\u043d\u043e\u0432\u0438\u0442\u0435 \u0441\u0442\u0440\u0430\u043d\u0438\u0446\u0443: \u043e\u0448\u0438\u0431\u043a\u0430 \u0447\u0442\u0435\u043d\u0438\u044f \u043d\u0430\u0441\u0442\u0440\u043e\u0435\u043a");
                else statusHost?.remove();
                return;
            }
            const video = findVideo();
            if (!video) {
                setStatus("video-missing", "\u043e\u0436\u0438\u0434\u0430\u043d\u0438\u0435 \u0432\u0438\u0434\u0435\u043e");
                return;
            }
            if (blocked(video)) {
                release();
                setStatus("blocked", "\u043f\u0430\u0443\u0437\u0430: \u043e\u0442\u043a\u0440\u044b\u0442\u043e \u043e\u043a\u043d\u043e \u0441\u0430\u0439\u0442\u0430");
                return;
            }
            const source = video.currentSrc || video.getAttribute("src") || "";
            if (!current || current.video !== video || current.source !== source || current.path !== location.pathname) {
                const previous = current;
                const sameVideo = previous?.video === video;
                if (!sameVideo) release();
                current = {
                    video, source, path: location.pathname,
                    restoreLoop: sameVideo ? previous.restoreLoop : video.loop,
                    awaitingReset: sameVideo && previous.finished &&
                        (video.ended || video.currentTime >= video.duration - 0.5),
                    finished: false, attempts: 0, retryAt: 0,
                };
            }
            if (video.loop) { current.restoreLoop = true; video.loop = false; }
            if (event?.target instanceof HTMLVideoElement && event.target !== video) return;
            if (video.error || !Number.isFinite(video.duration) || video.duration <= 0) {
                setStatus(video.error ? "media-error" : "loading", video.error
                    ? "\u043e\u0448\u0438\u0431\u043a\u0430 \u0432\u043e\u0441\u043f\u0440\u043e\u0438\u0437\u0432\u0435\u0434\u0435\u043d\u0438\u044f"
                    : "\u043e\u0436\u0438\u0434\u0430\u043d\u0438\u0435 \u0437\u0430\u0433\u0440\u0443\u0437\u043a\u0438");
                return;
            }
            if (current.awaitingReset) {
                if (video.ended || video.currentTime >= video.duration - Math.min(0.5, video.duration / 2)) {
                    setStatus("waiting", "\u043e\u0436\u0438\u0434\u0430\u043d\u0438\u0435 \u0441\u043b\u0435\u0434\u0443\u044e\u0449\u0435\u0433\u043e \u0432\u0438\u0434\u0435\u043e");
                    return;
                }
                current.awaitingReset = false;
            }
            if (video.seeking || (video.paused && !video.ended) || video.playbackRate <= 0) {
                setStatus("paused", "\u043f\u0430\u0443\u0437\u0430");
                return;
            }
            const margin = Math.min(0.15 * video.playbackRate, video.duration / 10);
            if (video.ended || (event?.type === "ended" && event.target === video) ||
                (video.readyState >= 2 && video.duration - video.currentTime <= margin)) current.finished = true;
            if (current.finished) advance(current);
            else setStatus("playing", "\u0440\u0430\u0431\u043e\u0442\u0430\u0435\u0442");
        } catch (error) {
            setStatus("error", "\u043e\u0448\u0438\u0431\u043a\u0430 \u0441\u043a\u0440\u0438\u043f\u0442\u0430");
            if (error.message !== lastError) console.error("[Auto Scroll]", error);
            lastError = error.message;
        }
    }

    function schedule() {
        if (scheduled) return;
        scheduled = true;
        setTimeout(() => { scheduled = false; check(); }, 80);
    }

    for (const type of ["ended", "timeupdate", "playing", "loadedmetadata", "durationchange", "seeked"]) {
        document.addEventListener(type, check, true);
    }
    for (const type of ["popstate", "pageshow"]) window.addEventListener(type, schedule);
    document.addEventListener("visibilitychange", schedule);
    document.addEventListener("scroll", schedule, true);
    new MutationObserver(schedule).observe(document, {
        childList: true, subtree: true, attributes: true,
        attributeFilter: ["src", "loop", "hidden", "aria-modal"],
    });
    setInterval(check, 500);
    AutoScrollSettings.watch((settings, ready, error) => {
        enabled = ready && settings.enabled && settings[site];
        settingsError = Boolean(error);
        check();
    });
})();
