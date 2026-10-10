// billing.js (core) - the "Create Bill" dialog, shared by the Tables, Dashboard and Sessions pages.
// It opens automatically after a session ends (see core/sessions.js), or from the session history.
//
// IMPORTANT: the browser never calculates the bill. Every change asks the server for a
// preview (POST /api/bills/preview) and shows the server's numbers.
//
// Uses: apiRequest (api.js), buildElement/createIcon/showToast/setButtonLoading (ui.js),
//       formatMoney/parseMoneyInput/formatDuration/formatMinutes/loadGameModes (format.js)

const MAX_PLAYERS = 4;
const MAX_CAFE_ITEMS = 20;

// Opens the dialog for a finished session. Resolves to the created bill, or null ("Bill later").
async function openCreateBillDialog(session) {
    // Phase 11.5: a session played as matches is billed match by match (the server refuses a bill for
    // the whole session) - show its Matches window instead, where each completed match is billed.
    try {
        const { data: matches } = await apiRequest(`/sessions/${session.id}/matches`);
        if (matches.some((match) => match.status !== "cancelled")) {
            if (typeof openMatchesDialog === "function") {
                await openMatchesDialog({ ...session, isOpen: false });
                return true; // match bills may have been made: the page refreshes its lists
            }
            showToast("This session has matches: bill each completed match from its Matches window.", "error", 6000);
            return null;
        }
    } catch {
        // Matches couldn't be checked: carry on - the server still refuses a wrong bill
    }

    let settings = null;
    let gameModes = [];
    let tab = { items: [] };
    let products = [];
    try {
        settings = (await apiRequest("/settings")).data;
        // Registry modes that can be billed, with TODAY's rates (fetched fresh, like the settings above)
        gameModes = (await apiRequest("/game-modes")).data.filter((mode) => mode.enabled);
    } catch (error) {
        showToast(`Could not load the rate list: ${error.message}`, "error");
        return null;
    }
    // Phase 10: the session's café tab (always billed) and the products that can be added now
    try {
        tab = (await apiRequest(`/sessions/${session.id}/cafe-items`)).data;
    } catch (error) {
        if (error.status !== 403 && error.status !== 404) {
            showToast(`Could not load the café tab: ${error.message}`, "error");
            return null;
        }
    }
    try {
        if (typeof fetchSellableProducts === "function") products = await fetchSellableProducts();
    } catch {
        products = []; // typed-in items still work
    }

    return new Promise((resolve) => {
        const ui = buildBillDialog(session, settings, products, tab.items.filter((item) => item.status === "open"), gameModes);
        let finished = false;
        let previewTimer = null;
        let previewNumber = 0;

        function finish(bill) {
            if (finished) return;
            finished = true;
            if (ui.dialog.open) ui.dialog.close();
            ui.dialog.remove();
            resolve(bill);
        }

        // ---------- Reading the form ----------

        // Returns { input } for the API, or { problem } explaining what is still missing
        function readInput() {
            const gameMode = ui.form.elements.gameMode.value;
            const quantity = Number(ui.quantityInput.value);
            const payerRule = ui.form.elements.payerRule.value;

            const players = [...ui.playerList.children].map((row) => ({
                name: row.querySelector("input").value.trim(),
                result: row.querySelector("select").value || null,
            }));
            if (players.some((player) => !player.name)) return { problem: "Enter a name for every player." };

            const cafeItems = [];
            for (const row of ui.cafeList.children) {
                const [description, quantityField, priceField] = row.querySelectorAll("input");
                const productSelect = row.querySelector(".product-select");
                const consumer = row.querySelector(".consumer-select")?.value || undefined;
                if (productSelect && productSelect.value) {
                    // A product from the list: the server uses today's price and checks the stock
                    cafeItems.push({ productId: productSelect.value, quantity: Number(quantityField.value), consumer });
                    continue;
                }
                const unitPrice = parseMoneyInput(priceField.value);
                if (!description.value.trim()) return { problem: "Give every café item a name (or remove the row)." };
                if (unitPrice === null) return { problem: `Enter a price like 80 or 80.50 for "${description.value.trim()}".` };
                cafeItems.push({ description: description.value.trim(), quantity: Number(quantityField.value), unitPrice, consumer });
            }

            const input = { sessionId: session.id, gameMode, quantity, payerRule, players, cafeItems };
            // Phase 10: the tab items (who had each) and who pays for the café
            if (ui.tabRows.length) input.tabItems = ui.tabRows.map((row) => ({ id: row.dataset.itemId, consumer: row.querySelector(".consumer-select").value || undefined }));
            if (cafeItems.length || ui.tabRows.length) input.cafePayerRule = ui.form.elements.cafePayerRule.value;
            return { input };
        }

        // ---------- Server preview ----------

        function schedulePreview() {
            clearTimeout(previewTimer);
            previewTimer = setTimeout(runPreview, 300);
        }

        async function runPreview() {
            const { input, problem } = readInput();
            const requestNumber = ++previewNumber;
            ui.createButton.disabled = true;

            if (problem) {
                showSummaryMessage(ui, problem);
                return;
            }
            showSummaryMessage(ui, "Calculating…", true);
            try {
                const { data } = await apiRequest("/bills/preview", { method: "POST", body: input });
                if (requestNumber !== previewNumber || finished) return;
                renderSummary(ui, data);
                ui.createButton.disabled = false;
            } catch (error) {
                if (requestNumber !== previewNumber || finished) return;
                const details = (error.errors || []).map((e) => e.message);
                showSummaryMessage(ui, details.length > 1 ? details.join(" · ") : error.message);
            }
        }

        // ---------- Saving ----------

        async function createBill(event) {
            event.preventDefault();
            const { input, problem } = readInput();
            ui.formError.hidden = true;
            if (problem) {
                ui.formError.textContent = problem;
                ui.formError.hidden = false;
                return;
            }

            setButtonLoading(ui.createButton, true, "Creating…");
            try {
                const { data, message } = await apiRequest("/bills", { method: "POST", body: input });
                showToast(`${message} · ${formatMoney(data.total)}`);
                finish(data);
            } catch (error) {
                const details = (error.errors || []).map((e) => e.message);
                ui.formError.textContent = details.length > 1 ? details.join(" · ") : error.message;
                ui.formError.hidden = false;
                setButtonLoading(ui.createButton, false);
            }
        }

        // ---------- Events ----------
        ui.form.addEventListener("input", (event) => {
            if (event.target.closest(".player-row")) refreshConsumerOptions(ui); // player names feed "who had it"
            schedulePreview();
        });
        ui.form.addEventListener("change", (event) => {
            if (event.target.name === "cafePayerRule") ui.cafeRuleTouched = true;
            if (event.target.name === "payerRule") syncCafeRule(ui);
            if (event.target.closest(".player-row")) refreshConsumerOptions(ui);
            schedulePreview();
        });
        ui.form.addEventListener("submit", createBill);
        ui.laterButton.addEventListener("click", () => finish(null));
        ui.dialog.addEventListener("close", () => finish(null)); // Esc key
        ui.onListChange = schedulePreview;

        document.body.appendChild(ui.dialog);
        ui.dialog.showModal();
        ui.playerList.querySelector("input").focus();
        runPreview();
    });
}

