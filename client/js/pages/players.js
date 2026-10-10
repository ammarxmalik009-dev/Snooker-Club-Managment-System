// players.js (page) - registered players: list, search, add, edit, deactivate / reactivate (Phase 11.2),
// and each player's details: match history, billing history and what they still owe (Phase 11.6).
// Players are separate from booking customers. Nothing is ever deleted: deactivated players keep their
// history. Buttons a role can't use are hidden; the server refuses them anyway (403).
// Uses: apiRequest (api.js), buildElement/createIcon/showToast/confirmDialog/setButtonLoading (ui.js),
//       formatDateTime/formatMoney/gameModeLabel/loadGameModes/BILL_STATUS_LABELS/PAYER_RULE_LABELS (format.js),
//       currentUserReady/userCan (layout.js)

const PLAYERS_PAGE_SIZE = 25;

const playersList = document.getElementById("players-list");
const playersSummary = document.getElementById("players-summary");
const playerSearch = document.getElementById("player-search");
const playerStatusFilter = document.getElementById("player-status-filter");
const playersPagination = document.getElementById("players-pagination");
const playerDialog = document.getElementById("player-dialog");
const playerForm = document.getElementById("player-form");
const playerFormError = document.getElementById("player-form-error");
const playerSave = document.getElementById("player-save");

let playerStatus = "active";
let playersPage = 1;
let editingPlayer = null;
let playerSearchTimer = null;
let playersRequest = 0;

// ---------- List ----------

async function loadPlayers() {
    const params = new URLSearchParams({ status: playerStatus, page: playersPage, limit: PLAYERS_PAGE_SIZE });
    const search = playerSearch.value.trim();
    if (search) params.set("search", search);
    const number = ++playersRequest;
    try {
        const { data } = await apiRequest(`/players?${params}`);
        if (number !== playersRequest) return;
        if (data.players.length === 0 && data.total > 0 && playersPage > data.totalPages) {
            playersPage = data.totalPages;
            return loadPlayers();
        }
        renderPlayers(data, Boolean(search));
    } catch (error) {
        if (number !== playersRequest) return;
        playersList.replaceChildren(playerEmpty("Could not load players", error.message));
        playersPagination.hidden = true;
    }
}

function playerEmpty(title, text) {
    return buildElement("div", { className: "empty-state panel-empty" },
        buildElement("span", { className: "empty-state-icon" }, createIcon("trophy")),
        buildElement("p", { className: "empty-state-title", text: title }),
        buildElement("p", { text }));
}

function renderPlayers(data, isSearching) {
    playersSummary.textContent = data.total === 1 ? "1 player" : `${data.total} players`;
    playersPagination.hidden = data.totalPages <= 1;
    document.getElementById("players-page-info").textContent = `Page ${data.page} of ${data.totalPages}`;
    document.getElementById("players-prev").disabled = data.page <= 1;
    document.getElementById("players-next").disabled = data.page >= data.totalPages;
    if (data.total === 0) {
        playersList.replaceChildren(isSearching || playerStatus !== "active"
            ? playerEmpty("No matching players", "Try another name, phone number or filter.")
            : playerEmpty("No players yet", userCan("players:manage") ? "Add your regular players here." : "An admin or staff member can add players."));
        return;
    }
    const head = buildElement("tr", {}, ...["Name", "Phone", "Notes", "Status", "Added"].map((text) =>
        buildElement("th", { text, attrs: { scope: "col" } })),
        buildElement("th", { attrs: { scope: "col" } }, buildElement("span", { className: "visually-hidden", text: "Actions" })));
    const rows = data.players.map((player) => {
        const actions = buildElement("td", { className: "actions-cell" });
        const button = (text, label, onClick, extra = "btn-ghost") => {
            const b = buildElement("button", { className: `btn btn-small ${extra}`, text, attrs: { type: "button", "aria-label": `${label} ${player.name}` } });
            b.addEventListener("click", onClick);
            actions.append(b);
        };
        button("History", "History of", () => openPlayerProfile(player.id));
        if (userCan("players:manage")) button("Edit", "Edit", () => openPlayerDialog(player), "btn-secondary");
        if (userCan("players:deactivate")) {
            if (player.isActive) button("Deactivate", "Deactivate", () => setPlayerActive(player, false), "btn-ghost is-danger");
            else button("Reactivate", "Reactivate", () => setPlayerActive(player, true));
        }
        return buildElement("tr", { className: player.isActive ? "" : "is-inactive" },
            buildElement("td", { attrs: { "data-label": "Name" } }, buildElement("strong", { text: player.name })),
            buildElement("td", { text: player.phone || "—", attrs: { "data-label": "Phone" } }),
            buildElement("td", { className: "cell-wrap", text: player.notes || "—", attrs: { "data-label": "Notes" } }),
            buildElement("td", { attrs: { "data-label": "Status" } },
                buildElement("span", { className: `status-badge ${player.isActive ? "status-available" : "status-inactive"}`, text: player.isActive ? "Active" : "Inactive" })),
            buildElement("td", { text: formatDateTime(player.createdAt), attrs: { "data-label": "Added" } }),
            actions);
    });
    playersList.replaceChildren(buildElement("div", { className: "table-scroll" },
        buildElement("table", { className: "data-table players-table" }, buildElement("thead", {}, head), buildElement("tbody", {}, ...rows))));
}

