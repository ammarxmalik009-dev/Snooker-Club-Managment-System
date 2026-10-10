// dashboard.js - the club overview. ONE request (GET /api/dashboard/summary) returns
// everything; all totals are calculated on the server. This file only displays them.
// Reuses: createActiveSessionRow / createTimerElement / startLiveTimers / syncServerClock (core/sessions.js),
//         openCreateBillDialog (core/billing.js), buildElement / createIcon / showToast (ui.js), format.js helpers.

const DASHBOARD_REFRESH_MS = 30000;

let lastData = null;      // the last summary that loaded successfully
let lastLoadedAt = null;  // when (browser time) - shown as "Updated 5:25 pm"
let loading = false;

const errorBox = document.getElementById("dashboard-error");
const errorText = document.getElementById("dashboard-error-text");

// ---------- Loading ----------

async function loadDashboard() {
    if (loading) return;
    loading = true;
    try {
        const { data } = await apiRequest("/dashboard/summary");
        syncServerClock(data.serverTime); // live timers use the server's clock
        lastData = data;
        lastLoadedAt = new Date();
        errorBox.hidden = true;
        renderDashboard(data);
    } catch (error) {
        showLoadError(error);
    } finally {
        loading = false;
    }
}

// If loading fails we NEVER show zeros. Either we keep the last good figures (and say so),
// or - on the first load - every number shows "—" and each section explains the problem.
function showLoadError(error) {
    const reason = error.status === 0
        ? "The server can't be reached."
        : error.status === 503 ? "The database is not available." : error.message;

    if (lastData) {
        errorText.textContent = `Couldn't refresh: ${reason} The figures below are from ${formatClock(lastLoadedAt)}.`;
    } else {
        errorText.textContent = `The dashboard couldn't be loaded. ${reason}`;
        document.querySelectorAll("[data-value]").forEach((element) => (element.textContent = "—"));
        document.querySelector('[data-hint="bills"]').textContent = "Could not load";
        for (const id of ["revenue-panel", "active-sessions", "table-overview", "upcoming-bookings", "recent-bills", "recent-sessions"]) {
            document.getElementById(id).replaceChildren(emptyState("Could not load", reason, "close"));
        }
    }
    errorBox.hidden = false;
}

function formatClock(date) {
    return date.toLocaleTimeString("en-GB", { timeZone: CLUB_TIME_ZONE, hour: "numeric", minute: "2-digit", hour12: true });
}

// ---------- Rendering ----------

function renderDashboard(data) {
    // Business day comes from the server (Karachi date), not from this computer's clock
    const dayLabel = new Date(`${data.businessDay.date}T12:00:00Z`).toLocaleDateString("en-GB", {
        weekday: "long", day: "numeric", month: "long", year: "numeric", timeZone: "UTC",
    });
    document.getElementById("business-day").textContent = `Club overview for ${dayLabel}`;
    document.getElementById("last-updated").textContent = `Updated ${formatClock(lastLoadedAt)} · refreshes every 30 seconds`;
    document.getElementById("today-bills-link").href = `/pages/billing.html?from=${data.businessDay.date}&to=${data.businessDay.date}`;

    // Number cards: data-value="tables.available" -> data.tables.available
    document.querySelectorAll("[data-value]").forEach((element) => {
        const value = element.dataset.value.split(".").reduce((object, key) => object?.[key], data);
        element.textContent = element.dataset.format === "money" ? formatMoney(value) : value;
    });
    const t = data.today;
    document.querySelector('[data-hint="bills"]').textContent =
        `${t.paidCount} paid · ${t.openCount} open${t.cancelledCount ? ` · ${t.cancelledCount} cancelled` : ""}`;

    renderRevenue(data);
    renderActiveSessions(data.activeSessions);
    renderTableOverview(data.tableOverview);
    renderUpcomingBookings(data.upcomingBookings);
    renderRecentBills(data.recentBills);
    renderRecentSessions(data.recentSessions);
}

