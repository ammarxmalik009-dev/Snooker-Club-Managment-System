// matches.js (core) - the Matches dialog of a session (Phase 11.4), shared by the Dashboard,
// Tables and Sessions pages (like the café tab in core/cafe.js).
//
//   Table -> Session -> Match -> Players -> Result
//
// A session can have many matches. Players are registered players (chosen from the Players list)
// or walk-ins (just a name - nothing is registered for them). 4 Players = Team 1 vs Team 2.
// The game types and their player rules come from the server (GET /api/game-modes); the server
// checks everything again. A match has no price: each completed match gets its own bill
// (Phase 11.5), made in the match bill window with today's rate - the server calculates it.
// Uses: apiRequest (api.js), buildElement/createIcon/showToast/confirmDialog/setButtonLoading (ui.js),
//       formatTime/formatMoney/formatMinutes/formatPercent/BILL_STATUS_LABELS/PAYER_RULE_LABELS/
//       CAFE_PAYER_RULE_LABELS (format.js), userCan (layout.js)

const MATCH_STATUS_LABELS = { in_progress: "In Progress", completed: "Completed", cancelled: "Cancelled" };
const MATCH_MAX_PLAYERS = 20; // the server's safety limit

let matchModesRequest = null;
function loadMatchModes() {
    if (!matchModesRequest) {
        matchModesRequest = apiRequest("/game-modes")
            .then(({ data }) => data.filter((mode) => mode.matchEnabled))
            .catch((error) => { matchModesRequest = null; throw error; });
    }
    return matchModesRequest;
}

// "2 or more players" / "exactly 3 players" / "4 players · 2 teams"
function matchPlayerRuleText(mode) {
    if (mode.resultType === "teams") return `${mode.minPlayers} players · 2 teams`;
    if (mode.maxPlayers === mode.minPlayers) return `exactly ${mode.minPlayers} players`;
    if (mode.maxPlayers === null) return `${mode.minPlayers} or more players`;
    return `${mode.minPlayers} to ${mode.maxPlayers} players`;
}

// "Ali vs Ahmed vs Guest" / "Team 1: Ali & Bilal vs Team 2: Saad & Zain"
function matchPlayersText(match) {
    if (match.teams && match.teams.length) {
        return match.teams.map((team) => `${team.name}: ${match.players.filter((p) => p.team === team.number).map((p) => p.name).join(" & ")}`).join(" vs ");
    }
    return match.players.map((p) => p.name).join(" vs ");
}

// "Winner: Ali" / "Winning Team: Team 1 (Ali & Bilal)" / "" (no result yet)
function matchResultText(match) {
    if (match.status !== "completed") return "";
    if (match.winningTeam) {
        const team = match.teams.find((t) => t.number === match.winningTeam);
        return `Winning Team: ${team.name} (${match.players.filter((p) => p.team === team.number).map((p) => p.name).join(" & ")})`;
    }
    const winner = match.players.find((p) => p.seat === match.winnerSeat);
    return `Winner: ${winner ? winner.name : "?"}`;
}

const matchModeLabel = (modes, key) => (modes.find((m) => m.key === key) || { label: key }).label;