// ---------- Add / edit ----------

function clearPlayerErrors() {
    playerFormError.hidden = true;
    playerForm.querySelectorAll("[data-error-for]").forEach((el) => (el.hidden = true));
}

function openPlayerDialog(player = null) {
    editingPlayer = player;
    playerForm.reset();
    clearPlayerErrors();
    document.getElementById("player-dialog-title").textContent = player ? `Edit ${player.name}` : "Add player";
    if (player) {
        playerForm.elements.name.value = player.name;
        playerForm.elements.phone.value = player.phone || "";
        playerForm.elements.notes.value = player.notes || "";
    }
    playerDialog.showModal();
    playerForm.elements.name.focus();
}

playerForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    clearPlayerErrors();
    const body = {
        name: playerForm.elements.name.value,
        phone: playerForm.elements.phone.value.trim(),
        notes: playerForm.elements.notes.value.trim(),
    };
    setButtonLoading(playerSave, true, "Saving…");
    try {
        const { message } = editingPlayer
            ? await apiRequest(`/players/${editingPlayer.id}`, { method: "PATCH", body })
            : await apiRequest("/players", { method: "POST", body });
        playerDialog.close();
        showToast(message);
        await loadPlayers();
    } catch (error) {
        let shown = false;
        for (const { field, message } of error.errors || []) {
            const target = playerForm.querySelector(`[data-error-for="${field}"]`);
            if (target) {
                target.textContent = message; // e.g. 'A player called "Ali" is already registered'
                target.hidden = false;
                shown = true;
            }
        }
        if (!shown) {
            playerFormError.textContent = error.message;
            playerFormError.hidden = false;
        }
    } finally {
        setButtonLoading(playerSave, false);
    }
});

// ---------- Deactivate / reactivate (no delete) ----------

async function setPlayerActive(player, active) {
    if (!active) {
        const ok = await confirmDialog(`${player.name} will no longer be offered for new games. Their history is kept, and they can be reactivated later.`,
            { title: `Deactivate ${player.name}?`, confirmText: "Deactivate", danger: true });
        if (!ok) return;
    }
    try {
        const { message } = await apiRequest(`/players/${player.id}/${active ? "reactivate" : "deactivate"}`, { method: "POST" });
        showToast(message);
        await loadPlayers();
    } catch (error) {
        showToast(error.message, "error", 6000);
    }
}

// ---------- Details & history (Phase 11.6) ----------
// Everything is worked out by the server from the matches and bills (no counters):
//   GET /api/players/:id            the player
//   GET /api/players/:id/matches    match history + statistics
//   GET /api/players/:id/bills      bill history + outstanding (share - paid on open bills)

const PROFILE_PAGE_SIZE = 10;
const playerProfileDialog = document.getElementById("player-profile-dialog");
const playerProfile = document.getElementById("player-profile");
let profileRequest = 0;

async function openPlayerProfile(playerId) {
    const number = ++profileRequest;
    // Never show the previous player's details while this one loads
    playerProfile.replaceChildren(buildElement("div", { className: "empty-state panel-empty" },
        buildElement("span", { className: "spinner", attrs: { "aria-hidden": "true" } }), buildElement("p", { text: "Loading…" })));
    if (!playerProfileDialog.open) playerProfileDialog.showModal();
    try {
        await loadGameModes().catch(() => null); // game type names (falls back to readable keys)
        const [player, matches, bills] = await Promise.all([
            apiRequest(`/players/${playerId}`).then((r) => r.data),
            apiRequest(`/players/${playerId}/matches?limit=${PROFILE_PAGE_SIZE}`).then((r) => r.data),
            apiRequest(`/players/${playerId}/bills?limit=${PROFILE_PAGE_SIZE}`).then((r) => r.data),
        ]);
        if (number !== profileRequest) return;
        renderPlayerProfile(player, matches, bills);
    } catch (error) {
        if (number !== profileRequest) return;
        playerProfile.replaceChildren(buildElement("p", { className: "form-error", text: error.message, attrs: { role: "alert" } }),
            buildElement("div", { className: "modal-actions" }, closeProfileButton("Close")));
    }
}

