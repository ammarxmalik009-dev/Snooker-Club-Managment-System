// reports.js (page) - business reports for a period. Every number is calculated by the SERVER
// (GET /api/reports/...); this file only asks for them and displays them.
// The period is sent as a preset ("last7") or From/To dates. The server decides what those
// mean in Karachi time, so this computer's own clock/timezone never changes a report.
// Uses: apiRequest/goToLogin (api.js), buildElement/createIcon/showToast/setButtonLoading (ui.js),
//       format.js helpers and labels, currentUser (layout.js), Chart (Chart.js, /vendor).

const SECTIONS = ["revenue", "payments", "games", "matches", "players", "tables", "bookings", "customers", "outstanding"];
const PRESET_LABELS = {
    today: "Today", yesterday: "Yesterday", last7: "Last 7 days", last30: "Last 30 days",
    thisMonth: "This month", prevMonth: "Previous month", custom: "Custom",
};
const FILTER_KEYS = ["tableId", "gameMode", "method", "billStatus", "bookingStatus"];
const MAX_RANGE_DAYS = 366;
const OUTSTANDING_PAGE_SIZE = 25;
const LIST_PAGE_SIZE = 25; // Phase 11.7: Matches and Players lists

// Everything the user has chosen (also kept in the address bar, so a refresh keeps it)
const state = {
    preset: "last7",
    from: "",
    to: "",
    filters: { tableId: "", gameMode: "", method: "", billStatus: "", bookingStatus: "" },
    tablesSort: "revenue",
    outstandingSort: "oldest",
    outstandingAll: false,
    outstandingPage: 1,
    matchesSort: "newest",   // Phase 11.7
    matchesPage: 1,
    playersSort: "matches",
    playersPage: 1,
};

const lastGood = {};      // section -> the last data that loaded successfully
const requestNumber = {}; // section -> number of the newest request (older answers are ignored)
let currentRange = null;  // the period as the server understood it
let revenueChart = null;
let tableLabels = new Map();

const sectionElement = (name) => document.getElementById(name);

// =====================================================================
// Query parameters
// =====================================================================

function periodParams() {
    return state.preset === "custom" ? { from: state.from, to: state.to } : { preset: state.preset };
}

function activeFilters() {
    return Object.fromEntries(Object.entries(state.filters).filter(([, value]) => value));
}

function sectionParams(name, { forExport = false } = {}) {
    const params = { ...periodParams(), ...activeFilters() };
    if (name === "tables") params.sort = state.tablesSort;
    if (name === "matches" || name === "players") {
        params.sort = state[`${name}Sort`];
        if (!forExport) {
            params.page = String(state[`${name}Page`]);
            params.limit = String(LIST_PAGE_SIZE);
        }
    }
    if (name === "outstanding") {
        params.sort = state.outstandingSort;
        if (state.outstandingAll) params.all = "true";
        if (!forExport) {
            params.page = String(state.outstandingPage);
            params.limit = String(OUTSTANDING_PAGE_SIZE);
        }
    }
    return new URLSearchParams(params);
}

function readStateFromUrl() {
    const params = new URLSearchParams(location.search);
    if (params.get("from") && params.get("to")) {
        state.preset = "custom";
        state.from = params.get("from");
        state.to = params.get("to");
    } else if (PRESET_LABELS[params.get("preset")] && params.get("preset") !== "custom") {
        state.preset = params.get("preset");
    }
    for (const key of FILTER_KEYS) state.filters[key] = params.get(key) || "";
    if (params.get("tsort")) state.tablesSort = params.get("tsort");
    if (params.get("osort")) state.outstandingSort = params.get("osort");
    if (params.get("msort")) state.matchesSort = params.get("msort");
    if (params.get("psort")) state.playersSort = params.get("psort");
    state.outstandingAll = params.get("oall") === "1";
}

function writeStateToUrl() {
    const params = new URLSearchParams({ ...periodParams(), ...activeFilters() });
    if (state.tablesSort !== "revenue") params.set("tsort", state.tablesSort);
    if (state.outstandingSort !== "oldest") params.set("osort", state.outstandingSort);
    if (state.outstandingAll) params.set("oall", "1");
    if (state.matchesSort !== "newest") params.set("msort", state.matchesSort);
    if (state.playersSort !== "matches") params.set("psort", state.playersSort);
    history.replaceState(null, "", `${location.pathname}?${params}${location.hash}`);
}

// =====================================================================
// Loading (each section on its own: one failing report doesn't hide the others)
// =====================================================================

function loadAll() {
    writeStateToUrl();
    SECTIONS.forEach(loadSection);
}

async function loadSection(name) {
    const section = sectionElement(name);
    const body = section.querySelector("[data-body]");
    const number = (requestNumber[name] || 0) + 1;
    requestNumber[name] = number;

    section.classList.add("is-loading");
    section.setAttribute("aria-busy", "true");
    if (!lastGood[name]) body.replaceChildren(loadingState());

    try {
        const { data } = await apiRequest(`/reports/${name}?${sectionParams(name)}`);
        if (requestNumber[name] !== number) return; // a newer request was started meanwhile
        lastGood[name] = data;
        hideSectionError(section);
        body.classList.remove("is-stale");
        if (data.range) showRange(data.range);
        RENDERERS[name](body, data);
    } catch (error) {
        if (requestNumber[name] !== number) return;
        showSectionError(section, name, error);
    } finally {
        if (requestNumber[name] === number) {
            section.classList.remove("is-loading");
            section.removeAttribute("aria-busy");
        }
    }
}

// Same style as the dashboard: never replace good figures with zeros. Keep the last good
// figures (and say they are old), or - if there are none - say the report could not load.
function showSectionError(section, name, error) {
    const reason = error.status === 0
        ? "The server can't be reached."
        : error.status === 503 ? "The database is not available." : error.message;
    let alert = section.querySelector(".report-error");
    if (!alert) {
        const retry = buildElement("button", { className: "btn btn-secondary btn-small", text: "Retry", attrs: { type: "button" } });
        retry.addEventListener("click", () => loadSection(name));
        alert = buildElement("div", { className: "alert alert-error report-error", attrs: { role: "alert" } },
            buildElement("span", { className: "report-error-text" }), retry);
        section.querySelector(".report-section-header").after(alert);
    }
    const body = section.querySelector("[data-body]");
    if (lastGood[name]) {
        alert.querySelector(".report-error-text").textContent =
            `Couldn't update this report. ${reason} The figures below are still for ${rangeLabel(lastGood[name].range || currentRange)}.`;
        body.classList.add("is-stale");
    } else {
        alert.querySelector(".report-error-text").textContent = `This report couldn't be loaded. ${reason}`;
        body.replaceChildren(emptyState("Could not load", "Use Retry to try again.", "close"));
    }
    alert.hidden = false;
}

