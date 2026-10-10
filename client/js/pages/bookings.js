// bookings.js (page) - book tables for customers, see the day at a glance, check customers in.
// All booking rules (times, overlaps, no-shows, check-in) are enforced by the server;
// this page shows its answers. Times are shown and entered in club time (Karachi).
// Uses: apiRequest (api.js), buildElement/createIcon/showToast/confirmDialog/setButtonLoading (ui.js),
//       format.js helpers, syncServerClock/serverNow (core/sessions.js)

const REFRESH_MS = 30000;
const CHECK_IN_EARLY_MS = 30 * 60 * 1000; // same rule as the server (check-in opens 30 min before)
const DAY_MINUTES = 24 * 60;

// ---------- Page elements ----------
const dayInput = document.getElementById("day-input");
const dayTitle = document.getElementById("day-title");
const timeline = document.getElementById("timeline");
const bookingList = document.getElementById("booking-list");
const bookingsSummary = document.getElementById("bookings-summary");
const statusFilter = document.getElementById("status-filter");
const bookingSearch = document.getElementById("booking-search");

const dialog = document.getElementById("booking-dialog");
const form = document.getElementById("booking-form");
const formError = document.getElementById("booking-form-error");
const saveButton = document.getElementById("booking-save");
const customerSearch = document.getElementById("customer-search");
const suggestions = document.getElementById("customer-suggestions");
const selectedBox = document.getElementById("selected-customer");
const selectedText = document.getElementById("selected-customer-text");
const changeCustomerButton = document.getElementById("change-customer");
const newCustomerToggle = document.getElementById("new-customer-toggle");
const newCustomerFields = document.getElementById("new-customer-fields");
const tableSelect = document.getElementById("booking-table");
const dateField = document.getElementById("booking-date");
const startSelect = document.getElementById("booking-start");
const durationSelect = document.getElementById("booking-duration");

// ---------- State ----------
let currentDay = null;        // "2026-10-07" (club date)
let availability = null;      // last /bookings/availability answer
let bookings = [];            // bookings on the current day (list)
let noShowGraceMinutes = 15;  // from Settings, for the "late" hint
let selectedStatus = "";
let editingBooking = null;    // null = new booking
let selectedCustomer = null;  // { id, name, phone }
let addingNewCustomer = false;
let searchTimer = null;
let customerTimer = null;
let latestLoad = 0;

// ---------- Loading a day ----------

async function loadDay({ quiet = false } = {}) {
    const loadNumber = ++latestLoad;
    dayInput.value = currentDay;
    dayTitle.textContent = formatLongDate(currentDay);
    if (!quiet) {
        timeline.replaceChildren(loadingState());
        bookingList.replaceChildren(loadingState());
    }

    const params = new URLSearchParams({ date: currentDay, limit: 200 });
    if (selectedStatus) params.set("status", selectedStatus);
    if (bookingSearch.value.trim()) params.set("search", bookingSearch.value.trim());

    try {
        const [day, list] = await Promise.all([
            apiRequest(`/bookings/availability?date=${currentDay}`),
            apiRequest(`/bookings?${params}`),
        ]);
        if (loadNumber !== latestLoad) return;
        syncServerClock(list.data.serverTime);
        availability = day.data;
        bookings = list.data.bookings;
        renderTimeline();
        renderList();
    } catch (error) {
        if (loadNumber !== latestLoad) return;
        timeline.replaceChildren(emptyBox("Could not load bookings", error.message, "close"));
        bookingList.replaceChildren(emptyBox("Could not load bookings", error.message, "close"));
        bookingsSummary.textContent = "";
    }
}

function goToDay(day) {
    currentDay = day;
    loadDay();
}

// ---------- Day view (timeline) ----------

function minutesIntoDay(isoText) {
    return (Date.parse(isoText) - Date.parse(availability.dayStart)) / 60000;
}

