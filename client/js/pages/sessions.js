// sessions.js (page) - active sessions + session history with date filters, search and pages.
// Uses: apiRequest (api.js), showToast/createIcon/buildElement (ui.js),
//       formatDateTime/formatDuration/todayInClub/BILL_STATUS_LABELS (format.js),
//       fetchActiveSessions/createActiveSessionRow/startLiveTimers (core/sessions.js), openCreateBillDialog (core/billing.js)

const PAGE_SIZE = 20;
const REFRESH_MS = 30000;

// ---------- Page elements ----------
const activeList = document.getElementById("active-sessions");
const activeCount = document.getElementById("active-count");

const filters = document.getElementById("history-filters");
const fromInput = document.getElementById("filter-from");
const toInput = document.getElementById("filter-to");
const searchInput = document.getElementById("filter-search");
const filterError = document.getElementById("filter-error");

const historyLoading = document.getElementById("history-loading");
const historyEmpty = document.getElementById("history-empty");
const historyWrapper = document.getElementById("history-wrapper");
const historyBody = document.getElementById("history-body");
const historySummary = document.getElementById("history-summary");
const pagination = document.getElementById("history-pagination");
const pageInfo = document.getElementById("page-info");
const prevButton = document.getElementById("page-prev");
const nextButton = document.getElementById("page-next");

// ---------- State ----------
let currentPage = 1;
let searchTimer = null;
let latestHistoryRequest = 0;

// ---------- Active sessions ----------

async function loadActive() {
    try {
        const sessions = await fetchActiveSessions();
        activeCount.textContent = sessions.length;
        if (sessions.length === 0) {
            activeList.replaceChildren(createEmpty("timer", "No active sessions", "Start one from the Tables page when players arrive."));
            return;
        }
        // When a session is ended here, both lists change
        activeList.replaceChildren(...sessions.map((session) => createActiveSessionRow(session, refreshAll)));
    } catch (error) {
        activeList.replaceChildren(createEmpty("timer", "Could not load active sessions", error.message));
    }
}

function createEmpty(iconName, title, text) {
    const box = document.createElement("div");
    box.className = "empty-state";
    const icon = document.createElement("span");
    icon.className = "empty-state-icon";
    icon.appendChild(createIcon(iconName));
    const heading = document.createElement("p");
    heading.className = "empty-state-title";
    heading.textContent = title;
    const body = document.createElement("p");
    body.textContent = text;
    box.append(icon, heading, body);
    return box;
}

// ---------- History ----------

function showHistory(element) {
    for (const box of [historyLoading, historyEmpty, historyWrapper]) box.hidden = box !== element;
}

// Checks the filters in the browser first (quick feedback); the server checks again
function readFilters() {
    const from = fromInput.value;
    const to = toInput.value;
    if (from && to && to < from) return { error: "The To date cannot be before the From date." };
    return { from, to, search: searchInput.value.trim() };
}

async function loadHistory({ quiet = false } = {}) {
    const values = readFilters();
    filterError.hidden = !values.error;
    if (values.error) {
        filterError.textContent = values.error;
        return;
    }

    // History = finished sessions; running ones are listed above
    const params = new URLSearchParams({ status: "completed", page: currentPage, limit: PAGE_SIZE });
    if (values.from) params.set("from", values.from);
    if (values.to) params.set("to", values.to);
    if (values.search) params.set("search", values.search);

    const requestNumber = ++latestHistoryRequest;
    if (!quiet) showHistory(historyLoading);

    try {
        const { data } = await apiRequest(`/sessions?${params}`);
        if (requestNumber !== latestHistoryRequest) return;

        // Asked for a page that no longer exists (e.g. after filtering)? Go to the last one.
        if (data.sessions.length === 0 && data.total > 0 && currentPage > data.totalPages) {
            currentPage = data.totalPages;
            return loadHistory({ quiet });
        }
        renderHistory(data, values);
    } catch (error) {
        if (requestNumber !== latestHistoryRequest) return;
        showEmptyHistory("Could not load history", error.message);
        showToast(error.message, "error");
    }
}

function showEmptyHistory(title, text) {
    document.getElementById("history-empty-title").textContent = title;
    document.getElementById("history-empty-text").textContent = text;
    pagination.hidden = true;
    historySummary.textContent = "";
    showHistory(historyEmpty);
}

function renderHistory(data, values) {
    const isFiltering = values.from || values.to || values.search;
    if (data.total === 0) {
        if (isFiltering) showEmptyHistory("No matching sessions", "Try other dates or another table.");
        else showEmptyHistory("No finished sessions yet", "Sessions appear here as soon as they end.");
        return;
    }

    historyBody.replaceChildren(...data.sessions.map(createHistoryRow));
    historySummary.textContent = data.total === 1 ? "1 session" : `${data.total} sessions`;

    pagination.hidden = data.totalPages <= 1;
    pageInfo.textContent = `Page ${data.page} of ${data.totalPages}`;
    prevButton.disabled = data.page <= 1;
    nextButton.disabled = data.page >= data.totalPages;

    showHistory(historyWrapper);
}

