// layout.js - builds the parts every page shares: the sidebar menu, the logged-in user
// with a Log out button, the mobile menu button, today's date and the server status.
// Each page tells us which menu item is active with <body data-page="dashboard">.
//
// Hiding a menu item or button here is only for convenience. SECURITY is on the server:
// every API request is checked there (401 not logged in, 403 not allowed).

// Menu items. "ready: false" = module not built yet (shown, but not clickable).
// "permission" = only shown to roles that have it (see server/config/permissions.js).
const NAV_SECTIONS = [
    {
        label: "Overview",
        items: [{ page: "dashboard", label: "Dashboard", icon: "dashboard", ready: true, permission: "dashboard:view" }],
    },
    {
        label: "Club",
        items: [
            { page: "tables", label: "Tables", icon: "table", ready: true, permission: "tables:view" },
            { page: "sessions", label: "Sessions", icon: "timer", ready: true, permission: "sessions:view" },
            { page: "bookings", label: "Bookings", icon: "calendar", ready: true, permission: "bookings:view" },
            { page: "customers", label: "Customers", icon: "users", ready: true, permission: "customers:view" },
        ],
    },
    {
        label: "Business",
        items: [
            { page: "billing", label: "Billing", icon: "receipt", ready: true, permission: "bills:view" },
            { page: "reports", label: "Reports", icon: "chart", ready: true, permission: "reports:view" },
            { page: "products", label: "Café Products", icon: "cup", ready: true, permission: "cafe:view" },
            { page: "categories", label: "Categories", icon: "box", ready: true, permission: "cafe:view" },
            { page: "players", label: "Players", icon: "trophy", ready: true, permission: "players:view" },
        ],
    },
    {
        label: "System",
        items: [
            { page: "users", label: "Users", icon: "user", ready: true, permission: "users:manage" },
            { page: "settings", label: "Settings", icon: "settings", ready: true, permission: "settings:manage" },
        ],
    },
];

const HEALTH_CHECK_INTERVAL_MS = 30000;
const APP_VERSION_LABEL = "v0.11 · Phase 11"; // shown at the bottom of the sidebar
const ROLE_LABELS = { admin: "Admin", staff: "Staff", cashier: "Cashier" };

// ---------- The logged-in user ----------
let currentUser = null;

// Pages can wait for this: currentUserReady.then((user) => …)
const currentUserReady = apiRequest("/auth/me")
    .then(({ data }) => {
        currentUser = data;
        return data;
    })
    .catch(() => null); // 401 -> apiRequest already sends the browser to the login page

// Phase 11.1: the game modes (labels, units, rates) from the server's registry, loaded once per page.
// Pages that show game modes can wait for it: gameModesReady.then(...). Never fails the page.
const gameModesReady = currentUserReady.then((user) => (user ? loadGameModes().catch(() => null) : null));

// ---------- Page-role guard (Step 1.5) ----------
// UX / navigation convenience ONLY. The server's pageGuard (middleware/auth.js) already refuses a
// restricted page before sending it when this app is served by Express - but a page hosted as a
// plain static file (e.g. on Vercel) has no such guard, so anyone could open its HTML. This asks
// the server "/api/auth/page-access" (the exact same PAGE_PERMISSIONS rule as pageGuard) and hides
// the page's content (layout.css: body[data-access]) until the answer says "allowed". It can never
// grant access to data: every API call still needs its own login (401) and permission (403) check.
//
// Resolves to true (show the page), "denied" (wrong role - already redirected to the dashboard),
// or "error" (couldn't check - fail closed: keep hiding the content, let the person retry).
const pageAccessReady = currentUserReady.then((user) => {
    if (!user) return null; // not logged in: apiRequest already sent us to the login page
    return apiRequest("/auth/page-access?page=" + encodeURIComponent(location.pathname), { redirectOn401: false })
        .then(({ data }) => {
            if (!data || typeof data.allowed !== "boolean") throw new Error("page-access: unexpected response");
            if (data.allowed) {
                document.body.setAttribute("data-access", "allowed");
                return true;
            }
            location.replace("/pages/dashboard.html?denied=1");
            return "denied";
        })
        .catch((error) => {
            if (error instanceof ApiError && error.status === 401) {
                goToLogin(); // the login expired between /auth/me and this request
                return "denied";
            }
            showPageAccessError();
            return "error";
        });
});

// Fail-closed: the page's content (layout.css) stays hidden. No redirect - a server/network
// problem here must never loop the person back to the login or dashboard page.
function showPageAccessError() {
    const main = document.querySelector("main.page-content");
    if (!main) return;
    const retryButton = buildElement("button", { className: "btn btn-secondary", attrs: { type: "button" } }, "Reload");
    retryButton.addEventListener("click", () => location.reload());
    main.insertAdjacentElement("beforebegin", buildElement("div", { className: "empty-state page-access-error" },
        buildElement("p", { className: "empty-state-title", text: "Could not check your access to this page." }),
        buildElement("p", { text: "Check your connection and try again." }),
        retryButton));
}

// true if the logged-in user's role has this permission (for showing/hiding buttons only)
function userCan(permission) {
    return Boolean(currentUser && currentUser.permissions.includes(permission));
}

