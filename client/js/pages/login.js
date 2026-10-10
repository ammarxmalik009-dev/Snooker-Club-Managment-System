// login.js - the login page.
// The password is sent once to the server and never stored by the page; the server answers
// with an httpOnly cookie that JavaScript can't read. Errors are always the same generic message.

const form = document.getElementById("login-form");
const errorBox = document.getElementById("login-error");
const button = document.getElementById("login-button");

// Where to go after logging in: only pages of this app (never another website)
function nextPage() {
    const next = new URLSearchParams(location.search).get("next") || "";
    return /^\/pages\/[a-z-]+\.html(\?[^#]*)?(#.*)?$/.test(next) && !next.startsWith("/pages/login.html")
        ? next
        : "/pages/dashboard.html";
}

function showError(message) {
    errorBox.textContent = message;
    errorBox.hidden = false;
}

// Already logged in? Go straight to the app.
apiRequest("/auth/me", { redirectOn401: false })
    .then(() => location.replace(nextPage()))
    .catch(() => document.getElementById("login-username").focus());

form.addEventListener("submit", async (event) => {
    event.preventDefault();
    errorBox.hidden = true;
    const username = form.elements.username.value.trim();
    const password = form.elements.password.value;
    if (!username || !password) return showError("Enter your username and password.");

    setButtonLoading(button, true, "Logging in…");
    try {
        await apiRequest("/auth/login", { method: "POST", body: { username, password }, redirectOn401: false });
        form.elements.password.value = ""; // don't keep the password in the page
        location.replace(nextPage());
    } catch (error) {
        // 401 -> "Invalid username or password." (never says which one), 429 -> too many attempts
        showError(error.status === 0 ? "Cannot reach the server. Is it running?" : error.message);
        form.elements.password.value = "";
        form.elements.password.focus();
        setButtonLoading(button, false);
    }
});
