// billing.js (page) - bill history, bill details, payments, cancel and printed receipt.
// Uses: apiRequest (api.js), buildElement/createIcon/showToast/confirmDialog/setButtonLoading (ui.js),
//       formatMoney/parseMoneyInput/paisaToInput/formatDateTime/formatDuration/formatMinutes/formatPercent/
//       todayInClub and the *_LABELS lists (format.js)

const PAGE_SIZE = 20;

// ---------- Page elements ----------
const statusFilter = document.getElementById("status-filter");
const filters = document.getElementById("bill-filters");
const fromInput = document.getElementById("filter-from");
const toInput = document.getElementById("filter-to");
const searchInput = document.getElementById("filter-search");
const filterError = document.getElementById("filter-error");
const loadingBox = document.getElementById("bills-loading");
const emptyBox = document.getElementById("bills-empty");
const tableWrapper = document.getElementById("bills-wrapper");
const billsBody = document.getElementById("bills-body");
const billsSummary = document.getElementById("bills-summary");
const pagination = document.getElementById("bills-pagination");
const pageInfo = document.getElementById("page-info");
const prevButton = document.getElementById("page-prev");
const nextButton = document.getElementById("page-next");
const billDialog = document.getElementById("bill-dialog");
const billDetail = document.getElementById("bill-detail");
const printReceipt = document.getElementById("print-receipt");

// ---------- State ----------
let selectedStatus = "";
let currentPage = 1;
let searchTimer = null;
let latestRequest = 0;

// ---------- Bill list ----------

function showList(element) {
    for (const box of [loadingBox, emptyBox, tableWrapper]) box.hidden = box !== element;
}

function showEmpty(title, text) {
    document.getElementById("bills-empty-title").textContent = title;
    document.getElementById("bills-empty-text").textContent = text;
    pagination.hidden = true;
    billsSummary.textContent = "";
    showList(emptyBox);
}

async function loadBills({ quiet = false } = {}) {
    const from = fromInput.value;
    const to = toInput.value;
    if (from && to && to < from) {
        filterError.textContent = "The To date cannot be before the From date.";
        filterError.hidden = false;
        return;
    }
    filterError.hidden = true;

    const params = new URLSearchParams({ page: currentPage, limit: PAGE_SIZE });
    if (selectedStatus) params.set("status", selectedStatus);
    if (from) params.set("from", from);
    if (to) params.set("to", to);
    const search = searchInput.value.trim();
    if (search) params.set("search", search);

    const requestNumber = ++latestRequest;
    if (!quiet) showList(loadingBox);

    try {
        const { data } = await apiRequest(`/bills?${params}`);
        if (requestNumber !== latestRequest) return;
        if (data.bills.length === 0 && data.total > 0 && currentPage > data.totalPages) {
            currentPage = data.totalPages;
            return loadBills({ quiet });
        }
        renderBills(data, Boolean(selectedStatus || from || to || search));
    } catch (error) {
        if (requestNumber !== latestRequest) return;
        showEmpty("Could not load bills", error.message);
        showToast(error.message, "error");
    }
}

function renderBills(data, isFiltering) {
    if (data.total === 0) {
        if (isFiltering) showEmpty("No matching bills", "Try another status, date or search.");
        else showEmpty("No bills yet", "End a session to create the first bill.");
        return;
    }

    billsBody.replaceChildren(...data.bills.map(createBillRow));
    billsSummary.textContent = data.total === 1 ? "1 bill" : `${data.total} bills`;
    pagination.hidden = data.totalPages <= 1;
    pageInfo.textContent = `Page ${data.page} of ${data.totalPages}`;
    prevButton.disabled = data.page <= 1;
    nextButton.disabled = data.page >= data.totalPages;
    showList(tableWrapper);
}

function cell(label, ...children) {
    return buildElement("td", { attrs: { "data-label": label } }, ...children);
}

function moneyCell(label, amount) {
    return buildElement("td", { className: "numeric", text: formatMoney(amount), attrs: { "data-label": label } });
}