function buildSidebarMenu(activePage) {
    const nav = document.getElementById("sidebar-nav");
    nav.replaceChildren();

    NAV_SECTIONS.forEach((section) => {
        const items = section.items.filter((item) => !item.permission || userCan(item.permission));
        if (items.length === 0) return; // e.g. "System" for staff and cashiers

        const label = document.createElement("p");
        label.className = "nav-section-label";
        label.textContent = section.label;

        const list = document.createElement("ul");
        list.className = "nav-list";

        items.forEach((item) => {
            // Finished modules are links; unfinished ones are plain text with a "Soon" tag
            const link = document.createElement(item.ready ? "a" : "span");
            link.className = "nav-link";
            link.appendChild(createIcon(item.icon));

            const text = document.createElement("span");
            text.textContent = item.label;
            link.appendChild(text);

            if (item.ready) {
                link.href = `/pages/${item.page}.html`;
                if (item.page === activePage) {
                    link.classList.add("active");
                    link.setAttribute("aria-current", "page");
                }
            } else {
                link.classList.add("is-disabled");
                link.setAttribute("aria-disabled", "true");
                const soon = document.createElement("span");
                soon.className = "nav-soon";
                soon.textContent = "Soon";
                link.appendChild(soon);
            }

            const listItem = document.createElement("li");
            listItem.appendChild(link);
            list.appendChild(listItem);
        });

        nav.append(label, list);
    });
}

// Name, role and Log out at the bottom of the sidebar
function buildUserBox() {
    const footer = document.getElementById("sidebar-footer");
    const initials = currentUser.name.split(/\s+/).map((part) => part[0]).join("").slice(0, 2).toUpperCase();

    const logoutButton = buildElement("button", { className: "btn btn-ghost btn-small logout-button", attrs: { type: "button", id: "logout-button" } },
        createIcon("login"), "Log out");
    logoutButton.addEventListener("click", logOut);

    footer.replaceChildren(
        buildElement("div", { className: "user-box" },
            buildElement("span", { className: "user-avatar", text: initials, attrs: { "aria-hidden": "true" } }),
            buildElement("span", { className: "user-text" },
                buildElement("strong", { className: "user-name", text: currentUser.name }),
                buildElement("span", { className: `role-badge role-${currentUser.role}`, text: ROLE_LABELS[currentUser.role] })),
            logoutButton),
        buildElement("p", { className: "app-version", text: APP_VERSION_LABEL })
    );
}

async function logOut() {
    try {
        await apiRequest("/auth/logout", { method: "POST", redirectOn401: false });
    } finally {
        location.replace("/pages/login.html");
    }
}

// Anything in a page marked data-permission="…" is hidden for roles without that permission;
// data-permission-not="…" is the opposite (a hint shown only to roles WITHOUT it)
function applyPagePermissions(root = document) {
    root.querySelectorAll("[data-permission]").forEach((element) => {
        element.hidden = !userCan(element.dataset.permission);
    });
    root.querySelectorAll("[data-permission-not]").forEach((element) => {
        element.hidden = userCan(element.dataset.permissionNot);
    });
}

// ---------- Mobile / tablet menu ----------
function setUpMenuButton() {
    const sidebar = document.getElementById("sidebar");
    const menuButton = document.getElementById("menu-button");
    const overlay = document.getElementById("sidebar-overlay");

    function setMenuOpen(isOpen) {
        sidebar.classList.toggle("is-open", isOpen);
        overlay.hidden = !isOpen;
        menuButton.setAttribute("aria-expanded", String(isOpen));
    }

    menuButton.addEventListener("click", () => setMenuOpen(!sidebar.classList.contains("is-open")));
    overlay.addEventListener("click", () => setMenuOpen(false));
    document.addEventListener("keydown", (event) => {
        if (event.key === "Escape") setMenuOpen(false);
    });
}

// ---------- Today's date ----------
function showTodayDate() {
    const dateElement = document.getElementById("topbar-date");
    dateElement.textContent = new Date().toLocaleDateString(undefined, {
        weekday: "long",
        day: "numeric",
        month: "long",
        year: "numeric",
    });
}

// ---------- Server & database status ----------
let lastStatus = null;

function setStatus(state, text) {
    const pill = document.getElementById("server-status");
    pill.className = `status-pill is-${state}`;
    pill.querySelector(".status-text").textContent = text;
    pill.querySelector(".status-dot, .spinner").className = "status-dot";
}

async function checkServerHealth() {
    let state;
    try {
        await apiRequest("/health");
        state = "online";
        setStatus("online", "System online");
    } catch (error) {
        if (error.status === 0) {
            state = "offline";
            setStatus("offline", "Server offline");
        } else {
            state = "warning";
            setStatus("warning", "Database offline");
        }
    }

    // Only show a message when the status CHANGES (not every 30 seconds),
    // and don't announce "online" on the first check - that's the normal case.
    const statusChanged = state !== lastStatus;
    const isFirstCheck = lastStatus === null;
    lastStatus = state;
    if (!statusChanged) return;

    if (state === "offline") showToast("Cannot reach the server", "error");
    else if (state === "warning") showToast("The database is not available", "error");
    else if (!isFirstCheck) showToast("Connection restored");
}

// ---------- Start ----------
function initLayout() {
    renderIcons();
    setUpMenuButton();
    showTodayDate();
    checkServerHealth();
    setInterval(checkServerHealth, HEALTH_CHECK_INTERVAL_MS);

    currentUserReady.then((user) => {
        if (!user) return;
        buildSidebarMenu(document.body.dataset.page);
        buildUserBox();
        applyPagePermissions();
        // Sent here by the server (pageGuard) or the client guard above because this role may
        // not open the page it asked for
        if (new URLSearchParams(location.search).get("denied")) {
            showToast("You don't have permission to open that page.", "error", 6000);
            history.replaceState(null, "", location.pathname);
        }
    });
}

initLayout();