function closeProfileButton(text = null) {
    const button = text
        ? buildElement("button", { className: "btn btn-secondary", text, attrs: { type: "button" } })
        : buildElement("button", { className: "btn btn-ghost btn-icon", attrs: { type: "button", "aria-label": "Close" } }, createIcon("close"));
    button.addEventListener("click", () => playerProfileDialog.close());
    return button;
}

function renderPlayerProfile(player, matches, bills) {
    const stat = (label, value, className = "") => buildElement("div", { className: `mini-stat ${className}`.trim(), attrs: { "data-stat": label } },
        buildElement("strong", { text: String(value) }), buildElement("span", { text: label }));
    const s = matches.stats;
    const owed = bills.summary.outstanding;
    const matchesBox = buildElement("div", { className: "player-matches" });
    const billsBox = buildElement("div", { className: "player-bills" });
    renderPlayerMatches(matchesBox, player, matches);
    renderPlayerBills(billsBox, player, bills);

    playerProfile.replaceChildren(...[
        buildElement("header", { className: "bill-detail-header" },
            buildElement("div", {},
                buildElement("h2", { className: "modal-title", text: player.name, attrs: { id: "player-profile-title" } }),
                buildElement("p", { className: "modal-subtitle", text: [player.phone || "No phone", `Registered ${formatDateTime(player.createdAt)}`].join(" · ") })),
            buildElement("span", { className: `status-badge ${player.isActive ? "status-available" : "status-inactive"}`, text: player.isActive ? "Active" : "Inactive" }),
            closeProfileButton()),
        player.notes ? buildElement("p", { className: "field-hint", text: player.notes }) : null,
        buildElement("div", { className: "mini-stats player-stats" },
            stat("Matches", s.total),
            stat("Wins", s.wins),
            stat("Losses", s.losses),
            stat("Bills", bills.summary.bills),
            stat("Paid", formatMoney(bills.summary.totalPaid)),
            stat("Outstanding", formatMoney(owed), owed > 0 ? "is-owed" : "")),
        buildElement("p", { className: "field-hint", text: "Worked out from this player's matches and match bills. Walk-in games and bills made for a whole session (names only) are not linked to registered players." }),
        buildElement("h3", { className: "detail-section-title", text: "Match history" }),
        matchesBox,
        buildElement("h3", { className: "detail-section-title", text: "Billing history" }),
        billsBox,
        buildElement("div", { className: "modal-actions" }, closeProfileButton("Close")),
    ].filter(Boolean));
}

// Previous / Next under a history list (only when there is more than one page)
function profilePager(data, label, load) {
    if (data.totalPages <= 1) return null;
    const prev = buildElement("button", { className: "btn btn-secondary btn-small", text: "Previous", attrs: { type: "button", disabled: data.page <= 1, "aria-label": `Previous page of ${label}` } });
    const next = buildElement("button", { className: "btn btn-secondary btn-small", text: "Next", attrs: { type: "button", disabled: data.page >= data.totalPages, "aria-label": `Next page of ${label}` } });
    prev.addEventListener("click", () => load(data.page - 1));
    next.addEventListener("click", () => load(data.page + 1));
    return buildElement("nav", { className: "pagination", attrs: { "aria-label": label } },
        prev, buildElement("span", { className: "pagination-info", text: `Page ${data.page} of ${data.totalPages}` }), next);
}

async function reloadProfileList(box, player, kind, pageNumber, render) {
    try {
        const { data } = await apiRequest(`/players/${player.id}/${kind}?limit=${PROFILE_PAGE_SIZE}&page=${pageNumber}`);
        render(box, player, data);
    } catch (error) {
        showToast(error.message, "error");
    }
}

const RESULT_LABELS = { winner: "Won", loser: "Lost" };
const MATCH_STATUS_TEXT = { in_progress: "In progress", completed: "Completed", cancelled: "Cancelled" };

function renderPlayerMatches(box, player, data) {
    if (data.total === 0) {
        box.replaceChildren(buildElement("p", { className: "field-hint", text: "No matches yet." }));
        return;
    }
    const names = (list) => list.map((p) => p.name).join(", ") || "—";
    const head = buildElement("tr", {}, ...["Match", "When", "Game", "With / against", "Result", "Bill"].map((text) => buildElement("th", { text, attrs: { scope: "col" } })));
    const rows = data.matches.map((m) => {
        let against = `vs ${names(m.opponents)}`;
        if (m.team) against = `Team ${m.team} with ${names(m.teammates)} · vs ${names(m.opponents)}`;
        let result = m.status === "completed" ? RESULT_LABELS[m.result] || "—" : MATCH_STATUS_TEXT[m.status];
        if (m.status === "completed" && m.winningTeam) result += ` (Team ${m.winningTeam} won)`;
        const bill = m.bill
            ? buildElement("span", {}, `${m.bill.billNumber} `, buildElement("span", { className: `status-badge status-${m.bill.status}`, text: BILL_STATUS_LABELS[m.bill.status] }))
            : buildElement("span", { className: "cell-sub", text: m.status === "completed" ? "Not billed" : "—" });
        return buildElement("tr", { attrs: { "data-match-id": m.id } },
            buildElement("td", { text: `#${m.number} · Table ${m.tableNumber}` }),
            buildElement("td", { text: formatDateTime(m.startedAt) }),
            buildElement("td", { text: gameModeLabel(m.gameMode) }),
            buildElement("td", { className: "cell-wrap", text: against }),
            buildElement("td", { className: m.result ? `match-result-${m.result}` : "", text: result }),
            buildElement("td", {}, bill));
    });
    box.replaceChildren(...[
        buildElement("div", { className: "history-scroll" },
            buildElement("table", { className: "detail-table player-history-table" }, buildElement("thead", {}, head), buildElement("tbody", {}, ...rows))),
        profilePager(data, "Match history pages", (n) => reloadProfileList(box, player, "matches", n, renderPlayerMatches)),
    ].filter(Boolean));
}