// ---------- Building the dialog ----------

function buildBillDialog(session, settings, products = [], tabItems = [], gameModes = []) {
    const ui = { products, tabRows: [], cafeRuleTouched: false };
    ui.dialog = buildElement("dialog", { className: "modal modal-wide bill-dialog", attrs: { "aria-labelledby": "bill-dialog-title" } });
    ui.form = buildElement("form", { className: "modal-content", attrs: { novalidate: true } });

    const played = session.durationSeconds !== null && session.durationSeconds !== undefined
        ? `Played ${formatDuration(session.durationSeconds)}`
        : "";
    ui.form.append(
        buildElement("h2", { className: "modal-title", text: `Create bill · Table ${session.tableNumber}`, attrs: { id: "bill-dialog-title" } }),
        buildElement("p", { className: "modal-subtitle", text: [session.tableName, played].filter(Boolean).join(" · ") })
    );

    ui.formError = buildElement("p", { className: "form-error", attrs: { role: "alert", hidden: true } });
    ui.form.append(ui.formError);

    // --- Game type + count ---
    const gameSection = buildSection("Game");
    const modes = buildElement("div", { className: "segmented", attrs: { role: "radiogroup", "aria-label": "Game type" } });
    // One button per billable game mode, from the server's registry (first one selected)
    // Phase 11.3: "Rs 10.00 / minute" for Century (billed minutes × rate), "Rs 250.00 each" for Frame
    const rateText = (mode) => !mode.rateSet ? "Price not set"
        : mode.pricingType === "per_minute" ? `${formatMoney(mode.rate)} / ${mode.rateUnit.one}` : `${formatMoney(mode.rate)} each`;
    gameModes.forEach((mode, index) => {
        modes.append(buildSegment("gameMode", mode.key, mode.label, rateText(mode), index === 0));
    });
    ui.quantityInput = buildElement("input", {
        className: "input stepper-input",
        attrs: { type: "number", min: "1", max: "100", step: "1", value: "1", inputmode: "numeric", "aria-label": "Number of games or frames" },
    });
    const stepper = buildElement("div", { className: "stepper" },
        buildStepButton("minus", "One less", () => changeQuantity(ui, -1)),
        ui.quantityInput,
        buildStepButton("plus", "One more", () => changeQuantity(ui, 1))
    );
    const units = [...new Set(gameModes.map((mode) => mode.quantityLabel.many))].join(" / ");
    const countLabel = buildElement("span", { className: "stepper-label", text: `${units} played` }); // "games / frames played"
    gameSection.append(modes, buildElement("div", { className: "stepper-row" }, stepper, countLabel));

    // --- Players ---
    const playerSection = buildSection("Players", "2 to 4 players. Mark the winner / loser if that person pays.");
    ui.playerList = buildElement("div", { className: "row-list" });
    ui.addPlayerButton = buildElement("button", { className: "btn btn-ghost btn-small", attrs: { type: "button" } }, createIcon("plus"), "Add player");
    ui.addPlayerButton.addEventListener("click", () => addPlayerRow(ui));
    playerSection.append(ui.playerList, ui.addPlayerButton);

    // --- Who pays ---
    const paySection = buildSection("Who pays");
    const rules = buildElement("div", { className: "segmented", attrs: { role: "radiogroup", "aria-label": "Who pays" } });
    rules.append(
        buildSegment("payerRule", "loser", PAYER_RULE_LABELS.loser, null, true),
        buildSegment("payerRule", "winner", PAYER_RULE_LABELS.winner, null, false),
        buildSegment("payerRule", "split", PAYER_RULE_LABELS.split, null, false)
    );
    paySection.append(rules);

    // --- Café items ---
    const cafeSection = buildSection("Café items", products.length
        ? "Optional: pick drinks or snacks from the list, or type in a one-off item."
        : "Optional: drinks or snacks to add to this bill.");
    // Items already on the session's tab: always billed; choose who had each one
    if (tabItems.length) {
        const tabList = buildElement("div", { className: "row-list tab-items" });
        for (const item of tabItems) {
            const consumer = buildConsumerSelect(`Who had ${item.description}`, item.consumer);
            const row = buildElement("div", { className: "list-row tab-item-row", attrs: { "data-item-id": item.id } },
                buildElement("span", { className: "tab-item-name" },
                    buildElement("strong", { text: `${item.description} × ${item.quantity}` }),
                    buildElement("span", { className: "cell-sub", text: `${formatMoney(item.unitPrice)} each · on the tab` })),
                consumer);
            ui.tabRows.push(row);
            tabList.append(row);
        }
        cafeSection.append(buildElement("p", { className: "field-hint", text: `${tabItems.length} item${tabItems.length === 1 ? "" : "s"} from the session's café tab:` }), tabList);
    }
    ui.cafeList = buildElement("div", { className: "row-list" });
    ui.addCafeButton = buildElement("button", { className: "btn btn-ghost btn-small", attrs: { type: "button" } }, createIcon("cup"), "Add café item");
    ui.addCafeButton.addEventListener("click", () => addCafeRow(ui));
    // Who pays for the café (Phase 10) - shown only when the bill has café items
    const cafeRules = buildElement("div", { className: "segmented", attrs: { role: "radiogroup", "aria-label": "Who pays for the café" } },
        buildSegment("cafePayerRule", "loser", CAFE_PAYER_RULE_LABELS.loser, null, true),
        buildSegment("cafePayerRule", "consumer", CAFE_PAYER_RULE_LABELS.consumer, "each pays what they had", false),
        buildSegment("cafePayerRule", "split", CAFE_PAYER_RULE_LABELS.split, null, false));
    ui.cafeRuleBox = buildElement("div", { className: "cafe-rule" },
        buildElement("p", { className: "bill-section-title", text: "Who pays for the café" }), cafeRules);
    cafeSection.append(ui.cafeList, ui.addCafeButton, ui.cafeRuleBox);

    // --- Summary (server numbers) ---
    ui.summary = buildElement("section", { className: "bill-summary", attrs: { "aria-live": "polite", "aria-label": "Bill summary" } });

    // --- Buttons ---
    ui.laterButton = buildElement("button", { className: "btn btn-secondary", text: "Bill later", attrs: { type: "button" } });
    ui.createButton = buildElement("button", { className: "btn btn-primary", text: "Create Bill", attrs: { type: "submit", disabled: true } });

    ui.form.append(gameSection, playerSection, paySection, cafeSection, ui.summary,
        buildElement("div", { className: "modal-actions" }, ui.laterButton, ui.createButton));
    ui.dialog.append(ui.form);

    addPlayerRow(ui);
    addPlayerRow(ui);
    refreshConsumerOptions(ui);
    return ui;
}