// Opens the Matches dialog of a session (running or ended). Resolves when it is closed.
async function openMatchesDialog(session) {
    if (typeof currentUserReady !== "undefined") await currentUserReady; // userCan() needs the logged-in user
    const dialog = buildElement("dialog", { className: "modal modal-wide matches-dialog", attrs: { "aria-labelledby": "matches-title" } });
    const content = buildElement("div", { className: "modal-content" });
    dialog.append(content);
    document.body.append(dialog);

    const sessionOpen = session.isOpen !== false && !session.endedAt;
    const canManage = typeof userCan !== "function" || userCan("matches:manage");
    const canCancel = typeof userCan !== "function" || userCan("matches:cancel");
    const canBill = typeof userCan !== "function" || userCan("bills:create");

    const error = buildElement("p", { className: "form-error", attrs: { role: "alert", hidden: true } });
    const list = buildElement("div", { className: "match-list", attrs: { "aria-live": "polite" } });
    const startArea = buildElement("div", { className: "match-start-area" });
    const close = buildElement("button", { className: "btn btn-secondary", text: "Close", attrs: { type: "button" } });
    const subtitle = `Session started ${formatTime(session.startedAt)}${sessionOpen ? "" : " · session ended"}`;
    content.append(
        buildElement("h2", { className: "modal-title", text: `Matches · Table ${session.tableNumber}`, attrs: { id: "matches-title" } }),
        buildElement("p", { className: "modal-subtitle", text: subtitle }),
        error, list, startArea,
        buildElement("div", { className: "modal-actions" }, close));

    const showError = (message) => {
        error.textContent = message || "";
        error.hidden = !message;
    };
    let modes = [];

    async function refresh() {
        try {
            const [{ data: matches }, loadedModes] = await Promise.all([apiRequest(`/sessions/${session.id}/matches`), loadMatchModes()]);
            modes = loadedModes;
            renderList(matches);
        } catch (err) {
            showError(err.message);
        }
    }

    // ---------- The list ----------

    function renderList(matches) {
        if (matches.length === 0) {
            list.replaceChildren(buildElement("p", { className: "field-hint match-empty", text: sessionOpen ? "No matches yet. Start the first one below." : "No matches were recorded in this session." }));
        } else {
            list.replaceChildren(...matches.map(buildMatchRow));
        }
        renderStartButton();
    }

    function buildMatchRow(match) {
        const row = buildElement("article", { className: `match-row is-${match.status}`, attrs: { "data-match-id": match.id } });
        const head = buildElement("div", { className: "match-row-head" },
            buildElement("strong", { className: "match-title", text: `#${match.number}  ${matchModeLabel(modes, match.gameMode)}` }),
            buildElement("span", { className: `status-badge status-${match.status}`, text: MATCH_STATUS_LABELS[match.status] }));
        // "Ali (Registered) vs Guest (Walk-in)" or "Team 1: A & B vs Team 2: C & D".
        // Registered players and walk-ins are told apart in words, not only by style.
        const playerSpan = (p) => buildElement("span", { className: "match-player", text: p.name },
            buildElement("span", { className: "match-player-kind", text: p.player ? " (Registered)" : " (Walk-in)" }));
        const groups = match.teams.length
            ? match.teams.map((team) => ({ title: `${team.name}: `, members: match.players.filter((p) => p.team === team.number), joiner: " & " }))
            : [{ title: "", members: match.players, joiner: "  vs  " }];
        const players = buildElement("p", { className: "match-players" });
        groups.forEach((group, g) => {
            if (g > 0) players.append(document.createTextNode("  vs  "));
            if (group.title) players.append(buildElement("strong", { text: group.title }));
            group.members.forEach((p, i) => {
                if (i > 0) players.append(document.createTextNode(group.joiner));
                players.append(playerSpan(p));
            });
        });
        const result = buildElement("p", { className: "match-result", text: matchResultText(match) || (match.status === "cancelled" ? `Cancelled${match.cancelReason ? `: ${match.cancelReason}` : ""}` : "") });
        const actions = buildElement("div", { className: "match-actions" });
        const button = (label, className, onClick, aria) => {
            const b = buildElement("button", { className: `btn btn-small ${className}`, text: label, attrs: { type: "button", "aria-label": `${aria || label} #${match.number}` } });
            b.addEventListener("click", onClick);
            actions.append(b);
            return b;
        };
        if (match.status === "in_progress" && canManage) button("Complete Match", "btn-primary", () => openResultForm(row, match, "complete"));
        if (match.status === "in_progress" && canCancel) button("Cancel Match", "btn-ghost is-danger", () => cancelMatch(match));
        if (match.status === "completed" && canManage) button("Change result", "btn-ghost", () => openResultForm(row, match, "result"));
        row.append(head, players, result, buildBillingLine(match), actions);
        return row;
    }

    // ---------- Billing (Phase 11.5): one bill per completed match ----------

    function buildBillingLine(match) {
        const line = buildElement("div", { className: "match-billing" }, buildElement("span", { className: "match-billing-label", text: "Billing: " }));
        if (match.status === "in_progress") {
            line.append(buildElement("span", { text: "Not ready — match in progress" }));
        } else if (match.status === "cancelled") {
            line.append(buildElement("span", { text: "Cancelled — not billed" }));
        } else if (match.billInfo) {
            const bill = match.billInfo;
            line.append(
                buildElement("span", { text: `Bill ${bill.billNumber} · ` }),
                buildElement("span", { className: `status-badge status-${bill.status}`, text: BILL_STATUS_LABELS[bill.status] }),
                buildElement("a", { className: "btn btn-ghost btn-small match-view-bill", text: "View Bill", attrs: { href: `/pages/billing.html?bill=${bill.id}`, "aria-label": `View bill ${bill.billNumber} of match #${match.number}` } }));
        } else {
            line.append(buildElement("span", { text: "Not billed" }));
            if (sessionOpen) {
                line.append(buildElement("span", { className: "field-hint match-billing-hint", text: " · End the session to bill its matches (the session's time is part of the bill)." }));
            } else if (canBill) {
                const create = buildElement("button", { className: "btn btn-primary btn-small match-create-bill", text: "Create Bill", attrs: { type: "button", "aria-label": `Create bill for match #${match.number}` } });
                create.addEventListener("click", async () => {
                    if (await openMatchBillDialog(match)) await refresh();
                });
                line.append(create);
            }
        }
        return line;
    }

    // The bill window of one completed match. Game type, players and result come from the match
    // and can't be changed here; the server calculates every number (preview), like the session bill window.
    async function openMatchBillDialog(match) {
        let tabItems = [];
        try {
            tabItems = (await apiRequest(`/sessions/${session.id}/cafe-items`)).data.items.filter((item) => item.status === "open");
        } catch {
            tabItems = []; // the server still puts the open tab items on the bill
        }
        const billDialog = buildElement("dialog", { className: "modal modal-wide match-bill-dialog", attrs: { "aria-labelledby": "match-bill-title" } });
        const form = buildElement("form", { className: "modal-content", attrs: { novalidate: true } });
        billDialog.append(form);
        document.body.append(billDialog);

        const modeLabel = matchModeLabel(modes, match.gameMode);
        const billError = buildElement("p", { className: "form-error", attrs: { role: "alert", hidden: true } });
        const summary = buildElement("div", { className: "bill-summary", attrs: { "aria-live": "polite" } });
        const facts = buildElement("dl", { className: "fact-grid match-bill-facts" },
            ...[["Match", `#${match.number} · Table ${match.tableNumber}`], ["Game type", modeLabel], ["Players", matchPlayersText(match)],
                [match.teams.length ? "Winning Team" : "Winner", matchResultText(match).replace(/^(Winner|Winning Team): /, "")]]
                .map(([label, value]) => buildElement("div", {}, buildElement("dt", { text: label }), buildElement("dd", { text: value }))));

        const radio = (name, value, label, checked) => buildElement("label", { className: "segment" },
            buildElement("input", { attrs: { type: "radio", name, value, checked } }), buildElement("span", { className: "segment-label", text: label }));
        const payerGroup = buildElement("div", { className: "segmented", attrs: { role: "radiogroup", "aria-label": "Who pays" } },
            radio("matchPayerRule", "loser", PAYER_RULE_LABELS.loser, true), radio("matchPayerRule", "winner", PAYER_RULE_LABELS.winner, false),
            radio("matchPayerRule", "split", PAYER_RULE_LABELS.split, false));
        const payerHint = match.teams.length ? "4 Players: the losing team's two players share it (or the winning team's, or all four)." : "Several losers (or winners) share it in equal parts.";

        // Café: the session's open tab (Phase 10 rules), unless it is left for a later bill
        let cafeSection = null;
        let includeTab = null;
        let cafeRule = null;
        let tabHint = null;
        const consumerSelects = [];
        if (tabItems.length) {
            includeTab = buildElement("input", { attrs: { type: "checkbox", checked: true } });
            cafeRule = buildElement("select", { className: "select", attrs: { "aria-label": "Who pays for the café" } },
                buildElement("option", { text: "Same as the game", attrs: { value: "" } }),
                ...["loser", "consumer", "split"].map((rule) => buildElement("option", { text: CAFE_PAYER_RULE_LABELS[rule], attrs: { value: rule } })));
            // Phase 11.6: a registered consumer is saved with their player reference (the server links it by
            // the match's player); a walk-in consumer is saved by name only
            const itemRows = tabItems.map((item) => {
                const select = buildElement("select", { className: "select consumer-select", attrs: { "aria-label": `Who had ${item.description}` } },
                    buildElement("option", { text: "Who had it?", attrs: { value: "" } }),
                    ...match.players.map((p) => buildElement("option", {
                        text: `${p.name} (${p.player ? "Registered" : "Walk-in"})`,
                        // Boolean(): an empty "who had it" must not select anyone ("" would still set the attribute)
                        attrs: { value: p.name, selected: Boolean(item.consumer) && item.consumer.trim().toLowerCase() === p.name.toLowerCase() },
                    })));
                consumerSelects.push({ item, select });
                return buildElement("div", { className: "match-tab-item" },
                    buildElement("span", { text: `${item.description} × ${item.quantity} · ${formatMoney(item.quantity * item.unitPrice)}` }), select);
            });
            tabHint = buildElement("p", { className: "field-hint match-tab-hint", text: "Untick to leave it open for another match's bill." });
            cafeSection = buildElement("fieldset", { className: "bill-section" },
                buildElement("legend", { className: "bill-section-title", text: "Café tab of this session" }),
                buildElement("label", { className: "match-choice" }, includeTab, buildElement("span", { text: "Put the café tab on this bill" })),
                tabHint,
                ...itemRows,
                buildElement("label", { className: "form-field" }, buildElement("span", { text: "Who pays for the café" }), cafeRule));
        }

        const create = buildElement("button", { className: "btn btn-primary", text: "Create Bill", attrs: { type: "submit" } });
        const cancel = buildElement("button", { className: "btn btn-secondary", text: "Cancel", attrs: { type: "button" } });
        form.append(
            buildElement("h2", { className: "modal-title", text: `Create bill · Match #${match.number}`, attrs: { id: "match-bill-title" } }),
            buildElement("p", { className: "modal-subtitle", text: "The game type, players and result come from the match. Today's rate is used." }),
            billError, facts,
            buildElement("fieldset", { className: "bill-section" }, buildElement("legend", { className: "bill-section-title", text: "Who pays" }),
                payerGroup, buildElement("p", { className: "field-hint", text: payerHint })),
            cafeSection, summary,
            buildElement("div", { className: "modal-actions" }, cancel, create));

        const showBillError = (message) => { billError.textContent = message || ""; billError.hidden = !message; };
        const body = () => {
            const input = { payerRule: form.querySelector('input[name="matchPayerRule"]:checked').value };
            if (includeTab) {
                input.includeCafeTab = includeTab.checked;
                if (includeTab.checked) {
                    if (cafeRule.value) input.cafePayerRule = cafeRule.value;
                    input.tabItems = consumerSelects.map(({ item, select }) => ({ id: item.id, consumer: select.value }));
                }
            }
            return input;
        };

        let previewNumber = 0;
        async function preview() {
            const number = ++previewNumber;
            showBillError("");
            if (cafeSection) cafeSection.querySelectorAll("select").forEach((s) => (s.disabled = !includeTab.checked));
            try {
                const { data } = await apiRequest(`/matches/${match.id}/bill/preview`, { method: "POST", body: body() });
                if (number !== previewNumber) return;
                renderPreview(data);
                create.disabled = false;
            } catch (err) {
                if (number !== previewNumber) return;
                summary.replaceChildren(buildElement("p", { className: "summary-note is-warning", text: err.message }));
                create.disabled = true;
            }
        }

        function renderPreview(bill) {
            // Phase 11.8: on the session's last billable match the café tab can't be left behind
            // (it would never be billed and would keep holding stock). The server refuses it too.
            if (includeTab) {
                includeTab.disabled = Boolean(bill.cafeTabMustStay);
                if (bill.cafeTabMustStay) includeTab.checked = true;
                tabHint.textContent = bill.cafeTabMustStay
                    ? "This is the last match of this session that can be billed, so its café tab must go on this bill (otherwise it would never be billed)."
                    : "Untick to leave it open for another match's bill.";
                tabHint.classList.toggle("is-warning", Boolean(bill.cafeTabMustStay));
            }
            const game = bill.lineItems.find((l) => l.type === "game");
            const cafeTotal = bill.lineItems.filter((l) => l.type === "cafe").reduce((s, l) => s + l.amount, 0);
            const rateUnit = bill.pricingType === "per_minute" ? " / minute" : "";
            const lines = buildElement("dl", { className: "summary-lines" });
            const add = (label, amount, className = "summary-line") =>
                lines.append(buildElement("div", { className }, buildElement("dt", { text: label }), buildElement("dd", { text: amount })));
            add("Rate", `${formatMoney(bill.unitPrice)}${rateUnit}`);
            add(bill.pricingType === "per_minute" ? "Billed minutes" : "Quantity", String(game.quantity));
            add(`Game total (${game.description} × ${game.quantity} @ ${formatMoney(game.unitPrice)})`, formatMoney(game.amount));
            add("Café total", formatMoney(cafeTotal));
            if (bill.taxEnabled) add(`Tax (${formatPercent(bill.taxRateBasisPoints)})`, formatMoney(bill.taxAmount), "summary-line is-sub");
            add("Grand total", formatMoney(bill.total), "summary-line is-total");
            const shares = buildElement("ul", { className: "summary-shares" },
                ...bill.players.map((p) => buildElement("li", { className: p.shareAmount > 0 ? "" : "is-zero" },
                    buildElement("span", { text: `${p.name}${p.result ? ` (${p.result === "winner" ? "Winner" : "Loser"})` : ""}` }),
                    buildElement("strong", { text: formatMoney(p.shareAmount) }))));
            summary.replaceChildren(lines,
                buildElement("p", { className: "summary-caption", text: `${PAYER_RULE_LABELS[bill.payerRule]} · Billed time ${formatMinutes(bill.billedMinutes)}` }), shares);
        }

        return new Promise((resolve) => {
            let done = false;
            const finish = (bill) => {
                if (done) return;
                done = true;
                if (billDialog.open) billDialog.close();
                billDialog.remove();
                resolve(bill);
            };
            cancel.addEventListener("click", () => finish(null));
            billDialog.addEventListener("close", () => finish(null));
            form.addEventListener("change", preview);
            form.addEventListener("submit", async (event) => {
                event.preventDefault();
                setButtonLoading(create, true, "Creating…");
                try {
                    const { data, message } = await apiRequest(`/matches/${match.id}/bill`, { method: "POST", body: body() });
                    showToast(`${message} · ${formatMoney(data.total)}`);
                    finish(data);
                } catch (err) {
                    showBillError(err.message); // e.g. "Match #2 already has bill B-…" (someone else was quicker)
                    setButtonLoading(create, false);
                }
            });
            billDialog.showModal();
            summary.replaceChildren(buildElement("p", { className: "summary-note" }, buildElement("span", { className: "spinner", attrs: { "aria-hidden": "true" } }), " Calculating…"));
            create.disabled = true;
            preview();
        });
    }

    // ---------- Complete / change result ----------

    function openResultForm(row, match, action) {
        row.querySelector(".match-result-form")?.remove();
        const isTeams = match.teams.length > 0;
        const name = `winner-${match.id}`;
        const options = isTeams
            ? match.teams.map((team) => ({ value: team.number, label: `${team.name} (${match.players.filter((p) => p.team === team.number).map((p) => p.name).join(" & ")})`, checked: match.winningTeam === team.number }))
            : match.players.map((p) => ({ value: p.seat, label: p.name, checked: match.winnerSeat === p.seat }));
        const choices = buildElement("div", { className: "match-choices", attrs: { role: "radiogroup", "aria-label": isTeams ? "Which team won?" : "Who won?" } },
            ...options.map((o) => buildElement("label", { className: "match-choice" },
                buildElement("input", { attrs: { type: "radio", name, value: o.value, checked: o.checked } }), buildElement("span", { text: o.label }))));
        const save = buildElement("button", { className: "btn btn-primary btn-small", text: action === "complete" ? "Save result" : "Save new result", attrs: { type: "submit" } });
        const back = buildElement("button", { className: "btn btn-ghost btn-small", text: "Back", attrs: { type: "button" } });
        const form = buildElement("form", { className: "match-result-form", attrs: { novalidate: true } },
            buildElement("p", { className: "match-question", text: isTeams ? "Which team won?" : "Who won?" }), choices,
            action === "result" ? buildElement("p", { className: "field-hint", text: "Changing the result does not change a bill that was already made." }) : null,
            buildElement("div", { className: "match-actions" }, save, back));
        back.addEventListener("click", () => form.remove());
        form.addEventListener("submit", async (event) => {
            event.preventDefault();
            showError("");
            const chosen = form.querySelector(`input[name="${name}"]:checked`);
            if (!chosen) return showError(isTeams ? "Choose the team that won." : "Choose the player who won.");
            const body = isTeams ? { winningTeam: Number(chosen.value) } : { winnerSeat: Number(chosen.value) };
            setButtonLoading(save, true, "Saving…");
            try {
                const { message } = await apiRequest(`/matches/${match.id}/${action}`, { method: "POST", body });
                showToast(message);
                await refresh();
            } catch (err) {
                showError(err.message);
                setButtonLoading(save, false);
            }
        });
        row.append(form);
        form.querySelector("input")?.focus();
    }

    async function cancelMatch(match) {
        const confirmed = await confirmDialog(`Match #${match.number} (${matchModeLabel(modes, match.gameMode)}: ${matchPlayersText(match)}) will be marked as cancelled. It stays in the history.`,
            { title: `Cancel match #${match.number}?`, confirmText: "Cancel Match", cancelText: "Keep playing", danger: true });
        if (!confirmed) return;
        showError("");
        try {
            const { message } = await apiRequest(`/matches/${match.id}/cancel`, { method: "POST", body: {} });
            showToast(message);
        } catch (err) {
            showError(err.message);
        }
        await refresh();
    }

    // ---------- Start a new match ----------

    function renderStartButton() {
        if (!sessionOpen || !canManage) {
            startArea.replaceChildren(sessionOpen ? null : buildElement("p", { className: "field-hint", text: "This session has ended, so no new match can start. Matches still in progress can be completed or cancelled." }));
            return;
        }
        if (startArea.querySelector(".match-start-form")) return; // keep a form that is being filled in
        const startButton = buildElement("button", { className: "btn btn-primary", attrs: { type: "button" } }, createIcon("plus"), "Start New Match");
        startButton.addEventListener("click", () => startArea.replaceChildren(buildStartForm()));
        startArea.replaceChildren(startButton);
    }

    function buildStartForm() {
        const enabled = modes.filter((m) => m.matchEnabled);
        let mode = enabled[0];
        // One entry per player: { kind: "walkin" | "registered", name, playerId, playerName, team }
        let rows = [];

        const form = buildElement("form", { className: "match-start-form", attrs: { novalidate: true, "aria-label": "Start a new match" } });
        const formError = buildElement("p", { className: "form-error", attrs: { role: "alert", hidden: true } });
        const showFormError = (message) => { formError.textContent = message || ""; formError.hidden = !message; };

        const modeGroup = buildElement("div", { className: "segmented", attrs: { role: "radiogroup", "aria-label": "Game type" } },
            ...enabled.map((m, i) => buildElement("label", { className: "segment" },
                buildElement("input", { attrs: { type: "radio", name: "matchGameMode", value: m.key, checked: i === 0 } }),
                buildElement("span", { className: "segment-label", text: m.label }),
                buildElement("span", { className: "segment-note", text: matchPlayerRuleText(m) }))));
        modeGroup.addEventListener("change", (event) => {
            mode = enabled.find((m) => m.key === event.target.value);
            fitRows();
            renderRows();
            showFormError("");
        });

        const playersArea = buildElement("div", { className: "match-players-area" });
        const addButton = buildElement("button", { className: "btn btn-ghost btn-small", attrs: { type: "button" } }, createIcon("plus"), "Add player");
        addButton.addEventListener("click", () => {
            rows.push(newRow(null));
            renderRows();
            playersArea.querySelector(`.match-player-row[data-index="${rows.length - 1}"] input`)?.focus();
        });
        const submit = buildElement("button", { className: "btn btn-primary", attrs: { type: "submit" } }, createIcon("start"), "Start Match");
        const back = buildElement("button", { className: "btn btn-ghost", text: "Back", attrs: { type: "button" } });
        back.addEventListener("click", () => {
            startArea.replaceChildren();
            renderStartButton();
        });

        form.append(
            buildElement("h3", { className: "bill-section-title", text: "Start a new match" }),
            buildElement("fieldset", { className: "bill-section" }, buildElement("legend", { className: "bill-section-title", text: "Game type" }), modeGroup),
            buildElement("fieldset", { className: "bill-section" }, buildElement("legend", { className: "bill-section-title", text: "Players" }),
                buildElement("p", { className: "field-hint", text: "A Registered Player is chosen from the Players list. A Walk-in Player only needs a name (nothing is registered)." }),
                playersArea, addButton),
            formError,
            buildElement("div", { className: "match-actions" }, submit, back));

        function newRow(team) {
            return { kind: "walkin", name: "", playerId: null, playerName: "", team };
        }

        // Keep the number of rows inside the mode's limits; 4 Players: two in each team
        function fitRows() {
            const min = mode.minPlayers;
            const max = mode.maxPlayers === null ? MATCH_MAX_PLAYERS : mode.maxPlayers;
            while (rows.length < min) rows.push(newRow(null));
            if (rows.length > max) rows = rows.slice(0, max);
            if (mode.resultType === "teams") {
                const perTeam = rows.length / 2;
                rows.forEach((row, i) => { if (row.team !== 1 && row.team !== 2) row.team = i < perTeam ? 1 : 2; });
                // A team switch from another mode may leave 3 + 1: balance it
                for (const [from, to] of [[1, 2], [2, 1]]) {
                    while (rows.filter((r) => r.team === from).length > perTeam) rows.find((r) => r.team === from).team = to;
                }
            } else {
                rows.forEach((row) => (row.team = null));
            }
        }

        function renderRows() {
            const max = mode.maxPlayers === null ? MATCH_MAX_PLAYERS : mode.maxPlayers;
            addButton.hidden = rows.length >= max;
            if (mode.resultType === "teams") {
                playersArea.replaceChildren(...[1, 2].map((team) => {
                    const members = rows.filter((r) => r.team === team);
                    return buildElement("fieldset", { className: "match-team", attrs: { "data-team": team } },
                        buildElement("legend", { className: "match-team-title", text: `Team ${team} (${members.length} of 2)` }),
                        ...members.map((row) => buildPlayerRow(row)));
                }));
            } else {
                playersArea.replaceChildren(...rows.map((row) => buildPlayerRow(row)));
            }
        }

        function buildPlayerRow(row) {
            const index = rows.indexOf(row);
            const label = `Player ${index + 1}`;
            const kind = buildElement("select", { className: "select match-kind", attrs: { "aria-label": `${label}: registered or walk-in` } },
                buildElement("option", { text: "Walk-in Player", attrs: { value: "walkin", selected: row.kind === "walkin" } }),
                buildElement("option", { text: "Registered Player", attrs: { value: "registered", selected: row.kind === "registered" } }));
            kind.addEventListener("change", () => {
                row.kind = kind.value;
                renderRows();
                playersArea.querySelector(`.match-player-row[data-index="${index}"] input`)?.focus();
            });

            let who;
            if (row.kind === "walkin") {
                who = buildElement("input", { className: "input match-walkin-name", attrs: { type: "text", maxlength: "40", value: row.name, placeholder: "Walk-in name", "aria-label": `${label}: walk-in name` } });
                who.addEventListener("input", () => (row.name = who.value));
            } else if (row.playerId) {
                const change = buildElement("button", { className: "btn btn-ghost btn-small", text: "Change", attrs: { type: "button", "aria-label": `Choose another player for ${label}` } });
                change.addEventListener("click", () => { row.playerId = null; row.playerName = ""; renderRows(); });
                who = buildElement("div", { className: "match-chosen" },
                    buildElement("strong", { text: row.playerName }), buildElement("span", { className: "match-player-kind", text: "Registered" }), change);
            } else {
                who = buildPlayerSearch(row, label);
            }

            const parts = [kind, who];
            if (mode.resultType === "teams") {
                const other = row.team === 1 ? 2 : 1;
                const move = buildElement("button", { className: "btn btn-ghost btn-small match-move", text: `Move to Team ${other}`, attrs: { type: "button", "aria-label": `Move ${label} to Team ${other}` } });
                move.addEventListener("click", () => { row.team = other; renderRows(); showFormError(""); });
                parts.push(move);
            } else if (rows.length > mode.minPlayers) {
                const remove = buildElement("button", { className: "btn btn-ghost btn-icon btn-small", attrs: { type: "button", "aria-label": `Remove ${label}` } }, createIcon("close"));
                remove.addEventListener("click", () => { rows.splice(rows.indexOf(row), 1); renderRows(); });
                parts.push(remove);
            }
            return buildElement("div", { className: "match-player-row", attrs: { "data-index": index } }, ...parts);
        }

        // Search the registered (active) players by name or phone; players already chosen are left out
        function buildPlayerSearch(row, label) {
            const input = buildElement("input", { className: "input match-player-search", attrs: { type: "search", placeholder: "Search registered players", autocomplete: "off", "aria-label": `${label}: search registered players` } });
            const suggestions = buildElement("ul", { className: "suggestions", attrs: { role: "listbox", hidden: true } });
            let timer = null;
            let request = 0;
            input.addEventListener("input", () => {
                clearTimeout(timer);
                const text = input.value.trim();
                if (!text) { suggestions.hidden = true; return; }
                timer = setTimeout(async () => {
                    const number = ++request;
                    try {
                        const { data } = await apiRequest(`/players?${new URLSearchParams({ search: text, status: "active", limit: 8 })}`);
                        if (number !== request) return;
                        const taken = new Set(rows.filter((r) => r !== row && r.playerId).map((r) => r.playerId));
                        const found = data.players.filter((p) => !taken.has(p.id));
                        suggestions.replaceChildren(...(found.length ? found.map((p) => {
                            const item = buildElement("li", { className: "suggestion", attrs: { role: "option", tabindex: "-1" } },
                                buildElement("span", { text: p.name }), buildElement("span", { className: "suggestion-meta", text: p.phone || "Registered" }));
                            item.addEventListener("click", () => { row.playerId = p.id; row.playerName = p.name; renderRows(); showFormError(""); });
                            return item;
                        }) : [buildElement("li", { className: "suggestion is-empty", text: "No registered player found. Choose Walk-in Player to type a name." })]));
                        suggestions.hidden = false;
                    } catch (err) {
                        showFormError(err.message);
                    }
                }, 250);
            });
            return buildElement("div", { className: "combo match-combo" }, input, suggestions);
        }

        form.addEventListener("submit", async (event) => {
            event.preventDefault();
            showFormError("");
            // Quick checks for the operator; the server checks everything again
            const missing = rows.findIndex((r) => (r.kind === "walkin" ? !r.name.trim() : !r.playerId));
            if (missing !== -1) return showFormError(rows[missing].kind === "walkin" ? `Player ${missing + 1}: type the walk-in name.` : `Player ${missing + 1}: choose a registered player from the search.`);
            if (mode.resultType === "teams") {
                const counts = [1, 2].map((team) => rows.filter((r) => r.team === team).length);
                if (counts[0] !== 2 || counts[1] !== 2) return showFormError(`Each team needs exactly 2 players (Team 1 has ${counts[0]}, Team 2 has ${counts[1]}).`);
            }
            const body = {
                gameMode: mode.key,
                players: rows.map((r) => ({
                    ...(r.kind === "registered" ? { playerId: r.playerId } : { playerId: null, name: r.name.trim() }),
                    ...(mode.resultType === "teams" ? { team: r.team } : {}),
                })),
            };
            setButtonLoading(submit, true, "Starting…");
            try {
                const { message } = await apiRequest(`/sessions/${session.id}/matches`, { method: "POST", body });
                showToast(message);
                startArea.replaceChildren();
                await refresh();
            } catch (err) {
                showFormError(err.message);
                setButtonLoading(submit, false);
            }
        });

        fitRows();
        renderRows();
        return form;
    }

    return new Promise((resolve) => {
        const finish = () => {
            if (dialog.open) dialog.close();
            dialog.remove();
            resolve();
        };
        close.addEventListener("click", finish);
        dialog.addEventListener("close", finish);
        dialog.showModal();
        list.replaceChildren(buildElement("p", { className: "field-hint" }, buildElement("span", { className: "spinner", attrs: { "aria-hidden": "true" } }), " Loading…"));
        refresh();
    });
}
