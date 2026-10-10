// customers.js (page) - list, search, add, edit, profile with booking history, delete/archive.
// Uses: apiRequest (api.js), buildElement/createIcon/showToast/confirmDialog/setButtonLoading (ui.js), format.js helpers

const PAGE_SIZE = 25;

// ---------- Page elements ----------
const searchInput = document.getElementById("customer-search");
const archivedToggle = document.getElementById("show-archived");
const loadingBox = document.getElementById("customers-loading");
const emptyBox = document.getElementById("customers-empty");
const tableWrapper = document.getElementById("customers-wrapper");
const customersBody = document.getElementById("customers-body");
const customersSummary = document.getElementById("customers-summary");
const pagination = document.getElementById("customers-pagination");
const pageInfo = document.getElementById("page-info");
const prevButton = document.getElementById("page-prev");
const nextButton = document.getElementById("page-next");

const customerDialog = document.getElementById("customer-dialog");
const customerForm = document.getElementById("customer-form");
const customerFormError = document.getElementById("customer-form-error");
const customerSave = document.getElementById("customer-save");
const profileDialog = document.getElementById("profile-dialog");
const profile = document.getElementById("profile");

// ---------- State ----------
let currentPage = 1;
let editingCustomer = null;
let searchTimer = null;
let latestRequest = 0;

// ---------- List ----------

function showList(element) {
    for (const box of [loadingBox, emptyBox, tableWrapper]) box.hidden = box !== element;
}

async function loadCustomers({ quiet = false } = {}) {
    const params = new URLSearchParams({ page: currentPage, limit: PAGE_SIZE });
    const search = searchInput.value.trim();
    if (search) params.set("search", search);
    if (archivedToggle.checked) params.set("includeArchived", "true");

    const requestNumber = ++latestRequest;
    if (!quiet) showList(loadingBox);
    try {
        const { data } = await apiRequest(`/customers?${params}`);
        if (requestNumber !== latestRequest) return;
        if (data.customers.length === 0 && data.total > 0 && currentPage > data.totalPages) {
            currentPage = data.totalPages;
            return loadCustomers({ quiet });
        }
        renderCustomers(data, Boolean(search));
    } catch (error) {
        if (requestNumber !== latestRequest) return;
        showEmpty("Could not load customers", error.message);
        showToast(error.message, "error");
    }
}

function showEmpty(title, text) {
    document.getElementById("customers-empty-title").textContent = title;
    document.getElementById("customers-empty-text").textContent = text;
    pagination.hidden = true;
    customersSummary.textContent = "";
    showList(emptyBox);
}

function renderCustomers(data, isSearching) {
    if (data.total === 0) {
        if (isSearching) showEmpty("No matching customers", "Try another name or phone number.");
        else showEmpty("No customers yet", "Add a customer here, or while making a booking.");
        return;
    }
    customersBody.replaceChildren(...data.customers.map(createCustomerRow));
    customersSummary.textContent = data.total === 1 ? "1 customer" : `${data.total} customers`;
    pagination.hidden = data.totalPages <= 1;
    pageInfo.textContent = `Page ${data.page} of ${data.totalPages}`;
    prevButton.disabled = data.page <= 1;
    nextButton.disabled = data.page >= data.totalPages;
    showList(tableWrapper);
}

function createCustomerRow(customer) {
    const nameButton = buildElement("button", { className: "link-button", text: customer.name, attrs: { type: "button" } });
    nameButton.addEventListener("click", () => openProfile(customer.id));
    const nameCell = buildElement("td", { attrs: { "data-label": "Name" } }, nameButton,
        customer.isActive ? null : buildElement("span", { className: "badge archived-badge", text: "Archived" }));

    const actions = buildElement("td", { className: "actions-cell" });
    const view = buildElement("button", { className: "btn btn-secondary btn-small", text: "View", attrs: { type: "button", "aria-label": `View ${customer.name}` } });
    view.addEventListener("click", () => openProfile(customer.id));
    actions.append(view);
    if (customer.isActive) {
        const edit = buildElement("button", { className: "btn btn-ghost btn-small", text: "Edit", attrs: { type: "button", "aria-label": `Edit ${customer.name}` } });
        edit.addEventListener("click", () => openCustomerDialog(customer));
        actions.append(edit);
    }

    return buildElement("tr", {},
        nameCell,
        buildElement("td", { text: customer.phone || "—", attrs: { "data-label": "Phone" } }),
        buildElement("td", { className: "numeric", text: String(customer.bookingCount), attrs: { "data-label": "Bookings" } }),
        buildElement("td", { text: customer.lastBookingAt ? formatDateTime(customer.lastBookingAt) : "—", attrs: { "data-label": "Last booking" } }),
        actions);
}

