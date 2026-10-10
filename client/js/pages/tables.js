// tables.js - the Tables page: list, search, filter, add, edit and delete tables,
// and start/end play sessions straight from each table's card.
// Uses: apiRequest (api.js), createIcon/showToast/confirmDialog/setButtonLoading (ui.js),
//       formatMoney/parseMoneyInput/paisaToInput/capitalize/formatTime (format.js),
//       fetchActiveSessions/createTimerElement/startSessionForTable/endSessionWithConfirm (sessions.js)

// ---------- Page elements ----------
const grid = document.getElementById("tables-grid");
const loadingBox = document.getElementById("tables-loading");
const emptyBox = document.getElementById("tables-empty");
const emptyTitle = document.getElementById("empty-title");
const emptyText = document.getElementById("empty-text");
const emptyAddButton = document.getElementById("empty-add-button");
const searchInput = document.getElementById("search-input");
const statusFilter = document.getElementById("status-filter");
const addTableButton = document.getElementById("add-table-button");

const dialog = document.getElementById("table-dialog");
const form = document.getElementById("table-form");
const dialogTitle = document.getElementById("dialog-title");
const dialogSubtitle = document.getElementById("dialog-subtitle");
const formError = document.getElementById("form-error");
const saveButton = document.getElementById("save-button");
const cancelButton = document.getElementById("cancel-button");
const statusHint = document.getElementById("status-hint");

// ---------- Page state ----------
let selectedStatus = "";   // "" = all
let editingTable = null;   // the table being edited, or null when adding
let searchTimer = null;
let latestRequest = 0;     // ignore old answers if the user typed again meanwhile
let activeSessionsByTable = new Map(); // tableId -> its running session
let nextBookingByTable = new Map();    // tableId -> its next booking today (Phase 7)

const AUTO_REFRESH_MS = 30000; // pick up sessions started on another computer

// ---------- Loading the list ----------

// quiet = true: refresh in the background without showing the loading spinner
async function loadTables({ quiet = false } = {}) {
    const params = new URLSearchParams();
    const searchText = searchInput.value.trim();
    if (searchText) params.set("search", searchText);
    if (selectedStatus) params.set("status", selectedStatus);

    const requestNumber = ++latestRequest;
    if (!quiet) showOnly(loadingBox);

    try {
        const query = params.toString();
        // Tables and running sessions are loaded together, so each card can show its timer
        const [result, sessions, todaysBookings] = await Promise.all([
            apiRequest("/tables" + (query ? "?" + query : "")),
            fetchActiveSessions(),
            // Phase 7: today's bookings, for the "Next booking" line (not critical if it fails)
            apiRequest(`/bookings/availability?date=${todayInClub()}`).catch(() => null),
        ]);
        if (requestNumber !== latestRequest) return; // a newer search is already running
        activeSessionsByTable = new Map(sessions.map((session) => [session.table, session]));
        nextBookingByTable = new Map();
        for (const table of todaysBookings ? todaysBookings.data.tables : []) {
            const next = table.bookings.find((b) => (b.status === "pending" || b.status === "confirmed") && Date.parse(b.endAt) > serverNow());
            if (next) nextBookingByTable.set(table.id, next);
        }
        renderTables(result.data);
    } catch (error) {
        if (requestNumber !== latestRequest) return;
        showEmpty("Could not load tables", error.message, false);
        showToast(error.message, "error");
    }
}

// Updates the numbers in the status filter buttons
async function loadSummary() {
    try {
        const { data } = await apiRequest("/tables/summary");
        statusFilter.querySelectorAll("[data-count]").forEach((element) => {
            element.textContent = data[element.dataset.count] ?? 0;
        });
    } catch {
        // Not critical: the list itself still works and shows its own error
    }
}

function refreshAll(options) {
    return Promise.all([loadTables(options), loadSummary()]);
}

// Shows exactly one of: loading / empty / grid
function showOnly(element) {
    for (const box of [loadingBox, emptyBox, grid]) box.hidden = box !== element;
}

