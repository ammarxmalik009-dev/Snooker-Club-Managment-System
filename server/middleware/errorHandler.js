// The ONE place where errors become JSON responses.
// Express calls this automatically when a route throws an error (Express 5 also
// catches errors from async functions, so routes don't need try/catch).

const mongoose = require("mongoose");
const AppError = require("../utils/AppError");
const { sendError } = require("../utils/response");
const env = require("../config/env");

// Turn any error into { statusCode, message, errors }
function describeError(error) {
  // 1. Errors we threw on purpose
  if (error instanceof AppError) {
    return { statusCode: error.statusCode, message: error.message, errors: error.errors };
  }

  // 2. The request body was not valid JSON (thrown by express.json())
  if (error.type === "entity.parse.failed") {
    return { statusCode: 400, message: "Request body is not valid JSON" };
  }
  if (error.type === "entity.too.large") {
    return { statusCode: 413, message: "Request body is too large" };
  }

  // 3. A Mongoose schema rule failed (e.g. a required field is missing)
  if (error instanceof mongoose.Error.ValidationError) {
    const errors = Object.values(error.errors).map((fieldError) => ({
      field: fieldError.path,
      message: fieldError.message,
    }));
    return { statusCode: 400, message: "Validation failed", errors };
  }

  // 4. A value had the wrong type, e.g. "abc" used as an id
  if (error instanceof mongoose.Error.CastError) {
    return { statusCode: 400, message: `Invalid value for ${error.path}` };
  }

  // 5. A unique index was violated (e.g. two tables with number 3)
  if (error.code === 11000) {
    const field = Object.keys(error.keyValue || {})[0] || "value";
    return { statusCode: 409, message: `A record with this ${field} already exists` };
  }

  // 6. MongoDB is not reachable
  if (error.name === "MongooseServerSelectionError" || error.name === "MongoNotConnectedError") {
    return { statusCode: 503, message: "The database is not available. Please try again shortly." };
  }

  // 7. Other known HTTP errors (they carry their own status, e.g. 404/405)
  const status = error.statusCode || error.status;
  if (Number.isInteger(status) && status >= 400 && status < 500) {
    return { statusCode: status, message: error.expose ? error.message : "Bad request" };
  }

  // 8. Anything else is a bug: hide the details from the user
  return { statusCode: 500, message: "Something went wrong on the server" };
}

// Express recognises an error handler because it has 4 parameters
// eslint-disable-next-line no-unused-vars
function errorHandler(error, req, res, next) {
  const { statusCode, message, errors } = describeError(error);

  if (statusCode >= 500) {
    // Full details go to the server log only, never to the browser
    console.error(`[${req.method} ${req.originalUrl}]`, env.isProduction ? error.message : error);
  }

  if (res.headersSent) return; // too late to send JSON; Express has already started replying
  sendError(res, message, statusCode, errors);
}

module.exports = errorHandler;