function renderRevenue({ today, businessDay }) {
    const panel = document.getElementById("revenue-panel");
    if (today.billCount === 0 && today.paymentCount === 0 && today.cancelledCount === 0) {
        panel.replaceChildren(emptyState("No bills today", "Bills appear here as soon as sessions are billed.", "receipt"));
        return;
    }

    // Paid share of today's billed amount (display only; the amounts come from the server)
    const paidPercent = today.totalBilled > 0 ? Math.round((today.totalPaid / today.totalBilled) * 100) : 0;
    const fill = buildElement("span", { className: "progress-fill" });
    fill.style.width = `${paidPercent}%`;
    const bar = buildElement("div", { className: "progress", attrs: { role: "img", "aria-label": `${paidPercent}% of today's billed amount is paid` } }, fill);

    const row = (label, value, className = "") => buildElement("div", { className: `revenue-row ${className}` },
        buildElement("dt", { text: label }), buildElement("dd", { text: value }));

    panel.replaceChildren(
        buildElement("dl", { className: "revenue-list" },
            row("Total billed", formatMoney(today.totalBilled), "is-strong"),
            row("Paid", formatMoney(today.totalPaid), "is-paid"),
            row("Outstanding", formatMoney(today.totalOutstanding), today.totalOutstanding > 0 ? "is-due" : "")),
        bar,
        buildElement("p", { className: "field-hint", text: `${paidPercent}% collected` }),
        buildElement("dl", { className: "revenue-counts" },
            row("Bills", String(today.billCount)),
            row("Paid", String(today.paidCount)),
            row("Unpaid / partly paid", String(today.openCount)),
            row("Cancelled (not counted)", String(today.cancelledCount))),
        buildElement("p", { className: "revenue-cash" },
            buildElement("span", { text: `Payments received on ${businessDay.date}` }),
            buildElement("strong", { text: `${formatMoney(today.paymentsReceived)} (${today.paymentCount})` })),
        buildElement("p", { className: "field-hint", text: "Includes money received today for bills from earlier days." })
    );
}

function renderActiveSessions(sessions) {
    const list = document.getElementById("active-sessions");
    if (sessions.length === 0) {
        list.replaceChildren(emptyState("No active sessions", "Start a session from the Tables page when players arrive.", "timer"));
        return;
    }
    // Same rows, timers and End -> Create Bill flow as the Sessions page
    list.replaceChildren(...sessions.map((session) => createActiveSessionRow(session, loadDashboard)));
}

function renderTableOverview(tables) {
    const container = document.getElementById("table-overview");
    if (tables.length === 0) {
        const box = emptyState("No tables yet", "Add your snooker tables to get started.", "table");
        box.append(buildElement("a", { className: "btn btn-primary btn-small", text: "Add Table", attrs: { href: "/pages/tables.html?action=add" } }));
        container.replaceChildren(box);
        return;
    }

    const grid = buildElement("div", { className: "table-tiles" });
    for (const table of tables) {
        const session = table.activeSession;
        // Occupied -> its running session; otherwise -> the table on the Tables page
        const href = session ? `/pages/sessions.html#session-${session.id}` : `/pages/tables.html#table-${table.id}`;
        const label = `Table ${table.tableNumber}${table.name ? `, ${table.name}` : ""}: ${capitalize(table.status)}`;

        const tile = buildElement("a", { className: "table-tile", attrs: { href, "data-status": table.status, "aria-label": label } },
            buildElement("span", { className: "table-number table-number-small", text: String(table.tableNumber) }),
            buildElement("span", { className: "table-tile-name", text: table.name || `Table ${table.tableNumber}` }),
            buildElement("span", { className: `status-badge status-${table.status}`, text: capitalize(table.status) }));
        if (session) {
            tile.append(buildElement("span", { className: "table-tile-session" },
                createTimerElement(session.startedAt, "session-timer session-timer-small"),
                buildElement("span", { className: "session-started", text: `since ${formatTime(session.startedAt)}` })));
        }
        grid.append(tile);
    }
    container.replaceChildren(grid);
}

// Phase 7: the next bookings still to come today
function renderUpcomingBookings(bookings) {
    const list = document.getElementById("upcoming-bookings");
    if (bookings.length === 0) {
        const box = emptyState("No more bookings today", "New bookings for today will appear here.", "calendar");
        box.append(buildElement("a", { className: "btn btn-secondary btn-small", text: "New Booking", attrs: { href: "/pages/bookings.html?action=new" } }));
        list.replaceChildren(box);
        return;
    }
    list.replaceChildren(...bookings.map((b) => buildElement("a", { className: "upcoming-row", attrs: { href: "/pages/bookings.html" } },
        buildElement("span", { className: "upcoming-time", text: formatTimeRange(b.startAt, b.endAt) }),
        buildElement("span", { className: "table-number table-number-small", text: String(b.tableNumber) }),
        buildElement("span", { className: "upcoming-name" },
            buildElement("strong", { text: b.customerName }),
            buildElement("span", { className: "cell-sub", text: b.customerPhone || "No phone" })),
        buildElement("span", { className: `status-badge booking-status-${b.status}`, text: BOOKING_STATUS_LABELS[b.status] }))));
}

