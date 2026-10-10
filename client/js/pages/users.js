// users.js (page) - admins manage who can log in. The server enforces every rule
// (admin only, strong passwords, unique usernames, never lose the last admin).
// Uses: apiRequest (api.js), buildElement/createIcon/showToast/confirmDialog/setButtonLoading (ui.js),
//       formatDateTime (format.js), currentUserReady/ROLE_LABELS (layout.js)

const usersList = document.getElementById("users-list");
const usersSummary = document.getElementById("users-summary");
const searchInput = document.getElementById("user-search");
const roleFilter = document.getElementById("role-filter");

const userDialog = document.getElementById("user-dialog");
const userForm = document.getElementById("user-form");
const userFormError = document.getElementById("user-form-error");
const userSave = document.getElementById("user-save");
const passwordDialog = document.getElementById("password-dialog");
const passwordForm = document.getElementById("password-form");
const passwordFormError = document.getElementById("password-form-error");
const passwordSave = document.getElementById("password-save");

let selectedRole = "";
let editingUser = null;
let passwordUser = null;
let searchTimer = null;
let me = null;

// ---------- List ----------

async function loadUsers() {
    const params = new URLSearchParams();
    if (searchInput.value.trim()) params.set("search", searchInput.value.trim());
    if (selectedRole) params.set("role", selectedRole);
    try {
        const { data } = await apiRequest(`/users?${params}`);
        renderUsers(data.users, data.activeAdmins);
    } catch (error) {
        usersList.replaceChildren(emptyBox("Could not load users", error.message));
    }
}

function renderUsers(users, activeAdmins) {
    usersSummary.textContent = `${users.length} account${users.length === 1 ? "" : "s"} · ${activeAdmins} active admin${activeAdmins === 1 ? "" : "s"}`;
    if (users.length === 0) {
        usersList.replaceChildren(emptyBox("No matching users", "Try another name or role."));
        return;
    }
    const head = buildElement("tr", {}, ...["Name", "Username", "Role", "Status", "Last login", "Created", ""].map((text) =>
        buildElement("th", { attrs: { scope: "col" } }, text ? text : buildElement("span", { className: "visually-hidden", text: "Actions" }))));
    const rows = users.map((user) => {
        const isMe = me && user.id === me.id;
        const actions = buildElement("td", { className: "actions-cell" });
        const edit = buildElement("button", { className: "btn btn-secondary btn-small", text: "Edit", attrs: { type: "button", "aria-label": `Edit ${user.username}` } });
        edit.addEventListener("click", () => openUserDialog(user));
        const password = buildElement("button", { className: "btn btn-ghost btn-small", text: "Password", attrs: { type: "button", "aria-label": `Set a new password for ${user.username}` } });
        password.addEventListener("click", () => openPasswordDialog(user));
        actions.append(edit, password);
        if (!isMe) {
            const toggle = buildElement("button", {
                className: `btn btn-ghost btn-small ${user.active ? "is-danger" : ""}`,
                text: user.active ? "Deactivate" : "Activate",
                attrs: { type: "button", "aria-label": `${user.active ? "Deactivate" : "Activate"} ${user.username}` },
            });
            toggle.addEventListener("click", () => toggleActive(user));
            actions.append(toggle);
        }
        return buildElement("tr", { className: user.active ? "" : "is-inactive" },
            buildElement("td", { attrs: { "data-label": "Name" } }, buildElement("strong", { text: user.name }), isMe ? buildElement("span", { className: "badge you-badge", text: "You" }) : null),
            buildElement("td", { text: user.username, attrs: { "data-label": "Username" } }),
            buildElement("td", { attrs: { "data-label": "Role" } }, buildElement("span", { className: `role-badge role-${user.role}`, text: ROLE_LABELS[user.role] })),
            buildElement("td", { attrs: { "data-label": "Status" } }, buildElement("span", { className: `status-badge ${user.active ? "status-available" : "status-inactive"}`, text: user.active ? "Active" : "Inactive" })),
            buildElement("td", { text: user.lastLoginAt ? formatDateTime(user.lastLoginAt) : "Never", attrs: { "data-label": "Last login" } }),
            buildElement("td", { text: formatDateTime(user.createdAt), attrs: { "data-label": "Created" } }),
            actions);
    });
    usersList.replaceChildren(buildElement("div", { className: "table-scroll" },
        buildElement("table", { className: "data-table" }, buildElement("thead", {}, head), buildElement("tbody", {}, ...rows))));
}

function emptyBox(title, text) {
    return buildElement("div", { className: "empty-state panel-empty" },
        buildElement("span", { className: "empty-state-icon" }, createIcon("user")),
        buildElement("p", { className: "empty-state-title", text: title }),
        buildElement("p", { text }));
}

// ---------- Add / edit ----------