function renderTimeline() {
    if (availability.tables.length === 0) {
        const box = emptyBox("No tables yet", "Add tables before taking bookings.", "table");
        box.append(buildElement("a", { className: "btn btn-primary btn-small", text: "Add Table", attrs: { href: "/pages/tables.html?action=add" } }));
        timeline.replaceChildren(box);
        return;
    }

    // Show 10:00 -> 02:00 (next day), widened to fit any booking outside that
    const all = availability.tables.flatMap((table) => table.bookings);
    let windowStart = 10 * 60;
    let windowEnd = DAY_MINUTES + 2 * 60;
    for (const b of all) {
        windowStart = Math.min(windowStart, Math.max(0, Math.floor(minutesIntoDay(b.startAt) / 60) * 60));
        windowEnd = Math.max(windowEnd, Math.min(DAY_MINUTES + 6 * 60, Math.ceil(minutesIntoDay(b.endAt) / 60) * 60));
    }
    const span = windowEnd - windowStart;
    const percent = (minutes) => `${((Math.min(Math.max(minutes, windowStart), windowEnd) - windowStart) / span) * 100}%`;

    // Hour labels
    const hours = buildElement("div", { className: "timeline-hours", attrs: { "aria-hidden": "true" } });
    for (let minute = windowStart; minute < windowEnd; minute += 60) {
        const hour = Math.floor(minute / 60) % 24;
        const label = hour === 0 ? "12 am" : hour < 12 ? `${hour} am` : hour === 12 ? "12 pm" : `${hour - 12} pm`;
        const tick = buildElement("span", { className: "timeline-hour", text: label });
        tick.style.left = percent(minute);
        hours.append(tick);
    }

    const rows = availability.tables.map((table) => {
        const track = buildElement("div", { className: "timeline-track" });
        for (const b of table.bookings) {
            const block = buildElement("button", {
                className: `timeline-block booking-${b.status}`,
                attrs: { type: "button", title: `${formatTimeRange(b.startAt, b.endAt)} · ${b.customerName} · ${BOOKING_STATUS_LABELS[b.status]}` },
            },
            buildElement("span", { className: "timeline-block-time", text: formatTimeRange(b.startAt, b.endAt) }),
            buildElement("span", { className: "timeline-block-name", text: b.customerName }));
            block.style.left = percent(minutesIntoDay(b.startAt));
            block.style.width = `calc(${percent(minutesIntoDay(b.endAt))} - ${percent(minutesIntoDay(b.startAt))})`;
            block.addEventListener("click", () => highlightRow(b.id));
            track.append(block);
        }
        // "Now" line on today's view
        const nowMinutes = (serverNow() - Date.parse(availability.dayStart)) / 60000;
        if (nowMinutes >= windowStart && nowMinutes <= windowEnd) {
            const now = buildElement("span", { className: "timeline-now", attrs: { "aria-hidden": "true" } });
            now.style.left = percent(nowMinutes);
            track.append(now);
        }
        return buildElement("div", { className: "timeline-row" },
            buildElement("div", { className: "timeline-label" },
                buildElement("span", { className: "table-number table-number-small", text: String(table.tableNumber) }),
                buildElement("span", { className: "timeline-label-name", text: table.name || `Table ${table.tableNumber}` })),
            track);
    });

    timeline.replaceChildren(buildElement("div", { className: "timeline" },
        buildElement("div", { className: "timeline-row timeline-head" }, buildElement("div", { className: "timeline-label" }), hours),
        ...rows));
}

// ---------- Bookings list ----------

function renderList() {
    const active = bookings.filter((b) => b.status === "pending" || b.status === "confirmed").length;
    bookingsSummary.textContent = bookings.length === 0 ? "" : `${bookings.length} booking${bookings.length === 1 ? "" : "s"} · ${active} upcoming`;

    if (bookings.length === 0) {
        const filtering = selectedStatus || bookingSearch.value.trim();
        const box = filtering
            ? emptyBox("No matching bookings", "Try another status or search.", "calendar")
            : emptyBox("No bookings on this day", "Use \"New Booking\" to reserve a table.", "calendar");
        bookingList.replaceChildren(box);
        return;
    }
    bookingList.replaceChildren(...bookings.map(createBookingRow));
}

