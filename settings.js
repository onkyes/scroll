(() => {
    "use strict";

    const defaults = Object.freeze({ enabled: true, youtube: true, tiktok: false, instagram: false });

    function watch(onChange) {
        const storage = globalThis.chrome?.storage;
        const values = { ...defaults };
        const revisions = Object.fromEntries(Object.keys(defaults).map(key => [key, 0]));
        let ready = false;
        let reading = false;
        const normalize = (key, value) => typeof value === "boolean" ? value : defaults[key];
        const notify = (error = "") => onChange({ ...values }, ready, error);

        function read() {
            if (reading) return;
            reading = true;
            const started = { ...revisions };
            storage.local.get(defaults, result => {
                reading = false;
                const error = globalThis.chrome.runtime?.lastError;
                if (error) {
                    notify(error.message);
                    return;
                }
                // Reconcile each key separately: a newer site choice must survive an older read.
                for (const key of Object.keys(defaults)) {
                    if (revisions[key] === started[key]) values[key] = normalize(key, result[key]);
                }
                ready = true;
                notify();
            });
        }

        if (storage?.local) {
            storage.onChanged.addListener((changes, area) => {
                if (area !== "local") return;
                let changed = false;
                for (const key of Object.keys(defaults)) {
                    if (!Object.hasOwn(changes, key)) continue;
                    values[key] = normalize(key, changes[key].newValue);
                    revisions[key] += 1;
                    changed = true;
                }
                if (!changed) return;
                if (ready) notify();
                else read();
            });
            read();
        } else {
            ready = true;
            notify();
        }

        return {
            set(key, value, done) {
                if (!ready || !storage?.local || !Object.hasOwn(defaults, key)) {
                    done("Settings unavailable");
                    return;
                }
                const revision = revisions[key];
                storage.local.set({ [key]: value }, () => {
                    const error = globalThis.chrome.runtime?.lastError?.message || "";
                    if (!error && revision === revisions[key]) {
                        values[key] = normalize(key, value);
                        revisions[key] += 1;
                        notify();
                    }
                    done(error);
                });
            },
        };
    }

    globalThis.AutoScrollSettings = Object.freeze({ defaults, watch });
})();