// ---------- Café helpers (Phase 10) ----------

// "Who had it?": nobody, or one of the bill's players
function buildConsumerSelect(label, current = "") {
    const select = buildElement("select", { className: "select consumer-select", attrs: { "aria-label": label } },
        buildElement("option", { text: "Who had it?", attrs: { value: "" } }));
    select.dataset.wanted = current || ""; // a name typed on the tab, matched once the players are entered
    return select;
}

// Keeps every "who had it" list in step with the player names typed above
function refreshConsumerOptions(ui) {
    const names = [...ui.playerList.querySelectorAll(".player-row input")].map((input) => input.value.trim()).filter(Boolean);
    for (const select of ui.form.querySelectorAll(".consumer-select")) {
        const keep = select.value || select.dataset.wanted;
        select.replaceChildren(select.options[0], ...names.map((name) => buildElement("option", { text: name, attrs: { value: name } })));
        const match = names.find((name) => name.toLowerCase() === String(keep || "").toLowerCase());
        select.value = match || "";
    }
    syncCafeRule(ui);
}

// Show the café rule only when there are café items; follow the game rule until the user picks one
function syncCafeRule(ui) {
    const hasCafe = ui.tabRows.length > 0 || ui.cafeList.children.length > 0;
    ui.cafeRuleBox.hidden = !hasCafe;
    if (!ui.cafeRuleTouched) {
        const game = ui.form.elements.payerRule.value;
        ui.form.elements.cafePayerRule.value = game === "loser" ? "loser" : "split"; // "winner pays" has no café twin
    }
}