function createBillRow(bill) {
    const viewButton = buildElement("button", { className: "btn btn-secondary btn-small", text: "View", attrs: { type: "button", "aria-label": `View bill ${bill.billNumber}` } });
    viewButton.addEventListener("click", () => openBill(bill.id));

    return buildElement("tr", { attrs: { "data-bill-id": bill.id } },
        cell("Bill",
            buildElement("span", { className: "cell-title", text: bill.billNumber }),
            buildElement("span", { className: "cell-sub", text: formatDateTime(bill.createdAt) })),
        cell("Table", `${bill.tableNumber}${bill.tableName ? ` · ${bill.tableName}` : ""}`),
        // Match bills (Phase 11.5): "Frame · match #2"; bills for a whole session: "Frame × 2"
        cell("Game", bill.matchNumber ? `${gameModeLabel(bill.gameMode)} · match #${bill.matchNumber}` : `${gameModeLabel(bill.gameMode)} × ${bill.quantity}`),
        moneyCell("Total", bill.total),
        moneyCell("Paid", bill.amountPaid),
        moneyCell("Balance", bill.balanceDue),
        cell("Status", buildElement("span", { className: `status-badge status-${bill.status}`, text: BILL_STATUS_LABELS[bill.status] })),
        buildElement("td", { className: "actions-cell" }, viewButton)
    );
}

// ---------- Bill detail ----------

async function openBill(billId) {
    try {
        const { data } = await apiRequest(`/bills/${billId}`);
        await currentUserReady; // the buttons shown depend on the user's role
        renderDetail(data);
        if (!billDialog.open) billDialog.showModal();
        history.replaceState(null, "", `?bill=${billId}`); // the address can be shared / refreshed
    } catch (error) {
        showToast(error.message, "error");
    }
}

function closeBill() {
    if (billDialog.open) billDialog.close();
}

billDialog.addEventListener("close", () => history.replaceState(null, "", location.pathname));

function renderDetail(bill) {
    const closeButton = buildElement("button", { className: "btn btn-ghost btn-icon", attrs: { type: "button", "aria-label": "Close" } }, createIcon("close"));
    closeButton.addEventListener("click", closeBill);

    const header = buildElement("header", { className: "bill-detail-header" },
        buildElement("div", {},
            buildElement("h2", { className: "modal-title", text: `Bill ${bill.billNumber}`, attrs: { id: "bill-title" } }),
            buildElement("p", { className: "modal-subtitle", text: formatDateTime(bill.createdAt) })),
        buildElement("span", { className: `status-badge status-${bill.status}`, text: BILL_STATUS_LABELS[bill.status] }),
        closeButton);

    // Phase 11.5: a bill made for one match says which (bills for a whole session have no match)
    const matchText = bill.matchNumber
        ? `#${bill.matchNumber} · ${gameModeLabel(bill.gameMode)}${bill.winningTeam ? ` · Team ${bill.winningTeam} won` : ""}`
        : null;
    const facts = buildElement("dl", { className: "fact-grid" },
        matchText ? fact("Match", matchText) : null,
        fact("Table", `${bill.tableNumber}${bill.tableName ? ` · ${bill.tableName}` : ""}`),
        fact("Session", `${formatDateTime(bill.sessionStartedAt)} – ${formatDateTime(bill.sessionEndedAt)}`),
        fact("Played", formatDuration(bill.durationSeconds)),
        fact("Billed time", formatMinutes(bill.billedMinutes)),
        fact("Who pays", PAYER_RULE_LABELS[bill.payerRule]),
        bill.cafePayerRule && bill.cafePayerRule !== bill.payerRule ? fact("Café paid by", CAFE_PAYER_RULE_LABELS[bill.cafePayerRule]) : null);

    // .filter(Boolean) drops the parts that don't apply (replaceChildren would print "null")
    billDetail.replaceChildren(...[
        header,
        facts,
        sectionTitle("Charges"),
        buildChargesTable(bill),
        sectionTitle("Players"),
        buildPlayersTable(bill),
        sectionTitle("Payments"),
        buildPaymentsList(bill),
        canRecordPayment(bill) ? buildPaymentForm(bill) : null,
        canTakePayment(bill) && !userCan("payments:record")
            ? buildElement("p", { className: "field-hint", text: "Your role can view payments but not record them. Ask a cashier or admin." })
            : null,
        bill.status === "cancelled" ? buildElement("p", { className: "form-note", text: `Cancelled ${formatDateTime(bill.cancelledAt)}${byWhom(bill.cancelledBy)}${bill.cancelReason ? ` · ${bill.cancelReason}` : ""}` }) : null,
        bill.createdBy ? buildElement("p", { className: "audit-line", text: `Bill created${byWhom(bill.createdBy)}` }) : null,
        buildDetailActions(bill),
    ].filter(Boolean));
}

