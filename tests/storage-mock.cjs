function createStorage(initial = {}) {
    const data = { ...initial };
    const listeners = [];
    const reads = [];
    const runtime = {};
    const mock = {
        data, writes: [], failReads: false, failWrites: false,
        fire(changes, area = "local") {
            listeners.forEach(listener => listener(changes, area));
        },
        change(value, area = "local") {
            mock.update({ enabled: value }, area);
        },
        update(values, area = "local") {
            const changes = {};
            for (const [key, value] of Object.entries(values)) {
                changes[key] = { oldValue: data[key], newValue: value };
                if (area === "local") {
                    if (value === undefined) delete data[key];
                    else data[key] = value;
                }
            }
            mock.fire(changes, area);
        },
        resolveReads() {
            reads.splice(0).forEach(({ callback, snapshot }) => {
                if (mock.failReads) runtime.lastError = { message: "Read failed" };
                try { callback(snapshot); } finally { delete runtime.lastError; }
            });
        },
    };
    mock.chrome = {
        runtime,
        storage: {
            onChanged: { addListener: listener => listeners.push(listener) },
            local: {
                get(defaults, callback) {
                    reads.push({ callback, snapshot: { ...defaults, ...data } });
                },
                set(values, callback) {
                    mock.writes.push(values);
                    queueMicrotask(() => {
                        if (mock.failWrites) {
                            runtime.lastError = { message: "Write failed" };
                            try { callback(); } finally { delete runtime.lastError; }
                        } else {
                            mock.update(values);
                            callback();
                        }
                    });
                },
            },
        },
    };
    return mock;
}

module.exports = { createStorage };