function hideSectionError(section) {
    const alert = section.querySelector(".report-error");
    if (alert) alert.hidden = true;
}

// =====================================================================
// Period label
// =====================================================================

// "2026-10-01" -> "1 October 2026" (calendar text only, no timezone maths)
function longDate(dateText) {
    return new Date(`${dateText}T12:00:00Z`).toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric", timeZone: "UTC" });
}

function rangeLabel(range) {
    if (!range) return "the previous period";
    return range.from === range.to ? longDate(range.from) : `${longDate(range.from)} – ${longDate(range.to)}`;
}

function showRange(range) {
    currentRange = range;
    const days = range.days === 1 ? "1 day" : `${range.days} days`;
    document.getElementById("range-label").textContent = `${rangeLabel(range)} (${PRESET_LABELS[range.preset] || "Custom"}, ${days})`;
}

// =====================================================================
// Shared builders
// =====================================================================

function td(label, content, className = "") {
    const cell = buildElement("td", { className, attrs: { "data-label": label } });
    if (content instanceof Node) cell.append(content);
    else cell.textContent = content;
    return cell;
}
const moneyTd = (label, paisa, className = "") => td(label, formatMoney(paisa), `numeric ${className}`);
const numberTd = (label, value) => td(label, String(value), "numeric");

// A responsive table: scrolls sideways inside its own box; becomes cards on phones
function dataTable(headings, numericColumns, rows, footRows = []) {
    const head = buildElement("tr", {}, ...headings.map((text, index) =>
        buildElement("th", { className: numericColumns.includes(index) ? "numeric" : "", text, attrs: { scope: "col" } })));
    const table = buildElement("table", { className: "data-table report-table" },
        buildElement("thead", {}, head), buildElement("tbody", {}, ...rows));
    if (footRows.length) table.append(buildElement("tfoot", {}, ...footRows));
    return buildElement("div", { className: "table-scroll" }, table);
}

function statCard(label, value, hint, tone = "") {
    return buildElement("article", { className: `stat-card report-stat ${tone}` },
        buildElement("h3", { className: "stat-label", text: label }),
        buildElement("p", { className: "stat-value", text: value }),
        hint ? buildElement("p", { className: "stat-hint", text: hint }) : null);
}

function emptyState(title, text, icon) {
    return buildElement("div", { className: "empty-state panel-empty" },
        buildElement("span", { className: "empty-state-icon" }, createIcon(icon)),
        buildElement("p", { className: "empty-state-title", text: title }),
        text ? buildElement("p", { text }) : null);
}

function loadingState() {
    return buildElement("div", { className: "empty-state panel-empty" },
        buildElement("span", { className: "spinner", attrs: { "aria-hidden": "true" } }),
        buildElement("p", { text: "Loading…" }));
}

function note(text, className = "") {
    return buildElement("p", { className: `report-note ${className}`, text });
}

const percentText = (value) => (value === null || value === undefined ? "—" : `${value}%`);
const durationText = (seconds) => (seconds === null || seconds === undefined ? "—" : formatMinutes(Math.round(seconds / 60)));
const gameLabel = (mode) => gameModeLabel(mode);          // from the game-mode registry (format.js)
const quantityLabel = (mode) => gameModeQuantityLabel(mode); // "games", "frames", ...
const tableText = (number, name) => `Table ${number}${name ? ` · ${name}` : ""}`;
const shortDate = (dateText) => new Date(`${dateText}T12:00:00Z`).toLocaleDateString("en-GB", { day: "numeric", month: "short", timeZone: "UTC" });
const plural = (count, word) => `${count} ${word}${count === 1 ? "" : "s"}`;

function shareBar(percentValue) {
    const fill = buildElement("span", { className: "progress-fill" });
    fill.style.width = `${Math.min(100, percentValue || 0)}%`;
    return buildElement("span", { className: "share" },
        buildElement("span", { className: "progress share-bar", attrs: { "aria-hidden": "true" } }, fill),
        buildElement("span", { className: "share-text", text: percentText(percentValue) }));
}

// =====================================================================
// 1. Revenue
// =====================================================================

function renderRevenue(body, data) {
    destroyRevenueChart();
    if (!data.hasData) {
        body.replaceChildren(emptyState("No data for the selected period.", "No bills or payments were recorded in this period.", "chart"));
        return;
    }
    const s = data.summary;
    const canvas = buildElement("canvas", { attrs: { id: "revenue-chart", role: "img", "aria-label": `Billed, paid and received per day, ${rangeLabel(data.range)}` } });
    const activeDays = data.days.filter((d) => d.billCount || d.cancelledCount || d.paymentCount);

    const rows = activeDays.map((d) => buildElement("tr", {},
        td("Date", formatLongDate(d.date)),
        numberTd("Bills", d.billCount),
        moneyTd("Billed", d.billed),
        moneyTd("Paid", d.paid),
        moneyTd("Outstanding", d.outstanding, d.outstanding > 0 ? "is-due" : ""),
        moneyTd("Received", d.received),
        numberTd("Cancelled", d.cancelledCount)));
    const total = buildElement("tr", { className: "report-total" },
        td("Date", "Total"), numberTd("Bills", s.billCount), moneyTd("Billed", s.totalBilled), moneyTd("Paid", s.totalPaid),
        moneyTd("Outstanding", s.totalOutstanding), moneyTd("Received", s.paymentsReceived), numberTd("Cancelled", s.cancelledCount));

    body.replaceChildren(
        buildElement("div", { className: "stat-grid report-stats" },
            statCard("Total billed", formatMoney(s.totalBilled), "Cancelled bills not counted"),
            statCard("Total paid", formatMoney(s.totalPaid), "Paid on these bills", "tone-paid"),
            statCard("Outstanding", formatMoney(s.totalOutstanding), "Still to collect on these bills", s.totalOutstanding > 0 ? "tone-due" : ""),
            statCard("Collected", percentText(s.collectedPercent), s.collectedPercent === null ? "Nothing billed" : "Of the billed amount"),
            statCard("Bills", String(s.billCount), `${s.paidCount} paid · ${s.partiallyPaidCount} partly paid · ${s.unpaidCount} unpaid`),
            statCard("Cancelled", String(s.cancelledCount), "Not counted as revenue"),
            statCard("Payments received", formatMoney(s.paymentsReceived), `${plural(s.paymentCount, "payment")}, incl. for older bills`)),
        buildElement("div", { className: "chart-box" }, canvas),
        buildElement("details", { className: "report-details", attrs: { open: activeDays.length <= 14 ? true : undefined } },
            buildElement("summary", { text: `Daily figures (${plural(activeDays.length, "day")} with activity)` }),
            dataTable(["Date", "Bills", "Billed", "Paid", "Outstanding", "Received", "Cancelled"], [1, 2, 3, 4, 5, 6], rows, [total]),
            note("Days without bills or payments are not listed. 'Paid' and 'Outstanding' belong to the bills created that day; 'Received' is money taken that day for any bill.")));
    drawRevenueChart(canvas, data.days);
}