// ---------- Add / edit ----------

function openCustomerDialog(customer = null) {
    editingCustomer = customer;
    customerForm.reset();
    clearErrors();
    document.getElementById("customer-dialog-title").textContent = customer ? `Edit ${customer.name}` : "Add customer";
    if (customer) {
        customerForm.elements.name.value = customer.name;
        customerForm.elements.phone.value = customer.phone;
        customerForm.elements.notes.value = customer.notes || "";
    }
    customerDialog.showModal();
    customerForm.elements.name.focus();
}

function clearErrors() {
    customerFormError.hidden = true;
    customerForm.querySelectorAll("[data-error-for]").forEach((el) => (el.hidden = true));
}

customerForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    clearErrors();
    const body = {
        name: customerForm.elements.name.value.trim(),
        phone: customerForm.elements.phone.value.trim(),
        notes: customerForm.elements.notes.value.trim(),
    };
    if (body.name.length < 2) {
        const target = customerForm.querySelector('[data-error-for="name"]');
        target.textContent = "Enter a name (at least 2 letters)";
        target.hidden = false;
        return;
    }

    setButtonLoading(customerSave, true, "Saving…");
    try {
        const { message } = editingCustomer
            ? await apiRequest(`/customers/${editingCustomer.id}`, { method: "PATCH", body })
            : await apiRequest("/customers", { method: "POST", body });
        customerDialog.close();
        showToast(message);
        await loadCustomers({ quiet: true });
        if (profileDialog.open && editingCustomer) openProfile(editingCustomer.id);
    } catch (error) {
        let shown = false;
        for (const { field, message } of error.errors || []) {
            const target = customerForm.querySelector(`[data-error-for="${field}"]`);
            if (target) {
                target.textContent = message;
                target.hidden = false;
                shown = true;
            }
        }
        if (!shown) {
            customerFormError.textContent = error.message;
            customerFormError.hidden = false;
        }
    } finally {
        setButtonLoading(customerSave, false);
    }
});

// ---------- Profile ----------

async function openProfile(customerId) {
    // Never show the previous customer's details while this one loads
    profile.replaceChildren(buildElement("div", { className: "empty-state panel-empty" },
        buildElement("span", { className: "spinner", attrs: { "aria-hidden": "true" } }), buildElement("p", { text: "Loading…" })));
    try {
        const { data } = await apiRequest(`/customers/${customerId}`);
        renderProfile(data);
        if (!profileDialog.open) profileDialog.showModal();
    } catch (error) {
        showToast(error.message, "error");
    }
}