function openUserDialog(user = null) {
    editingUser = user;
    userForm.reset();
    clearErrors(userForm, userFormError);
    document.getElementById("user-dialog-title").textContent = user ? `Edit ${user.username}` : "Add user";
    // Username can't change; passwords are set with the separate "Password" button
    document.getElementById("username-field").hidden = Boolean(user);
    document.getElementById("password-fields").hidden = Boolean(user);
    if (user) {
        userForm.elements.name.value = user.name;
        userForm.elements.role.value = user.role;
    }
    userDialog.showModal();
    userForm.elements.name.focus();
}

userForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    clearErrors(userForm, userFormError);
    const body = { name: userForm.elements.name.value.trim(), role: userForm.elements.role.value };
    if (!editingUser) {
        body.username = userForm.elements.username.value.trim();
        body.password = userForm.elements.password.value;
        if (body.password !== document.getElementById("user-password2").value) {
            return showErrors(userForm, userFormError, [{ field: "password", message: "The two passwords are different" }]);
        }
    }
    setButtonLoading(userSave, true, "Saving…");
    try {
        const { message } = editingUser
            ? await apiRequest(`/users/${editingUser.id}`, { method: "PATCH", body })
            : await apiRequest("/users", { method: "POST", body });
        userDialog.close();
        showToast(message);
        await loadUsers();
    } catch (error) {
        showErrors(userForm, userFormError, error.errors || [], error.message);
    } finally {
        setButtonLoading(userSave, false);
        userForm.elements.password.value = "";
        document.getElementById("user-password2").value = "";
    }
});

// ---------- Activate / deactivate ----------

async function toggleActive(user) {
    if (user.active) {
        const ok = await confirmDialog(`${user.name} (${user.username}) will no longer be able to log in, and is logged out everywhere right away. Their history is kept.`,
            { title: `Deactivate ${user.username}?`, confirmText: "Deactivate", danger: true });
        if (!ok) return;
    }
    try {
        const { message } = await apiRequest(`/users/${user.id}`, { method: "PATCH", body: { active: !user.active } });
        showToast(message);
        await loadUsers();
    } catch (error) {
        showToast(error.message, "error", 7000); // e.g. "This is the last active admin…"
    }
}

// ---------- Set a new password ----------

function openPasswordDialog(user) {
    passwordUser = user;
    passwordForm.reset();
    passwordFormError.hidden = true;
    document.getElementById("password-dialog-title").textContent = `New password for ${user.username}`;
    document.getElementById("password-dialog-text").textContent =
        "The old password is never shown. After saving, the user is logged out on other devices and must use the new password.";
    passwordDialog.showModal();
    document.getElementById("new-password").focus();
}

passwordForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    passwordFormError.hidden = true;
    const password = document.getElementById("new-password").value;
    if (password !== document.getElementById("new-password2").value) {
        passwordFormError.textContent = "The two passwords are different.";
        passwordFormError.hidden = false;
        return;
    }
    setButtonLoading(passwordSave, true, "Saving…");
    try {
        const { message } = await apiRequest(`/users/${passwordUser.id}/password`, { method: "POST", body: { password } });
        passwordDialog.close();
        showToast(message);
    } catch (error) {
        passwordFormError.textContent = error.message;
        passwordFormError.hidden = false;
    } finally {
        setButtonLoading(passwordSave, false);
        passwordForm.reset(); // never keep passwords in the page
    }
});

// ---------- Form errors ----------

function showErrors(form, generalBox, errors, message) {
    let shown = false;
    for (const { field, message: text } of errors) {
        const target = form.querySelector(`[data-error-for="${field}"]`);
        if (target) {
            target.textContent = text;
            target.hidden = false;
            shown = true;
        }
    }
    if (!shown && (message || errors.length)) {
        generalBox.textContent = message || errors[0].message;
        generalBox.hidden = false;
    }
}

function clearErrors(form, generalBox) {
    generalBox.hidden = true;
    form.querySelectorAll("[data-error-for]").forEach((el) => (el.hidden = true));
}

// ---------- Events ----------

document.getElementById("add-user-button").addEventListener("click", () => openUserDialog());
document.getElementById("user-cancel").addEventListener("click", () => userDialog.close());
document.getElementById("password-cancel").addEventListener("click", () => passwordDialog.close());
searchInput.addEventListener("input", () => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(loadUsers, 300);
});
roleFilter.addEventListener("click", (event) => {
    const chip = event.target.closest(".chip");
    if (!chip) return;
    selectedRole = chip.dataset.role;
    roleFilter.querySelectorAll(".chip").forEach((c) => c.setAttribute("aria-pressed", String(c === chip)));
    loadUsers();
});

currentUserReady.then((user) => {
    me = user;
    loadUsers();
});