function showEmpty(title, text, showAddButton) {
    emptyTitle.textContent = title;
    emptyText.textContent = text;
    emptyAddButton.hidden = !showAddButton;
    showOnly(emptyBox);
}

function renderTables(tables) {
    if (tables.length === 0) {
        const isFiltering = searchInput.value.trim() || selectedStatus;
        if (isFiltering) showEmpty("No matching tables", "Try another search or status filter.", false);
        else showEmpty("No tables yet", "Add your first snooker table to get started.", true);
        return;
    }

    grid.replaceChildren(...tables.map(createTableCard));
    showOnly(grid);
}

// Builds one card. textContent is used for all data, so names can never inject HTML.
function createTableCard(table) {
    const card = document.createElement("article");
    card.className = "table-card";
    card.dataset.status = table.status;
    card.dataset.id = table.id;

    // Top row: number + status badge
    const top = document.createElement("div");
    top.className = "table-card-top";

    const number = document.createElement("span");
    number.className = "table-number";
    number.textContent = table.tableNumber;
    number.setAttribute("aria-label", `Table number ${table.tableNumber}`);

    const badge = document.createElement("span");
    badge.className = `status-badge status-${table.status}`;
    badge.textContent = capitalize(table.status);

    top.append(number, badge);

    // Name + rate
    const info = document.createElement("div");
    const name = document.createElement("h2");
    name.className = "table-card-name";
    name.textContent = table.name || `Table ${table.tableNumber}`;

    const rate = document.createElement("p");
    rate.className = "table-card-rate";
    rate.textContent = `${formatMoney(table.hourlyRate)} / hour`;
    info.append(name, rate);

    const nextBooking = nextBookingByTable.get(table.id);
    if (nextBooking) {
        const link = buildElement("a", { className: "table-card-booking", attrs: { href: "/pages/bookings.html" } },
            createIcon("calendar"), `Next booking ${formatTimeRange(nextBooking.startAt, nextBooking.endAt)} · ${nextBooking.customerName}`);
        info.append(link);
    }

    // Session area: live timer + End, or Start
    const sessionArea = createSessionArea(table);

    // Buttons
    const actions = document.createElement("div");
    actions.className = "table-card-actions";

    const editButton = createCardButton("edit", "Edit", "btn btn-ghost btn-small");
    editButton.setAttribute("aria-label", `Edit table ${table.tableNumber}`);
    editButton.addEventListener("click", () => openDialog(table));

    const deleteButton = createCardButton("trash", "Delete", "btn btn-ghost btn-small is-danger");
    deleteButton.setAttribute("aria-label", `Delete table ${table.tableNumber}`);
    deleteButton.addEventListener("click", () => deleteTable(table, deleteButton));

    actions.append(editButton, deleteButton);
    card.append(top, info, sessionArea, actions);
    return card;
}

// What a card shows about play:
//  - running session  -> live timer, start time and an "End Session" button
//  - available table  -> a "Start Session" button
//  - reserved / maintenance -> a short explanation (sessions can't start)
function createSessionArea(table) {
    const area = document.createElement("div");
    area.className = "table-card-session";
    const session = activeSessionsByTable.get(table.id);

    if (session) {
        const clock = document.createElement("div");
        clock.className = "session-clock";
        const started = document.createElement("span");
        started.className = "session-started";
        started.textContent = `Started ${formatTime(session.startedAt)}`;
        clock.append(createTimerElement(session.startedAt), started);

        const endButton = createCardButton("stop", "End Session", "btn btn-end btn-block");
        endButton.setAttribute("aria-label", `End session on table ${table.tableNumber}`);
        endButton.addEventListener("click", async () => {
            if (await endSessionWithConfirm(session, endButton)) await refreshAll({ quiet: true });
        });
        // Phase 11.4: the matches of this session (Start New Match, results)
        area.append(clock, createMatchesButton(session, "btn btn-secondary btn-block"), endButton);
    } else if (table.status === "available") {
        const startButton = createCardButton("start", "Start Session", "btn btn-primary btn-block");
        startButton.setAttribute("aria-label", `Start session on table ${table.tableNumber}`);
        startButton.addEventListener("click", async () => {
            if (await startSessionForTable(table, startButton)) await refreshAll({ quiet: true });
        });
        area.append(startButton);
    } else {
        const note = document.createElement("p");
        note.className = "session-note";
        note.textContent =
            table.status === "occupied"
                ? "Marked occupied, but no session is running. Edit the table to free it."
                : `Sessions can't start while the table is ${table.status === "maintenance" ? "under maintenance" : table.status}.`;
        area.append(note);
    }
    return area;
}

