// An error we throw on purpose, with an HTTP status code and a message that is
// safe to show to the user. Example:
//   throw new AppError("Table 3 already has an active session", 409);
// The central error handler (middleware/errorHandler.js) turns it into JSON.

class AppError extends Error {
  constructor(message, statusCode = 400, errors = undefined) {
    super(message);
    this.name = "AppError";
    this.statusCode = statusCode;
    this.errors = errors; // optional list of field errors, e.g. [{ field, message }]
  }
}

module.exports = AppError;
