// products.js (page) - café products: list, search/filter, add/edit (admin), restock (admin+staff),
// adjust/waste (admin), stock history. Every number comes from the server; buttons a role can't
// use are hidden, and the server refuses them anyway (403).
// Uses: apiRequest (api.js), buildElement/createIcon/showToast/confirmDialog/setButtonLoading (ui.js),
//       formatMoney/parseMoneyInput/paisaToInput/formatDateTime/STOCK_MOVEMENT_LABELS (format.js),
//       currentUserReady/userCan (layout.js), productStockText (core/cafe.js)

const productsList = document.getElementById("products-list");
const productsSummary = document.getElementById("products-summary");
const productSearch = document.getElementById("product-search");
const categoryFilter = document.getElementById("category-filter");
const statusFilter = document.getElementById("status-filter");
const lowStockOnly = document.getElementById("low-stock-only");
const lowStockAlert = document.getElementById("low-stock-alert");

const productDialog = document.getElementById("product-dialog");
const productForm = document.getElementById("product-form");
const productFormError = document.getElementById("product-form-error");
const productSave = document.getElementById("product-save");
const stockDialog = document.getElementById("stock-dialog");
const stockForm = document.getElementById("stock-form");
const stockFormError = document.getElementById("stock-form-error");
const stockSave = document.getElementById("stock-save");
const historyDialog = document.getElementById("history-dialog");

let categories = [];
let editingProduct = null;
let stockAction = null; // { product, kind: "restock" | "adjust" }
let selectedStatus = "active";
let productSearchTimer = null;
let productRequest = 0;

// ---------- Loading ----------

async function loadCategoryOptions() {
    try {
        categories = (await apiRequest("/categories")).data;
    } catch (error) {
        showToast(`Couldn't load categories: ${error.message}`, "error");
        categories = [];
    }
    const keep = categoryFilter.value || new URLSearchParams(location.search).get("categoryId") || "";
    categoryFilter.replaceChildren(categoryFilter.options[0],
        ...categories.map((c) => buildElement("option", { text: c.name, attrs: { value: c.id } })));
    categoryFilter.value = categories.some((c) => c.id === keep) ? keep : "";
}

async function loadProducts() {
    const params = new URLSearchParams({ status: selectedStatus });
    if (productSearch.value.trim()) params.set("search", productSearch.value.trim());
    if (categoryFilter.value) params.set("categoryId", categoryFilter.value);
    if (lowStockOnly.checked) params.set("lowStock", "true");
    const number = ++productRequest;
    try {
        const { data } = await apiRequest(`/products?${params}`);
        if (number !== productRequest) return;
        renderProducts(data);
    } catch (error) {
        if (number !== productRequest) return;
        productsList.replaceChildren(productEmpty("Could not load products", error.message));
    }
    loadLowStockAlert();
}

// The warning counts ALL active products, whatever filter is chosen
async function loadLowStockAlert() {
    try {
        const { data } = await apiRequest("/products?status=active&lowStock=true");
        const out = data.filter((p) => p.stockQuantity === 0).length;
        lowStockAlert.hidden = data.length === 0;
        lowStockAlert.textContent = data.length === 0 ? "" :
            `${data.length} product${data.length === 1 ? " is" : "s are"} low on stock${out ? ` (${out} out of stock)` : ""}: ${data.map((p) => `${p.name} (${p.stockQuantity})`).join(", ")}.`;
    } catch {
        lowStockAlert.hidden = true;
    }
}

function productEmpty(title, text) {
    return buildElement("div", { className: "empty-state panel-empty" },
        buildElement("span", { className: "empty-state-icon" }, createIcon("cup")),
        buildElement("p", { className: "empty-state-title", text: title }),
        buildElement("p", { text }));
}

// ---------- List ----------

function stockBadges(product) {
    const badges = [];
    if (product.status === "inactive") badges.push(buildElement("span", { className: "badge", text: "Inactive" }));
    if (product.trackStock && product.stockQuantity === 0) badges.push(buildElement("span", { className: "badge badge-danger", text: "Out of stock" }));
    else if (product.isLowStock) badges.push(buildElement("span", { className: "badge badge-warning", text: "Low stock" }));
    return badges;
}

