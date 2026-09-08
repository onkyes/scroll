(() => {
    "use strict";

    const toggle = document.querySelector("#toggle");
    const stateLabel = document.querySelector("#state-label");
    const hint = document.querySelector("#hint");
    let enabled = true;
    let revision = 0;
    let saving = false;

    function render(value) {
        enabled = value !== false;
        toggle.setAttribute("aria-checked", String(enabled));
        toggle.textContent = enabled ? "Выключить" : "Включить";
        toggle.disabled = saving;
        stateLabel.textContent = enabled ? "Включено" : "Выключено";
        hint.textContent = enabled
            ? "Работает во всех вкладках YouTube Shorts."
            : "Выключено во всех вкладках. Выбор сохранён.";
    }

    chrome.storage.onChanged.addListener((changes, area) => {
        if (area === "local" && changes.enabled) {
            revision += 1;
            render(changes.enabled.newValue);
        }
    });
    chrome.storage.local.get({ enabled: true }, (settings) => {
        if (chrome.runtime.lastError) {
            if (revision === 0) {
                stateLabel.textContent = "Ошибка";
                hint.textContent = "Не удалось прочитать настройку. Откройте панель заново.";
            }
            return;
        }
        if (revision === 0) render(settings.enabled);
    });

    toggle.addEventListener("click", () => {
        if (saving || toggle.disabled) return;
        saving = true;
        toggle.disabled = true;
        const next = !enabled;
        const writeRevision = revision;
        chrome.storage.local.set({ enabled: next }, () => {
            const error = chrome.runtime.lastError;
            saving = false;
            // A storage event may arrive before the write callback.
            render(!error && revision === writeRevision ? next : enabled);
            if (error) hint.textContent = "Не удалось сохранить. Нажмите кнопку ещё раз.";
        });
    });
})();