function destroyRevenueChart() {
    if (revenueChart) {
        revenueChart.destroy();
        revenueChart = null;
    }
}

function drawRevenueChart(canvas, days) {
    if (typeof Chart === "undefined") {
        canvas.replaceWith(note("The chart couldn't be drawn. The figures are in the table below."));
        return;
    }
    const css = getComputedStyle(document.documentElement);
    const color = (name) => css.getPropertyValue(name).trim();
    const rupees = (paisa) => paisa / 100; // only for drawing; labels use the exact paisa again
    const isPhone = window.matchMedia("(max-width: 640px)").matches;

    revenueChart = new Chart(canvas, {
        type: "bar",
        data: {
            labels: days.map((d) => shortDate(d.date)),
            datasets: [
                { label: "Paid", data: days.map((d) => rupees(d.paid)), backgroundColor: color("--color-primary"), stack: "billed", borderRadius: 3 },
                { label: "Outstanding", data: days.map((d) => rupees(d.outstanding)), backgroundColor: color("--color-warning"), stack: "billed", borderRadius: 3 },
                {
                    type: "line", label: "Received", data: days.map((d) => rupees(d.received)), stack: "received", order: -1, // drawn on top of the bars
                    borderColor: color("--color-info"), backgroundColor: color("--color-info"), borderWidth: 2, tension: 0.25,
                    pointRadius: days.length > 31 ? 0 : 3,
                },
            ],
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            animation: false,
            interaction: { mode: "index", intersect: false },
            scales: {
                x: { stacked: true, grid: { display: false }, ticks: { color: color("--color-text-muted"), maxRotation: 0, autoSkip: true, maxTicksLimit: isPhone ? 5 : 12 } },
                y: {
                    stacked: true, beginAtZero: true, grid: { color: color("--color-border") },
                    ticks: { color: color("--color-text-muted"), maxTicksLimit: 6, callback: (value) => `Rs ${Number(value).toLocaleString("en-US")}` },
                },
            },
            plugins: {
                legend: { labels: { color: color("--color-text"), boxWidth: 12 } },
                tooltip: { callbacks: { label: (ctx) => `${ctx.dataset.label}: ${formatMoney(Math.round(ctx.parsed.y * 100))}` } },
            },
        },
    });
}

// =====================================================================
// 2. Payments
// =====================================================================

function renderPayments(body, data) {
    if (!data.hasData) {
        body.replaceChildren(emptyState("No payments in the selected period.", "Payments appear here when money is recorded on a bill.", "money"));
        return;
    }
    const methods = state.filters.method ? data.methods.filter((m) => m.method === state.filters.method) : data.methods;
    const rows = methods.map((m) => buildElement("tr", { className: m.count === 0 ? "is-zero" : "" },
        td("Method", PAYMENT_METHOD_LABELS[m.method] || capitalize(m.method)),
        numberTd("Payments", m.count),
        moneyTd("Amount", m.amount),
        td("Share", shareBar(m.sharePercent))));
    const total = buildElement("tr", { className: "report-total" },
        td("Method", "Total"), numberTd("Payments", data.totals.count), moneyTd("Amount", data.totals.amount), td("Share", ""));

    body.replaceChildren(
        buildElement("div", { className: "stat-grid report-stats" },
            statCard("Payments received", String(data.totals.count), "Number of payments"),
            statCard("Total amount", formatMoney(data.totals.amount), "Money received in the period", "tone-paid"),
            statCard("For older bills", formatMoney(data.forEarlierBills.amount), `${plural(data.forEarlierBills.count, "payment")} for bills from before this period`)),
        dataTable(["Method", "Payments", "Amount", "Share"], [1, 2], rows, [total]));
}

// =====================================================================
// 3. Game types
// =====================================================================

function renderGames(body, data) {
    if (!data.hasData) {
        body.replaceChildren(emptyState("No bills in the selected period.", "Game types appear once bills are created.", "trophy"));
        return;
    }
    const rows = data.games.map((g) => buildElement("tr", {},
        td("Game type", gameLabel(g.gameMode)),
        numberTd("Bills", g.billCount),
        td("Played", `${g.quantity} ${quantityLabel(g.gameMode)}`, "numeric"),
        moneyTd("Game charges", g.gameRevenue),
        moneyTd("Café", g.cafeRevenue),
        moneyTd("Total billed", g.totalBilled),
        td("Average bill", g.averageBill === null ? "—" : formatMoney(g.averageBill), "numeric"),
        numberTd("Cancelled", g.cancelledCount)));
    body.replaceChildren(
        dataTable(["Game type", "Bills", "Played", "Game charges", "Café", "Total billed", "Average bill", "Cancelled"], [1, 2, 3, 4, 5, 6, 7], rows),
        note("Only game types that have bills in this period are listed. Amounts are the prices saved on each bill; tax (if any) is inside 'Total billed'."));
}

// =====================================================================
// 3b. Matches (Phase 11.7)
// =====================================================================

const MATCH_STATUS_TEXT = { in_progress: "In progress", completed: "Completed", cancelled: "Cancelled" };

