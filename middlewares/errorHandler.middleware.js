const { ApiError } = require("../utils/ApiError");
const { cleanupUploadedFiles } = require("../utils/helperFunctions");

const errorHandler = (err, req, res, next) => {
    if (req.file || req.files) {
        cleanupUploadedFiles(req.file || req.files);
    }

    let error = err;

    if (!(error instanceof ApiError)) {
        const statusCode = error.statusCode || error.status || 500;
        const message = error.message || "Internal Server Error";
        error = new ApiError(
            statusCode,
            message,
            error.errors || [],
            err.stack
        );
    }

    const response = {
        success: error.success,
        statusCode: error.statusCode,
        message: error.message,
        errors: error.errors,
        ...(process.env.NODE_ENV === "development"
            ? { stack: error.stack }
            : {}),
    };

    console.error(
        `[Error] ${req.method} ${req.originalUrl} - Status: ${error.statusCode} - Message: ${error.message}`
    );
    if (error.stack && process.env.NODE_ENV === "development") {
        console.error(error.stack);
    }

    return res.status(error.statusCode).json(response);
};

module.exports = errorHandler;