function renderProducts(products) {
    productsSummary.textContent = products.length === 1 ? "1 product" : `${products.length} products`;
    if (products.length === 0) {
        const filtered = productSearch.value.trim() || categoryFilter.value || lowStockOnly.checked || selectedStatus !== "active";
        productsList.replaceChildren(filtered
            ? productEmpty("No matching products", "Try another search or filter.")
            : productEmpty("No products yet", userCan("products:manage") ? "Add a category first, then your products." : "An admin can add products."));
        return;
    }
    const head = buildElement("tr", {}, ...[["Product"], ["Price", true], ["Stock", true], ["Free to sell", true], ["Status"], [""]].map(([text, numeric]) =>
        buildElement("th", { className: numeric ? "numeric" : "", attrs: { scope: "col" } }, text || buildElement("span", { className: "visually-hidden", text: "Actions" }))));
    const rows = products.map((product) => {
        const actions = buildElement("td", { className: "actions-cell" });
        const button = (text, label, onClick, extra = "") => {
            const b = buildElement("button", { className: `btn btn-small ${extra || "btn-ghost"}`, text, attrs: { type: "button", "aria-label": `${label} ${product.name}` } });
            b.addEventListener("click", onClick);
            actions.append(b);
        };
        if (product.trackStock && userCan("stock:restock")) button("Restock", "Restock", () => openStockDialog(product, "restock"), "btn-secondary");
        if (product.trackStock && userCan("stock:adjust")) button("Adjust", "Adjust stock of", () => openStockDialog(product, "adjust"));
        if (userCan("stock:view")) button("History", "Stock history of", () => openHistory(product));
        if (userCan("products:manage")) {
            button("Edit", "Edit", () => openProductDialog(product));
            button("Delete", "Delete", () => deleteProduct(product), "btn-ghost is-danger");
        }
        const stockCell = product.trackStock ? String(product.stockQuantity) : "Made to order";
        const freeCell = product.trackStock
            ? buildElement("span", {}, String(product.availableQuantity),
                product.reservedQuantity ? buildElement("span", { className: "cell-sub", text: `${product.reservedQuantity} on open tabs` }) : null)
            : "—";
        return buildElement("tr", { className: product.status === "inactive" ? "is-inactive" : "" },
            buildElement("td", { attrs: { "data-label": "Product" } },
                buildElement("strong", { text: product.name }),
                buildElement("span", { className: "cell-sub", text: product.category ? product.category.name : "" })),
            buildElement("td", { className: "numeric", text: formatMoney(product.price), attrs: { "data-label": "Price" } }),
            buildElement("td", { className: "numeric", text: stockCell, attrs: { "data-label": "Stock" } }),
            buildElement("td", { className: "numeric", attrs: { "data-label": "Free to sell" } }, freeCell),
            buildElement("td", { attrs: { "data-label": "Status" } }, ...(stockBadges(product).length ? stockBadges(product) : [buildElement("span", { className: "cell-sub", text: "On sale" })])),
            actions);
    });
    productsList.replaceChildren(buildElement("div", { className: "table-scroll" },
        buildElement("table", { className: "data-table products-table" }, buildElement("thead", {}, head), buildElement("tbody", {}, ...rows))));
}

// ---------- Add / edit (admin) ----------

function clearProductErrors() {
    productFormError.hidden = true;
    productForm.querySelectorAll("[data-error-for]").forEach((el) => (el.hidden = true));
}

function syncTrackFields() {
    const tracked = productForm.elements.trackStock.checked;
    document.getElementById("low-limit-field").hidden = !tracked;
    document.getElementById("initial-stock-field").hidden = !tracked || Boolean(editingProduct);
}

function openProductDialog(product = null) {
    if (categories.length === 0) {
        showToast("Add a category first (Categories page).", "error", 6000);
        return;
    }
    editingProduct = product;
    productForm.reset();
    clearProductErrors();
    document.getElementById("product-dialog-title").textContent = product ? `Edit ${product.name}` : "Add product";
    productForm.elements.categoryId.replaceChildren(...categories.map((c) => buildElement("option", { text: c.name, attrs: { value: c.id } })));
    if (product) {
        productForm.elements.name.value = product.name;
        productForm.elements.categoryId.value = product.category.id;
        productForm.elements.price.value = paisaToInput(product.price);
        productForm.elements.trackStock.checked = product.trackStock;
        productForm.elements.lowStockLimit.value = product.lowStockLimit;
        productForm.elements.status.value = product.status;
    } else if (categoryFilter.value) {
        productForm.elements.categoryId.value = categoryFilter.value;
    }
    syncTrackFields();
    productDialog.showModal();
    productForm.elements.name.focus();
}