// Previous / Next for a paged list (Matches, Players). Print and CSV say what they contain.
function listPager(name, pagination) {
    const { page, pages } = pagination;
    const pager = buildElement("div", { className: "pager" });
    if (pages > 1) {
        const previous = buildElement("button", { className: "btn btn-secondary btn-small", text: "Previous", attrs: { type: "button", disabled: page <= 1 } });
        const next = buildElement("button", { className: "btn btn-secondary btn-small", text: "Next", attrs: { type: "button", disabled: page >= pages } });
        previous.addEventListener("click", () => { state[`${name}Page`] = page - 1; loadSection(name); });
        next.addEventListener("click", () => { state[`${name}Page`] = page + 1; loadSection(name); });
        pager.append(previous, buildElement("span", { className: "pager-text", text: `Page ${page} of ${pages}` }), next);
    }
    return pager;
}

function pagedNote(shown, pagination, word) {
    if (pagination.pages <= 1) return null;
    return note(`Showing ${shown} of ${plural(pagination.total, word)} (page ${pagination.page} of ${pagination.pages}). Print shows this page; CSV export includes all ${pagination.total}.`);
}

function renderMatches(body, data) {
    if (!data.hasData) {
        body.replaceChildren(emptyState("No matches in the selected period.", "Matches appear here once they are started from a session's Matches window.", "trophy"));
        return;
    }
    const s = data.summary;
    const stats = buildElement("div", { className: "stat-grid report-stats" },
        statCard("Matches", String(s.total), `${s.completed} completed · ${s.cancelled} cancelled · ${s.inProgress} in progress`),
        statCard("Billed", String(s.billed), `${s.notBilled} not billed · ${s.billCancelled} bill cancelled`),
        statCard("Match bills", formatMoney(s.billTotal), `${formatMoney(s.billPaid)} paid${s.averageBill === null ? "" : ` · average ${formatMoney(s.averageBill)}`}`, "tone-paid"),
        statCard("Outstanding", formatMoney(s.billOutstanding), "On the bills of these matches", "tone-due"),
        statCard("Registered players", percentText(s.registeredPercent), `${s.registeredSlots} registered · ${s.walkInSlots} walk-in places`));

    // Every game type of the registry (zeros are real: none played)
    const gameRows = data.games.map((g) => buildElement("tr", {},
        td("Game type", gameLabel(g.gameMode)),
        numberTd("Matches", g.total),
        numberTd("Completed", g.completed),
        numberTd("Cancelled", g.cancelled),
        numberTd("Billed", g.billed),
        numberTd("Not billed", g.notBilled),
        moneyTd("Bill total", g.billTotal),
        moneyTd("Paid", g.billPaid),
        moneyTd("Outstanding", g.billOutstanding, g.billOutstanding > 0 ? "is-due" : "")));

    const matchRows = data.matches.map((m) => {
        const players = buildElement("span", {}, m.playersText,
            buildElement("span", { className: "cell-sub", text: ` ${m.players.filter((p) => p.registered).length} registered · ${m.players.filter((p) => !p.registered).length} walk-in` }));
        let bill = buildElement("span", { className: "cell-sub", text: m.status === "completed" ? "Not billed" : "—" });
        if (m.bill) {
            bill = buildElement("span", {},
                buildElement("a", { className: "cell-link", text: m.bill.billNumber, attrs: { href: `/pages/billing.html?bill=${m.bill.id}` } }), " ",
                buildElement("span", { className: `status-badge status-${m.bill.status}`, text: BILL_STATUS_LABELS[m.bill.status] }));
        }
        return buildElement("tr", { attrs: { "data-match-id": m.id } },
            td("Match", `#${m.number}`),
            td("Started", formatDateTime(m.startedAt)),
            td("Table", tableText(m.tableNumber, m.tableName)),
            td("Game type", gameLabel(m.gameMode)),
            td("Players", players, "cell-wrap"),
            td("Result", m.status === "completed" ? m.resultText : "—", "cell-wrap"),
            td("Status", buildElement("span", { className: `status-badge status-${m.status}`, text: MATCH_STATUS_TEXT[m.status] || m.status })),
            td("Bill", bill),
            td("Amount", m.bill && m.bill.status !== "cancelled" ? formatMoney(m.bill.total) : "—", "numeric"));
    });

    body.replaceChildren(...[
        stats,
        buildElement("h3", { className: "report-subtitle", text: "By game type" }),
        dataTable(["Game type", "Matches", "Completed", "Cancelled", "Billed", "Not billed", "Bill total", "Paid", "Outstanding"], [1, 2, 3, 4, 5, 6, 7, 8], gameRows),
        buildElement("h3", { className: "report-subtitle", text: "Matches" }),
        dataTable(["Match", "Started", "Table", "Game type", "Players", "Result", "Status", "Bill", "Amount"], [8], matchRows),
        listPager("matches", data.pagination),
        pagedNote(data.matches.length, data.pagination, "match"),
        note(data.moneyNote),
    ].filter(Boolean));
}

// =====================================================================
// 3c. Players (Phase 11.7)
// =====================================================================

function renderPlayers(body, data) {
    if (!data.hasData) {
        body.replaceChildren(emptyState("No player activity in the selected period.", "Registered players appear here once they play matches or are on match bills.", "trophy"));
        return;
    }
    const t = data.totals;
    const playerRow = (name, p, className = "") => buildElement("tr", { className },
        td("Player", name),
        numberTd("Matches", p.matches),
        numberTd("Wins", p.wins),
        numberTd("Losses", p.losses),
        td("Win %", percentText(p.winPercent), "numeric"),
        numberTd("Bills", p.bills),
        moneyTd("Billed", p.billed),
        moneyTd("Paid", p.paid),
        moneyTd("Outstanding", p.outstanding, p.outstanding > 0 ? "is-due" : ""));
    const rows = data.players.map((p) => {
        const name = buildElement("span", {},
            buildElement("a", { className: "cell-link", text: p.name, attrs: { href: `/pages/players.html?player=${p.playerId}` } }),
            p.isActive ? null : buildElement("span", { className: "badge archived-badge", text: "Inactive" }));
        const row = playerRow(name, p);
        row.dataset.playerId = p.playerId;
        return row;
    });
    const walkIns = playerRow("Walk-in players (not registered)", data.walkIns, "report-walkins");
    const total = buildElement("tr", { className: "report-total" },
        td("Player", `All registered players (${t.players})`), td("Matches", ""), td("Wins", ""), td("Losses", ""), td("Win %", ""), td("Bills", ""),
        moneyTd("Billed", t.billed), moneyTd("Paid", t.paid), moneyTd("Outstanding", t.outstanding));

    body.replaceChildren(...[
        buildElement("div", { className: "stat-grid report-stats" },
            statCard("Registered players", String(t.players), "Played or were on a match bill"),
            statCard("Billed to players", formatMoney(t.billed), "Their own shares of match bills"),
            statCard("Paid", formatMoney(t.paid), null, "tone-paid"),
            statCard("Outstanding", formatMoney(t.outstanding), "Each player's own share only", "tone-due")),
        rows.length
            ? dataTable(["Player", "Matches", "Wins", "Losses", "Win %", "Bills", "Billed", "Paid", "Outstanding"], [1, 2, 3, 4, 5, 6, 7, 8], rows, [walkIns, total])
            : note("No registered player took part in this period - only walk-ins.", "report-note-warning"),
        rows.length ? null : dataTable(["Player", "Matches", "Wins", "Losses", "Win %", "Bills", "Billed", "Paid", "Outstanding"], [1, 2, 3, 4, 5, 6, 7, 8], [walkIns]),
        listPager("players", data.pagination),
        pagedNote(data.players.length, data.pagination, "player"),
        note("Matches, wins and losses: completed matches only. Win % = wins ÷ (wins + losses). The totals row adds up money only: one match or bill can have several players."),
        note(data.limitation),
    ].filter(Boolean));
}