// " by Ali (ali)" from a saved who-did-it snapshot; empty for records made before logins existed
function byWhom(actor) {
    return actor && actor.name ? ` by ${actor.name} (${actor.username})` : "";
}

function fact(label, value) {
    return buildElement("div", {}, buildElement("dt", { text: label }), buildElement("dd", { text: value }));
}

function sectionTitle(text) {
    return buildElement("h3", { className: "detail-section-title", text });
}

function buildChargesTable(bill) {
    const rows = bill.lineItems.map((item) => buildElement("tr", {},
        buildElement("td", { text: item.type === "cafe" ? `${item.description} (café${item.consumer ? `, ${item.consumer}` : ""})` : item.description }),
        buildElement("td", { className: "numeric", text: `${item.quantity} × ${formatMoney(item.unitPrice)}` }),
        buildElement("td", { className: "numeric", text: formatMoney(item.amount) })));

    const totalRow = (label, amount, className) => buildElement("tr", { className },
        buildElement("td", { text: label, attrs: { colspan: "2" } }), buildElement("td", { className: "numeric", text: formatMoney(amount) }));

    const foot = [];
    if (bill.taxEnabled) {
        foot.push(totalRow("Subtotal", bill.subtotal, "row-sub"), totalRow(`Tax (${formatPercent(bill.taxRateBasisPoints)})`, bill.taxAmount, "row-sub"));
    }
    foot.push(totalRow("Total", bill.total, "row-total"), totalRow("Paid", bill.amountPaid, "row-sub"), totalRow("Balance due", bill.balanceDue, "row-balance"));

    return buildElement("table", { className: "detail-table" }, buildElement("tbody", {}, ...rows), buildElement("tfoot", {}, ...foot));
}

function buildPlayersTable(bill) {
    const head = buildElement("tr", {}, ...["Player", "Share", "Paid", "Remaining"].map((text, i) =>
        buildElement("th", { className: i ? "numeric" : "", text, attrs: { scope: "col" } })));
    const rows = bill.players.map((player) => {
        // Match bills of 4 Players also say the team ("Loser · Team 2")
        const resultText = [player.result ? (player.result === "winner" ? "Winner" : "Loser") : "", player.team ? `Team ${player.team}` : ""].filter(Boolean).join(" · ");
        const resultTag = resultText ? buildElement("span", { className: "player-result", text: resultText }) : null;
        return buildElement("tr", {},
            buildElement("td", {}, player.name, resultTag),
            buildElement("td", { className: "numeric" }, formatMoney(player.shareAmount),
                // Phase 10: a separate café payer rule -> show both parts
                bill.cafePayerRule && bill.cafePayerRule !== bill.payerRule
                    ? buildElement("span", { className: "cell-sub", text: `game ${formatMoney(player.gameShare)} + café ${formatMoney(player.cafeShare)}` }) : null),
            buildElement("td", { className: "numeric", text: formatMoney(player.paidAmount) }),
            buildElement("td", { className: "numeric", text: formatMoney(bill.status === "cancelled" ? 0 : player.shareAmount - player.paidAmount) }));
    });
    return buildElement("table", { className: "detail-table" }, buildElement("thead", {}, head), buildElement("tbody", {}, ...rows));
}

function buildPaymentsList(bill) {
    if (bill.payments.length === 0) return buildElement("p", { className: "field-hint", text: "No payments yet." });
    return buildElement("ul", { className: "payment-list" }, ...bill.payments.map((payment) =>
        buildElement("li", {},
            buildElement("span", { className: "payment-main", text: `${payment.payerName} · ${PAYMENT_METHOD_LABELS[payment.method]}` }),
            buildElement("span", { className: "payment-meta", text: `${formatDateTime(payment.paidAt)}${payment.receivedBy ? ` · received by ${payment.receivedBy.name}` : ""}${payment.note ? ` · ${payment.note}` : ""}` }),
            buildElement("strong", { className: "payment-amount", text: formatMoney(payment.amount) }))));
}

function canTakePayment(bill) {
    return bill.status === "unpaid" || bill.status === "partially_paid";
}

// The payment form is only shown to roles that may record payments (the server checks too)
function canRecordPayment(bill) {
    return canTakePayment(bill) && userCan("payments:record");
}

// ---------- Record a payment ----------