// One row. data-label lets the CSS show "Started:", "Ended:"… on phones (stacked layout).
function createHistoryRow(session) {
    const row = document.createElement("tr");

    const tableCell = document.createElement("td");
    tableCell.dataset.label = "Table";
    const number = document.createElement("span");
    number.className = "table-number table-number-small";
    number.textContent = session.tableNumber;
    const name = document.createElement("span");
    name.className = "cell-title";
    name.textContent = session.tableName || `Table ${session.tableNumber}`;
    const tableWrap = document.createElement("div");
    tableWrap.className = "cell-table";
    tableWrap.append(number, name);
    tableCell.appendChild(tableWrap);

    const started = createCell("Started", formatDateTime(session.startedAt));
    const ended = createCell("Ended", formatDateTime(session.endedAt));
    const duration = createCell("Duration", formatDuration(session.durationSeconds));
    duration.classList.add("numeric");

    row.append(tableCell, started, ended, duration, createBillCell(session));
    return row;
}

// Phase 5: billed -> status + bill number (opens the bill); not billed -> "Create bill" button
function createBillCell(session) {
    const cell = document.createElement("td");
    cell.dataset.label = "Bill";

    if (session.bill) {
        const link = buildElement("a", { className: "bill-link", attrs: { href: `/pages/billing.html?bill=${session.bill.id}` } },
            buildElement("span", { className: `status-badge status-${session.bill.status}`, text: BILL_STATUS_LABELS[session.bill.status] }),
            buildElement("span", { className: "bill-link-number", text: session.bill.billNumber }));
        cell.append(link);
    } else if (session.matches && session.matches.total > session.matches.cancelled) {
        // Phase 11.5: played as matches -> one bill per match (made in its Matches window)
        cell.append(buildElement("span", { className: "cell-sub match-bill-summary", text: matchBillingSummary(session.matches) }));
    } else {
        const button = buildElement("button", { className: "btn btn-secondary btn-small", attrs: { type: "button" } }, createIcon("receipt"), "Create bill");
        button.setAttribute("aria-label", `Create bill for the session on table ${session.tableNumber}`);
        button.addEventListener("click", async () => {
            if (await openCreateBillDialog(session)) await loadHistory({ quiet: true });
        });
        cell.append(button);
    }
    // Phase 11.4: the matches played in this session (results can still be recorded after it ended)
    cell.append(createMatchesButton(session, "btn btn-ghost btn-small"));
    return cell;
}

function createCell(label, text) {
    const cell = document.createElement("td");
    cell.dataset.label = label;
    cell.textContent = text;
    return cell;
}

function refreshAll() {
    return Promise.all([loadActive(), loadHistory({ quiet: true })]);
}

// ---------- Events ----------

// Dates: reload straight away. Search: wait until typing stops (300 ms).
filters.addEventListener("change", (event) => {
    if (event.target === searchInput) return;
    currentPage = 1;
    loadHistory();
});
searchInput.addEventListener("input", () => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => {
        currentPage = 1;
        loadHistory();
    }, 300);
});
filters.addEventListener("submit", (event) => event.preventDefault()); // Enter shouldn't reload the page

document.getElementById("filter-today").addEventListener("click", () => {
    fromInput.value = todayInClub();
    toInput.value = todayInClub();
    currentPage = 1;
    loadHistory();
});
document.getElementById("filter-clear").addEventListener("click", () => {
    filters.reset();
    currentPage = 1;
    loadHistory();
});

prevButton.addEventListener("click", () => {
    currentPage -= 1;
    loadHistory();
});
nextButton.addEventListener("click", () => {
    currentPage += 1;
    loadHistory();
});

// ---------- Start ----------
startLiveTimers();
loadHistory();

// Link from the dashboard: #session-<id> -> highlight that running session
loadActive().then(() => {
    const sessionId = location.hash.startsWith("#session-") ? location.hash.slice(9) : null;
    const row = sessionId && activeList.querySelector(`.session-row[data-session-id="${CSS.escape(sessionId)}"]`);
    if (row) {
        row.classList.add("is-highlighted");
        row.setAttribute("tabindex", "-1");
        row.scrollIntoView({ block: "center" });
        row.focus({ preventScroll: true });
    }
});

setInterval(() => {
    if (!document.hidden && !document.querySelector("dialog[open]")) refreshAll();
}, REFRESH_MS);
