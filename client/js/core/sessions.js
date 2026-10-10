// sessions.js - session helpers shared by the Dashboard, Tables and Sessions pages:
// live timers, starting/ending sessions, and the "active session" row.
// Uses: apiRequest (api.js), showToast/confirmDialog/setButtonLoading/createIcon (ui.js),
//       formatTimer/formatDuration/formatTime/capitalize (format.js)

// ---------- Server clock ----------
// Timers count from the session's startedAt, which the SERVER saved. If this computer's
// clock is a few minutes wrong, timers would be wrong too - so we remember how far our
// clock is from the server's and correct for it.
let serverClockOffsetMs = 0;

function syncServerClock(serverTimeIso) {
    const serverTime = Date.parse(serverTimeIso);
    if (!Number.isNaN(serverTime)) serverClockOffsetMs = serverTime - Date.now();
}

function serverNow() {
    return Date.now() + serverClockOffsetMs;
}

function secondsSince(isoText) {
    return Math.max(0, Math.floor((serverNow() - Date.parse(isoText)) / 1000));
}

// ---------- Live timers ----------
// Any element with data-timer-start="<ISO time>" shows a running HH:MM:SS clock.
// Because it is calculated from the saved start time, a page refresh never resets it.
function updateLiveTimers() {
    document.querySelectorAll("[data-timer-start]").forEach((element) => {
        element.textContent = formatTimer(secondsSince(element.dataset.timerStart));
    });
}

let liveTimersStarted = false;
function startLiveTimers() {
    if (liveTimersStarted) return;
    liveTimersStarted = true;
    setInterval(updateLiveTimers, 1000);
}

function createTimerElement(startedAt, className = "session-timer") {
    const timer = document.createElement("span");
    timer.className = className;
    timer.dataset.timerStart = startedAt;
    timer.setAttribute("role", "timer");
    timer.textContent = formatTimer(secondsSince(startedAt));
    return timer;
}

// ---------- API actions ----------

async function fetchActiveSessions() {
    const { data } = await apiRequest("/sessions/active");
    syncServerClock(data.serverTime);
    return data.sessions;
}

// Returns the new session, or null if it failed (the error is shown as a toast)
async function startSessionForTable(table, button) {
    if (button) setButtonLoading(button, true, "Starting…");
    try {
        const { data, message } = await apiRequest("/sessions", { method: "POST", body: { tableId: table.id } });
        showToast(message);
        return data;
    } catch (error) {
        showToast(error.message, "error", 6000);
        return null;
    } finally {
        if (button && button.isConnected) setButtonLoading(button, false);
    }
}

// Asks first. Returns the ended session, or null if cancelled or failed.
async function endSessionWithConfirm(session, button) {
    const label = `Table ${session.tableNumber}${session.tableName ? ` (${session.tableName})` : ""}`;
    const confirmed = await confirmDialog(
        `${label} has been playing for ${formatDuration(secondsSince(session.startedAt))}. ` +
            "The end time is saved now and the table becomes available.",
        { title: `End session on Table ${session.tableNumber}?`, confirmText: "End Session", danger: true }
    );
    if (!confirmed) return null;

    if (button) setButtonLoading(button, true, "Ending…");
    let ended = null;
    try {
        const { data, message } = await apiRequest(`/sessions/${session.id}/end`, { method: "POST" });
        showToast(`${message} · ${formatDuration(data.durationSeconds)}`);
        ended = data;
    } catch (error) {
        showToast(error.message, "error", 6000);
        return null;
    } finally {
        if (button && button.isConnected) setButtonLoading(button, false);
    }

    // Phase 5: go straight on to billing (staff can also choose "Bill later")
    if (typeof openCreateBillDialog === "function") await openCreateBillDialog(ended);
    return ended;
}

// "Billed per match: 2 of 3" - a session played as matches has one bill per completed match (Phase 11.5)
function matchBillingSummary(summary) {
    const billable = summary.total - summary.cancelled;
    const waiting = summary.inProgress ? ` · ${summary.inProgress} in progress` : "";
    return `Billed per match: ${summary.billed} of ${billable}${waiting}`;
}

// "Matches" button for a session (Phase 11.4). Hidden on pages that don't load core/matches.js.
function createMatchesButton(session, className = "btn btn-secondary btn-small") {
    const button = document.createElement("button");
    button.type = "button";
    button.className = `${className} matches-button`;
    button.append(createIcon("trophy"), document.createTextNode("Matches"));
    button.setAttribute("aria-label", `Matches on table ${session.tableNumber}`);
    button.hidden = typeof openMatchesDialog !== "function"; // every role may view matches
    button.addEventListener("click", () => openMatchesDialog(session));
    return button;
}

// ---------- Active session row (Dashboard + Sessions page) ----------
// onEnded() is called after the session was ended, so the page can reload its data.
function createActiveSessionRow(session, onEnded) {
    const row = document.createElement("article");
    row.className = "session-row";
    row.dataset.sessionId = session.id;

    const number = document.createElement("span");
    number.className = "table-number table-number-small";
    number.textContent = session.tableNumber;
    number.setAttribute("aria-label", `Table number ${session.tableNumber}`);

    const info = document.createElement("div");
    info.className = "session-row-info";
    const name = document.createElement("p");
    name.className = "session-row-name";
    name.textContent = session.tableName || `Table ${session.tableNumber}`;
    const started = document.createElement("p");
    started.className = "session-row-meta";
    started.textContent = `Started ${formatTime(session.startedAt)}`;
    info.append(name, started);

    const badge = document.createElement("span");
    badge.className = "status-badge status-active";
    badge.textContent = capitalize(session.status);

    const timer = createTimerElement(session.startedAt);

    const endButton = document.createElement("button");
    endButton.type = "button";
    endButton.className = "btn btn-end btn-small";
    endButton.append(createIcon("stop"), document.createTextNode("End"));
    endButton.setAttribute("aria-label", `End session on table ${session.tableNumber}`);
    endButton.addEventListener("click", async () => {
        if (await endSessionWithConfirm(session, endButton)) onEnded();
    });

    // Phase 10: the café tab of this session (core/cafe.js, if the page loads it)
    const cafeButton = document.createElement("button");
    cafeButton.type = "button";
    cafeButton.className = "btn btn-secondary btn-small cafe-tab-button";
    cafeButton.append(createIcon("cup"), document.createTextNode("Café"));
    cafeButton.setAttribute("aria-label", `Café items for table ${session.tableNumber}`);
    cafeButton.hidden = typeof openCafeTabDialog !== "function"; // every role may see and sell café items
    cafeButton.addEventListener("click", () => openCafeTabDialog(session));

    // Phase 11.4: the matches played in this session (core/matches.js, if the page loads it)
    const matchesButton = createMatchesButton(session);

    const actions = document.createElement("div");
    actions.className = "session-row-actions";
    actions.append(matchesButton, cafeButton, endButton);

    row.append(number, info, badge, timer, actions);
    return row;
}
