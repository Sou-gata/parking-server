const { prisma } = require("../utils/db");
const bcrypt = require("bcrypt");
const { ApiError } = require("../utils/ApiError");
const { ApiResponse } = require("../utils/ApiResponse");
const { saveBase64File, cleanupUploadedFiles } = require("../utils/helperFunctions");
const { consumeVerificationToken } = require("./otp.controller");

const registerOrg = async (req, res) => {
    const savedFiles = [];
    try {
        const {
            org_name,
            username,
            email,
            phone_number,
            password,
            org_address,
            landmark,
            latitude,
            longitude,
            profile_photo, // Base64 string from app
            verification_document, // Base64 string from app
            aadhaar_card, // Base64 string from app
            trade_license_document, // Base64 string from app
            two_wheeler_capacity,
            three_wheeler_capacity,
            four_wheeler_capacity, // Shared mapping from app
            car_capacity,
            suv_capacity,
            van_capacity,
            pickup_capacity,
            ev_capacity,
            ev_charging_support,
            cctv_available,
            trade_license,
            zoning_clearance,
            shops_establishment_license,
            gst_registration,
            otp_verification_token,
        } = req.body;

        // Validation
        if (
            [org_name, username, email, phone_number, password].some(
                (f) => !f || String(f).trim() === ""
            )
        ) {
            throw new ApiError(400, "Required fields (including Phone Number) are missing");
        }

        // Save Files from FormData (Multer) or Base64 Fallback
        let profilePhotoPath = req.files?.["profile_photo"]?.[0]?.path
            ? req.files["profile_photo"][0].path
                  .replace(/\\/g, "/")
                  .replace(/^uploads\//, "")
            : null;
        if (!profilePhotoPath && profile_photo) {
            const saved = saveBase64File(profile_photo, "profile", "profile");
            if (saved) {
                savedFiles.push(saved);
                profilePhotoPath = saved.replace(/^uploads\//, "");
            }
        }

        let verificationDocumentPath = req.files?.[
            "verification_document"
        ]?.[0]?.path
            ? req.files["verification_document"][0].path
                  .replace(/\\/g, "/")
                  .replace(/^uploads\//, "")
            : null;
        if (!verificationDocumentPath && verification_document) {
            const saved = saveBase64File(
                verification_document,
                "documents",
                "doc"
            );
            if (saved) {
                savedFiles.push(saved);
                verificationDocumentPath = saved.replace(/^uploads\//, "");
            }
        }

        let aadhaarCardPath = req.files?.["aadhaar_card"]?.[0]?.path
            ? req.files["aadhaar_card"][0].path
                  .replace(/\\/g, "/")
                  .replace(/^uploads\//, "")
            : null;
        if (!aadhaarCardPath && aadhaar_card) {
            const saved = saveBase64File(aadhaar_card, "documents", "aadhaar");
            if (saved) {
                savedFiles.push(saved);
                aadhaarCardPath = saved.replace(/^uploads\//, "");
            }
        }

        // Trade License Document
        let tradeLicenseDocPath = req.files?.["trade_license_document"]?.[0]?.path
            ? req.files["trade_license_document"][0].path
                  .replace(/\\/g, "/")
                  .replace(/^uploads\//, "")
            : null;
        if (!tradeLicenseDocPath && trade_license_document) {
            const saved = saveBase64File(
                trade_license_document,
                "documents",
                "trade_license"
            );
            if (saved) {
                savedFiles.push(saved);
                tradeLicenseDocPath = saved.replace(/^uploads\//, "");
            }
        }

        // Validate: if trade_license is declared true, document is mandatory
        const isTradeLicenseTrue = trade_license === true || trade_license === "true" || trade_license === "yes";
        if (isTradeLicenseTrue && !tradeLicenseDocPath) {
            throw new ApiError(400, "Trade License document is required when Trade License is declared as Yes");
        }

        // Use transaction to check existence and insert org
        await prisma.$transaction(async (tx) => {
            // Verify OTP Token before creating agency user
            await consumeVerificationToken(phone_number, otp_verification_token, tx);

            const existing = await tx.orgUser.findFirst({
                where: {
                    OR: [{ username: username }, { email: email }],
                },
            });

            if (existing) {
                throw new ApiError(409, "User already exists");
            }

            // Hash password
            const passwordHash = await bcrypt.hash(password, 10);

            // Insert Org
            const createdOrg = await tx.orgUser.create({
                data: {
                    org_name,
                    username,
                    email,
                    phone_number: phone_number || null,
                    password_hash: passwordHash,
                    org_address: org_address || null,
                    landmark: landmark || null,
                    latitude:
                        latitude !== undefined && latitude !== null
                            ? parseFloat(latitude)
                            : 0,
                    longitude:
                        longitude !== undefined && longitude !== null
                            ? parseFloat(longitude)
                            : 0,
                    profile_photo_path: profilePhotoPath,
                    verification_document_path: verificationDocumentPath,
                    aadhaar_card_path: aadhaarCardPath,
                    two_wheeler_capacity: parseInt(two_wheeler_capacity) || 0,
                    three_wheeler_capacity:
                        parseInt(three_wheeler_capacity) || 0,
                    car_capacity:
                        parseInt(car_capacity || four_wheeler_capacity) || 0,
                    suv_capacity: parseInt(suv_capacity) || 0,
                    van_capacity: parseInt(van_capacity) || 0,
                    pickup_capacity: parseInt(pickup_capacity) || 0,
                    ev_capacity: parseInt(ev_capacity) || 0,
                    ev_charging_support: ev_charging_support === true || ev_charging_support === "true" || ev_charging_support === "yes",
                    cctv_available: cctv_available === true || cctv_available === "true" || cctv_available === "yes",
                    trade_license: isTradeLicenseTrue,
                    trade_license_document_path: tradeLicenseDocPath || null,
                    zoning_clearance: zoning_clearance === true || zoning_clearance === "true" || zoning_clearance === "yes",
                    shops_establishment_license: shops_establishment_license === true || shops_establishment_license === "true" || shops_establishment_license === "yes",
                    gst_registration: gst_registration === true || gst_registration === "true" || gst_registration === "yes",
                    two_wheeler_rate: 20,
                    three_wheeler_rate: 30,
                    car_rate: 40,
                    suv_rate: 50,
                    van_rate: 50,
                    pickup_rate: 50,
                    ev_rate: 60,
                },
            });

            // Process optional Org Media (photos / videos up to 10)
            const uploadedMediaFiles = req.files?.["org_media"] || [];
            let mediaItems = [];

            for (const file of uploadedMediaFiles) {
                const cleanPath = file.path
                    .replace(/\\/g, "/")
                    .replace(/^uploads\//, "");
                const isVideo =
                    file.mimetype?.includes("video") ||
                    /\.(mp4|mov|avi|mkv|webm)$/i.test(file.originalname);
                mediaItems.push({
                    file_path: cleanPath,
                    file_type: isVideo ? "video" : "photo",
                });
            }

            let base64MediaList = req.body.org_media;
            if (base64MediaList) {
                if (typeof base64MediaList === "string") {
                    try {
                        base64MediaList = JSON.parse(base64MediaList);
                    } catch (e) {
                        base64MediaList = [base64MediaList];
                    }
                }
                if (Array.isArray(base64MediaList)) {
                    for (const item of base64MediaList) {
                        if (mediaItems.length >= 10) break;
                        const b64Str =
                            typeof item === "string" ? item : item?.base64 || item?.uri;
                        const typeHint = typeof item === "object" ? item?.type : null;
                        const isVideo =
                            typeHint === "video" || b64Str?.includes("video/");
                        const savedPath = saveBase64File(
                            b64Str,
                            "media",
                            isVideo ? "vid" : "img"
                        );
                        if (savedPath) {
                            savedFiles.push(savedPath);
                            const cleanPath = savedPath.replace(/^uploads\//, "");
                            mediaItems.push({
                                file_path: cleanPath,
                                file_type: isVideo ? "video" : "photo",
                            });
                        }
                    }
                }
            }

            mediaItems = mediaItems.slice(0, 10);

            for (const item of mediaItems) {
                await tx.orgMedia.create({
                    data: {
                        org_id: createdOrg.org_id,
                        file_path: item.file_path,
                        file_type: item.file_type,
                        status: "pending",
                    },
                });
            }
        });

        return new ApiResponse(
            201,
            null,
            "Organization registered successfully"
        ).send(res);
    } catch (error) {
        console.error("registerOrg Error:", error);
        cleanupUploadedFiles(req.files || req.file, savedFiles);
        if (error instanceof ApiError)
            return new ApiError(error.statusCode, error.message).send(res);
        return new ApiError(500, error.message).send(res);
    }
};

module.exports = {
    registerOrg,
};