function createBookingRow(b) {
    const minutes = Math.round((Date.parse(b.endAt) - Date.parse(b.startAt)) / 60000);
    const isActive = b.status === "pending" || b.status === "confirmed";
    const started = serverNow() >= Date.parse(b.startAt);

    const who = buildElement("div", { className: "booking-who" },
        buildElement("p", { className: "booking-name", text: b.customerName }),
        b.customerPhone
            ? buildElement("a", { className: "booking-phone", text: b.customerPhone, attrs: { href: `tel:${b.customerPhone.replace(/[^\d+]/g, "")}` } })
            : buildElement("span", { className: "booking-phone", text: "No phone" }));

    const meta = [`Table ${b.tableNumber}${b.tableName ? ` · ${b.tableName}` : ""}`];
    if (b.notes) meta.push(b.notes);

    const row = buildElement("article", { className: "booking-row", attrs: { "data-booking-id": b.id } },
        buildElement("div", { className: "booking-time" },
            buildElement("strong", { text: formatTimeRange(b.startAt, b.endAt) }),
            buildElement("span", { text: formatMinutes(minutes) })),
        who,
        buildElement("p", { className: "booking-meta", text: meta.join(" · ") }),
        buildElement("span", { className: `status-badge booking-status-${b.status}`, text: BOOKING_STATUS_LABELS[b.status] }),
        buildElement("div", { className: "booking-actions" }, ...bookingActions(b)));

    if (isActive && started) {
        const noShowAt = new Date(Date.parse(b.startAt) + noShowGraceMinutes * 60000);
        row.append(buildElement("p", { className: "booking-late", text: `Late: becomes a no-show at ${formatTime(noShowAt.toISOString())} if not checked in` }));
    }
    return row;
}

function bookingActions(b) {
    const actions = [];
    const button = (label, className, handler, extra = {}) => {
        const element = buildElement("button", { className: `btn btn-small ${className}`, text: label, attrs: { type: "button", ...extra } });
        element.addEventListener("click", () => handler(element));
        actions.push(element);
        return element;
    };

    if (b.status === "pending" || b.status === "confirmed") {
        const opensAt = Date.parse(b.startAt) - CHECK_IN_EARLY_MS;
        const canCheckIn = serverNow() >= opensAt;
        button("Check in", "btn-primary", (el) => checkIn(b, el), {
            disabled: !canCheckIn,
            title: canCheckIn ? "Customer arrived: start the session" : `Check-in opens at ${formatTime(new Date(opensAt).toISOString())}`,
        });
        if (b.status === "pending") button("Confirm", "btn-secondary", (el) => runAction(`/bookings/${b.id}/confirm`, el));
        button("Edit", "btn-ghost", () => openDialog(b));
        button("Cancel", "btn-ghost is-danger", () => cancelBooking(b));
    } else if (b.status === "completed" && b.session) {
        actions.push(buildElement("a", { className: "btn btn-small btn-ghost", text: "View session", attrs: { href: `/pages/sessions.html#session-${b.session}` } }));
    }
    return actions;
}

async function runAction(path, button, body = {}) {
    setButtonLoading(button, true, "…");
    try {
        const { message } = await apiRequest(path, { method: "POST", body });
        showToast(message);
        await loadDay({ quiet: true });
    } catch (error) {
        showToast(error.message, "error", 6000);
        if (button.isConnected) setButtonLoading(button, false);
    }
}

function checkIn(b, button) {
    return runAction(`/bookings/${b.id}/check-in`, button);
}

async function cancelBooking(b) {
    const ok = await confirmDialog(`${b.customerName}'s booking for Table ${b.tableNumber} (${formatTimeRange(b.startAt, b.endAt)}) will be cancelled and the time slot becomes free.`,
        { title: "Cancel this booking?", confirmText: "Cancel Booking", cancelText: "Keep booking", danger: true });
    if (!ok) return;
    try {
        const { message } = await apiRequest(`/bookings/${b.id}/cancel`, { method: "POST", body: {} });
        showToast(message);
        await loadDay({ quiet: true });
    } catch (error) {
        showToast(error.message, "error", 6000);
    }
}

function highlightRow(bookingId) {
    const row = bookingList.querySelector(`[data-booking-id="${CSS.escape(bookingId)}"]`);
    if (!row) return;
    bookingList.querySelectorAll(".is-highlighted").forEach((el) => el.classList.remove("is-highlighted"));
    row.classList.add("is-highlighted");
    row.scrollIntoView({ block: "center", behavior: "smooth" });
}

// ---------- New / edit dialog ----------

