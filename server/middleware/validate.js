// Runs a list of express-validator rules, then stops the request with a 400
// error (listing every wrong field) if any rule failed.
//
// Usage in a route file:
//   router.post("/", validate(createTableRules), controller.create);

const { validationResult } = require("express-validator");
const AppError = require("../utils/AppError");

function validate(rules) {
  return [
    ...rules,
    (req, res, next) => {
      const result = validationResult(req);
      if (result.isEmpty()) return next();

      // One message per field, e.g. [{ field: "tableNumber", message: "Table number is required" }]
      const errors = result
        .array({ onlyFirstError: true })
        .map((error) => ({ field: error.path, message: error.msg }));

      const message = errors.length === 1 ? errors[0].message : "Please correct the highlighted fields";
      next(new AppError(message, 400, errors));
    },
  ];
}

// Phase 11.8: every query value of this API is ONE value (a page, a date, a status...). A key given
// twice (?page=1&page=2) arrives as a list, which the rules above would accept item by item and a
// query could then fail with a 500. Such a request is refused with a clear 400, in the same format.
function singleQueryValues(req, res, next) {
  const errors = Object.entries(req.query || {})
    .filter(([, value]) => typeof value !== "string")
    .map(([field]) => ({ field, message: `"${field}" can only be given once` }));
  if (errors.length === 0) return next();
  next(new AppError(errors.length === 1 ? errors[0].message : "Please correct the highlighted fields", 400, errors));
}

module.exports = validate;
module.exports.singleQueryValues = singleQueryValues;