function renderPlayerBills(box, player, data) {
    if (data.total === 0) {
        box.replaceChildren(buildElement("p", { className: "field-hint", text: "No bills yet." }));
        return;
    }
    const numeric = (text) => buildElement("td", { className: "numeric", text });
    const head = buildElement("tr", {},
        ...["Bill", "When", "Game", "Status"].map((text) => buildElement("th", { text, attrs: { scope: "col" } })),
        ...["Bill total", "Share", "Paid", "Owes"].map((text) => buildElement("th", { className: "numeric", text, attrs: { scope: "col" } })));
    const rows = data.bills.map((b) => {
        const game = `${gameModeLabel(b.gameMode)}${b.matchNumber ? ` · match #${b.matchNumber}` : ""}`;
        const cafe = b.cafeItems.length ? ` · café: ${b.cafeItems.map((c) => `${c.description} × ${c.quantity}`).join(", ")}` : "";
        return buildElement("tr", { attrs: { "data-bill-id": b.id } },
            buildElement("td", {}, buildElement("a", { text: b.billNumber, attrs: { href: `/pages/billing.html?bill=${b.id}` } })),
            buildElement("td", { text: formatDateTime(b.createdAt) }),
            buildElement("td", { className: "cell-wrap" }, game,
                buildElement("span", { className: "cell-sub", text: ` ${PAYER_RULE_LABELS[b.payerRule] || b.payerRule}${cafe}` })),
            buildElement("td", {}, buildElement("span", { className: `status-badge status-${b.status}`, text: BILL_STATUS_LABELS[b.status] || b.status })),
            numeric(formatMoney(b.total)),
            numeric(formatMoney(b.share.shareAmount)),
            numeric(formatMoney(b.share.paidAmount)),
            numeric(b.status === "cancelled" ? "—" : formatMoney(b.share.outstanding)));
    });
    box.replaceChildren(...[
        buildElement("p", { className: "player-owes", text: data.summary.outstanding > 0
            ? `Outstanding: ${formatMoney(data.summary.outstanding)} on ${data.summary.openBills} bill${data.summary.openBills === 1 ? "" : "s"}`
            : "Outstanding: Rs 0.00 (nothing owed)" }),
        buildElement("div", { className: "history-scroll" },
            buildElement("table", { className: "detail-table player-history-table" }, buildElement("thead", {}, head), buildElement("tbody", {}, ...rows))),
        profilePager(data, "Billing history pages", (n) => reloadProfileList(box, player, "bills", n, renderPlayerBills)),
    ].filter(Boolean));
}

// ---------- Events ----------

document.getElementById("add-player-button").addEventListener("click", () => openPlayerDialog());
document.getElementById("player-cancel").addEventListener("click", () => playerDialog.close());
document.getElementById("players-prev").addEventListener("click", () => { playersPage -= 1; loadPlayers(); });
document.getElementById("players-next").addEventListener("click", () => { playersPage += 1; loadPlayers(); });
playerSearch.addEventListener("input", () => {
    clearTimeout(playerSearchTimer);
    playerSearchTimer = setTimeout(() => { playersPage = 1; loadPlayers(); }, 300);
});
playerStatusFilter.addEventListener("click", (event) => {
    const chip = event.target.closest(".chip");
    if (!chip) return;
    playerStatus = chip.dataset.status;
    playersPage = 1;
    playerStatusFilter.querySelectorAll(".chip").forEach((c) => c.setAttribute("aria-pressed", String(c === chip)));
    loadPlayers();
});

currentUserReady.then(() => {
    loadPlayers();
    // Phase 11.7: /pages/players.html?player=<id> (from the Players report) opens that player's history
    const linked = new URLSearchParams(location.search).get("player");
    if (linked && /^[a-f0-9]{24}$/i.test(linked)) openPlayerProfile(linked);
});