function buildSection(title, hint) {
    return buildElement("fieldset", { className: "bill-section" },
        buildElement("legend", { className: "bill-section-title", text: title }),
        hint ? buildElement("p", { className: "field-hint", text: hint }) : null
    );
}

// One option of a segmented control (radio button styled as a button)
function buildSegment(name, value, label, note, checked) {
    const input = buildElement("input", { attrs: { type: "radio", name, value, checked } });
    return buildElement("label", { className: "segment" },
        input,
        buildElement("span", { className: "segment-label", text: label }),
        note ? buildElement("span", { className: "segment-note", text: note }) : null
    );
}

function buildStepButton(icon, label, onClick) {
    const button = buildElement("button", { className: "btn btn-secondary btn-icon", attrs: { type: "button", "aria-label": label } }, createIcon(icon));
    button.addEventListener("click", onClick);
    return button;
}

function changeQuantity(ui, step) {
    const next = Math.min(100, Math.max(1, (Number(ui.quantityInput.value) || 1) + step));
    ui.quantityInput.value = next;
    ui.quantityInput.dispatchEvent(new Event("input", { bubbles: true }));
}

function addPlayerRow(ui) {
    const number = ui.playerList.children.length + 1;
    const name = buildElement("input", {
        className: "input",
        attrs: { type: "text", maxlength: "40", placeholder: `Player ${number}`, autocomplete: "off", "aria-label": `Player ${number} name` },
    });
    const result = buildElement("select", { className: "select", attrs: { "aria-label": `Player ${number} result` } },
        buildElement("option", { text: "—", attrs: { value: "" } }),
        buildElement("option", { text: "Winner", attrs: { value: "winner" } }),
        buildElement("option", { text: "Loser", attrs: { value: "loser" } })
    );
    const remove = buildRemoveButton(`Remove player ${number}`, () => {
        row.remove();
        updateRowButtons(ui);
        if (ui.cafeRuleBox) refreshConsumerOptions(ui); // the player can't be "who had it" any more
        ui.onListChange?.();
    });
    const row = buildElement("div", { className: "list-row player-row" }, name, result, remove);
    ui.playerList.append(row);
    updateRowButtons(ui);
    if (number > 2) name.focus();
    ui.onListChange?.();
}

