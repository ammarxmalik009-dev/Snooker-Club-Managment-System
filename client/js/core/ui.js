// ui.js - small building blocks shared by all pages: icons and toast messages.

// ---------- Icons (simple line icons, 24x24) ----------
const ICON_PATHS = {
    dashboard: '<rect x="3" y="3" width="7" height="9" rx="1.5"/><rect x="14" y="3" width="7" height="5" rx="1.5"/><rect x="14" y="12" width="7" height="9" rx="1.5"/><rect x="3" y="16" width="7" height="5" rx="1.5"/>',
    table: '<rect x="3" y="6" width="18" height="12" rx="2"/><circle cx="3.5" cy="6.5" r="1"/><circle cx="20.5" cy="6.5" r="1"/><circle cx="3.5" cy="17.5" r="1"/><circle cx="20.5" cy="17.5" r="1"/><circle cx="12" cy="12" r="1.5"/>',
    check: '<circle cx="12" cy="12" r="9"/><path d="m8 12 3 3 5-6"/>',
    play: '<circle cx="12" cy="12" r="9"/><path d="m10 8.5 5 3.5-5 3.5z"/>',
    timer: '<circle cx="12" cy="13" r="8"/><path d="M12 9v4l2.5 2.5M9 2h6"/>',
    calendar: '<rect x="3" y="5" width="18" height="16" rx="2"/><path d="M3 10h18M8 3v4M16 3v4"/>',
    users: '<circle cx="9" cy="8" r="3.5"/><path d="M2.5 20c.6-3.6 3.2-5.5 6.5-5.5s5.9 1.9 6.5 5.5"/><path d="M16 4.5a3.5 3.5 0 0 1 0 7M18 14.6c2 .7 3.2 2.5 3.5 5.4"/>',
    receipt: '<path d="M6 3h12v18l-3-2-3 2-3-2-3 2z"/><path d="M9 8h6M9 12h6"/>',
    money: '<rect x="2.5" y="6" width="19" height="12" rx="2"/><circle cx="12" cy="12" r="2.5"/><path d="M6 9.5v5M18 9.5v5"/>',
    chart: '<path d="M4 20V10M10 20V4M16 20v-7M22 20H2"/>',
    box: '<path d="m3 7 9-4 9 4-9 4z"/><path d="M3 7v10l9 4 9-4V7M12 11v10"/>',
    trophy: '<path d="M8 4h8v5a4 4 0 0 1-8 0zM8 6H4.5a3 3 0 0 0 3.5 4M16 6h3.5a3 3 0 0 1-3.5 4M12 13v4M8 21h8M9.5 17h5"/>',
    settings: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/>',
    menu: '<path d="M4 6h16M4 12h16M4 18h16"/>',
    plus: '<path d="M12 5v14M5 12h14"/>',
    search: '<circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/>',
    edit: '<path d="M4 20h4L19 9a2.8 2.8 0 0 0-4-4L4 16z"/><path d="m13.5 6.5 4 4"/>',
    trash: '<path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3"/>',
    start: '<path d="M7 4.5v15l12-7.5z"/>',
    stop: '<rect x="6" y="6" width="12" height="12" rx="1.5"/>',
    history: '<path d="M3 12a9 9 0 1 0 3-6.7L3 8"/><path d="M3 3v5h5M12 7v5l3 2"/>',
    minus: '<path d="M5 12h14"/>',
    close: '<path d="M6 6l12 12M18 6 6 18"/>',
    print: '<path d="M7 9V3h10v6M7 17H4v-7h16v7h-3"/><rect x="7" y="14" width="10" height="7" rx="1"/>',
    cup: '<path d="M4 8h13v5a6 6 0 0 1-12 0V8zM17 9h1.5a2.5 2.5 0 0 1 0 5H17M7 3v2M11 3v2"/>',
    chevronLeft: '<path d="m15 18-6-6 6-6"/>',
    chevronRight: '<path d="m9 18 6-6-6-6"/>',
    login: '<path d="M15 3h4a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2h-4M10 17l5-5-5-5M15 12H3"/>',
    phone: '<path d="M5 4h4l2 5-2.5 1.5a11 11 0 0 0 5 5L15 13l5 2v4a2 2 0 0 1-2 2A16 16 0 0 1 3 6a2 2 0 0 1 2-2"/>',
    user: '<circle cx="12" cy="8" r="4"/><path d="M4 21c.8-4 4-6 8-6s7.2 2 8 6"/>',
    download: '<path d="M12 4v11M7 10l5 5 5-5M5 20h14"/>',
};

// Returns an <svg> element for an icon name (icons are decorative, so screen readers skip them)
function createIcon(name) {
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.setAttribute("viewBox", "0 0 24 24");
    svg.setAttribute("fill", "none");
    svg.setAttribute("stroke", "currentColor");
    svg.setAttribute("stroke-width", "1.8");
    svg.setAttribute("stroke-linecap", "round");
    svg.setAttribute("stroke-linejoin", "round");
    svg.setAttribute("aria-hidden", "true");
    svg.innerHTML = ICON_PATHS[name] || ""; // our own fixed icon code, never user data
    return svg;
}