productForm.elements.trackStock.addEventListener("change", syncTrackFields);

productForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    clearProductErrors();
    const price = parseMoneyInput(productForm.elements.price.value);
    if (price === null) {
        const err = productForm.querySelector('[data-error-for="price"]');
        err.textContent = "Enter a price like 80 or 80.50";
        err.hidden = false;
        return;
    }
    const body = {
        name: productForm.elements.name.value,
        categoryId: productForm.elements.categoryId.value,
        price,
        trackStock: productForm.elements.trackStock.checked,
        lowStockLimit: Number(productForm.elements.lowStockLimit.value || 0),
        status: productForm.elements.status.value,
    };
    if (!editingProduct && body.trackStock) body.stockQuantity = Number(productForm.elements.stockQuantity.value || 0);
    setButtonLoading(productSave, true, "Saving…");
    try {
        const { message } = editingProduct
            ? await apiRequest(`/products/${editingProduct.id}`, { method: "PATCH", body })
            : await apiRequest("/products", { method: "POST", body });
        productDialog.close();
        showToast(message);
        await loadProducts();
    } catch (error) {
        let shown = false;
        for (const { field, message } of error.errors || []) {
            const target = productForm.querySelector(`[data-error-for="${field}"]`);
            if (target) {
                target.textContent = message;
                target.hidden = false;
                shown = true;
            }
        }
        if (!shown) {
            productFormError.textContent = error.message;
            productFormError.hidden = false;
        }
    } finally {
        setButtonLoading(productSave, false);
    }
});

async function deleteProduct(product) {
    const ok = await confirmDialog(`"${product.name}" will be deleted. Products with sales or stock history can't be deleted - set them inactive instead.`,
        { title: `Delete ${product.name}?`, confirmText: "Delete", danger: true });
    if (!ok) return;
    try {
        const { message } = await apiRequest(`/products/${product.id}`, { method: "DELETE" });
        showToast(message);
        await loadProducts();
    } catch (error) {
        showToast(error.message, "error", 8000);
    }
}

// ---------- Restock / adjust ----------

function openStockDialog(product, kind) {
    stockAction = { product, kind };
    stockForm.reset();
    stockFormError.hidden = true;
    const restock = kind === "restock";
    document.getElementById("stock-dialog-title").textContent = restock ? `Restock ${product.name}` : `Adjust stock: ${product.name}`;
    document.getElementById("stock-dialog-text").textContent = `In stock now: ${product.stockQuantity}.`;
    document.getElementById("adjust-type").hidden = restock;
    syncStockLabels();
    stockDialog.showModal();
    stockForm.elements.quantity.focus();
}

function syncStockLabels() {
    const restock = stockAction && stockAction.kind === "restock";
    const waste = !restock && stockForm.elements.type.value === "waste";
    document.getElementById("stock-quantity-label").textContent = restock ? "Quantity received" : waste ? "How many were thrown away" : "Change (e.g. 3 or -2)";
    stockForm.elements.quantity.min = restock || waste ? "1" : "";
    document.getElementById("stock-reason-label").replaceChildren(restock ? "Note " : "Reason ",
        buildElement("span", { className: "optional", text: restock ? "(optional)" : "(required)" }));
}

stockForm.addEventListener("change", syncStockLabels);

stockForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    stockFormError.hidden = true;
    const { product, kind } = stockAction;
    const quantity = Number(stockForm.elements.quantity.value);
    const body = { quantity, reason: stockForm.elements.reason.value.trim() };
    if (kind === "adjust") body.type = stockForm.elements.type.value;
    if (!Number.isInteger(quantity) || quantity === 0) {
        stockFormError.textContent = "Enter a whole number.";
        stockFormError.hidden = false;
        return;
    }
    setButtonLoading(stockSave, true, "Saving…");
    try {
        const { message } = await apiRequest(`/products/${product.id}/${kind}`, { method: "POST", body });
        stockDialog.close();
        showToast(message);
        await Promise.all([loadProducts(), loadRecentMovements()]);
    } catch (error) {
        const details = (error.errors || []).map((e) => e.message);
        stockFormError.textContent = details.length > 1 ? details.join(" · ") : error.message; // e.g. "...can't go below 0"
        stockFormError.hidden = false;
    } finally {
        setButtonLoading(stockSave, false);
    }
});

