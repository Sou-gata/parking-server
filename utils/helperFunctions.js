const fs = require("fs");
const path = require("path");
const os = require("os");

const saveBase64File = (base64String, folder, prefix) => {
    if (!base64String || !base64String.includes("base64,")) return null;

    try {
        const [meta, data] = base64String.split("base64,");
        const metaParts = meta.split("/");
        const extension = (metaParts.length > 1) ? metaParts[1].split(";")[0] : "jpg";
        const filename = `${prefix}-${Date.now()}-${Math.round(Math.random() * 1e4)}.${extension}`;

        // Path construction relative to the server root
        const relativePath = `uploads/${folder}/${filename}`;
        const absolutePath = path.join(
            __dirname,
            "..",
            "uploads",
            folder,
            filename
        );

        // Ensure directory exists
        const dir = path.dirname(absolutePath);
        if (!fs.existsSync(dir)) {
            fs.mkdirSync(dir, { recursive: true });
        }

        fs.writeFileSync(absolutePath, data, "base64");
        return relativePath;
    } catch (error) {
        console.error("Base64 Save Error:", error);
        return null;
    }
};

const deleteFile = (filePath) => {
    if (!filePath) return;
    try {
        const absolutePath = path.isAbsolute(filePath)
            ? filePath
            : path.join(__dirname, "..", filePath);
        if (fs.existsSync(absolutePath)) {
            fs.unlinkSync(absolutePath);
            console.log(`[Cleanup] Deleted file on failure: ${absolutePath}`);
        }
    } catch (error) {
        console.error("Error deleting file:", filePath, error);
    }
};

const cleanupUploadedFiles = (reqFiles, extraPaths = []) => {
    const extractPaths = (input) => {
        if (!input) return [];
        if (typeof input === "string") return [input];
        if (Array.isArray(input)) return input.flatMap(extractPaths);
        if (typeof input === "object") {
            if (input.path && typeof input.path === "string") {
                return [input.path];
            }
            return Object.values(input).flatMap(extractPaths);
        }
        return [];
    };

    const allPaths = [
        ...extractPaths(reqFiles),
        ...extractPaths(extraPaths),
    ];

    const uniquePaths = [...new Set(allPaths)];
    for (const filePath of uniquePaths) {
        deleteFile(filePath);
    }
};

function getLocalIPv4() {
    const interfaces = os.networkInterfaces();

    for (const interfaceName of Object.keys(interfaces)) {
        for (const iface of interfaces[interfaceName]) {
            if (iface.family === "IPv4" && !iface.internal) {
                return iface.address;
            }
        }
    }

    return null;
}

module.exports = { saveBase64File, deleteFile, cleanupUploadedFiles, getLocalIPv4 };

