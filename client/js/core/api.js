// api.js - the ONE helper every page uses to talk to the server.
// The API is on the same address as the website, so paths are simply "/api/...".

class ApiError extends Error {
    constructor(message, status, data, errors) {
        super(message);
        this.status = status;       // HTTP status (0 = server not reachable)
        this.data = data;           // extra details the server sent, if any
        this.errors = errors || []; // field errors, e.g. [{ field: "tableNumber", message: "…" }]
    }
}

// Not logged in (or the login expired): go to the login page, then come back here afterwards
function goToLogin() {
    if (location.pathname === "/pages/login.html") return;
    location.href = `/pages/login.html?next=${encodeURIComponent(location.pathname + location.search)}`;
}

// Example: const result = await apiRequest("/health");
//          await apiRequest("/tables", { method: "POST", body: { tableNumber: 3 } });
// The login cookie is sent automatically by the browser (same website); JavaScript never sees it.
async function apiRequest(path, { method = "GET", body, redirectOn401 = true } = {}) {
    const options = { method, headers: { Accept: "application/json" } };

    if (body !== undefined) {
        options.headers["Content-Type"] = "application/json";
        options.body = JSON.stringify(body);
    }

    let response;
    try {
        response = await fetch("/api" + path, options);
    } catch {
        throw new ApiError("Cannot reach the server. Is it running?", 0);
    }

    // Every API answer is JSON: { success, message, data }
    const result = await response.json().catch(() => null);

    if (response.status === 401 && redirectOn401) goToLogin();

    if (!response.ok || !result || !result.success) {
        const message = (result && result.message) || `Request failed (status ${response.status})`;
        throw new ApiError(message, response.status, result && result.data, result && result.errors);
    }
    return result;
}