function fillTimeOptions() {
    for (let minute = 0; minute < DAY_MINUTES; minute += 15) {
        const value = `${String(Math.floor(minute / 60)).padStart(2, "0")}:${String(minute % 60).padStart(2, "0")}`;
        const hour = Math.floor(minute / 60);
        const label = `${hour % 12 === 0 ? 12 : hour % 12}:${String(minute % 60).padStart(2, "0")} ${hour < 12 ? "am" : "pm"}`;
        startSelect.append(buildElement("option", { text: label, attrs: { value } }));
    }
    for (let minutes = 30; minutes <= 480; minutes += 15) {
        durationSelect.append(buildElement("option", { text: formatMinutes(minutes), attrs: { value: String(minutes) } }));
    }
}

function fillTableOptions(selectedId) {
    const tables = availability ? availability.tables : [];
    tableSelect.replaceChildren(
        buildElement("option", { text: "Choose a table", attrs: { value: "" } }),
        ...tables.map((t) => buildElement("option", {
            text: `Table ${t.tableNumber}${t.name ? ` · ${t.name}` : ""}${t.status === "maintenance" ? " (maintenance now)" : ""}`,
            attrs: { value: t.id },
        })));
    tableSelect.value = selectedId || "";
}

// Next quarter hour from now (club time) on today; 18:00 on other days
function defaultStartTime() {
    if (currentDay !== clubDateOf(new Date(serverNow()).toISOString())) return "18:00";
    const [h, m] = clubTimeOf(new Date(serverNow() + 15 * 60000).toISOString()).split(":").map(Number);
    const rounded = Math.ceil((h * 60 + m) / 15) * 15;
    return rounded >= DAY_MINUTES ? "23:45" : `${String(Math.floor(rounded / 60)).padStart(2, "0")}:${String(rounded % 60).padStart(2, "0")}`;
}

function openDialog(booking = null, presetCustomer = null) {
    editingBooking = booking;
    form.reset();
    clearFormErrors();
    setCustomer(null);
    showNewCustomer(false);

    const isEdit = Boolean(booking);
    document.getElementById("booking-dialog-title").textContent = isEdit ? `Edit booking · ${booking.customerName}` : "New booking";
    document.getElementById("confirmed-field").hidden = isEdit;
    newCustomerToggle.hidden = isEdit;
    changeCustomerButton.hidden = isEdit;

    if (isEdit) {
        setCustomer({ id: booking.customer, name: booking.customerName, phone: booking.customerPhone });
        fillTableOptions(booking.table);
        dateField.value = clubDateOf(booking.startAt);
        startSelect.value = clubTimeOf(booking.startAt);
        durationSelect.value = String(Math.round((Date.parse(booking.endAt) - Date.parse(booking.startAt)) / 60000));
        form.elements.notes.value = booking.notes;
    } else {
        fillTableOptions("");
        dateField.value = currentDay;
        startSelect.value = defaultStartTime();
        durationSelect.value = "60";
        if (presetCustomer) setCustomer(presetCustomer);
    }

    dialog.showModal();
    (isEdit || presetCustomer ? tableSelect : customerSearch).focus();
}

function setCustomer(customer) {
    selectedCustomer = customer;
    selectedBox.hidden = !customer;
    customerSearch.parentElement.hidden = Boolean(customer);
    selectedText.textContent = customer ? `${customer.name}${customer.phone ? ` · ${customer.phone}` : ""}` : "";
    hideSuggestions();
}

function showNewCustomer(show) {
    addingNewCustomer = show;
    newCustomerFields.hidden = !show;
    customerSearch.parentElement.hidden = show || Boolean(selectedCustomer);
    selectedBox.hidden = show || !selectedCustomer;
    newCustomerToggle.replaceChildren(createIcon(show ? "search" : "plus"), show ? " Find existing customer" : " New customer");
    if (show) document.getElementById("new-customer-name").focus();
}

// --- Customer suggestions (combobox) ---

async function searchCustomers() {
    const text = customerSearch.value.trim();
    if (text.length < 2) return hideSuggestions();
    try {
        const { data } = await apiRequest(`/customers?search=${encodeURIComponent(text)}&limit=8`);
        if (customerSearch.value.trim() !== text) return; // the user kept typing
        renderSuggestions(data.customers, text);
    } catch (error) {
        renderSuggestions([], text, error.message);
    }
}