// A café row: a product from the list (price + stock from the server) or a typed-in one-off item.
// The inputs stay in the same order as before Phase 10: name, quantity, price.
function addCafeRow(ui) {
    const description = buildElement("input", { className: "input cafe-typed-field", attrs: { type: "text", maxlength: "60", placeholder: "e.g. Tea", "aria-label": "Café item" } });
    const quantity = buildElement("input", { className: "input", attrs: { type: "number", min: "1", max: "99", value: "1", "aria-label": "Quantity" } });
    const price = buildElement("input", { className: "input cafe-typed-field", attrs: { type: "text", inputmode: "decimal", placeholder: "Rs each", "aria-label": "Price each (Rs)" } });
    const consumer = buildConsumerSelect("Who had it?");
    const remove = buildRemoveButton("Remove café item", () => {
        row.remove();
        updateRowButtons(ui);
        syncCafeRule(ui);
        ui.onListChange?.();
    });
    const parts = [];
    let productSelect = null;
    if (ui.products.length && typeof buildProductSelect === "function") {
        productSelect = buildProductSelect(ui.products);
        const firstOnSale = [...productSelect.options].find((o) => o.value && !o.disabled);
        if (firstOnSale) productSelect.value = firstOnSale.value;
        parts.push(productSelect);
    }
    const row = buildElement("div", { className: `list-row cafe-row${productSelect ? " has-products" : " is-typed"}` },
        ...parts, description, quantity, price, consumer, remove);
    if (productSelect) {
        // A product -> name and price come from the list; "Type in an item…" -> show the name and price boxes
        const syncMode = () => {
            const typed = !productSelect.value;
            description.hidden = !typed;
            price.hidden = !typed;
            row.classList.toggle("is-typed", typed);
        };
        productSelect.addEventListener("change", syncMode);
        syncMode();
    }
    ui.cafeList.append(row);
    updateRowButtons(ui);
    refreshConsumerOptions(ui);
    (productSelect || description).focus();
    ui.onListChange?.();
}

function buildRemoveButton(label, onClick) {
    const button = buildElement("button", { className: "btn btn-ghost btn-icon", attrs: { type: "button", "aria-label": label } }, createIcon("close"));
    button.addEventListener("click", onClick);
    return button;
}

// Players: at least 2 (remove buttons hidden), at most 4 (add button hidden)
function updateRowButtons(ui) {
    const playerRows = [...ui.playerList.children];
    playerRows.forEach((row) => (row.querySelector(".btn-icon").hidden = playerRows.length <= 2));
    ui.addPlayerButton.hidden = playerRows.length >= MAX_PLAYERS;
    ui.addCafeButton.hidden = ui.cafeList.children.length >= MAX_CAFE_ITEMS;
}

// ---------- Summary ----------

// true when the café is paid by a different rule than the game ("loser + loser" and
// "split + split" share the whole bill exactly like before Phase 10, so no breakdown is needed)
function hasSeparateCafeRule(bill) {
    return Boolean(bill.cafePayerRule) && bill.cafePayerRule !== bill.payerRule;
}

function showSummaryMessage(ui, text, busy = false) {
    ui.summary.replaceChildren(
        buildElement("p", { className: busy ? "summary-note" : "summary-note is-warning" },
            busy ? buildElement("span", { className: "spinner", attrs: { "aria-hidden": "true" } }) : null, text)
    );
}

function renderSummary(ui, bill) {
    const lines = buildElement("dl", { className: "summary-lines" });
    const addLine = (label, amount, className) => {
        lines.append(buildElement("div", { className: className || "summary-line" },
            buildElement("dt", { text: label }), buildElement("dd", { text: formatMoney(amount) })));
    };

    for (const item of bill.lineItems) {
        addLine(`${item.description} × ${item.quantity} @ ${formatMoney(item.unitPrice)}${item.consumer ? ` (${item.consumer})` : ""}`, item.amount);
    }
    if (bill.taxEnabled) {
        addLine("Subtotal", bill.subtotal, "summary-line is-sub");
        addLine(`Tax (${formatPercent(bill.taxRateBasisPoints)})`, bill.taxAmount, "summary-line is-sub");
    }
    addLine("Total", bill.total, "summary-line is-total");

    // When the café is paid differently from the game, each share also shows its game and café parts
    const showParts = hasSeparateCafeRule(bill);
    const shares = buildElement("ul", { className: "summary-shares" },
        ...bill.players.map((player) => buildElement("li", { className: player.shareAmount > 0 ? "" : "is-zero" },
            buildElement("span", { text: player.name }),
            showParts ? buildElement("span", { className: "share-parts", text: `game ${formatMoney(player.gameShare)} + café ${formatMoney(player.cafeShare)}` }) : null,
            buildElement("strong", { text: formatMoney(player.shareAmount) })))
    );

    const caption = [PAYER_RULE_LABELS[bill.payerRule]];
    if (showParts) caption.push(`Café: ${CAFE_PAYER_RULE_LABELS[bill.cafePayerRule]}`);
    caption.push(`Billed time ${formatMinutes(bill.billedMinutes)}`);
    ui.summary.replaceChildren(
        lines,
        buildElement("p", { className: "summary-caption", text: caption.join(" · ") }),
        shares
    );
}