function createCardButton(iconName, label, className) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = className;
    button.append(createIcon(iconName), document.createTextNode(label));
    return button;
}

// ---------- Add / edit form ----------

function openDialog(table = null) {
    editingTable = table;
    form.reset();
    clearErrors();
    const statusSelect = form.elements.status;
    statusSelect.disabled = false;
    statusHint.hidden = true;

    if (table) {
        dialogTitle.textContent = `Edit Table ${table.tableNumber}`;
        dialogSubtitle.textContent = "Change the details and save.";
        form.elements.tableNumber.value = table.tableNumber;
        form.elements.name.value = table.name;
        form.elements.hourlyRate.value = paisaToInput(table.hourlyRate);
        statusSelect.value = table.status;

        // While a session runs, the status belongs to the session
        if (activeSessionsByTable.has(table.id)) {
            statusSelect.disabled = true;
            statusHint.textContent = "Locked while a session is running. End the session to change it.";
            statusHint.hidden = false;
        }
    } else {
        dialogTitle.textContent = "Add Table";
        dialogSubtitle.textContent = "Each table needs a unique number and an hourly rate.";
        form.elements.status.value = "available";
    }

    dialog.showModal();
    form.elements.tableNumber.focus();
}

// Reads the form. Returns the data to send, or null (and shows messages) if something is wrong.
function readForm() {
    const errors = [];
    const numberText = form.elements.tableNumber.value.trim();
    const rateText = form.elements.hourlyRate.value.trim();

    const tableNumber = Number(numberText);
    if (!numberText) {
        errors.push({ field: "tableNumber", message: "Table number is required" });
    } else if (!Number.isInteger(tableNumber) || tableNumber < 1 || tableNumber > 999) {
        errors.push({ field: "tableNumber", message: "Table number must be a whole number from 1 to 999" });
    }

    const hourlyRate = parseMoneyInput(rateText);
    if (!rateText) {
        errors.push({ field: "hourlyRate", message: "Hourly rate is required" });
    } else if (hourlyRate === null) {
        errors.push({ field: "hourlyRate", message: "Enter an amount like 600 or 600.50" });
    }

    if (errors.length > 0) {
        showErrors(errors);
        return null;
    }

    const data = {
        tableNumber,
        name: form.elements.name.value.trim(),
        hourlyRate, // in paisa
    };
    // Send the status only when staff can actually choose it
    // ("occupied" is never sent - it is set by starting a session)
    const statusSelect = form.elements.status;
    if (!statusSelect.disabled && statusSelect.value !== "occupied") data.status = statusSelect.value;
    return data;
}

async function saveTable(event) {
    event.preventDefault(); // don't reload the page
    clearErrors();

    const data = readForm();
    if (!data) return;

    setButtonLoading(saveButton, true, "Saving…");
    try {
        const result = editingTable
            ? await apiRequest(`/tables/${editingTable.id}`, { method: "PATCH", body: data })
            : await apiRequest("/tables", { method: "POST", body: data });

        dialog.close();
        showToast(result.message);
        await refreshAll();
    } catch (error) {
        // Keep the form open and show what the server said
        showErrors(error.errors || [], error.message);
    } finally {
        setButtonLoading(saveButton, false);
    }
}

