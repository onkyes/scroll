(() => {
    "use strict";

    if (globalThis.__ytShortsAutoScrollInstalled) return;
    globalThis.__ytShortsAutoScrollInstalled = true;

    const RENDERERS = "ytd-reel-video-renderer, yt-reel-video-renderer";
    const NEXT_LABEL = /^(next(?: video)?|\u0441\u043b\u0435\u0434\u0443\u044e\u0449(?:\u0435\u0435|\u0438\u0439))(?:\s|$)/i;
    let current = null;
    let scheduled = false;
    let statusHost = null;
    let statusText = null;
    let lastError = "";
    const extensionStorage = globalThis.chrome?.storage;
    // Wait for the saved preference before touching a video in an extension context.
    let enabled = !extensionStorage?.local;
    let settingsError = false;

    function loadSettings() {
        if (!extensionStorage?.local) return;
        let revision = 0;
        const apply = (value) => {
            enabled = value !== false;
            settingsError = false;
            check();
        };
        extensionStorage.onChanged.addListener((changes, area) => {
            if (area === "local" && changes.enabled) {
                revision += 1;
                apply(changes.enabled.newValue);
            }
        });
        extensionStorage.local.get({ enabled: true }, (settings) => {
            // A newer toggle must not be overwritten by an older, pending read.
            if (globalThis.chrome.runtime?.lastError) {
                if (revision === 0) {
                    settingsError = true;
                    check();
                }
                return;
            }
            if (revision === 0) apply(settings.enabled);
        });
    }

    function setStatus(state, message) {
        if (!document.body) return;
        if (!statusHost) {
            statusHost = document.createElement("div");
            statusHost.id = "yt-shorts-autoscroll-status";
            statusHost.style.cssText = "position:fixed;left:16px;bottom:16px;z-index:2147483647;pointer-events:none";
            const shadow = statusHost.attachShadow({ mode: "open" });
            statusText = document.createElement("div");
            statusText.style.cssText = "padding:8px 12px;border-radius:6px;background:#17211f;color:#e0f3ec;font:12px/1.4 sans-serif;box-shadow:0 2px 8px #0005;max-width:300px";
            shadow.append(statusText);
        }
        if (!statusHost.isConnected) document.body.append(statusHost);
        statusHost.dataset.state = state;
        const text = "\u0410\u0432\u0442\u043e\u0441\u043a\u0440\u043e\u043b\u043b 1.2.0: " + message;
        if (statusText.textContent !== text) statusText.textContent = text;
    }

    function visibleArea(element) {
        // aria-hidden excludes content from screen readers; it does not hide the player.
        if (element.closest("[hidden]")) return 0;
        const style = getComputedStyle(element);
        if (style.visibility !== "visible" || style.display === "none") return 0;

        const rect = element.getBoundingClientRect();
        let left = Math.max(rect.left, 0);
        let top = Math.max(rect.top, 0);
        let right = Math.min(rect.right, innerWidth);
        let bottom = Math.min(rect.bottom, innerHeight);
        for (let parent = element.parentElement; parent; parent = parent.parentElement) {
            // Root overflow applies to the viewport, not YouTube's zero-height body box.
            if (parent === document.body || parent === document.documentElement) break;
            const parentStyle = getComputedStyle(parent);
            const bounds = parent.getBoundingClientRect();
            if (/hidden|clip|auto|scroll/.test(parentStyle.overflowX)) {
                left = Math.max(left, bounds.left + parent.clientLeft);
                right = Math.min(right, bounds.left + parent.clientLeft + parent.clientWidth);
            }
            if (/hidden|clip|auto|scroll/.test(parentStyle.overflowY)) {
                top = Math.max(top, bounds.top + parent.clientTop);
                bottom = Math.min(bottom, bounds.top + parent.clientTop + parent.clientHeight);
            }
        }
        return Math.max(0, right - left) * Math.max(0, bottom - top);
    }

    function findActive() {
        let best = null;
        let bestArea = 0;
        let bestActive = false;
        for (const root of document.querySelectorAll("ytd-shorts")) {
            for (const video of root.querySelectorAll("video")) {
                const area = visibleArea(video);
                if (area <= 0) continue;
                const rect = video.getBoundingClientRect();
                // Preloaded neighbours can be in the DOM, but must not drive navigation.
                if (area < rect.width * rect.height / 2) continue;
                const renderer = video.closest(RENDERERS);
                const isActive = renderer?.hasAttribute("is-active") &&
                    renderer.getAttribute("is-active") !== "false";
                if (best && ((bestActive && !isActive) ||
                    (Boolean(isActive) === Boolean(bestActive) && area <= bestArea))) continue;
                bestArea = area;
                bestActive = isActive;
                best = { root, video, renderer };
            }
        }
        return best;
    }

    function releaseVideo() {
        if (current?.restoreLoop) current.video.loop = true;
        current = null;
    }

    function usableButton(button) {
        return button instanceof HTMLElement &&
            !button.closest('[disabled], [aria-disabled="true"]') &&
            visibleArea(button) > 0;
    }

    function clickNext(root) {
        // The structural selector works independently of YouTube's interface language.
        for (const control of root.querySelectorAll("#navigation-button-down")) {
            const button = control.matches('button, [role="button"]')
                ? control : control.querySelector('button, [role="button"]');
            if (usableButton(button)) {
                button.click();
                return true;
            }
        }
        for (const button of root.querySelectorAll("button[aria-label]")) {
            if (NEXT_LABEL.test(button.getAttribute("aria-label")) && usableButton(button)) {
                button.click();
                return true;
            }
        }
        return false;
    }

    function scrollNext(state) {
        if (!state.renderer) return false;
        const renderers = [...state.root.querySelectorAll(RENDERERS)];
        const index = renderers.indexOf(state.renderer);
        const next = index >= 0 ? renderers[index + 1] : null;
        if (!next || next.getClientRects().length === 0) return false;
        next.scrollIntoView({ behavior: "instant", block: "center" });
        return true;
    }

    function advance(state, now) {
        if (now < state.retryAt) return;
        // Set the lock before clicking: YouTube can dispatch navigation events synchronously.
        state.retryAt = now + Math.min(1500 * (state.attempts + 1), 5000);
        state.attempts += 1;
        const acted = state.attempts % 2 === 0
            ? scrollNext(state) || clickNext(state.root)
            : clickNext(state.root) || scrollNext(state);
        setStatus(acted ? "switching" : "no-control", acted
            ? "\u043f\u0435\u0440\u0435\u043a\u043b\u044e\u0447\u0435\u043d\u0438\u0435, \u043f\u043e\u043f\u044b\u0442\u043a\u0430 " + state.attempts
            : "\u043d\u0435 \u043d\u0430\u0439\u0434\u0435\u043d\u0430 \u043a\u043d\u043e\u043f\u043a\u0430 \u0441\u043b\u0435\u0434\u0443\u044e\u0449\u0435\u0433\u043e \u0432\u0438\u0434\u0435\u043e");
        if (state.attempts === 3) {
            console.warn("[Shorts Auto Scroll] Navigation has not completed; retrying.");
        }
    }

    function refresh(event) {
        if (!/^\/shorts\/[^/]+/.test(location.pathname)) {
            releaseVideo();
            statusHost?.remove();
            return;
        }

        const active = findActive();
        // Keep a pending attempt while the player is temporarily detached or scrolling.
        if (!active) {
            setStatus("video-missing", "\u0432\u0438\u0434\u0435\u043e \u043d\u0435 \u043d\u0430\u0439\u0434\u0435\u043d\u043e");
            return;
        }
        const { video } = active;
        const source = video.currentSrc || video.getAttribute("src") || "";
        if (!current || current.video !== video || current.renderer !== active.renderer ||
            current.path !== location.pathname || current.source !== source) {
            const previous = current;
            const sameVideo = previous?.video === video;
            const sameMedia = sameVideo && previous.source === source;
            if (!sameVideo) releaseVideo();
            current = {
                ...active,
                path: location.pathname,
                source,
                restoreLoop: sameVideo ? previous.restoreLoop : video.loop,
                // The URL can change before the old, ended player is replaced.
                awaitingReset: sameMedia && previous.path !== location.pathname &&
                    (previous.finished || video.ended),
                finished: false,
                attempts: 0,
                retryAt: 0,
            };
        }

        if (video.loop) {
            current.restoreLoop = true;
            video.loop = false;
        }
        if (event?.target instanceof HTMLVideoElement && event.target !== video) return;
        if (video.error) {
            setStatus("media-error", "\u043e\u0448\u0438\u0431\u043a\u0430 \u0432\u043e\u0441\u043f\u0440\u043e\u0438\u0437\u0432\u0435\u0434\u0435\u043d\u0438\u044f YouTube");
            return;
        }
        if (!Number.isFinite(video.duration) || video.duration <= 0) {
            setStatus("loading", "\u043e\u0436\u0438\u0434\u0430\u043d\u0438\u0435 \u0437\u0430\u0433\u0440\u0443\u0437\u043a\u0438 \u0432\u0438\u0434\u0435\u043e");
            return;
        }

        if (current.awaitingReset) {
            if (video.ended || video.currentTime >= video.duration - Math.min(0.5, video.duration / 2)) {
                setStatus("waiting", "\u043e\u0436\u0438\u0434\u0430\u043d\u0438\u0435 \u0441\u043b\u0435\u0434\u0443\u044e\u0449\u0435\u0433\u043e \u0432\u0438\u0434\u0435\u043e");
                return;
            }
            current.awaitingReset = false;
        }
        if (video.seeking) {
            setStatus("seeking", "\u043f\u0435\u0440\u0435\u043c\u043e\u0442\u043a\u0430");
            return;
        }
        if ((video.paused && !video.ended) || video.playbackRate <= 0) {
            setStatus("paused", "\u043f\u0430\u0443\u0437\u0430");
            return;
        }

        const endMargin = Math.min(0.2 * video.playbackRate, video.duration / 10);
        if (video.ended || (event?.type === "ended" && event.target === video) ||
            (video.readyState >= 2 && video.duration - video.currentTime <= endMargin)) {
            current.finished = true;
        }
        if (current.finished) {
            advance(current, performance.now());
        } else {
            setStatus("playing", "\u0440\u0430\u0431\u043e\u0442\u0430\u0435\u0442, " + Math.floor(video.currentTime) + " / " +
                Math.ceil(video.duration) + " \u0441");
        }
    }

    function check(event) {
        try {
            if (!enabled) {
                releaseVideo();
                if (settingsError && /^\/shorts\/[^/]+/.test(location.pathname)) {
                    setStatus("settings-error", "\u041d\u0435 \u0443\u0434\u0430\u043b\u043e\u0441\u044c \u043f\u0440\u043e\u0447\u0438\u0442\u0430\u0442\u044c \u043d\u0430\u0441\u0442\u0440\u043e\u0439\u043a\u0443. \u041e\u0431\u043d\u043e\u0432\u0438\u0442\u0435 \u0441\u0442\u0440\u0430\u043d\u0438\u0446\u0443.");
                } else {
                    statusHost?.remove();
                }
                return;
            }
            refresh(event);
        } catch (error) {
            setStatus("error", "\u043e\u0448\u0438\u0431\u043a\u0430 \u0441\u043a\u0440\u0438\u043f\u0442\u0430");
            if (lastError !== error.message) console.error("[Shorts Auto Scroll]", error);
            lastError = error.message;
        }
    }

    function scheduleRefresh() {
        if (scheduled) return;
        scheduled = true;
        setTimeout(() => {
            scheduled = false;
            check();
        }, 0);
    }

    // Capture media events: ended/timeupdate do not bubble, and players are often replaced.
    for (const type of ["timeupdate", "ended", "playing", "loadedmetadata", "durationchange", "seeked"]) {
        document.addEventListener(type, check, true);
    }
    for (const type of ["yt-navigate-finish", "yt-page-data-updated", "visibilitychange"]) {
        document.addEventListener(type, scheduleRefresh);
    }
    window.addEventListener("popstate", scheduleRefresh);
    window.addEventListener("pageshow", scheduleRefresh);

    new MutationObserver(scheduleRefresh).observe(document, {
        childList: true,
        subtree: true,
        attributes: true,
        attributeFilter: ["is-active", "aria-hidden", "hidden", "src", "loop"],
    });
    // Recovery if a site event is missed or the browser resumes a suspended tab.
    setInterval(check, 500);
    loadSettings();
    check();
})();