// =====================================================================
// 4. Tables
// =====================================================================

function renderTables(body, data) {
    if (!data.hasData) {
        body.replaceChildren(emptyState("No sessions in the selected period.", data.tables.length ? "No table was played on in this period." : "No tables have been added yet.", "table"));
        return;
    }
    const u = data.utilization; // label and wording come from the server, so page and API always agree
    const rows = data.tables.map((t) => {
        const name = buildElement("span", { className: "cell-table" },
            buildElement("span", { className: "table-number table-number-small", text: String(t.tableNumber) }),
            buildElement("span", { text: t.tableName || `Table ${t.tableNumber}` }),
            t.deleted ? buildElement("span", { className: "badge", text: "Deleted" }) : null);
        const observed = t.utilizationPercent === null
            ? buildElement("span", { text: "—", attrs: { title: t.deleted ? "Not available: the table was deleted" : "Not available for this period" } })
            : shareBar(t.utilizationPercent);
        return buildElement("tr", { className: t.sessionCount === 0 ? "is-zero" : "" },
            td("Table", name),
            numberTd("Sessions", t.sessionCount),
            numberTd("Completed", t.completedCount),
            td("Played", durationText(t.playedSeconds), "numeric"),
            td("Avg session", durationText(t.averageSessionSeconds), "numeric"),
            td("Billed time", formatMinutes(t.billedMinutes), "numeric"),
            moneyTd("Revenue", t.revenue),
            td("In use", durationText(t.occupiedSeconds), "numeric"),
            td(u.label, observed));
    });
    const totals = data.totals;
    const total = buildElement("tr", { className: "report-total" },
        td("Table", "Total"), numberTd("Sessions", totals.sessionCount), numberTd("Completed", totals.completedCount),
        td("Played", durationText(totals.playedSeconds), "numeric"), td("Avg session", ""), td("Billed time", formatMinutes(totals.billedMinutes), "numeric"),
        moneyTd("Revenue", totals.revenue), td("In use", durationText(totals.occupiedSeconds), "numeric"), td(u.label, ""));

    const s = data.sessionCounting;
    const table = dataTable(["Table", s.label, "Completed", "Played", "Avg session", "Billed time", "Revenue", "In use", u.label], [1, 2, 3, 4, 5, 6, 7], rows, [total]);
    // The two columns count days differently, so both headings explain themselves (texts from the server)
    addHeadingHelp(table, s.label, s.description);
    addHeadingHelp(table, u.label, `${u.description} ${u.dayAllocation}`);

    body.replaceChildren(
        table,
        note(`${s.label}: ${s.definition} ${u.label}: ${u.dayAllocation} The two can therefore differ for the same day.`),
        note(`${u.label} (an estimate): ${u.description} ${u.definition} Measured from ${formatDateTime(u.measuredFrom)} until ${formatDateTime(u.measuredUntil)} (Karachi time).`),
        note("Revenue = the saved totals of these sessions' bills (cancelled bills not counted). The table's hourly rate is not used, because bills are priced per game/frame."));
}

// Help on a column heading: hover tooltip + a "?" that screen readers can read
function addHeadingHelp(table, label, helpText) {
    const heading = [...table.querySelectorAll("th")].find((th) => th.textContent === label);
    heading.title = helpText;
    heading.append(" ", buildElement("span", { className: "help-mark", text: "?", attrs: { title: helpText, "aria-label": helpText, role: "img" } }));
}

// =====================================================================
// 5. Bookings
// =====================================================================

// Status cards: [status key, label, hint, tone]
const BOOKING_STATUS_CARDS = [
    ["pending", "Pending", "Not confirmed yet", ""],
    ["confirmed", "Confirmed", "Still to come", ""],
    ["completed", "Checked in", "Customer came; session started", "tone-paid"],
    ["cancelled", "Cancelled", "", ""],
    ["no_show", "No-show", "", "tone-due"],
];

function renderBookings(body, data) {
    // The server says which status (if any) the report is filtered to - the page doesn't guess
    const status = data.statusFilter;
    const statusLabel = status ? BOOKING_STATUS_LABELS[status] : "";
    const filterBanner = status
        ? buildElement("p", { className: "report-filter-banner", attrs: { role: "status" } },
            buildElement("strong", { text: "Filtered: " }), `only "${statusLabel}" bookings are counted below (summary, daily list and CSV).`)
        : null;

    if (!data.hasData) {
        body.replaceChildren(...[
            filterBanner,
            emptyState(status ? `No "${statusLabel}" bookings in the selected period.` : "No bookings in the selected period.",
                "Bookings appear here by the day they start.", "calendar"),
        ].filter(Boolean));
        return;
    }
    const c = data.counts;
    const r = data.rates;
    // All statuses: every status card. One status: only that status's card (the rest would just be 0).
    const cards = BOOKING_STATUS_CARDS.filter(([key]) => !status || key === status)
        .map(([key, label, hint, tone]) => statCard(label, String(c[key]), hint, c[key] ? tone : ""));
    const rateHint = !data.ratesAvailable
        ? "Rates are shown only when All statuses is selected."
        : c.decided ? `Of ${plural(c.decided, "booking")} with a known outcome` : "No booking has an outcome yet";

    // Daily rows: with one status selected, just that status's column
    const days = data.days.filter((d) => d.total > 0);
    const columns = status
        ? [["Date"], [statusLabel, status]]
        : [["Date"], ["Total", "total"], ["Pending", "pending"], ["Confirmed", "confirmed"], ["Checked in", "completed"], ["Cancelled", "cancelled"], ["No-show", "no_show"]];
    const rows = days.map((d) => buildElement("tr", {},
        td("Date", formatLongDate(d.date)), ...columns.slice(1).map(([label, key]) => numberTd(label, d[key]))));

    body.replaceChildren(...[
        filterBanner,
        buildElement("div", { className: "stat-grid report-stats" },
            statCard(status ? `${statusLabel} bookings` : "Total bookings", String(data.totalBookings), status ? "Starting in the period, this status only" : "Starting in the period"),
            ...cards),
        buildElement("div", { className: `stat-grid report-stats report-rates${data.ratesAvailable ? "" : " is-unavailable"}` },
            statCard("Check-in rate", percentText(r.checkInPercent), rateHint),
            statCard("No-show rate", percentText(r.noShowPercent), rateHint),
            statCard("Cancellation rate", percentText(r.cancellationPercent), rateHint)),
        dataTable(columns.map(([label]) => label), columns.map((_, i) => i).slice(1), rows),
        note(`${data.ratesNote} Checking a booking in starts its session and marks it completed, so "checked in" and "completed" are the same bookings.`),
    ].filter(Boolean));
}