function renderRecentBills(bills) {
    const container = document.getElementById("recent-bills");
    if (bills.length === 0) {
        container.replaceChildren(emptyState("No bills yet", "End a session and create its bill to see it here.", "receipt", true));
        return;
    }
    const rows = bills.map((bill) => {
        // Opens the EXISTING bill details on the Billing page
        const link = buildElement("a", { className: "cell-link", text: bill.billNumber, attrs: { href: `/pages/billing.html?bill=${bill.id}` } });
        return buildElement("tr", {},
            td("Bill", link, buildElement("span", { className: "cell-sub", text: formatDateTime(bill.createdAt) })),
            td("Table", `${bill.tableNumber}${bill.tableName ? ` · ${bill.tableName}` : ""}`),
            td("Players", bill.players.join(", ")),
            moneyTd("Total", bill.total),
            moneyTd("Paid", bill.amountPaid),
            moneyTd("Remaining", bill.balanceDue),
            td("Status", buildElement("span", { className: `status-badge status-${bill.status}`, text: BILL_STATUS_LABELS[bill.status] })));
    });
    container.replaceChildren(dataTable(["Bill", "Table", "Players", "Total", "Paid", "Remaining", "Status"], [3, 4, 5], rows));
}

function renderRecentSessions(sessions) {
    const container = document.getElementById("recent-sessions");
    if (sessions.length === 0) {
        container.replaceChildren(emptyState("No finished sessions yet", "Finished sessions appear here with their bill.", "history", true));
        return;
    }
    const rows = sessions.map((session) => {
        let billCell;
        const playedAsMatches = !session.bill && session.matches && session.matches.total > session.matches.cancelled;
        if (playedAsMatches) {
            // Phase 11.5: one bill per match - made in the session's Matches window
            billCell = createMatchesButton(session, "btn btn-secondary btn-small");
            billCell.lastChild.textContent = matchBillingSummary(session.matches).replace("Billed per match", "Matches billed");
        } else if (session.bill) {
            billCell = buildElement("a", { className: "bill-link", attrs: { href: `/pages/billing.html?bill=${session.bill.id}` } },
                buildElement("span", { className: `status-badge status-${session.bill.status}`, text: BILL_STATUS_LABELS[session.bill.status] }),
                buildElement("span", { className: "bill-link-number", text: session.bill.billNumber }));
        } else {
            // Not billed yet -> the existing Create Bill window
            billCell = buildElement("button", { className: "btn btn-secondary btn-small", attrs: { type: "button" } }, createIcon("receipt"), "Create bill");
            billCell.addEventListener("click", async () => {
                if (await openCreateBillDialog(session)) loadDashboard();
            });
        }
        return buildElement("tr", {},
            td("Table", `${session.tableNumber}${session.tableName ? ` · ${session.tableName}` : ""}`),
            td("Started", formatDateTime(session.startedAt)),
            td("Ended", formatDateTime(session.endedAt)),
            td("Billed time", session.bill ? formatMinutes(session.bill.billedMinutes) : "—"),
            td("Game", session.bill ? `${gameModeLabel(session.bill.gameMode)} × ${session.bill.quantity}` : playedAsMatches ? `${session.matches.total - session.matches.cancelled} matches` : "—"),
            td("Bill", billCell));
    });
    container.replaceChildren(dataTable(["Table", "Started", "Ended", "Billed time", "Game", "Bill"], [], rows));
}

// ---------- Small builders ----------

function td(label, ...children) {
    return buildElement("td", { attrs: { "data-label": label } }, ...children);
}

function moneyTd(label, amount) {
    return buildElement("td", { className: "numeric", text: formatMoney(amount), attrs: { "data-label": label } });
}

// A responsive table (scrolls sideways inside its box; becomes cards on phones)
function dataTable(headings, numericColumns, rows) {
    const head = buildElement("tr", {}, ...headings.map((text, index) =>
        buildElement("th", { className: numericColumns.includes(index) ? "numeric" : "", text, attrs: { scope: "col" } })));
    return buildElement("div", { className: "table-scroll" },
        buildElement("table", { className: "data-table" }, buildElement("thead", {}, head), buildElement("tbody", {}, ...rows)));
}

function emptyState(title, text, icon, padded = false) {
    const box = buildElement("div", { className: padded ? "empty-state panel-empty" : "empty-state" },
        buildElement("span", { className: "empty-state-icon" }, createIcon(icon)),
        buildElement("p", { className: "empty-state-title", text: title }),
        buildElement("p", { text }));
    return box;
}

// ---------- Start ----------

document.getElementById("refresh-button").addEventListener("click", loadDashboard);
document.getElementById("retry-button").addEventListener("click", loadDashboard);

startLiveTimers();
loadDashboard();

// Keep the overview current (e.g. sessions started on another computer).
// Skipped while a window (End session / Create bill) is open, so nothing changes under the user.
setInterval(() => {
    if (!document.hidden && !document.querySelector("dialog[open]")) loadDashboard();
}, DASHBOARD_REFRESH_MS);