function buildPaymentForm(bill) {
    const owing = bill.players.filter((player) => player.shareAmount - player.paidAmount > 0);
    const remainingFor = (name) => {
        const player = bill.players.find((p) => p.name === name);
        return player.shareAmount - player.paidAmount;
    };

    const payerSelect = buildElement("select", { className: "select", attrs: { id: "pay-payer", name: "payerName" } },
        ...owing.map((player) => buildElement("option", { text: `${player.name} (owes ${formatMoney(player.shareAmount - player.paidAmount)})`, attrs: { value: player.name } })));
    const amountInput = buildElement("input", { className: "input", attrs: { id: "pay-amount", name: "amount", type: "text", inputmode: "decimal", autocomplete: "off" } });
    const methodSelect = buildElement("select", { className: "select", attrs: { id: "pay-method", name: "method" } },
        ...Object.entries(PAYMENT_METHOD_LABELS).map(([value, label]) => buildElement("option", { text: label, attrs: { value } })));
    const noteInput = buildElement("input", { className: "input", attrs: { id: "pay-note", name: "note", type: "text", maxlength: "120", placeholder: "Optional" } });
    const error = buildElement("p", { className: "form-error", attrs: { role: "alert", hidden: true } });
    const saveButton = buildElement("button", { className: "btn btn-primary", text: "Save payment", attrs: { type: "submit" } });

    // Amount starts as what the chosen player still owes (staff can type less for a part payment)
    const fillAmount = () => (amountInput.value = paisaToInput(remainingFor(payerSelect.value)));
    payerSelect.addEventListener("change", fillAmount);
    fillAmount();

    const form = buildElement("form", { className: "payment-form", attrs: { novalidate: true, "aria-label": "Record a payment" } },
        buildElement("h3", { className: "detail-section-title", text: "Record payment" }),
        error,
        buildElement("div", { className: "payment-grid" },
            labelled("Player", payerSelect),
            labelled("Amount (Rs)", amountInput),
            labelled("Method", methodSelect),
            labelled("Note", noteInput)),
        buildElement("div", { className: "modal-actions" }, saveButton));

    form.addEventListener("submit", async (event) => {
        event.preventDefault();
        error.hidden = true;
        const amount = parseMoneyInput(amountInput.value);
        if (!amount) {
            error.textContent = "Enter an amount like 150 or 150.50";
            error.hidden = false;
            amountInput.focus();
            return;
        }
        setButtonLoading(saveButton, true, "Saving…");
        try {
            const { message } = await apiRequest(`/bills/${bill.id}/payments`, {
                method: "POST",
                body: { amount, method: methodSelect.value, payerName: payerSelect.value, note: noteInput.value.trim() },
            });
            showToast(message);
            await Promise.all([openBill(bill.id), loadBills({ quiet: true })]);
        } catch (err) {
            error.textContent = err.message; // e.g. "Payment of Rs 600.00 is more than the remaining balance of Rs 300.00"
            error.hidden = false;
            setButtonLoading(saveButton, false);
        }
    });
    return form;
}

function labelled(text, control) {
    return buildElement("div", { className: "form-field" }, buildElement("label", { text, attrs: { for: control.id } }), control);
}

// ---------- Print & cancel ----------

function buildDetailActions(bill) {
    const printButton = buildElement("button", { className: "btn btn-secondary", attrs: { type: "button" } }, createIcon("print"), "Print receipt");
    printButton.addEventListener("click", () => printBill(bill));

    let cancelButton = null;
    if (bill.status === "unpaid" && bill.amountPaid === 0 && userCan("bills:cancel")) {
        cancelButton = buildElement("button", { className: "btn btn-ghost is-danger", text: "Cancel bill", attrs: { type: "button" } });
        cancelButton.addEventListener("click", async () => {
            const confirmed = await confirmDialog(`Bill ${bill.billNumber} (${formatMoney(bill.total)}) will be marked as cancelled. It stays in the history.`,
                { title: "Cancel this bill?", confirmText: "Cancel Bill", cancelText: "Keep bill", danger: true });
            if (!confirmed) return;
            try {
                const { message } = await apiRequest(`/bills/${bill.id}/cancel`, { method: "POST", body: {} });
                showToast(message);
                await Promise.all([openBill(bill.id), loadBills({ quiet: true })]);
            } catch (err) {
                showToast(err.message, "error", 6000);
            }
        });
    }
    return buildElement("div", { className: "modal-actions detail-actions" }, cancelButton, printButton);
}