// =====================================================================
// 6. Customers
// =====================================================================

function renderCustomers(body, data) {
    const limitation = note(data.limitation, "report-note-warning");
    if (!data.hasData) {
        body.replaceChildren(emptyState("No customer activity in the selected period.", "New customers and their bookings appear here.", "users"), limitation);
        return;
    }
    const s = data.stats;
    const bookingRows = data.topByBookings.map((c) => buildElement("tr", {},
        td("Customer", customerName(c)), numberTd("Bookings", c.bookings), numberTd("Checked in", c.checkedIn),
        numberTd("No-shows", c.noShows), numberTd("Cancelled", c.cancelled)));
    const sessionRows = data.topBySessions.map((c) => buildElement("tr", {},
        td("Customer", customerName(c)), numberTd("Sessions", c.sessions), td("Played", durationText(c.playedSeconds), "numeric"),
        td("Last visit", c.lastVisit ? formatDateTime(c.lastVisit) : "—")));

    body.replaceChildren(
        buildElement("div", { className: "stat-grid report-stats" },
            statCard("New customers", String(s.newCustomers), "Added in the period"),
            statCard("With bookings", String(s.customersWithBookings), "Booked a table in the period"),
            statCard("Checked in", String(s.customersCheckedIn), "Came at least once", "tone-paid"),
            statCard("Repeat customers", String(s.repeatCustomers), "Checked in 2 or more times")),
        buildElement("div", { className: "report-columns" },
            buildElement("div", {},
                buildElement("h3", { className: "report-subtitle", text: "Top customers by bookings" }),
                bookingRows.length ? dataTable(["Customer", "Bookings", "Checked in", "No-shows", "Cancelled"], [1, 2, 3, 4], bookingRows) : note("No bookings in this period.")),
            buildElement("div", {},
                buildElement("h3", { className: "report-subtitle", text: "Top customers by sessions" }),
                sessionRows.length ? dataTable(["Customer", "Sessions", "Played", "Last visit"], [1, 2], sessionRows) : note("No sessions were started from a customer's booking in this period."))),
        limitation);
}

function customerName(customer) {
    return buildElement("span", {}, customer.name, customer.archived ? buildElement("span", { className: "badge archived-badge", text: "Archived" }) : null);
}

// =====================================================================
// 7. Outstanding bills
// =====================================================================

function renderOutstanding(body, data) {
    if (!data.hasData) {
        body.replaceChildren(emptyState("No outstanding bills.", data.allDates ? "Every bill is paid or cancelled." : "Every bill from this period is paid or cancelled.", "check"));
        return;
    }
    const t = data.totals;
    const rows = data.bills.map((b) => buildElement("tr", {},
        td("Bill", buildElement("a", { className: "cell-link", text: b.billNumber, attrs: { href: `/pages/billing.html?bill=${b.id}` } })),
        td("Date", formatDateTime(b.createdAt)),
        td("Table", tableText(b.tableNumber, b.tableName)),
        td("Players", b.players.join(", "), "cell-wrap"),
        moneyTd("Total", b.total),
        moneyTd("Paid", b.amountPaid),
        moneyTd("Remaining", b.balanceDue, "is-due"),
        td("Status", buildElement("span", { className: `status-badge status-${b.status}`, text: BILL_STATUS_LABELS[b.status] }))));

    const { page, pages } = data.pagination;
    const pager = buildElement("div", { className: "pager" });
    if (pages > 1) {
        const previous = buildElement("button", { className: "btn btn-secondary btn-small", text: "Previous", attrs: { type: "button", disabled: page <= 1 } });
        const next = buildElement("button", { className: "btn btn-secondary btn-small", text: "Next", attrs: { type: "button", disabled: page >= pages } });
        previous.addEventListener("click", () => { state.outstandingPage = page - 1; loadSection("outstanding"); });
        next.addEventListener("click", () => { state.outstandingPage = page + 1; loadSection("outstanding"); });
        pager.append(previous, buildElement("span", { className: "pager-text", text: `Page ${page} of ${pages}` }), next);
    }

    body.replaceChildren(
        buildElement("div", { className: "stat-grid report-stats" },
            statCard("Total outstanding", formatMoney(t.totalOutstanding), data.allDates ? "All dates" : "Bills from this period", "tone-due"),
            statCard("Bills", String(t.count), `${t.unpaidCount} unpaid · ${t.partiallyPaidCount} partly paid`),
            statCard("Billed / paid", `${formatMoney(t.totalBilled)}`, `${formatMoney(t.totalPaid)} paid so far`)),
        dataTable(["Bill", "Date", "Table", "Players", "Total", "Paid", "Remaining", "Status"], [4, 5, 6], rows),
        pager,
        pages > 1 ? note(`Showing ${data.bills.length} of ${t.count} bills. Print and CSV export include all ${t.count}.`) : null);
}

const RENDERERS = {
    revenue: renderRevenue,
    payments: renderPayments,
    games: renderGames,
    matches: renderMatches,
    players: renderPlayers,
    tables: renderTables,
    bookings: renderBookings,
    customers: renderCustomers,
    outstanding: renderOutstanding,
};