// Builds an element in one line. Text is always set with textContent (safe, never runs HTML).
//   buildElement("p", { className: "hint", text: "Hello" })
//   buildElement("button", { className: "btn", attrs: { type: "button" } }, createIcon("plus"), "Add")
function buildElement(tag, { className, text, attrs } = {}, ...children) {
    const element = document.createElement(tag);
    if (className) element.className = className;
    if (text !== undefined) element.textContent = text;
    for (const [name, value] of Object.entries(attrs || {})) {
        if (value !== undefined && value !== null && value !== false) element.setAttribute(name, value === true ? "" : value);
    }
    for (const child of children) {
        if (child !== null && child !== undefined && child !== false) element.append(child);
    }
    return element;
}

// Fills every <span data-icon="name"> on the page with its icon
function renderIcons(root = document) {
    root.querySelectorAll("[data-icon]").forEach((element) => {
        element.replaceChildren(createIcon(element.dataset.icon));
    });
}

// ---------- Toast notifications ----------
// showToast("Table saved")  or  showToast("Could not save", "error")
function showToast(message, type = "success", durationMs = 4000) {
    let container = document.querySelector(".toast-container");
    if (!container) {
        container = document.createElement("div");
        container.className = "toast-container";
        container.setAttribute("aria-live", "polite");
        document.body.appendChild(container);
    }

    const toast = document.createElement("div");
    toast.className = `toast toast-${type}`;
    toast.setAttribute("role", type === "error" ? "alert" : "status");

    const text = document.createElement("span");
    text.className = "toast-message";
    text.textContent = message; // textContent: safe, never runs HTML

    const closeButton = document.createElement("button");
    closeButton.type = "button";
    closeButton.className = "toast-close";
    closeButton.setAttribute("aria-label", "Close notification");
    closeButton.textContent = "×";
    closeButton.addEventListener("click", () => toast.remove());

    toast.append(text, closeButton);
    container.appendChild(toast);
    setTimeout(() => toast.remove(), durationMs);
}

// ---------- Confirm dialog ----------
// A nicer, on-brand replacement for the browser's confirm() box.
// Usage:  if (await confirmDialog("Delete Table 3?", { confirmText: "Delete", danger: true })) { ... }
// Resolves to true (confirmed) or false (cancelled, Esc, or clicked outside).
function confirmDialog(message, { title = "Are you sure?", confirmText = "Confirm", cancelText = "Cancel", danger = false } = {}) {
    return new Promise((resolve) => {
        const dialog = document.createElement("dialog");
        dialog.className = "modal modal-small";

        const content = document.createElement("div");
        content.className = "modal-content";

        const heading = document.createElement("h2");
        heading.className = "modal-title";
        heading.textContent = title;

        const text = document.createElement("p");
        text.className = "modal-text";
        text.textContent = message;

        const actions = document.createElement("div");
        actions.className = "modal-actions";

        // Answers straight away when a button is clicked (doesn't wait for the
        // browser's slightly delayed "close" event). "answered" makes sure we answer only once.
        let answered = false;
        function finish(isConfirmed) {
            if (answered) return;
            answered = true;
            if (dialog.open) dialog.close();
            dialog.remove();
            resolve(isConfirmed);
        }

        const cancelButton = document.createElement("button");
        cancelButton.type = "button";
        cancelButton.className = "btn btn-secondary";
        cancelButton.textContent = cancelText;
        cancelButton.addEventListener("click", () => finish(false));

        const confirmButton = document.createElement("button");
        confirmButton.type = "button";
        confirmButton.className = danger ? "btn btn-danger" : "btn btn-primary";
        confirmButton.textContent = confirmText;
        confirmButton.addEventListener("click", () => finish(true));

        actions.append(cancelButton, confirmButton);
        content.append(heading, text, actions);
        dialog.appendChild(content);

        // Clicking the dark area outside the box = cancel
        dialog.addEventListener("click", (event) => {
            if (event.target === dialog) finish(false);
        });
        // Esc key, or the dialog closed some other way = cancel
        dialog.addEventListener("close", () => finish(false));

        document.body.appendChild(dialog);
        dialog.showModal();
        cancelButton.focus(); // the safe choice is focused, so Enter doesn't delete by accident
    });
}

// ---------- Button loading state ----------
// setButtonLoading(saveButton, true, "Saving…")  ...  setButtonLoading(saveButton, false)
const originalButtonContent = new WeakMap(); // remembers a button's icon + text while it is busy

function setButtonLoading(button, isLoading, loadingText = "Working…") {
    if (isLoading) {
        if (!originalButtonContent.has(button)) originalButtonContent.set(button, [...button.childNodes]);
        button.disabled = true;
        button.setAttribute("aria-busy", "true");
        const spinner = document.createElement("span");
        spinner.className = "spinner";
        spinner.setAttribute("aria-hidden", "true");
        button.replaceChildren(spinner, document.createTextNode(" " + loadingText));
    } else {
        button.disabled = false;
        button.removeAttribute("aria-busy");
        if (originalButtonContent.has(button)) {
            button.replaceChildren(...originalButtonContent.get(button));
            originalButtonContent.delete(button);
        }
    }
}