function renderProfile(customer) {
    const close = buildElement("button", { className: "btn btn-ghost btn-icon", attrs: { type: "button", "aria-label": "Close" } }, createIcon("close"));
    close.addEventListener("click", () => profileDialog.close());

    const stat = (label, value) => buildElement("div", { className: "mini-stat" },
        buildElement("strong", { text: String(value) }), buildElement("span", { text: label }));

    const actions = buildElement("div", { className: "modal-actions detail-actions" });
    if (customer.isActive) {
        const remove = buildElement("button", { className: "btn btn-ghost is-danger", text: customer.stats.bookings > 0 ? "Archive" : "Delete", attrs: { type: "button" } });
        remove.addEventListener("click", () => deleteCustomer(customer));
        const edit = buildElement("button", { className: "btn btn-secondary", text: "Edit", attrs: { type: "button" } });
        edit.addEventListener("click", () => openCustomerDialog(customer));
        const book = buildElement("a", { className: "btn btn-primary", attrs: { href: `/pages/bookings.html?action=new&customer=${customer.id}` } },
            createIcon("calendar"), "New booking");
        actions.append(remove, edit, book);
    }

    const parts = [
        buildElement("header", { className: "bill-detail-header" },
            buildElement("div", {},
                buildElement("h2", { className: "modal-title", text: customer.name, attrs: { id: "profile-title" } }),
                buildElement("p", { className: "modal-subtitle", text: [customer.phone || "No phone", `Customer since ${formatDateTime(customer.createdAt)}`].join(" · ") })),
            customer.isActive ? null : buildElement("span", { className: "badge archived-badge", text: "Archived" }),
            close),
        customer.notes ? buildElement("p", { className: "field-hint", text: customer.notes }) : null,
        buildElement("div", { className: "mini-stats" },
            stat("Bookings", customer.stats.bookings),
            stat("Checked in", customer.stats.completed),
            stat("Upcoming", customer.stats.upcoming),
            stat("No-shows", customer.stats.noShows),
            stat("Cancelled", customer.stats.cancelled)),
        buildElement("h3", { className: "detail-section-title", text: "Booking history" }),
        buildHistory(customer.bookings),
        actions,
    ];
    profile.replaceChildren(...parts.filter(Boolean));
}

function buildHistory(bookings) {
    if (bookings.length === 0) return buildElement("p", { className: "field-hint", text: "No bookings yet." });
    const head = buildElement("tr", {}, ...["When", "Table", "Status", "Played"].map((text) =>
        buildElement("th", { text, attrs: { scope: "col" } })));
    const rows = bookings.map((b) => {
        const played = b.sessionInfo
            ? b.sessionInfo.status === "active" ? "Playing now" : formatDuration(b.sessionInfo.durationSeconds)
            : "—";
        return buildElement("tr", {},
            buildElement("td", { text: `${formatDateTime(b.startAt)} (${formatMinutes(Math.round((Date.parse(b.endAt) - Date.parse(b.startAt)) / 60000))})` }),
            buildElement("td", { text: `${b.tableNumber}${b.tableName ? ` · ${b.tableName}` : ""}` }),
            buildElement("td", {}, buildElement("span", { className: `status-badge booking-status-${b.status}`, text: BOOKING_STATUS_LABELS[b.status] })),
            buildElement("td", { text: played }));
    });
    return buildElement("div", { className: "history-scroll" },
        buildElement("table", { className: "detail-table" }, buildElement("thead", {}, head), buildElement("tbody", {}, ...rows)));
}

async function deleteCustomer(customer) {
    const hasBookings = customer.stats.bookings > 0;
    const ok = await confirmDialog(
        hasBookings
            ? `${customer.name} has ${customer.stats.bookings} booking(s), so they will be archived: hidden from lists, but their booking history stays.`
            : `${customer.name} will be deleted permanently.`,
        { title: hasBookings ? `Archive ${customer.name}?` : `Delete ${customer.name}?`, confirmText: hasBookings ? "Archive" : "Delete", danger: true });
    if (!ok) return;
    try {
        const { message } = await apiRequest(`/customers/${customer.id}`, { method: "DELETE" });
        showToast(message);
        profileDialog.close();
        await loadCustomers({ quiet: true });
    } catch (error) {
        showToast(error.message, "error", 6000);
    }
}

// ---------- Events ----------

document.getElementById("add-customer-button").addEventListener("click", () => openCustomerDialog());
document.getElementById("customer-cancel").addEventListener("click", () => customerDialog.close());
searchInput.addEventListener("input", () => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => {
        currentPage = 1;
        loadCustomers();
    }, 300);
});
archivedToggle.addEventListener("change", () => {
    currentPage = 1;
    loadCustomers();
});
prevButton.addEventListener("click", () => {
    currentPage -= 1;
    loadCustomers();
});
nextButton.addEventListener("click", () => {
    currentPage += 1;
    loadCustomers();
});

loadCustomers();
