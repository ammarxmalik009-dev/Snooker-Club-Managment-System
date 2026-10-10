// settings.js (page) - edit the club's rate list, time rule and tax.
// Money and the tax % are converted with string maths (parseMoneyInput), never floats:
//   "300"   -> 30000 paisa,   "16" % -> 1600 basis points,   "16.5" % -> 1650

const form = document.getElementById("settings-form");
const loadingBox = document.getElementById("settings-loading");
const formError = document.getElementById("form-error");
const saveButton = document.getElementById("save-button");
const taxSwitch = document.getElementById("field-taxEnabled");
const taxRateInput = document.getElementById("field-taxRate");
const timeRuleText = document.getElementById("time-rule-text");
const rateFields = document.getElementById("rate-fields");

// Game modes from the registry (GET /api/game-modes): one rate field each (Phase 11.3)
let rateModes = [];

const RATE_SUFFIX = { per_minute: "per minute", per_frame: "per frame" }; // fixed rates: just "Rs ___"

function rateHint(mode) {
    // Snooker Point and 4 Players: billed per game from their completed matches (Phase 11.5); the
    // Create Bill window (sessions without matches) offers Century and Frame only - on purpose.
    if (!mode.enabled) return `Charged per game, on the bill of each completed ${mode.label} match (Matches window). Not offered in the Create Bill window.`;
    if (mode.pricingType === "per_minute") return "Charged for every billed minute (see the time rule below).";
    return `Charged for each ${mode.rateUnit.one} played.`;
}

function buildRateFields(modes) {
    rateModes = modes;
    rateFields.replaceChildren(...modes.map((mode) => {
        const id = `field-gameRate-${mode.key}`;
        const input = buildElement("input", {
            className: "input",
            attrs: { type: "text", id, name: `gameRate-${mode.key}`, inputmode: "decimal", autocomplete: "off", placeholder: `e.g. ${paisaToInput(mode.defaultRate)}` },
        });
        const group = buildElement("div", { className: "input-group" }, buildElement("span", { className: "input-prefix", text: "Rs" }), input);
        if (RATE_SUFFIX[mode.pricingType]) group.append(buildElement("span", { className: "input-suffix", text: RATE_SUFFIX[mode.pricingType] }));
        return buildElement("div", { className: "form-field" },
            buildElement("label", { text: mode.label, attrs: { for: id } }),
            group,
            buildElement("p", { className: "field-hint", text: rateHint(mode) }),
            buildElement("p", { className: "field-error", attrs: { "data-error-for": `gameRates.${mode.key}`, hidden: true } }));
    }));
}

function fillForm(settings) {
    for (const mode of rateModes) {
        const rate = settings.gameRates ? settings.gameRates[mode.key] : null;
        form.elements[`gameRate-${mode.key}`].value = Number.isInteger(rate) ? paisaToInput(rate) : "";
    }
    form.elements.minimumBillableMinutes.value = settings.minimumBillableMinutes;
    form.elements.billingIncrementMinutes.value = settings.billingIncrementMinutes;
    form.elements.noShowGraceMinutes.value = settings.noShowGraceMinutes;
    form.elements.backupEnabled.checked = settings.backupEnabled;
    form.elements.backupIntervalHours.value = settings.backupIntervalHours;
    form.elements.backupKeepCount.value = settings.backupKeepCount;
    taxSwitch.checked = settings.taxEnabled;
    taxRateInput.value = settings.taxRateBasisPoints > 0 ? Number((settings.taxRateBasisPoints / 100).toFixed(2)) : "";
    updateTaxField();
    updateTimeRuleText();
}

function updateTaxField() {
    taxRateInput.disabled = !taxSwitch.checked;
}

// Plain-language explanation of the current time rule
function updateTimeRuleText() {
    const minimum = Number(form.elements.minimumBillableMinutes.value) || 0;
    const step = Number(form.elements.billingIncrementMinutes.value) || 0;
    timeRuleText.textContent = minimum && step
        ? `Played time is counted as at least ${minimum} minutes, then rounded up to the next ${step} minutes. ` +
          "Century is charged for these billed minutes; the other prices don't depend on time."
        : "";
}

async function loadSettings() {
    try {
        const [{ data }, { data: modes }] = await Promise.all([apiRequest("/settings"), apiRequest("/game-modes")]);
        buildRateFields(modes);
        fillForm(data);
        loadingBox.hidden = true;
        form.hidden = false;
    } catch (error) {
        loadingBox.textContent = `Could not load settings: ${error.message}`;
        showToast(error.message, "error");
    }
}

