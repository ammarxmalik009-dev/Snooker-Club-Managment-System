// Every API response has the same shape, so the frontend always knows what to expect:
//   success: { "success": true,  "message": "...", "data": ... }
//   error:   { "success": false, "message": "...", "errors": [...] (optional) }

function sendSuccess(res, message, data = null, statusCode = 200) {
  return res.status(statusCode).json({ success: true, message, data });
}

function sendError(res, message, statusCode = 400, errors = undefined) {
  const body = { success: false, message };
  if (errors && errors.length > 0) body.errors = errors;
  return res.status(statusCode).json(body);
}

module.exports = { sendSuccess, sendError };