// ---------- History ----------

function movementTable(movements, withProduct) {
    if (movements.length === 0) return buildElement("p", { className: "field-hint panel-empty", text: "No stock changes yet." });
    const headings = ["When", ...(withProduct ? ["Product"] : []), "Type", "Change", "Stock after", "Reason", "By"];
    const head = buildElement("tr", {}, ...headings.map((text) => buildElement("th", { className: ["Change", "Stock after"].includes(text) ? "numeric" : "", text, attrs: { scope: "col" } })));
    const rows = movements.map((m) => buildElement("tr", {},
        buildElement("td", { text: formatDateTime(m.createdAt), attrs: { "data-label": "When" } }),
        withProduct ? buildElement("td", { text: m.productName, attrs: { "data-label": "Product" } }) : null,
        buildElement("td", { text: STOCK_MOVEMENT_LABELS[m.type] || m.type, attrs: { "data-label": "Type" } }),
        buildElement("td", { className: `numeric ${m.quantity < 0 ? "is-negative" : "is-positive"}`, text: m.quantity > 0 ? `+${m.quantity}` : String(m.quantity), attrs: { "data-label": "Change" } }),
        buildElement("td", { className: "numeric", text: String(m.balanceAfter), attrs: { "data-label": "Stock after" } }),
        buildElement("td", { className: "cell-wrap", text: m.reason || "—", attrs: { "data-label": "Reason" } }),
        buildElement("td", { text: m.createdBy ? m.createdBy.name : "—", attrs: { "data-label": "By" } })));
    return buildElement("div", { className: "table-scroll" },
        buildElement("table", { className: "data-table" }, buildElement("thead", {}, head), buildElement("tbody", {}, ...rows)));
}

async function openHistory(product) {
    const box = document.getElementById("history");
    const close = buildElement("button", { className: "btn btn-secondary", text: "Close", attrs: { type: "button" } });
    close.addEventListener("click", () => historyDialog.close());
    box.replaceChildren(buildElement("h2", { className: "modal-title", text: `Stock history: ${product.name}`, attrs: { id: "history-title" } }),
        buildElement("p", { className: "field-hint", text: "Loading…" }));
    historyDialog.showModal();
    try {
        const { data } = await apiRequest(`/products/${product.id}/movements?limit=100`);
        box.replaceChildren(
            buildElement("h2", { className: "modal-title", text: `Stock history: ${product.name}`, attrs: { id: "history-title" } }),
            buildElement("p", { className: "modal-subtitle", text: product.trackStock ? `In stock now: ${product.stockQuantity}` : "Made to order (stock not counted)" }),
            movementTable(data.movements, false),
            data.total > data.movements.length ? buildElement("p", { className: "field-hint", text: `Showing the latest ${data.movements.length} of ${data.total}.` }) : null,
            buildElement("div", { className: "modal-actions" }, close));
    } catch (error) {
        box.replaceChildren(buildElement("p", { className: "form-error", text: error.message }), buildElement("div", { className: "modal-actions" }, close));
    }
}

async function loadRecentMovements() {
    if (!userCan("stock:view")) return;
    const box = document.getElementById("recent-movements");
    try {
        const { data } = await apiRequest("/stock-movements?limit=15");
        box.replaceChildren(movementTable(data.movements, true));
    } catch (error) {
        box.replaceChildren(productEmpty("Could not load stock changes", error.message));
    }
}

// ---------- Events ----------

document.getElementById("add-product-button").addEventListener("click", () => openProductDialog());
document.getElementById("product-cancel").addEventListener("click", () => productDialog.close());
document.getElementById("stock-cancel").addEventListener("click", () => stockDialog.close());
productSearch.addEventListener("input", () => {
    clearTimeout(productSearchTimer);
    productSearchTimer = setTimeout(loadProducts, 300);
});
categoryFilter.addEventListener("change", loadProducts);
lowStockOnly.addEventListener("change", loadProducts);
statusFilter.addEventListener("click", (event) => {
    const chip = event.target.closest(".chip");
    if (!chip) return;
    selectedStatus = chip.dataset.status;
    statusFilter.querySelectorAll(".chip").forEach((c) => c.setAttribute("aria-pressed", String(c === chip)));
    loadProducts();
});

currentUserReady.then(async () => {
    await loadCategoryOptions();
    await loadProducts();
    loadRecentMovements();
});