function showErrors(fieldErrors, generalMessage) {
    let firstInvalid = null;

    for (const { field, message } of fieldErrors) {
        const errorText = form.querySelector(`[data-error-for="${field}"]`);
        const input = form.elements[field];
        if (errorText && input) {
            errorText.textContent = message;
            errorText.hidden = false;
            input.setAttribute("aria-invalid", "true");
            firstInvalid = firstInvalid || input;
        }
    }

    // A message that doesn't belong to one field (e.g. "Cannot reach the server")
    if (generalMessage && !firstInvalid) {
        formError.textContent = generalMessage;
        formError.hidden = false;
    }
    if (firstInvalid) firstInvalid.focus();
}

function clearErrors() {
    formError.hidden = true;
    form.querySelectorAll("[data-error-for]").forEach((element) => {
        element.hidden = true;
        element.textContent = "";
    });
    form.querySelectorAll("[aria-invalid]").forEach((input) => input.removeAttribute("aria-invalid"));
}

// ---------- Delete ----------

async function deleteTable(table, button) {
    const confirmed = await confirmDialog(
        `Table ${table.tableNumber}${table.name ? ` (${table.name})` : ""} will be removed permanently.`,
        { title: `Delete Table ${table.tableNumber}?`, confirmText: "Delete Table", danger: true }
    );
    if (!confirmed) return;

    setButtonLoading(button, true, "Deleting…");
    try {
        const result = await apiRequest(`/tables/${table.id}`, { method: "DELETE" });
        showToast(result.message);
        await refreshAll();
    } catch (error) {
        // e.g. 409 "Table 3 is currently occupied…"
        showToast(error.message, "error", 6000);
        setButtonLoading(button, false);
    }
}

// ---------- Events ----------

addTableButton.addEventListener("click", () => openDialog());
emptyAddButton.addEventListener("click", () => openDialog());
cancelButton.addEventListener("click", () => dialog.close());
form.addEventListener("submit", saveTable);

// Click on the dark area outside the form closes it
dialog.addEventListener("click", (event) => {
    if (event.target === dialog) dialog.close();
});

// Remove a field's error as soon as the user starts fixing it
form.addEventListener("input", (event) => {
    const errorText = form.querySelector(`[data-error-for="${event.target.name}"]`);
    if (errorText) errorText.hidden = true;
    event.target.removeAttribute("aria-invalid");
});

// Search after the user stops typing for 300 ms (not on every key press)
searchInput.addEventListener("input", () => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(loadTables, 300);
});

statusFilter.addEventListener("click", (event) => {
    const chip = event.target.closest(".chip");
    if (!chip) return;
    selectedStatus = chip.dataset.status;
    statusFilter.querySelectorAll(".chip").forEach((c) => c.setAttribute("aria-pressed", String(c === chip)));
    loadTables();
});

// ---------- Start ----------
document.getElementById("currency-prefix").textContent = CURRENCY.symbol;
startLiveTimers();

// Links from the dashboard:
//   ?status=available -> start with that status filter      ?action=add -> open the Add Table form
//   #table-<id>       -> scroll to that table and highlight it
const address = new URLSearchParams(location.search);
const chipFromAddress = statusFilter.querySelector(`.chip[data-status="${address.get("status") || ""}"]`);
if (chipFromAddress) {
    selectedStatus = chipFromAddress.dataset.status;
    statusFilter.querySelectorAll(".chip").forEach((c) => c.setAttribute("aria-pressed", String(c === chipFromAddress)));
}

refreshAll().then(() => {
    const tableId = location.hash.startsWith("#table-") ? location.hash.slice(7) : null;
    const card = tableId && grid.querySelector(`.table-card[data-id="${CSS.escape(tableId)}"]`);
    if (card) {
        card.classList.add("is-highlighted");
        card.setAttribute("tabindex", "-1");
        card.scrollIntoView({ block: "center" });
        card.focus({ preventScroll: true });
    }
    if (address.get("action") === "add") openDialog();
    if (location.search) history.replaceState(null, "", location.pathname + location.hash); // don't repeat on refresh
});

// Every 30 s, quietly reload (e.g. a session was started on the reception PC).
// Skipped while a form or confirm box is open, so nothing jumps under the user's mouse.
setInterval(() => {
    if (!document.hidden && !document.querySelector("dialog[open]")) refreshAll({ quiet: true });
}, AUTO_REFRESH_MS);
