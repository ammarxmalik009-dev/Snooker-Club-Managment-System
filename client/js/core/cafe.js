// cafe.js (core) - café helpers shared by the bill window (core/billing.js), the session tab
// (Sessions page, Dashboard, Tables page) and the Products page.
// The browser never decides prices or stock: the server copies the price and checks the stock.
// Uses: apiRequest (api.js), buildElement/createIcon/showToast/setButtonLoading (ui.js),
//       formatMoney/parseMoneyInput (format.js), userCan (layout.js)

// Products that can be sold now (active), with the free stock (stock minus items on open tabs)
async function fetchSellableProducts() {
    const { data } = await apiRequest("/products?status=active");
    return data;
}

// "5 left" / "out of stock" / "made to order"
function productStockText(product) {
    if (!product.trackStock) return "made to order";
    return product.availableQuantity > 0 ? `${product.availableQuantity} left` : "out of stock";
}

// A <select> of products grouped by category. Products that are out of stock can't be chosen.
// typeInLabel: an extra first option for a typed-in one-off item (value "").
function buildProductSelect(products, { typeInLabel = "Type in an item…", label = "Café product" } = {}) {
    const select = buildElement("select", { className: "select product-select", attrs: { "aria-label": label } });
    if (typeInLabel) select.append(buildElement("option", { text: typeInLabel, attrs: { value: "" } }));
    const groups = new Map();
    for (const product of products) {
        const name = product.category ? product.category.name : "Other";
        if (!groups.has(name)) groups.set(name, []);
        groups.get(name).push(product);
    }
    for (const [name, list] of [...groups.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
        const group = buildElement("optgroup", { attrs: { label: name } });
        for (const product of list) {
            const soldOut = product.trackStock && product.availableQuantity <= 0;
            group.append(buildElement("option", {
                text: `${product.name} · ${formatMoney(product.price)} · ${productStockText(product)}`,
                attrs: { value: product.id, disabled: soldOut },
            }));
        }
        select.append(group);
    }
    return select;
}

// ---------- The session tab ----------

// Opens the café tab of a session (running, or ended but not billed yet). Resolves when closed.
async function openCafeTabDialog(session) {
    const ui = { dialog: buildElement("dialog", { className: "modal modal-wide cafe-tab-dialog", attrs: { "aria-labelledby": "cafe-tab-title" } }) };
    const content = buildElement("div", { className: "modal-content" });
    ui.dialog.append(content);
    document.body.append(ui.dialog);

    const close = buildElement("button", { className: "btn btn-secondary", text: "Close", attrs: { type: "button" } });
    const error = buildElement("p", { className: "form-error", attrs: { role: "alert", hidden: true } });
    const list = buildElement("div", { className: "cafe-tab-list" });
    const totalLine = buildElement("p", { className: "cafe-tab-total" });
    const addArea = buildElement("div", { className: "cafe-tab-add" });
    content.append(
        buildElement("h2", { className: "modal-title", text: `Café · Table ${session.tableNumber}`, attrs: { id: "cafe-tab-title" } }),
        buildElement("p", { className: "modal-subtitle", text: "Items on this tab go onto the bill when the session is billed. Stock is taken off then." }),
        error, list, totalLine, addArea,
        buildElement("div", { className: "modal-actions" }, close));

    const showError = (message) => {
        error.textContent = message;
        error.hidden = !message;
    };
    const canSell = typeof userCan !== "function" || userCan("cafe:sell");
    let products = [];

    async function refresh() {
        let tab;
        try {
            [tab, products] = await Promise.all([
                apiRequest(`/sessions/${session.id}/cafe-items`).then((r) => r.data),
                fetchSellableProducts().catch(() => []),
            ]);
        } catch (err) {
            showError(err.message);
            return;
        }
        renderItems(tab);
        renderAddForm(tab);
    }

    function renderItems(tab) {
        if (tab.items.length === 0) {
            list.replaceChildren(buildElement("p", { className: "field-hint", text: "Nothing on this tab yet." }));
        } else {
            list.replaceChildren(...tab.items.map((item) => buildItemRow(item, tab)));
        }
        totalLine.textContent = tab.billed
            ? `Billed on ${tab.bill.billNumber}.`
            : `Open on the tab: ${formatMoney(tab.openTotal)} (${tab.openCount} item${tab.openCount === 1 ? "" : "s"})`;
    }

    function buildItemRow(item, tab) {
        const editable = canSell && item.status === "open" && !tab.billed;
        const amount = buildElement("strong", { className: "cafe-tab-amount", text: formatMoney(item.quantity * item.unitPrice) });
        const name = buildElement("span", { className: "cafe-tab-name" },
            buildElement("strong", { text: item.description }),
            buildElement("span", { className: "cell-sub", text: `${formatMoney(item.unitPrice)} each${item.categoryName ? ` · ${item.categoryName}` : ""}${item.addedBy ? ` · by ${item.addedBy.name}` : ""}` }));
        if (!editable) {
            return buildElement("div", { className: "list-row cafe-tab-row" }, name,
                buildElement("span", { text: `× ${item.quantity}` }),
                buildElement("span", { className: "cell-sub", text: item.consumer || "—" }), amount,
                buildElement("span", { className: "status-badge", text: item.status === "billed" ? "Billed" : capitalize(item.status) }));
        }
        const quantity = buildElement("input", { className: "input cafe-qty", attrs: { type: "number", min: "1", max: "99", value: String(item.quantity), "aria-label": `Quantity of ${item.description}` } });
        const consumer = buildElement("input", { className: "input cafe-consumer", attrs: { type: "text", maxlength: "60", value: item.consumer, placeholder: "Who had it?", "aria-label": `Who had ${item.description}` } });
        const save = async (changes) => {
            showError("");
            try {
                await apiRequest(`/sessions/${session.id}/cafe-items/${item.id}`, { method: "PATCH", body: changes });
                await refresh();
            } catch (err) {
                showError(err.message);
                await refresh();
            }
        };
        quantity.addEventListener("change", () => save({ quantity: Number(quantity.value) }));
        consumer.addEventListener("change", () => save({ consumer: consumer.value.trim() }));
        const remove = buildElement("button", { className: "btn btn-ghost btn-icon", attrs: { type: "button", "aria-label": `Remove ${item.description}` } }, createIcon("close"));
        remove.addEventListener("click", async () => {
            showError("");
            try {
                const { message } = await apiRequest(`/sessions/${session.id}/cafe-items/${item.id}`, { method: "DELETE" });
                showToast(message);
            } catch (err) {
                showError(err.message);
            }
            await refresh();
        });
        return buildElement("div", { className: "list-row cafe-tab-row" }, name, quantity, consumer, amount, remove);
    }

    function renderAddForm(tab) {
        if (tab.billed || !canSell) {
            addArea.replaceChildren();
            return;
        }
        const select = buildProductSelect(products);
        const quantity = buildElement("input", { className: "input cafe-qty", attrs: { type: "number", min: "1", max: "99", value: "1", "aria-label": "Quantity" } });
        const consumer = buildElement("input", { className: "input cafe-consumer", attrs: { type: "text", maxlength: "60", placeholder: "Who had it? (optional)", "aria-label": "Who had it" } });
        const description = buildElement("input", { className: "input", attrs: { type: "text", maxlength: "60", placeholder: "Item name", "aria-label": "Item name" } });
        const price = buildElement("input", { className: "input", attrs: { type: "text", inputmode: "decimal", placeholder: "Rs each", "aria-label": "Price each (Rs)" } });
        const typed = buildElement("div", { className: "cafe-typed" }, description, price);
        const add = buildElement("button", { className: "btn btn-primary", attrs: { type: "submit" } }, createIcon("plus"), "Add to tab");
        // Start with the first product that can be sold (typing in is the exception)
        const firstOnSale = [...select.options].find((o) => o.value && !o.disabled);
        if (firstOnSale) select.value = firstOnSale.value;
        const syncMode = () => (typed.hidden = Boolean(select.value));
        select.addEventListener("change", syncMode);
        syncMode();

        const form = buildElement("form", { className: "cafe-add-form", attrs: { novalidate: true, "aria-label": "Add a café item" } },
            select, typed, quantity, consumer, add);
        form.addEventListener("submit", async (event) => {
            event.preventDefault();
            showError("");
            const body = { quantity: Number(quantity.value), consumer: consumer.value.trim() };
            if (select.value) {
                body.productId = select.value;
            } else {
                body.description = description.value.trim();
                body.unitPrice = parseMoneyInput(price.value);
                if (!body.description) return showError("Type the item's name, or choose a product.");
                if (body.unitPrice === null) return showError("Enter a price like 80 or 80.50.");
            }
            setButtonLoading(add, true, "Adding…");
            try {
                const { message } = await apiRequest(`/sessions/${session.id}/cafe-items`, { method: "POST", body });
                showToast(message);
                await refresh();
            } catch (err) {
                showError(err.message); // e.g. "Only 1 Cola available"
                setButtonLoading(add, false);
            }
        });
        addArea.replaceChildren(buildElement("h3", { className: "bill-section-title", text: "Add an item" }), form);
    }

    return new Promise((resolve) => {
        const finish = () => {
            if (ui.dialog.open) ui.dialog.close();
            ui.dialog.remove();
            resolve();
        };
        close.addEventListener("click", finish);
        ui.dialog.addEventListener("close", finish);
        ui.dialog.showModal();
        list.replaceChildren(buildElement("p", { className: "field-hint" }, buildElement("span", { className: "spinner", attrs: { "aria-hidden": "true" } }), " Loading…"));
        refresh();
    });
}