// =====================================================================
// CSV export (the server builds the file with the same period and filters)
// =====================================================================

async function downloadCsv(report, button) {
    setButtonLoading(button, true, "Exporting…");
    try {
        const response = await fetch(`/api/reports/export/${report}?${sectionParams(report, { forExport: true })}`);
        if (response.status === 401) return goToLogin();
        if (!response.ok) {
            const body = await response.json().catch(() => ({}));
            throw new Error(body.message || "The export failed. Please try again.");
        }
        const blob = await response.blob();
        const filename = /filename="([^"]+)"/.exec(response.headers.get("content-disposition") || "")?.[1] || `${report}.csv`;
        const url = URL.createObjectURL(blob);
        const link = buildElement("a", { attrs: { href: url, download: filename } });
        document.body.append(link);
        link.click();
        link.remove();
        setTimeout(() => URL.revokeObjectURL(url), 30000);
        showToast(`Downloaded ${filename}`);
    } catch (error) {
        showToast(error.message === "Failed to fetch" ? "Cannot reach the server." : error.message, "error", 6000);
    } finally {
        setButtonLoading(button, false);
    }
}

// =====================================================================
// Printing (browser print; one section or the whole report)
// =====================================================================

function filtersText() {
    const parts = [];
    if (state.filters.tableId) parts.push(tableLabels.get(state.filters.tableId) || "One table");
    if (state.filters.gameMode) parts.push(gameLabel(state.filters.gameMode));
    if (state.filters.method) parts.push(PAYMENT_METHOD_LABELS[state.filters.method]);
    if (state.filters.billStatus) parts.push(`Bills: ${BILL_STATUS_LABELS[state.filters.billStatus]}`);
    if (state.filters.bookingStatus) parts.push(`Bookings: ${BOOKING_STATUS_LABELS[state.filters.bookingStatus]}`);
    return parts.length ? parts.join(" · ") : "none";
}

// The screen shows Outstanding bills 25 at a time; the PRINTED report has every matching bill.
// They come from the server (same filters and money as the screen and the CSV). If that fails,
// nothing is printed - an incomplete list on paper would be misleading.
async function printReport(onlySection = null, button = null) {
    if (!onlySection || onlySection === "outstanding") {
        if (button) setButtonLoading(button, true, "Preparing…");
        try {
            const { data } = await apiRequest(`/reports/outstanding/print?${sectionParams("outstanding", { forExport: true })}`);
            buildOutstandingPrint(data);
        } catch (error) {
            const reason = error.status === 0 ? "The server can't be reached." : error.message;
            showToast(`Nothing was printed. ${reason}`, "error", 10000);
            return;
        } finally {
            if (button) setButtonLoading(button, false);
        }
    }
    document.querySelectorAll(".report-section").forEach((section) => {
        section.classList.toggle("print-skip", Boolean(onlySection) && section.dataset.report !== onlySection);
    });
    document.getElementById("print-range").textContent = `Period: ${rangeLabel(currentRange)} (Karachi time)`;
    document.getElementById("print-meta").textContent =
        `Filters: ${filtersText()} · Printed ${formatDateTime(new Date().toISOString())}${currentUser ? ` by ${currentUser.name}` : ""}`;
    // Folded "Daily figures" lists are printed open
    document.querySelectorAll(".report-details:not([open])").forEach((details) => {
        details.open = true;
        details.dataset.closeAfterPrint = "1";
    });
    window.print();
}

// The complete Outstanding list, only visible on paper (the on-screen page of 25 is hidden while printing)
function buildOutstandingPrint(data) {
    const section = sectionElement("outstanding");
    section.querySelector(".outstanding-print")?.remove();
    const t = data.totals;
    const scope = data.allDates ? "all dates" : rangeLabel(data.range);
    const block = buildElement("div", { className: "print-only outstanding-print" },
        buildElement("h3", { className: "report-subtitle", text: `Outstanding bills: ${plural(t.count, "bill")} (${scope})` }));

    if (!data.hasData) {
        block.append(buildElement("p", { className: "report-note", text: "No outstanding bills match the selected period and filters." }));
    } else {
        block.append(buildElement("p", { className: "report-note",
            text: `Total outstanding ${formatMoney(t.totalOutstanding)} · billed ${formatMoney(t.totalBilled)} · paid ${formatMoney(t.totalPaid)} · ${t.unpaidCount} unpaid, ${t.partiallyPaidCount} partly paid` }));
        const rows = data.bills.map((b) => buildElement("tr", {},
            td("Bill", b.billNumber),
            td("Date", formatDateTime(b.createdAt)),
            td("Table", tableText(b.tableNumber, b.tableName)),
            td("Players", b.players.join(", "), "cell-wrap"),
            moneyTd("Total", b.total),
            moneyTd("Paid", b.amountPaid),
            moneyTd("Remaining", b.balanceDue),
            td("Status", BILL_STATUS_LABELS[b.status])));
        const total = buildElement("tr", { className: "report-total" },
            td("Bill", `Total (${t.count})`), td("Date", ""), td("Table", ""), td("Players", ""),
            moneyTd("Total", t.totalBilled), moneyTd("Paid", t.totalPaid), moneyTd("Remaining", t.totalOutstanding), td("Status", ""));
        block.append(dataTable(["Bill", "Date", "Table", "Players", "Total", "Paid", "Remaining", "Status"], [4, 5, 6], rows, [total]));
    }
    section.append(block);
    section.classList.add("has-complete-print");
}

// The chart's labels are light grey for the dark screen; on white paper they become black.
// beforeprint also fires for Ctrl+P, not only for the Print buttons.
function setChartColors(forPaper) {
    if (!revenueChart) return;
    const css = getComputedStyle(document.documentElement);
    const text = forPaper ? "#000" : css.getPropertyValue("--color-text").trim();
    const muted = forPaper ? "#333" : css.getPropertyValue("--color-text-muted").trim();
    const grid = forPaper ? "#ccc" : css.getPropertyValue("--color-border").trim();
    revenueChart.options.plugins.legend.labels.color = text;
    revenueChart.options.scales.x.ticks.color = muted;
    revenueChart.options.scales.y.ticks.color = muted;
    revenueChart.options.scales.y.grid.color = grid;
    revenueChart.update("none");
}

window.addEventListener("beforeprint", () => setChartColors(true));

