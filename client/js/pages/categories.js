// categories.js (page) - café product categories: list, search, add, rename, delete.
// Everyone can look; only admins (products:manage) see the buttons - the server checks it too.
// Uses: apiRequest (api.js), buildElement/createIcon/showToast/confirmDialog/setButtonLoading (ui.js),
//       currentUserReady/userCan (layout.js)

const categoriesList = document.getElementById("categories-list");
const categoriesSummary = document.getElementById("categories-summary");
const categorySearch = document.getElementById("category-search");
const categoryDialog = document.getElementById("category-dialog");
const categoryForm = document.getElementById("category-form");
const categoryFormError = document.getElementById("category-form-error");
const categorySave = document.getElementById("category-save");

let editingCategory = null;
let categorySearchTimer = null;

async function loadCategories() {
    const search = categorySearch.value.trim();
    try {
        const { data } = await apiRequest(`/categories${search ? `?search=${encodeURIComponent(search)}` : ""}`);
        renderCategories(data, Boolean(search));
    } catch (error) {
        categoriesList.replaceChildren(categoryEmpty("Could not load categories", error.message));
    }
}

function categoryEmpty(title, text) {
    return buildElement("div", { className: "empty-state panel-empty" },
        buildElement("span", { className: "empty-state-icon" }, createIcon("box")),
        buildElement("p", { className: "empty-state-title", text: title }),
        buildElement("p", { text }));
}

function renderCategories(categories, isSearching) {
    categoriesSummary.textContent = categories.length === 1 ? "1 category" : `${categories.length} categories`;
    if (categories.length === 0) {
        categoriesList.replaceChildren(isSearching
            ? categoryEmpty("No matching categories", "Try another name.")
            : categoryEmpty("No categories yet", userCan("products:manage") ? "Add the first one, e.g. Cold drinks." : "An admin can add categories."));
        return;
    }
    const canManage = userCan("products:manage");
    const head = buildElement("tr", {},
        buildElement("th", { text: "Name", attrs: { scope: "col" } }),
        buildElement("th", { className: "numeric", text: "Products", attrs: { scope: "col" } }),
        buildElement("th", { text: "Updated", attrs: { scope: "col" } }),
        buildElement("th", {}, buildElement("span", { className: "visually-hidden", text: "Actions" })));
    const rows = categories.map((category) => {
        const actions = buildElement("td", { className: "actions-cell" });
        const view = buildElement("a", { className: "btn btn-secondary btn-small", text: "Products", attrs: { href: `/pages/products.html?categoryId=${category.id}` } });
        actions.append(view);
        if (canManage) {
            const edit = buildElement("button", { className: "btn btn-ghost btn-small", text: "Rename", attrs: { type: "button", "aria-label": `Rename ${category.name}` } });
            edit.addEventListener("click", () => openCategoryDialog(category));
            const remove = buildElement("button", { className: "btn btn-ghost btn-small is-danger", text: "Delete", attrs: { type: "button", "aria-label": `Delete ${category.name}` } });
            remove.addEventListener("click", () => deleteCategory(category));
            actions.append(edit, remove);
        }
        return buildElement("tr", {},
            buildElement("td", { attrs: { "data-label": "Name" } }, buildElement("strong", { text: category.name })),
            buildElement("td", { className: "numeric", text: `${category.productCount}${category.productCount !== category.activeProductCount ? ` (${category.activeProductCount} active)` : ""}`, attrs: { "data-label": "Products" } }),
            buildElement("td", { text: formatDateTime(category.updatedAt), attrs: { "data-label": "Updated" } }),
            actions);
    });
    categoriesList.replaceChildren(buildElement("div", { className: "table-scroll" },
        buildElement("table", { className: "data-table" }, buildElement("thead", {}, head), buildElement("tbody", {}, ...rows))));
}

function openCategoryDialog(category = null) {
    editingCategory = category;
    categoryForm.reset();
    categoryFormError.hidden = true;
    categoryForm.querySelectorAll("[data-error-for]").forEach((el) => (el.hidden = true));
    document.getElementById("category-dialog-title").textContent = category ? `Rename ${category.name}` : "Add category";
    if (category) categoryForm.elements.name.value = category.name;
    categoryDialog.showModal();
    categoryForm.elements.name.focus();
}

categoryForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    categoryFormError.hidden = true;
    const fieldError = categoryForm.querySelector('[data-error-for="name"]');
    fieldError.hidden = true;
    const body = { name: categoryForm.elements.name.value };
    setButtonLoading(categorySave, true, "Saving…");
    try {
        const { message } = editingCategory
            ? await apiRequest(`/categories/${editingCategory.id}`, { method: "PATCH", body })
            : await apiRequest("/categories", { method: "POST", body });
        categoryDialog.close();
        showToast(message);
        await loadCategories();
    } catch (error) {
        const field = (error.errors || []).find((e) => e.field === "name");
        if (field) {
            fieldError.textContent = field.message; // e.g. "Category name already exists"
            fieldError.hidden = false;
        } else {
            categoryFormError.textContent = error.message;
            categoryFormError.hidden = false;
        }
    } finally {
        setButtonLoading(categorySave, false);
    }
});

async function deleteCategory(category) {
    const ok = await confirmDialog(`"${category.name}" will be deleted. A category that still has products can't be deleted.`,
        { title: `Delete ${category.name}?`, confirmText: "Delete", danger: true });
    if (!ok) return;
    try {
        const { message } = await apiRequest(`/categories/${category.id}`, { method: "DELETE" });
        showToast(message);
        await loadCategories();
    } catch (error) {
        showToast(error.message, "error", 7000); // e.g. "...because it has 3 product(s)..."
    }
}

document.getElementById("add-category-button").addEventListener("click", () => openCategoryDialog());
document.getElementById("category-cancel").addEventListener("click", () => categoryDialog.close());
categorySearch.addEventListener("input", () => {
    clearTimeout(categorySearchTimer);
    categorySearchTimer = setTimeout(loadCategories, 300);
});

currentUserReady.then(loadCategories);