function renderSuggestions(customers, text, errorMessage) {
    const items = customers.map((c, index) => {
        const item = buildElement("li", { className: "suggestion", attrs: { role: "option", id: `suggestion-${index}`, "aria-selected": "false" } },
            buildElement("span", { className: "suggestion-name", text: c.name }),
            buildElement("span", { className: "suggestion-meta", text: c.phone || "No phone" }));
        item.addEventListener("mousedown", (event) => {
            event.preventDefault(); // keep focus
            setCustomer({ id: c.id, name: c.name, phone: c.phone });
            tableSelect.focus();
        });
        return item;
    });
    if (items.length === 0) {
        const empty = buildElement("li", { className: "suggestion is-empty", text: errorMessage || `No customer called "${text}". ` });
        if (!errorMessage) {
            const add = buildElement("button", { className: "btn btn-ghost btn-small", text: `Add "${text}" as new`, attrs: { type: "button" } });
            add.addEventListener("mousedown", (event) => {
                event.preventDefault();
                showNewCustomer(true);
                document.getElementById("new-customer-name").value = text;
                hideSuggestions();
            });
            empty.append(add);
        }
        items.push(empty);
    }
    suggestions.replaceChildren(...items);
    suggestions.hidden = false;
    customerSearch.setAttribute("aria-expanded", "true");
}

function hideSuggestions() {
    suggestions.hidden = true;
    customerSearch.setAttribute("aria-expanded", "false");
    customerSearch.removeAttribute("aria-activedescendant");
}

// Arrow keys + Enter in the suggestion list
customerSearch.addEventListener("keydown", (event) => {
    const options = [...suggestions.querySelectorAll('[role="option"]')];
    if (suggestions.hidden || options.length === 0) return;
    const current = options.findIndex((o) => o.getAttribute("aria-selected") === "true");
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        event.preventDefault();
        const next = event.key === "ArrowDown" ? Math.min(options.length - 1, current + 1) : Math.max(0, current - 1);
        options.forEach((o, i) => o.setAttribute("aria-selected", String(i === next)));
        customerSearch.setAttribute("aria-activedescendant", options[next].id);
    } else if (event.key === "Enter" && current >= 0) {
        event.preventDefault();
        options[current].dispatchEvent(new MouseEvent("mousedown", { cancelable: true }));
    } else if (event.key === "Escape") {
        event.stopPropagation();
        hideSuggestions();
    }
});

// --- Saving ---

function readBookingForm() {
    const body = {
        tableId: tableSelect.value,
        date: dateField.value,
        startTime: startSelect.value,
        durationMinutes: Number(durationSelect.value),
        notes: form.elements.notes.value.trim(),
    };
    const errors = [];
    if (!editingBooking) {
        if (addingNewCustomer) {
            const name = document.getElementById("new-customer-name").value.trim();
            if (name.length < 2) errors.push({ field: "customer", message: "Enter the new customer's name (at least 2 letters)" });
            body.newCustomer = { name, phone: document.getElementById("new-customer-phone").value.trim() };
        } else if (selectedCustomer) {
            body.customerId = selectedCustomer.id;
        } else {
            errors.push({ field: "customer", message: "Choose a customer or add a new one" });
        }
        if (document.getElementById("booking-confirmed").checked) body.status = "confirmed";
    }
    if (!body.tableId) errors.push({ field: "tableId", message: "Choose a table" });
    if (!body.date) errors.push({ field: "date", message: "Choose a date" });
    return { body, errors };
}

function showFormErrors(errors, message) {
    let shown = false;
    for (const { field, message: text } of errors) {
        // Server fields like "newCustomer.name" or "customerId" belong to the customer section
        const key = /^(customerId|newCustomer)/.test(field) || field === "" ? "customer" : field;
        const target = form.querySelector(`[data-error-for="${key}"]`);
        if (target) {
            target.textContent = text;
            target.hidden = false;
            shown = true;
        }
    }
    if (message && (!shown || errors.length === 0)) {
        formError.textContent = message;
        formError.hidden = false;
    }
}

function clearFormErrors() {
    formError.hidden = true;
    form.querySelectorAll("[data-error-for]").forEach((el) => (el.hidden = true));
}