// Builds a simple paper receipt and opens the browser's print window
function printBill(bill) {
    const line = (label, value, className) => buildElement("div", { className: `receipt-line ${className || ""}` },
        buildElement("span", { text: label }), buildElement("span", { text: value }));

    printReceipt.replaceChildren(...[
        buildElement("h1", { text: "Snooker Club Pro" }),
        buildElement("p", { text: `Bill ${bill.billNumber}` }),
        buildElement("p", { text: formatDateTime(bill.createdAt) }),
        buildElement("p", { text: `Table ${bill.tableNumber}${bill.tableName ? ` · ${bill.tableName}` : ""}` }),
        bill.matchNumber ? buildElement("p", { text: `Match #${bill.matchNumber} · ${gameModeLabel(bill.gameMode)}` }) : null,
        buildElement("p", { text: `Played ${formatDuration(bill.durationSeconds)} · Billed ${formatMinutes(bill.billedMinutes)}` }),
        buildElement("hr"),
        ...bill.lineItems.map((item) => line(`${item.description} ${item.quantity} × ${formatMoney(item.unitPrice)}`, formatMoney(item.amount))),
        buildElement("hr"),
        bill.taxEnabled ? line("Subtotal", formatMoney(bill.subtotal)) : null,
        bill.taxEnabled ? line(`Tax ${formatPercent(bill.taxRateBasisPoints)}`, formatMoney(bill.taxAmount)) : null,
        line("TOTAL", formatMoney(bill.total), "is-total"),
        line("Paid", formatMoney(bill.amountPaid)),
        line("Balance", formatMoney(bill.balanceDue)),
        buildElement("hr"),
        buildElement("p", { text: PAYER_RULE_LABELS[bill.payerRule] }),
        ...bill.players.map((player) => line(player.name, formatMoney(player.shareAmount))),
        buildElement("p", { className: "receipt-status", text: BILL_STATUS_LABELS[bill.status].toUpperCase() }),
        buildElement("p", { text: "Thank you for playing!" }),
    ].filter(Boolean));
    window.print();
}

// ---------- Rates warning ----------

async function checkRates() {
    try {
        // Every game mode that can be billed needs its rate (the list comes from the registry)
        const modes = await loadGameModes();
        document.getElementById("rates-warning").hidden = modes.filter((mode) => mode.enabled).every((mode) => mode.rateSet);
    } catch {
        // not critical
    }
}

// ---------- Events ----------

statusFilter.addEventListener("click", (event) => {
    const chip = event.target.closest(".chip");
    if (!chip) return;
    selectedStatus = chip.dataset.status;
    statusFilter.querySelectorAll(".chip").forEach((c) => c.setAttribute("aria-pressed", String(c === chip)));
    currentPage = 1;
    loadBills();
});

filters.addEventListener("change", (event) => {
    if (event.target === searchInput) return;
    currentPage = 1;
    loadBills();
});
filters.addEventListener("submit", (event) => event.preventDefault());
searchInput.addEventListener("input", () => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => {
        currentPage = 1;
        loadBills();
    }, 300);
});

document.getElementById("filter-today").addEventListener("click", () => {
    fromInput.value = todayInClub();
    toInput.value = todayInClub();
    currentPage = 1;
    loadBills();
});
document.getElementById("filter-clear").addEventListener("click", () => {
    filters.reset();
    currentPage = 1;
    loadBills();
});
prevButton.addEventListener("click", () => {
    currentPage -= 1;
    loadBills();
});
nextButton.addEventListener("click", () => {
    currentPage += 1;
    loadBills();
});

// ---------- Start ----------

// Links from the dashboard: ?status=unpaid  and  ?from=2026-10-05&to=2026-10-05
const startAddress = new URLSearchParams(location.search);
const startChip = statusFilter.querySelector(`.chip[data-status="${startAddress.get("status") || ""}"]`);
if (startChip) {
    selectedStatus = startChip.dataset.status;
    statusFilter.querySelectorAll(".chip").forEach((c) => c.setAttribute("aria-pressed", String(c === startChip)));
}
if (/^\d{4}-\d{2}-\d{2}$/.test(startAddress.get("from") || "")) fromInput.value = startAddress.get("from");
if (/^\d{4}-\d{2}-\d{2}$/.test(startAddress.get("to") || "")) toInput.value = startAddress.get("to");

loadBills();
checkRates();

// Opened from a link like /pages/billing.html?bill=<id> (e.g. from the session history)
const billFromAddress = new URLSearchParams(location.search).get("bill");
if (billFromAddress) openBill(billFromAddress);
