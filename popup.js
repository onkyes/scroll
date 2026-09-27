(() => {
    "use strict";

    const toggle = document.querySelector("#toggle");
    const hint = document.querySelector("#hint");
    const networks = [...document.querySelectorAll("[data-network]")];
    const names = { youtube: "YouTube", tiktok: "TikTok", instagram: "Instagram" };
    let settings = { ...AutoScrollSettings.defaults };
    let ready = false;
    let saving = false;

    function render() {
        const selected = networks.filter(button => settings[button.dataset.network]);
        for (const button of networks) {
            button.setAttribute("aria-pressed", String(settings[button.dataset.network]));
            button.disabled = !ready || saving;
        }
        toggle.setAttribute("aria-checked", String(settings.enabled));
        toggle.textContent = settings.enabled ? "Включено" : "Выключено";
        toggle.disabled = !ready || saving || (selected.length === 0 && !settings.enabled);
        hint.textContent = selected.length === 0
            ? "Выберите соцсеть сверху."
            : settings.enabled
                ? "Работает: " + selected.map(button => names[button.dataset.network]).join(", ") + "."
                : "Выключено во всех вкладках. Выбор сохранён.";
    }

    const preferences = AutoScrollSettings.watch((value, loaded, error) => {
        settings = value;
        ready = loaded;
        if (ready) render();
        if (error) {
            toggle.textContent = "Ошибка";
            hint.textContent = "Не удалось прочитать настройки. Откройте панель заново.";
        }
    });

    function save(key, value) {
        if (!ready || saving) return;
        saving = true;
        render();
        preferences.set(key, value, error => {
            saving = false;
            render();
            if (error) hint.textContent = "Не удалось сохранить. Нажмите кнопку ещё раз.";
        });
    }

    toggle.addEventListener("click", () => {
        if (!toggle.disabled) save("enabled", !settings.enabled);
    });
    for (const button of networks) {
        button.addEventListener("click", () => {
            if (!button.disabled) save(button.dataset.network, !settings[button.dataset.network]);
        });
    }
})();