form.addEventListener("submit", async (event) => {
    event.preventDefault();
    clearFormErrors();
    const { body, errors } = readBookingForm();
    if (errors.length) return showFormErrors(errors);

    setButtonLoading(saveButton, true, "Saving…");
    try {
        const { data, message } = editingBooking
            ? await apiRequest(`/bookings/${editingBooking.id}`, { method: "PATCH", body })
            : await apiRequest("/bookings", { method: "POST", body });
        dialog.close();
        showToast(message);
        currentDay = clubDateOf(data.startAt); // show the day the booking is on
        await loadDay();
        highlightRow(data.id);
    } catch (error) {
        // e.g. 409 "Table 2 is already booked 6:00 pm–7:30 pm (Ali)" - shown in the form, which stays open
        showFormErrors(error.errors || [], error.message);
    } finally {
        setButtonLoading(saveButton, false);
    }
});

// ---------- Small builders ----------

function emptyBox(title, text, icon) {
    return buildElement("div", { className: "empty-state panel-empty" },
        buildElement("span", { className: "empty-state-icon" }, createIcon(icon)),
        buildElement("p", { className: "empty-state-title", text: title }),
        buildElement("p", { text }));
}

function loadingState() {
    return buildElement("div", { className: "empty-state panel-empty" },
        buildElement("span", { className: "spinner", attrs: { "aria-hidden": "true" } }), buildElement("p", { text: "Loading…" }));
}

// ---------- Events ----------

document.getElementById("new-booking-button").addEventListener("click", () => openDialog());
document.getElementById("booking-cancel").addEventListener("click", () => dialog.close());
document.getElementById("day-prev").addEventListener("click", () => goToDay(addDays(currentDay, -1)));
document.getElementById("day-next").addEventListener("click", () => goToDay(addDays(currentDay, 1)));
document.getElementById("day-today").addEventListener("click", () => goToDay(clubDateOf(new Date(serverNow()).toISOString())));
dayInput.addEventListener("change", () => dayInput.value && goToDay(dayInput.value));

statusFilter.addEventListener("click", (event) => {
    const chip = event.target.closest(".chip");
    if (!chip) return;
    selectedStatus = chip.dataset.status;
    statusFilter.querySelectorAll(".chip").forEach((c) => c.setAttribute("aria-pressed", String(c === chip)));
    loadDay({ quiet: true });
});
bookingSearch.addEventListener("input", () => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => loadDay({ quiet: true }), 300);
});

customerSearch.addEventListener("input", () => {
    clearTimeout(customerTimer);
    customerTimer = setTimeout(searchCustomers, 250);
});
customerSearch.addEventListener("blur", () => setTimeout(hideSuggestions, 150));
changeCustomerButton.addEventListener("click", () => {
    setCustomer(null);
    customerSearch.focus();
});
newCustomerToggle.addEventListener("click", () => showNewCustomer(!addingNewCustomer));

// ---------- Start ----------

async function start() {
    fillTimeOptions();
    // "Today" comes from the server's clock, shown in club time
    try {
        const health = await apiRequest("/health");
        syncServerClock(health.data.serverTime);
    } catch {
        // the layout shows the server status; fall back to this computer's clock
    }
    apiRequest("/settings").then(({ data }) => (noShowGraceMinutes = data.noShowGraceMinutes)).catch(() => {});

    // Links: ?date=2026-10-07   ?action=new   ?action=new&customer=<id>
    const address = new URLSearchParams(location.search);
    const requestedDay = address.get("date");
    currentDay = /^\d{4}-\d{2}-\d{2}$/.test(requestedDay || "") ? requestedDay : clubDateOf(new Date(serverNow()).toISOString());
    await loadDay();

    if (address.get("action") === "new") {
        let preset = null;
        const customerId = address.get("customer");
        if (customerId) {
            try {
                const { data } = await apiRequest(`/customers/${customerId}`);
                preset = { id: data.id, name: data.name, phone: data.phone };
            } catch (error) {
                showToast(error.message, "error");
            }
        }
        openDialog(null, preset);
    }
    if (location.search) history.replaceState(null, "", location.pathname);
}

start();
setInterval(() => {
    if (!document.hidden && !document.querySelector("dialog[open]")) loadDay({ quiet: true });
}, REFRESH_MS);
