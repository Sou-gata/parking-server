const multer = require("multer");
const path = require("path");

const fs = require("fs");

const storage = multer.diskStorage({
    destination: function (req, file, cb) {
        let dir = "./uploads/documents";
        if (file.fieldname === "profile_photo") {
            dir = "./uploads/profile";
        } else if (
            file.fieldname === "org_media" ||
            file.fieldname.startsWith("org_media") ||
            file.fieldname === "media"
        ) {
            dir = "./uploads/media";
        } else if (
            file.fieldname === "trade_license_document"
        ) {
            dir = "./uploads/documents";
        }

        if (!fs.existsSync(dir)) {
            fs.mkdirSync(dir, { recursive: true });
        }
        cb(null, dir);
    },
    filename: function (req, file, cb) {
        // Use unique filename to avoid collisions
        const uniqueSuffix = Date.now() + "-" + Math.round(Math.random() * 1e9);
        cb(null, file.fieldname + "-" + uniqueSuffix + path.extname(file.originalname));
    },
});

const upload = multer({
    storage,
});

module.exports = { upload };
