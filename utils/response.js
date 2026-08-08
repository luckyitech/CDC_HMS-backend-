const success = (res, data, statusCode = 200) => {
  res.status(statusCode).json({
    success: true,
    data,
  });
};

// `extra` merges extra top-level fields into the body, for the few errors the
// client must branch on rather than just display — e.g. a `code` that tells the
// frontend to route somewhere instead of showing a toast.
const error = (res, message, statusCode = 400, extra = {}) => {
  res.status(statusCode).json({
    success: false,
    message,
    ...extra,
  });
};

module.exports = { success, error };