window.addEventListener("afterprint", () => {
    setChartColors(false);
    document.querySelectorAll(".report-section.print-skip").forEach((section) => section.classList.remove("print-skip"));
    document.querySelectorAll(".outstanding-print").forEach((block) => block.remove());
    document.querySelectorAll(".has-complete-print").forEach((section) => section.classList.remove("has-complete-print"));
    document.querySelectorAll("[data-close-after-print]").forEach((details) => {
        details.open = false;
        delete details.dataset.closeAfterPrint;
    });
});

// =====================================================================
// Controls
// =====================================================================

function fillSelect(select, values, labelFor) {
    const keep = select.value;
    select.replaceChildren(select.options[0], ...values.map((value) => buildElement("option", { text: labelFor(value), attrs: { value } })));
    select.value = keep;
}

async function loadOptions() {
    try {
        const { data } = await apiRequest("/reports/options");
        tableLabels = new Map(data.tables.map((t) => [t.id, tableText(t.tableNumber, t.name)]));
        fillSelect(document.getElementById("filter-table"), data.tables.map((t) => t.id), (id) => tableLabels.get(id));
        fillSelect(document.getElementById("filter-game"), data.gameModes, gameLabel);
        fillSelect(document.getElementById("filter-method"), data.paymentMethods, (m) => PAYMENT_METHOD_LABELS[m] || capitalize(m));
        fillSelect(document.getElementById("filter-bill-status"), data.billStatuses, (s) => BILL_STATUS_LABELS[s] || capitalize(s));
        fillSelect(document.getElementById("filter-booking-status"), data.bookingStatuses, (s) => BOOKING_STATUS_LABELS[s] || capitalize(s));
    } catch (error) {
        showToast(`Couldn't load the filter lists. ${error.message}`, "error", 6000);
    }
    showControls();
}

// Put the current choices into the buttons and boxes
function showControls() {
    document.querySelectorAll("#preset-chips .chip").forEach((chip) => chip.setAttribute("aria-pressed", String(chip.dataset.preset === state.preset)));
    document.getElementById("custom-range").hidden = state.preset !== "custom";
    document.querySelectorAll("[data-filter]").forEach((select) => {
        const value = state.filters[select.dataset.filter];
        if (value && ![...select.options].some((o) => o.value === value)) {
            select.append(buildElement("option", { text: "(selected)", attrs: { value } })); // e.g. a deleted table from an old link
        }
        select.value = value;
    });
    document.getElementById("tables-sort").value = state.tablesSort;
    document.getElementById("outstanding-sort").value = state.outstandingSort;
    document.getElementById("outstanding-all").checked = state.outstandingAll;
    document.getElementById("matches-sort").value = state.matchesSort;
    document.getElementById("players-sort").value = state.playersSort;
    if (state.preset === "custom") {
        document.getElementById("range-from").value = state.from;
        document.getElementById("range-to").value = state.to;
    }
}

// A new period or filter starts every paged list again at page 1
function firstPages() {
    state.outstandingPage = 1;
    state.matchesPage = 1;
    state.playersPage = 1;
}

document.getElementById("preset-chips").addEventListener("click", (event) => {
    const chip = event.target.closest(".chip");
    if (!chip) return;
    if (chip.dataset.preset === "custom") {
        // Start from the period currently shown; nothing reloads until "Show" is pressed
        document.querySelectorAll("#preset-chips .chip").forEach((c) => c.setAttribute("aria-pressed", String(c === chip)));
        document.getElementById("custom-range").hidden = false;
        document.getElementById("range-from").value = state.from || currentRange?.from || todayInClub();
        document.getElementById("range-to").value = state.to || currentRange?.to || todayInClub();
        document.getElementById("range-from").focus();
        return;
    }
    state.preset = chip.dataset.preset;
    state.from = "";
    state.to = "";
    firstPages();
    showControls();
    loadAll();
});

document.getElementById("custom-range").addEventListener("submit", (event) => {
    event.preventDefault();
    const from = document.getElementById("range-from").value;
    const to = document.getElementById("range-to").value;
    const errorBox = document.getElementById("custom-error");
    let problem = "";
    if (!from || !to) problem = "Choose both a From and a To date.";
    else if (to < from) problem = "The To date can't be before the From date.";
    else if ((Date.parse(to) - Date.parse(from)) / 86400000 + 1 > MAX_RANGE_DAYS) problem = `Choose at most ${MAX_RANGE_DAYS} days.`;
    errorBox.textContent = problem;
    errorBox.hidden = !problem;
    if (problem) return;
    state.preset = "custom";
    state.from = from;
    state.to = to;
    firstPages();
    loadAll();
});

document.getElementById("report-filters").addEventListener("change", (event) => {
    const key = event.target.dataset.filter;
    if (!key) return;
    state.filters[key] = event.target.value;
    firstPages();
    loadAll();
});

document.getElementById("reset-filters").addEventListener("click", () => {
    for (const key of FILTER_KEYS) state.filters[key] = "";
    firstPages();
    showControls();
    loadAll();
});

document.getElementById("tables-sort").addEventListener("change", (event) => {
    state.tablesSort = event.target.value;
    writeStateToUrl();
    loadSection("tables");
});

document.getElementById("outstanding-sort").addEventListener("change", (event) => {
    state.outstandingSort = event.target.value;
    state.outstandingPage = 1;
    writeStateToUrl();
    loadSection("outstanding");
});

document.getElementById("outstanding-all").addEventListener("change", (event) => {
    state.outstandingAll = event.target.checked;
    state.outstandingPage = 1;
    writeStateToUrl();
    loadSection("outstanding");
});

// Phase 11.7: Matches and Players sorting (back to page 1)
for (const name of ["matches", "players"]) {
    document.getElementById(`${name}-sort`).addEventListener("change", (event) => {
        state[`${name}Sort`] = event.target.value;
        state[`${name}Page`] = 1;
        writeStateToUrl();
        loadSection(name);
    });
}

document.querySelector(".reports-page").addEventListener("click", (event) => {
    const exportButton = event.target.closest("[data-export]");
    if (exportButton) downloadCsv(exportButton.dataset.export, exportButton);
    const printButton = event.target.closest("[data-print]");
    if (printButton) printReport(printButton.dataset.print, printButton);
});

document.getElementById("print-all-button").addEventListener("click", (event) => printReport(null, event.currentTarget));

// ---------- Start ----------
readStateFromUrl();
showControls();
// Game-mode labels and units come from the server registry (layout.js) - wait for them first
gameModesReady.then(() => {
    loadOptions();
    loadAll();
});