// Reads the form; returns the values to send, or null after showing what is wrong
function readForm() {
    const errors = [];
    const data = {};

    // Rates (paisa), e.g. "10" -> 1000. 0 switches a game type off (its bills are refused).
    data.gameRates = {};
    for (const mode of rateModes) {
        const text = form.elements[`gameRate-${mode.key}`].value.trim();
        const paisa = text === "" ? null : parseMoneyInput(text);
        const example = paisaToInput(mode.defaultRate).replace(/\.00$/, "");
        if (paisa === null) errors.push({ field: `gameRates.${mode.key}`, message: `${mode.label}: enter an amount like ${example} or ${example}.50` });
        else data.gameRates[mode.key] = paisa;
    }

    data.minimumBillableMinutes = Number(form.elements.minimumBillableMinutes.value);
    data.billingIncrementMinutes = Number(form.elements.billingIncrementMinutes.value);
    data.taxEnabled = taxSwitch.checked;

    const noShow = Number(form.elements.noShowGraceMinutes.value);
    if (!Number.isInteger(noShow) || noShow < 5 || noShow > 120) {
        errors.push({ field: "noShowGraceMinutes", message: "Enter 5 to 120 minutes" });
    } else {
        data.noShowGraceMinutes = noShow;
    }

    data.backupEnabled = form.elements.backupEnabled.checked;
    const backupHours = Number(form.elements.backupIntervalHours.value);
    if (!Number.isInteger(backupHours) || backupHours < 1 || backupHours > 168) {
        errors.push({ field: "backupIntervalHours", message: "Enter 1 to 168 hours" });
    } else {
        data.backupIntervalHours = backupHours;
    }
    const keepCount = Number(form.elements.backupKeepCount.value);
    if (!Number.isInteger(keepCount) || keepCount < 1 || keepCount > 365) {
        errors.push({ field: "backupKeepCount", message: "Enter 1 to 365 backups" });
    } else {
        data.backupKeepCount = keepCount;
    }

    const taxText = taxRateInput.value.trim();
    const basisPoints = taxText === "" ? 0 : parseMoneyInput(taxText); // "16.5" -> 1650
    if (basisPoints === null || basisPoints > 10000) {
        errors.push({ field: "taxRateBasisPoints", message: "Enter a tax rate between 0 and 100, e.g. 16" });
    } else {
        data.taxRateBasisPoints = basisPoints;
        if (data.taxEnabled && basisPoints === 0) errors.push({ field: "taxRateBasisPoints", message: "Enter the tax rate, or switch tax off" });
    }

    if (errors.length) {
        showErrors(errors);
        return null;
    }
    return data;
}

function showErrors(errors, generalMessage) {
    let shown = false;
    for (const { field, message } of errors) {
        const target = form.querySelector(`[data-error-for="${field}"]`);
        if (target) {
            target.textContent = message;
            target.hidden = false;
            shown = true;
        }
    }
    if (generalMessage && !shown) {
        formError.textContent = generalMessage;
        formError.hidden = false;
    }
}

function clearErrors() {
    formError.hidden = true;
    form.querySelectorAll("[data-error-for]").forEach((element) => (element.hidden = true));
}

form.addEventListener("submit", async (event) => {
    event.preventDefault();
    clearErrors();
    const data = readForm();
    if (!data) return;

    setButtonLoading(saveButton, true, "Saving…");
    try {
        const result = await apiRequest("/settings", { method: "PATCH", body: data });
        fillForm(result.data);
        showToast(result.message);
        loadBackups(); // the next backup time follows the new hours
    } catch (error) {
        showErrors(error.errors || [], error.message);
    } finally {
        setButtonLoading(saveButton, false);
    }
});

// ---------- Backup (XML): status, files, Backup Now ----------

const backupNowButton = document.getElementById("backup-now-button");
const backupError = document.getElementById("backup-error");

function formatFileSize(bytes) {
    if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
    return `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

function renderBackups(status) {
    document.getElementById("backup-folder").textContent = status.folder;
    document.getElementById("backup-drive-warning").hidden = !status.onSystemDrive;
    document.getElementById("backup-last").textContent = status.lastBackupAt
        ? `${formatDateTime(status.lastBackupAt)} · ${status.lastBackupFile}`
        : "No backup yet";
    document.getElementById("backup-next").textContent = !status.enabled
        ? "Automatic backup is off"
        : status.nextBackupAt && new Date(status.nextBackupAt) > new Date()
            ? formatDateTime(status.nextBackupAt)
            : "Within a minute (while the app is running)";

    backupError.hidden = !status.lastBackupError;
    backupError.textContent = status.lastBackupError
        ? `The last backup failed (${formatDateTime(status.lastBackupAttemptAt)}): ${status.lastBackupError}`
        : "";

    document.getElementById("backup-files").replaceChildren(...status.files.map((backup) => buildElement("tr", {},
        buildElement("td", { text: backup.file }),
        buildElement("td", { text: formatDateTime(backup.modifiedAt) }),
        buildElement("td", { className: "numeric", text: formatFileSize(backup.size) }),
        buildElement("td", {}, buildElement("a", {
            className: "btn btn-ghost btn-small",
            text: "Download",
            attrs: { href: `/api/backups/${encodeURIComponent(backup.file)}`, download: backup.file },
        })))));
    document.getElementById("backup-table").hidden = status.files.length === 0;
    document.getElementById("backup-empty").hidden = status.files.length > 0;
}

async function loadBackups() {
    try {
        renderBackups((await apiRequest("/backups")).data);
    } catch (error) {
        backupError.textContent = `Could not load the backups: ${error.message}`;
        backupError.hidden = false;
    }
}

backupNowButton.addEventListener("click", async () => {
    setButtonLoading(backupNowButton, true, "Saving backup…");
    try {
        const result = await apiRequest("/backups", { method: "POST" });
        showToast(result.message);
    } catch (error) {
        showToast(error.message, "error");
    } finally {
        setButtonLoading(backupNowButton, false);
        loadBackups();
    }
});

taxSwitch.addEventListener("change", updateTaxField);
form.addEventListener("input", (event) => {
    const name = event.target.name.startsWith("gameRate-") ? `gameRates.${event.target.name.slice("gameRate-".length)}` : event.target.name;
    const errorText = form.querySelector(`[data-error-for="${name}"]`);
    if (errorText) errorText.hidden = true;
    updateTimeRuleText();
});

loadSettings();
loadBackups();
