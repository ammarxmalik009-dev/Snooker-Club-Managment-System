// Runs when no route or file matched the request.

const AppError = require("../utils/AppError");

// Unknown /api/... URL -> JSON 404 (handled by errorHandler)
function apiNotFound(req, res, next) {
  next(new AppError(`API endpoint not found: ${req.method} ${req.originalUrl}`, 404));
}

// Unknown page -> simple HTML 404 with a link back to the dashboard
function pageNotFound(req, res) {
  res
    .status(404)
    .type("html")
    .send(
      '<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><title>Page not found</title></head>' +
        '<body style="font-family:system-ui,sans-serif;background:#0b0d0c;color:#e8ecea;padding:40px">' +
        '<h1>Page not found</h1><p><a style="color:#34d399" href="/pages/dashboard.html">Go to the dashboard</a></p>' +
        "</body></html>"
    );
}

module.exports = { apiNotFound, pageNotFound };
