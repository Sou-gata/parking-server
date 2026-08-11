const { prisma } = require("./db");
const bcrypt = require("bcrypt");
const Logger = require("./log");

async function createTables() {
    const dbType = process.env.DB_TYPE || "mssql";

    try {
        if (dbType === "mysql") {
            const mysqlUsersTable = `
                CREATE TABLE IF NOT EXISTS users (
                    user_id INT AUTO_INCREMENT PRIMARY KEY,
                    full_name VARCHAR(100) NOT NULL,
                    username VARCHAR(50) NOT NULL UNIQUE,
                    email VARCHAR(100) NOT NULL UNIQUE,
                    phone_number VARCHAR(20),
                    password_hash TEXT NOT NULL,
                    user_address TEXT,
                    landmark VARCHAR(255),
                    latitude DECIMAL(12, 9),
                    longitude DECIMAL(12, 9),
                    profile_photo_path VARCHAR(500),
                    role VARCHAR(50) NOT NULL DEFAULT 'user',
                    status VARCHAR(50) NOT NULL DEFAULT 'active',
                    agency_id INT NULL,
                    vehicle_numbers VARCHAR(1000) NULL,
                    driving_licence VARCHAR(100) NULL,
                    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
                );
            `;

            const mysqlOrgUsersTable = `
                CREATE TABLE IF NOT EXISTS org_users (
                    org_id INT AUTO_INCREMENT PRIMARY KEY,
                    org_name VARCHAR(200) NOT NULL,
                    username VARCHAR(50) NOT NULL UNIQUE,
                    email VARCHAR(100) NOT NULL UNIQUE,
                    phone_number VARCHAR(20),
                    password_hash TEXT NOT NULL,
                    org_address TEXT,
                    landmark VARCHAR(255),
                    latitude DECIMAL(12, 9),
                    longitude DECIMAL(12, 9),
                    profile_photo_path VARCHAR(500),
                    verification_document_path VARCHAR(500), 
                    aadhaar_card_path VARCHAR(500), 
                    two_wheeler_capacity INT DEFAULT 0,
                    three_wheeler_capacity INT DEFAULT 0,
                    car_capacity INT DEFAULT 0,
                    suv_capacity INT DEFAULT 0,
                    van_capacity INT DEFAULT 0,
                    pickup_capacity INT DEFAULT 0,
                    ev_capacity INT DEFAULT 0,
                    ev_charging_support TINYINT(1) DEFAULT 0,
                    two_wheeler_rate DECIMAL(10, 2) DEFAULT 20.00,
                    three_wheeler_rate DECIMAL(10, 2) DEFAULT 30.00,
                    car_rate DECIMAL(10, 2) DEFAULT 40.00,
                    suv_rate DECIMAL(10, 2) DEFAULT 50.00,
                    van_rate DECIMAL(10, 2) DEFAULT 50.00,
                    pickup_rate DECIMAL(10, 2) DEFAULT 50.00,
                    ev_rate DECIMAL(10, 2) DEFAULT 60.00,
                    status VARCHAR(50) NOT NULL DEFAULT 'pending',
                    commission_percentage DECIMAL(5, 2) DEFAULT 0.00,
                    wallet_balance DECIMAL(10, 2) DEFAULT 0.00,
                    cancellation_policy TEXT NULL,
                    cctv_available TINYINT(1) DEFAULT 0,
                    trade_license TINYINT(1) DEFAULT 0,
                    zoning_clearance TINYINT(1) DEFAULT 0,
                    shops_establishment_license TINYINT(1) DEFAULT 0,
                    gst_registration TINYINT(1) DEFAULT 0,
                    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
                );
            `;

            const mysqlAgencyTransactionsTable = `
                CREATE TABLE IF NOT EXISTS agency_transactions (
                    transaction_id INT AUTO_INCREMENT PRIMARY KEY,
                    agency_id INT NOT NULL,
                    booking_id INT NOT NULL,
                    total_amount DECIMAL(10, 2) NOT NULL,
                    approved_amount DECIMAL(10, 2) NULL,
                    commission_rate DECIMAL(5, 2) NOT NULL,
                    admin_share DECIMAL(10, 2) NOT NULL,
                    agency_share DECIMAL(10, 2) NOT NULL,
                    status VARCHAR(50) NOT NULL DEFAULT 'pending',
                    rejection_reason TEXT NULL,
                    approved_by INT NULL,
                    approved_at DATETIME NULL,
                    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
                );
            `;

            const mysqlBookingsTable = `
                CREATE TABLE IF NOT EXISTS bookings (
                    booking_id INT AUTO_INCREMENT PRIMARY KEY,
                    booking_code VARCHAR(50) NOT NULL UNIQUE,
                    user_id INT,
                    user_name VARCHAR(100) NOT NULL,
                    user_phone VARCHAR(20),
                    agency_id INT NOT NULL,
                    agency_name VARCHAR(200) NOT NULL,
                    vehicle_type VARCHAR(50) NOT NULL,
                    vehicle_number VARCHAR(50) NOT NULL,
                    status VARCHAR(50) NOT NULL DEFAULT 'booked',
                    start_time DATETIME NULL,
                    end_time DATETIME NULL,
                    booking_start_time DATETIME NULL,
                    booking_end_time DATETIME NULL,
                    checkin_time DATETIME NULL,
                    checkout_time DATETIME NULL,
                    booked_duration DECIMAL(10, 2) NOT NULL,
                    hourly_rate DECIMAL(10, 2) NOT NULL,
                    total_bill DECIMAL(10, 2) DEFAULT 0,
                    payment_status VARCHAR(50) NOT NULL DEFAULT 'pending',
                    otp VARCHAR(6) NULL,
                    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
                );
            `;

            const mysqlWalletTransactionsTable = `
                CREATE TABLE IF NOT EXISTS wallet_transactions (
                    transaction_id INT AUTO_INCREMENT PRIMARY KEY,
                    user_id INT NOT NULL,
                    amount DECIMAL(10, 2) NOT NULL,
                    type VARCHAR(50) NOT NULL,
                    status VARCHAR(50) NOT NULL DEFAULT 'pending',
                    transaction_number VARCHAR(100) NULL,
                    screenshot_path VARCHAR(500) NULL,
                    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
                );
            `;

            const mysqlConfigurationsTable = `
                CREATE TABLE IF NOT EXISTS configurations (
                    config_id INT AUTO_INCREMENT PRIMARY KEY,
                    config_key VARCHAR(100) NOT NULL UNIQUE,
                    config_value TEXT NOT NULL
                );
            `;

            const mysqlRatingsTable = `
                CREATE TABLE IF NOT EXISTS ratings (
                    rating_id INT AUTO_INCREMENT PRIMARY KEY,
                    user_id INT NOT NULL,
                    agency_id INT NOT NULL,
                    booking_id INT NULL,
                    rating TINYINT NOT NULL CHECK (rating >= 1 AND rating <= 5),
                    review TEXT NULL,
                    rating_type VARCHAR(50) NOT NULL DEFAULT 'user_to_agency',
                    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
                    UNIQUE KEY uq_booking_rating_type (booking_id, rating_type)
                );
            `;

            const mysqlNotificationTable = `
                CREATE TABLE IF NOT EXISTS notifications (
                    notification_id INT NOT NULL AUTO_INCREMENT,
                    recipient_id INT NOT NULL,
                    type VARCHAR(100) NOT NULL,
                    title VARCHAR(255) NOT NULL,
                    message TEXT NOT NULL,
                    data TEXT NULL,
                    is_read BOOLEAN NOT NULL DEFAULT FALSE,
                    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,

                    PRIMARY KEY (notification_id),
                    INDEX idx_notifications_recipient_created (recipient_id, created_at)
                );
            `;

            const mysqlNotificationPreferencesTable = `
                CREATE TABLE IF NOT EXISTS notification_preferences (
                    recipient_id INT NOT NULL PRIMARY KEY,
                    enabled BOOLEAN NOT NULL DEFAULT TRUE,
                    updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
                );
            `;

            const mysqlOrgMediaTable = `
                CREATE TABLE IF NOT EXISTS org_media (
                    media_id INT AUTO_INCREMENT PRIMARY KEY,
                    org_id INT NOT NULL,
                    file_path VARCHAR(500) NOT NULL,
                    pending_file_path VARCHAR(500) NULL,
                    file_type VARCHAR(50) NOT NULL DEFAULT 'photo',
                    status VARCHAR(50) NOT NULL DEFAULT 'pending',
                    rejection_reason TEXT NULL,
                    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
                    INDEX idx_org_media_org_id (org_id)
                );
            `;

            const mysqlOrgWorkingHoursTable = `
                CREATE TABLE IF NOT EXISTS org_working_hours (
                    id INT AUTO_INCREMENT PRIMARY KEY,
                    org_id INT NOT NULL UNIQUE,
                    working_days TEXT NULL,
                    open_time VARCHAR(10) NULL,
                    close_time VARCHAR(10) NULL,
                    is_24_7 TINYINT(1) DEFAULT 0,
                    special_vacations TEXT NULL,
                    daily_schedules TEXT NULL,
                    pending_working_days TEXT NULL,
                    pending_open_time VARCHAR(10) NULL,
                    pending_close_time VARCHAR(10) NULL,
                    pending_is_24_7 TINYINT(1) DEFAULT 0,
                    pending_special_vacations TEXT NULL,
                    pending_daily_schedules TEXT NULL,
                    status VARCHAR(50) NOT NULL DEFAULT 'approved',
                    rejection_reason TEXT NULL,
                    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
                );
            `;

            const mysqlComplaintsTable = `
                CREATE TABLE IF NOT EXISTS complaints (
                    complaint_id INT AUTO_INCREMENT PRIMARY KEY,
                    booking_id INT NOT NULL,
                    user_id INT NOT NULL,
                    agency_id INT NOT NULL,
                    complainant_type VARCHAR(50) NOT NULL DEFAULT 'user_to_agency',
                    complainant_id INT NOT NULL,
                    subject VARCHAR(255) NULL,
                    description TEXT NOT NULL,
                    status VARCHAR(50) NOT NULL DEFAULT 'pending',
                    resolution_notes TEXT NULL,
                    resolved_by INT NULL,
                    resolved_at DATETIME NULL,
                    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
                    UNIQUE KEY uq_booking_complainant_type (booking_id, complainant_type)
                );
            `;

            const mysqlComplaintStepsTable = `
                CREATE TABLE IF NOT EXISTS complaint_steps (
                    step_id INT AUTO_INCREMENT PRIMARY KEY,
                    complaint_id INT NOT NULL,
                    step_number INT NOT NULL DEFAULT 1,
                    action_by_role VARCHAR(50) NOT NULL,
                    action_by_id INT NOT NULL,
                    previous_status VARCHAR(50) NULL,
                    new_status VARCHAR(50) NOT NULL,
                    comment TEXT NOT NULL,
                    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                    FOREIGN KEY (complaint_id) REFERENCES complaints(complaint_id) ON DELETE CASCADE
                );
            `;

            const mysqlUserStatusLogsTable = `
    CREATE TABLE IF NOT EXISTS user_status_logs (
        log_id INT AUTO_INCREMENT PRIMARY KEY,
        user_id INT NOT NULL,
        previous_status VARCHAR(50) NOT NULL,
        new_status VARCHAR(50) NOT NULL,
        reason TEXT NOT NULL,
        changed_by INT NOT NULL,
        changed_by_role VARCHAR(50) NOT NULL,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        INDEX idx_user_status_logs_user_id (user_id)
    );
`;

            await prisma.$executeRawUnsafe(mysqlUsersTable);
            await prisma.$executeRawUnsafe(mysqlOrgUsersTable);
            await prisma.$executeRawUnsafe(mysqlBookingsTable);
            await prisma.$executeRawUnsafe(mysqlWalletTransactionsTable);
            await prisma.$executeRawUnsafe(mysqlConfigurationsTable);
            await prisma.$executeRawUnsafe(mysqlRatingsTable);
            await prisma.$executeRawUnsafe(mysqlAgencyTransactionsTable);
            await prisma.$executeRawUnsafe(mysqlNotificationTable);
            await prisma.$executeRawUnsafe(mysqlNotificationPreferencesTable);
            await prisma.$executeRawUnsafe(mysqlOrgMediaTable);
            await prisma.$executeRawUnsafe(mysqlOrgWorkingHoursTable);
            await prisma.$executeRawUnsafe(mysqlComplaintsTable);
            await prisma.$executeRawUnsafe(mysqlComplaintStepsTable);
            await prisma.$executeRawUnsafe(mysqlUserStatusLogsTable);

            // Safe ALTER queries for existing MySQL databases
            try {
                await prisma.$executeRawUnsafe(
                    "ALTER TABLE users ADD COLUMN role VARCHAR(50) NOT NULL DEFAULT 'user'"
                );
            } catch (e) {}
            try {
                await prisma.$executeRawUnsafe(
                    "ALTER TABLE users ADD COLUMN status VARCHAR(50) NOT NULL DEFAULT 'active'"
                );
            } catch (e) {}
            try {
                await prisma.$executeRawUnsafe(
                    "ALTER TABLE users ADD COLUMN agency_id INT NULL"
                );
            } catch (e) {}
            try {
                await prisma.$executeRawUnsafe(
                    "ALTER TABLE users ADD COLUMN wallet_balance DECIMAL(10, 2) DEFAULT 0.00"
                );
            } catch (e) {}
            try {
                await prisma.$executeRawUnsafe(
                    "ALTER TABLE users ADD COLUMN vehicle_numbers VARCHAR(1000) NULL"
                );
            } catch (e) {}
            try {
                await prisma.$executeRawUnsafe(
                    "ALTER TABLE users ADD COLUMN driving_licence VARCHAR(100) NULL"
                );
            } catch (e) {}
            try {
                await prisma.$executeRawUnsafe(
                    "ALTER TABLE wallet_transactions ADD COLUMN transaction_number VARCHAR(100) NULL"
                );
            } catch (e) {}
            try {
                await prisma.$executeRawUnsafe(
                    "ALTER TABLE wallet_transactions ADD COLUMN screenshot_path VARCHAR(500) NULL"
                );
            } catch (e) {}
            try {
                await prisma.$executeRawUnsafe(
                    "ALTER TABLE org_working_hours ADD COLUMN daily_schedules TEXT NULL"
                );
            } catch (e) {}
            try {
                await prisma.$executeRawUnsafe(
                    "ALTER TABLE org_working_hours ADD COLUMN pending_daily_schedules TEXT NULL"
                );
            } catch (e) {}
            try {
                await prisma.$executeRawUnsafe(
                    "ALTER TABLE wallet_transactions ADD COLUMN agency_id INT NULL"
                );
            } catch (e) {}
            try {
                await prisma.$executeRawUnsafe(
                    "ALTER TABLE wallet_transactions ADD COLUMN rejection_reason TEXT NULL"
                );
            } catch (e) {}
            try {
                await prisma.$executeRawUnsafe(
                    "ALTER TABLE org_users ADD COLUMN status VARCHAR(50) NOT NULL DEFAULT 'pending'"
                );
            } catch (e) {}
            try {
                await prisma.$executeRawUnsafe(
                    "ALTER TABLE bookings ADD COLUMN refund_amount DECIMAL(10, 2) DEFAULT 0.00"
                );
            } catch (e) {}
            try {
                await prisma.$executeRawUnsafe(
                    "ALTER TABLE bookings ADD COLUMN refund_notes TEXT NULL"
                );
            } catch (e) {}
            try {
                await prisma.$executeRawUnsafe(
                    "ALTER TABLE bookings ADD COLUMN refunded_at DATETIME NULL"
                );
            } catch (e) {}
            try {
                await prisma.$executeRawUnsafe(
                    "ALTER TABLE bookings ADD COLUMN refunded_by INT NULL"
                );
            } catch (e) {}
            try {
                await prisma.$executeRawUnsafe(
                    "ALTER TABLE org_users ADD COLUMN aadhaar_card_path VARCHAR(500) NULL"
                );
            } catch (e) {}
            try {
                await prisma.$executeRawUnsafe(
                    "ALTER TABLE org_users ADD COLUMN cctv_available TINYINT(1) DEFAULT 0"
                );
            } catch (e) {}
            try {
                await prisma.$executeRawUnsafe(
                    "ALTER TABLE org_users ADD COLUMN trade_license TINYINT(1) DEFAULT 0"
                );
            } catch (e) {}
            try {
                await prisma.$executeRawUnsafe(
                    "ALTER TABLE org_users ADD COLUMN zoning_clearance TINYINT(1) DEFAULT 0"
                );
            } catch (e) {}
            try {
                await prisma.$executeRawUnsafe(
                    "ALTER TABLE org_users ADD COLUMN shops_establishment_license TINYINT(1) DEFAULT 0"
                );
            } catch (e) {}
            try {
                await prisma.$executeRawUnsafe(
                    "ALTER TABLE org_users ADD COLUMN gst_registration TINYINT(1) DEFAULT 0"
                );
            } catch (e) {}
            try {
                await prisma.$executeRawUnsafe(
                    "ALTER TABLE org_users ADD COLUMN two_wheeler_rate DECIMAL(10, 2) DEFAULT 20.00"
                );
            } catch (e) {}
            try {
                await prisma.$executeRawUnsafe(
                    "ALTER TABLE org_users ADD COLUMN three_wheeler_rate DECIMAL(10, 2) DEFAULT 30.00"
                );
            } catch (e) {}
            try {
                await prisma.$executeRawUnsafe(
                    "ALTER TABLE org_users ADD COLUMN car_rate DECIMAL(10, 2) DEFAULT 40.00"
                );
            } catch (e) {}
            try {
                await prisma.$executeRawUnsafe(
                    "ALTER TABLE org_users ADD COLUMN suv_rate DECIMAL(10, 2) DEFAULT 50.00"
                );
            } catch (e) {}
            try {
                await prisma.$executeRawUnsafe(
                    "ALTER TABLE org_users ADD COLUMN van_rate DECIMAL(10, 2) DEFAULT 50.00"
                );
            } catch (e) {}
            try {
                await prisma.$executeRawUnsafe(
                    "ALTER TABLE org_users ADD COLUMN pickup_rate DECIMAL(10, 2) DEFAULT 50.00"
                );
            } catch (e) {}
            try {
                await prisma.$executeRawUnsafe(
                    "ALTER TABLE org_users ADD COLUMN ev_rate DECIMAL(10, 2) DEFAULT 60.00"
                );
            } catch (e) {}
            try {
                await prisma.$executeRawUnsafe(
                    "ALTER TABLE org_users ADD COLUMN cancellation_policy TEXT NULL"
                );
            } catch (e) {}
            try {
                await prisma.$executeRawUnsafe(
                    "ALTER TABLE org_users ADD COLUMN commission_percentage DECIMAL(5, 2) DEFAULT 0.00"
                );
            } catch (e) {}
            try {
                await prisma.$executeRawUnsafe(
                    "ALTER TABLE org_users ADD COLUMN wallet_balance DECIMAL(10, 2) DEFAULT 0.00"
                );
            } catch (e) {}
            try {
                await prisma.$executeRawUnsafe(
                    "ALTER TABLE bookings ADD COLUMN booking_start_time DATETIME NULL"
                );
            } catch (e) {}
            try {
                await prisma.$executeRawUnsafe(
                    "ALTER TABLE bookings ADD COLUMN booking_end_time DATETIME NULL"
                );
            } catch (e) {}
            try {
                await prisma.$executeRawUnsafe(
                    "ALTER TABLE bookings ADD COLUMN checkin_time DATETIME NULL"
                );
            } catch (e) {}
            try {
                await prisma.$executeRawUnsafe(
                    "ALTER TABLE bookings ADD COLUMN checkout_time DATETIME NULL"
                );
            } catch (e) {}
            try {
                await prisma.$executeRawUnsafe(
                    "ALTER TABLE bookings ADD COLUMN otp VARCHAR(6) NULL"
                );
            } catch (e) {}
            try {
                await prisma.$executeRawUnsafe(
                    "ALTER TABLE bookings ADD COLUMN is_force_cancelled TINYINT(1) DEFAULT 0"
                );
            } catch (e) {}
            try {
                await prisma.$executeRawUnsafe(
                    "ALTER TABLE bookings ADD COLUMN cancelled_by VARCHAR(50) NULL"
                );
            } catch (e) {}
            try {
                await prisma.$executeRawUnsafe(
                    "ALTER TABLE bookings ADD COLUMN cancellation_reason TEXT NULL"
                );
            } catch (e) {}
            try {
                await prisma.$executeRawUnsafe(
                    "ALTER TABLE org_users ADD COLUMN require_booking_approval TINYINT(1) DEFAULT 0"
                );
            } catch (e) {}
            try {
                await prisma.$executeRawUnsafe(
                    "ALTER TABLE bookings ADD COLUMN approved_by INT NULL"
                );
            } catch (e) {}
            try {
                await prisma.$executeRawUnsafe(
                    "ALTER TABLE bookings ADD COLUMN approved_at DATETIME NULL"
                );
            } catch (e) {}
            try {
                await prisma.$executeRawUnsafe(
                    "ALTER TABLE bookings ADD COLUMN rejected_by INT NULL"
                );
            } catch (e) {}
            try {
                await prisma.$executeRawUnsafe(
                    "ALTER TABLE bookings ADD COLUMN rejected_at DATETIME NULL"
                );
            } catch (e) {}
            try {
                await prisma.$executeRawUnsafe(
                    "ALTER TABLE bookings ADD COLUMN rejection_reason TEXT NULL"
                );
            } catch (e) {}
            try {
                await prisma.$executeRawUnsafe(
                    "ALTER TABLE agency_transactions ADD COLUMN status VARCHAR(50) NOT NULL DEFAULT 'pending'"
                );
            } catch (e) {}
            try {
                await prisma.$executeRawUnsafe(
                    "ALTER TABLE agency_transactions ADD COLUMN approved_amount DECIMAL(10, 2) NULL"
                );
            } catch (e) {}
            try {
                await prisma.$executeRawUnsafe(
                    "ALTER TABLE agency_transactions ADD COLUMN rejection_reason TEXT NULL"
                );
            } catch (e) {}
            try {
                await prisma.$executeRawUnsafe(
                    "ALTER TABLE agency_transactions ADD COLUMN approved_by INT NULL"
                );
            } catch (e) {}
            try {
                await prisma.$executeRawUnsafe(
                    "ALTER TABLE agency_transactions ADD COLUMN approved_at DATETIME NULL"
                );
            } catch (e) {}

            Logger.success("MySQL database schema check/creation completed.");
        } else {
            // MSSQL queries
            const mssqlUsersTable = `
                IF NOT EXISTS (SELECT * FROM sys.objects WHERE object_id = OBJECT_ID(N'[dbo].[users]') AND type in (N'U'))
                BEGIN
                    CREATE TABLE users (
                        user_id INT IDENTITY(1,1) PRIMARY KEY,
                        full_name NVARCHAR(100) NOT NULL,
                        username NVARCHAR(50) NOT NULL UNIQUE,
                        email NVARCHAR(100) NOT NULL UNIQUE,
                        phone_number NVARCHAR(20),
                        password_hash NVARCHAR(MAX) NOT NULL,
                        user_address NVARCHAR(MAX),
                        landmark NVARCHAR(255),
                        latitude DECIMAL(12, 9),
                        longitude DECIMAL(12, 9),
                        profile_photo_path NVARCHAR(500),
                        role NVARCHAR(50) NOT NULL DEFAULT 'user',
                        status NVARCHAR(50) NOT NULL DEFAULT 'active',
                        agency_id INT NULL,
                        vehicle_numbers NVARCHAR(1000) NULL,
                        driving_licence NVARCHAR(100) NULL,
                        created_at DATETIME DEFAULT GETDATE(),
                        updated_at DATETIME DEFAULT GETDATE()
                    );
                END
            `;

            const mssqlOrgUsersTable = `
                IF NOT EXISTS (SELECT * FROM sys.objects WHERE object_id = OBJECT_ID(N'[dbo].[org_users]') AND type in (N'U'))
                BEGIN
                    CREATE TABLE org_users (
                        org_id INT IDENTITY(1,1) PRIMARY KEY,
                        org_name NVARCHAR(200) NOT NULL,
                        username NVARCHAR(50) NOT NULL UNIQUE,
                        email NVARCHAR(100) NOT NULL UNIQUE,
                        phone_number NVARCHAR(20),
                        password_hash NVARCHAR(MAX) NOT NULL,
                        org_address NVARCHAR(MAX),
                        landmark NVARCHAR(255),
                        latitude DECIMAL(12, 9),
                        longitude DECIMAL(12, 9),
                        profile_photo_path NVARCHAR(500),
                        verification_document_path NVARCHAR(500), 
                        aadhaar_card_path NVARCHAR(500), 
                        two_wheeler_capacity INT DEFAULT 0,
                        three_wheeler_capacity INT DEFAULT 0,
                        car_capacity INT DEFAULT 0,
                        suv_capacity INT DEFAULT 0,
                        van_capacity INT DEFAULT 0,
                        pickup_capacity INT DEFAULT 0,
                        ev_capacity INT DEFAULT 0,
                        ev_charging_support BIT DEFAULT 0,
                        two_wheeler_rate DECIMAL(10, 2) DEFAULT 20.00,
                        three_wheeler_rate DECIMAL(10, 2) DEFAULT 30.00,
                        car_rate DECIMAL(10, 2) DEFAULT 40.00,
                        suv_rate DECIMAL(10, 2) DEFAULT 50.00,
                        van_rate DECIMAL(10, 2) DEFAULT 50.00,
                        pickup_rate DECIMAL(10, 2) DEFAULT 50.00,
                        ev_rate DECIMAL(10, 2) DEFAULT 60.00,
                        status NVARCHAR(50) NOT NULL DEFAULT 'pending',
                        commission_percentage DECIMAL(5, 2) DEFAULT 0.00,
                        wallet_balance DECIMAL(10, 2) DEFAULT 0.00,
                        cancellation_policy NVARCHAR(MAX) NULL,
                        cctv_available BIT DEFAULT 0,
                        trade_license BIT DEFAULT 0,
                        zoning_clearance BIT DEFAULT 0,
                        shops_establishment_license BIT DEFAULT 0,
                        gst_registration BIT DEFAULT 0,
                        created_at DATETIME DEFAULT GETDATE(),
                        updated_at DATETIME DEFAULT GETDATE()
                    );
                END
            `;

            const mssqlAgencyTransactionsTable = `
                IF NOT EXISTS (SELECT * FROM sys.objects WHERE object_id = OBJECT_ID(N'[dbo].[agency_transactions]') AND type in (N'U'))
                BEGIN
                    CREATE TABLE agency_transactions (
                        transaction_id INT IDENTITY(1,1) PRIMARY KEY,
                        agency_id INT NOT NULL,
                        booking_id INT NOT NULL,
                        total_amount DECIMAL(10, 2) NOT NULL,
                        approved_amount DECIMAL(10, 2) NULL,
                        commission_rate DECIMAL(5, 2) NOT NULL,
                        admin_share DECIMAL(10, 2) NOT NULL,
                        agency_share DECIMAL(10, 2) NOT NULL,
                        status NVARCHAR(50) NOT NULL DEFAULT 'pending',
                        rejection_reason NVARCHAR(MAX) NULL,
                        approved_by INT NULL,
                        approved_at DATETIME NULL,
                        created_at DATETIME DEFAULT GETDATE()
                    );
                END
            `;

            const mssqlBookingsTable = `
                IF NOT EXISTS (SELECT * FROM sys.objects WHERE object_id = OBJECT_ID(N'[dbo].[bookings]') AND type in (N'U'))
                BEGIN
                    CREATE TABLE bookings (
                        booking_id INT IDENTITY(1,1) PRIMARY KEY,
                        booking_code NVARCHAR(50) NOT NULL UNIQUE,
                        user_id INT NULL,
                        user_name NVARCHAR(100) NOT NULL,
                        user_phone NVARCHAR(20) NULL,
                        agency_id INT NOT NULL,
                        agency_name NVARCHAR(200) NOT NULL,
                        vehicle_type NVARCHAR(50) NOT NULL,
                        vehicle_number NVARCHAR(50) NOT NULL,
                        status NVARCHAR(50) NOT NULL DEFAULT 'booked',
                        start_time DATETIME NULL,
                        end_time DATETIME NULL,
                        booking_start_time DATETIME NULL,
                        booking_end_time DATETIME NULL,
                        checkin_time DATETIME NULL,
                        checkout_time DATETIME NULL,
                        booked_duration DECIMAL(10, 2) NOT NULL,
                        hourly_rate DECIMAL(10, 2) NOT NULL,
                        total_bill DECIMAL(10, 2) DEFAULT 0,
                        payment_status NVARCHAR(50) NOT NULL DEFAULT 'pending',
                        otp NVARCHAR(6) NULL,
                        created_at DATETIME DEFAULT GETDATE(),
                        updated_at DATETIME DEFAULT GETDATE()
                    );
                END
            `;

            const mssqlWalletTransactionsTable = `
                IF NOT EXISTS (SELECT * FROM sys.objects WHERE object_id = OBJECT_ID(N'[dbo].[wallet_transactions]') AND type in (N'U'))
                BEGIN
                    CREATE TABLE wallet_transactions (
                        transaction_id INT IDENTITY(1,1) PRIMARY KEY,
                        user_id INT NOT NULL,
                        amount DECIMAL(10, 2) NOT NULL,
                        type NVARCHAR(50) NOT NULL,
                        status NVARCHAR(50) NOT NULL DEFAULT 'pending',
                        transaction_number NVARCHAR(100) NULL,
                        screenshot_path NVARCHAR(500) NULL,
                        created_at DATETIME DEFAULT GETDATE(),
                        updated_at DATETIME DEFAULT GETDATE()
                    );
                END
            `;

            const mssqlConfigurationsTable = `
                IF NOT EXISTS (SELECT * FROM sys.objects WHERE object_id = OBJECT_ID(N'[dbo].[configurations]') AND type in (N'U'))
                BEGIN
                    CREATE TABLE configurations (
                        config_id INT IDENTITY(1,1) PRIMARY KEY,
                        config_key NVARCHAR(100) NOT NULL UNIQUE,
                        config_value NVARCHAR(MAX) NOT NULL
                    );
                END
            `;

            const mssqlRatingsTable = `
                IF NOT EXISTS (SELECT * FROM sys.objects WHERE object_id = OBJECT_ID(N'[dbo].[ratings]') AND type in (N'U'))
                BEGIN
                    CREATE TABLE ratings (
                        rating_id INT IDENTITY(1,1) PRIMARY KEY,
                        user_id INT NOT NULL,
                        agency_id INT NOT NULL,
                        booking_id INT NULL,
                        rating TINYINT NOT NULL CHECK (rating >= 1 AND rating <= 5),
                        review NVARCHAR(MAX) NULL,
                        rating_type NVARCHAR(50) NOT NULL DEFAULT 'user_to_agency',
                        created_at DATETIME DEFAULT GETDATE(),
                        updated_at DATETIME DEFAULT GETDATE(),
                        CONSTRAINT uq_booking_rating_type UNIQUE (booking_id, rating_type)
                    );
                END
            `;

            const mssqlNotificationsTable = `
                IF NOT EXISTS (SELECT * FROM sys.objects WHERE object_id = OBJECT_ID(N'[dbo].[notifications]') AND type in (N'U'))
                BEGIN
                   CREATE TABLE notifications (
                    notification_id INT IDENTITY(1,1) PRIMARY KEY,
                    recipient_id INT NOT NULL,
                    type NVARCHAR(100) NOT NULL,
                    title NVARCHAR(255) NOT NULL,
                    message NVARCHAR(MAX) NOT NULL,
                    data NVARCHAR(MAX) NULL,
                    is_read BIT NOT NULL DEFAULT 0,
                    created_at DATETIME NOT NULL DEFAULT GETDATE()
                );
                CREATE INDEX idx_notifications_recipient_created ON notifications (recipient_id, created_at);
                END
            `;

            const mssqlNotificationPreferencesTable = `
                IF NOT EXISTS (SELECT * FROM sys.objects WHERE object_id = OBJECT_ID(N'[dbo].[notification_preferences]') AND type in (N'U'))
                BEGIN
                  CREATE TABLE notification_preferences (
                  recipient_id INT NOT NULL PRIMARY KEY,
                  enabled BIT NOT NULL DEFAULT 1,
                  updated_at DATETIME NOT NULL DEFAULT GETDATE()
                );
                END
            `;

            const mssqlOrgMediaTable = `
                IF NOT EXISTS (SELECT * FROM sys.objects WHERE object_id = OBJECT_ID(N'[dbo].[org_media]') AND type in (N'U'))
                BEGIN
                    CREATE TABLE org_media (
                        media_id INT IDENTITY(1,1) PRIMARY KEY,
                        org_id INT NOT NULL,
                        file_path NVARCHAR(500) NOT NULL,
                        pending_file_path NVARCHAR(500) NULL,
                        file_type NVARCHAR(50) NOT NULL DEFAULT 'photo',
                        status NVARCHAR(50) NOT NULL DEFAULT 'pending',
                        rejection_reason NVARCHAR(MAX) NULL,
                        created_at DATETIME DEFAULT GETDATE(),
                        updated_at DATETIME DEFAULT GETDATE()
                    );
                    CREATE INDEX idx_org_media_org_id ON org_media(org_id);
                END
            `;

            const mssqlOrgWorkingHoursTable = `
                IF NOT EXISTS (SELECT * FROM sys.objects WHERE object_id = OBJECT_ID(N'[dbo].[org_working_hours]') AND type in (N'U'))
                BEGIN
                    CREATE TABLE org_working_hours (
                        id INT IDENTITY(1,1) PRIMARY KEY,
                        org_id INT NOT NULL UNIQUE,
                        working_days NVARCHAR(MAX) NULL,
                        open_time NVARCHAR(10) NULL,
                        close_time NVARCHAR(10) NULL,
                        is_24_7 BIT DEFAULT 0,
                        special_vacations NVARCHAR(MAX) NULL,
                        daily_schedules NVARCHAR(MAX) NULL,
                        pending_working_days NVARCHAR(MAX) NULL,
                        pending_open_time NVARCHAR(10) NULL,
                        pending_close_time NVARCHAR(10) NULL,
                        pending_is_24_7 BIT DEFAULT 0,
                        pending_special_vacations NVARCHAR(MAX) NULL,
                        pending_daily_schedules NVARCHAR(MAX) NULL,
                        status NVARCHAR(50) NOT NULL DEFAULT 'approved',
                        rejection_reason NVARCHAR(MAX) NULL,
                        created_at DATETIME DEFAULT GETDATE(),
                        updated_at DATETIME DEFAULT GETDATE()
                    );
                END
            `;

            const mssqlComplaintsTable = `
                IF NOT EXISTS (SELECT * FROM sys.objects WHERE object_id = OBJECT_ID(N'[dbo].[complaints]') AND type in (N'U'))
                BEGIN
                    CREATE TABLE complaints (
                        complaint_id INT IDENTITY(1,1) PRIMARY KEY,
                        booking_id INT NOT NULL,
                        user_id INT NOT NULL,
                        agency_id INT NOT NULL,
                        complainant_type NVARCHAR(50) NOT NULL DEFAULT 'user_to_agency',
                        complainant_id INT NOT NULL,
                        subject NVARCHAR(255) NULL,
                        description NVARCHAR(MAX) NOT NULL,
                        status NVARCHAR(50) NOT NULL DEFAULT 'pending',
                        resolution_notes NVARCHAR(MAX) NULL,
                        resolved_by INT NULL,
                        resolved_at DATETIME NULL,
                        created_at DATETIME DEFAULT GETDATE(),
                        updated_at DATETIME DEFAULT GETDATE(),
                        CONSTRAINT uq_booking_complainant_type UNIQUE (booking_id, complainant_type)
                    );
                END
            `;

            const mssqlComplaintStepsTable = `
                IF NOT EXISTS (SELECT * FROM sys.objects WHERE object_id = OBJECT_ID(N'[dbo].[complaint_steps]') AND type in (N'U'))
                BEGIN
                    CREATE TABLE complaint_steps (
                        step_id INT IDENTITY(1,1) PRIMARY KEY,
                        complaint_id INT NOT NULL,
                        step_number INT NOT NULL DEFAULT 1,
                        action_by_role NVARCHAR(50) NOT NULL,
                        action_by_id INT NOT NULL,
                        previous_status NVARCHAR(50) NULL,
                        new_status NVARCHAR(50) NOT NULL,
                        comment NVARCHAR(MAX) NOT NULL,
                        created_at DATETIME DEFAULT GETDATE(),
                        CONSTRAINT fk_complaint_steps_complaint FOREIGN KEY (complaint_id) REFERENCES complaints(complaint_id) ON DELETE CASCADE
                    );
                END
            `;

            const mssqlUserStatusLogsTable = `
                IF NOT EXISTS (SELECT * FROM sys.objects WHERE object_id = OBJECT_ID(N'[dbo].[user_status_logs]') AND type in (N'U'))
                BEGIN
                    CREATE TABLE user_status_logs (
                        log_id INT IDENTITY(1,1) PRIMARY KEY,
                        user_id INT NOT NULL,
                        previous_status NVARCHAR(50) NOT NULL,
                        new_status NVARCHAR(50) NOT NULL,
                        reason NVARCHAR(MAX) NOT NULL,
                        changed_by INT NOT NULL,
                        changed_by_role NVARCHAR(50) NOT NULL,
                        created_at DATETIME DEFAULT GETDATE()
                    );
                    CREATE INDEX idx_user_status_logs_user_id ON user_status_logs(user_id);
                END
            `;

            await prisma.$executeRawUnsafe(mssqlUsersTable);
            await prisma.$executeRawUnsafe(mssqlOrgUsersTable);
            await prisma.$executeRawUnsafe(mssqlBookingsTable);
            await prisma.$executeRawUnsafe(mssqlWalletTransactionsTable);
            await prisma.$executeRawUnsafe(mssqlConfigurationsTable);
            await prisma.$executeRawUnsafe(mssqlRatingsTable);
            await prisma.$executeRawUnsafe(mssqlAgencyTransactionsTable);
            await prisma.$executeRawUnsafe(mssqlNotificationsTable);
            await prisma.$executeRawUnsafe(mssqlNotificationPreferencesTable);
            await prisma.$executeRawUnsafe(mssqlOrgMediaTable);
            await prisma.$executeRawUnsafe(mssqlOrgWorkingHoursTable);
            await prisma.$executeRawUnsafe(mssqlComplaintsTable);
            await prisma.$executeRawUnsafe(mssqlComplaintStepsTable);
            await prisma.$executeRawUnsafe(mssqlUserStatusLogsTable);

            // Safe ALTER queries for existing MSSQL databases
            try {
                await prisma.$executeRawUnsafe(
                    "IF NOT EXISTS(SELECT * FROM sys.columns WHERE Name = N'role' AND Object_ID = OBJECT_ID(N'users')) ALTER TABLE users ADD role NVARCHAR(50) NOT NULL DEFAULT 'user'"
                );
            } catch (e) {}
            try {
                await prisma.$executeRawUnsafe(
                    "IF NOT EXISTS(SELECT * FROM sys.columns WHERE Name = N'daily_schedules' AND Object_ID = OBJECT_ID(N'org_working_hours')) ALTER TABLE org_working_hours ADD daily_schedules NVARCHAR(MAX) NULL"
                );
            } catch (e) {}
            try {
                await prisma.$executeRawUnsafe(
                    "IF NOT EXISTS(SELECT * FROM sys.columns WHERE Name = N'pending_daily_schedules' AND Object_ID = OBJECT_ID(N'org_working_hours')) ALTER TABLE org_working_hours ADD pending_daily_schedules NVARCHAR(MAX) NULL"
                );
            } catch (e) {}
            try {
                await prisma.$executeRawUnsafe(
                    "IF NOT EXISTS(SELECT * FROM sys.columns WHERE Name = N'status' AND Object_ID = OBJECT_ID(N'users')) ALTER TABLE users ADD status NVARCHAR(50) NOT NULL DEFAULT 'active'"
                );
            } catch (e) {}
            try {
                await prisma.$executeRawUnsafe(
                    "IF NOT EXISTS(SELECT * FROM sys.columns WHERE Name = N'agency_id' AND Object_ID = OBJECT_ID(N'users')) ALTER TABLE users ADD agency_id INT NULL"
                );
            } catch (e) {}
            try {
                await prisma.$executeRawUnsafe(
                    "IF NOT EXISTS(SELECT * FROM sys.columns WHERE Name = N'wallet_balance' AND Object_ID = OBJECT_ID(N'users')) ALTER TABLE users ADD wallet_balance DECIMAL(10, 2) DEFAULT 0.00"
                );
            } catch (e) {}
            try {
                await prisma.$executeRawUnsafe(
                    "IF NOT EXISTS(SELECT * FROM sys.columns WHERE Name = N'vehicle_numbers' AND Object_ID = OBJECT_ID(N'users')) ALTER TABLE users ADD vehicle_numbers NVARCHAR(1000) NULL"
                );
            } catch (e) {}
            try {
                await prisma.$executeRawUnsafe(
                    "IF NOT EXISTS(SELECT * FROM sys.columns WHERE Name = N'driving_licence' AND Object_ID = OBJECT_ID(N'users')) ALTER TABLE users ADD driving_licence NVARCHAR(100) NULL"
                );
            } catch (e) {}
            try {
                await prisma.$executeRawUnsafe(
                    "IF NOT EXISTS(SELECT * FROM sys.columns WHERE Name = N'transaction_number' AND Object_ID = OBJECT_ID(N'wallet_transactions')) ALTER TABLE wallet_transactions ADD transaction_number NVARCHAR(100) NULL"
                );
            } catch (e) {}
            try {
                await prisma.$executeRawUnsafe(
                    "IF NOT EXISTS(SELECT * FROM sys.columns WHERE Name = N'screenshot_path' AND Object_ID = OBJECT_ID(N'wallet_transactions')) ALTER TABLE wallet_transactions ADD screenshot_path NVARCHAR(500) NULL"
                );
            } catch (e) {}
            try {
                await prisma.$executeRawUnsafe(
                    "IF NOT EXISTS(SELECT * FROM sys.columns WHERE Name = N'agency_id' AND Object_ID = OBJECT_ID(N'wallet_transactions')) ALTER TABLE wallet_transactions ADD agency_id INT NULL"
                );
            } catch (e) {}
            try {
                await prisma.$executeRawUnsafe(
                    "IF NOT EXISTS(SELECT * FROM sys.columns WHERE Name = N'rejection_reason' AND Object_ID = OBJECT_ID(N'wallet_transactions')) ALTER TABLE wallet_transactions ADD rejection_reason NVARCHAR(MAX) NULL"
                );
            } catch (e) {}
            try {
                await prisma.$executeRawUnsafe(
                    "IF NOT EXISTS(SELECT * FROM sys.columns WHERE Name = N'status' AND Object_ID = OBJECT_ID(N'org_users')) ALTER TABLE org_users ADD status NVARCHAR(50) NOT NULL DEFAULT 'pending'"
                );
            } catch (e) {}
            try {
                await prisma.$executeRawUnsafe(
                    "IF NOT EXISTS(SELECT * FROM sys.columns WHERE Name = N'aadhaar_card_path' AND Object_ID = OBJECT_ID(N'org_users')) ALTER TABLE org_users ADD aadhaar_card_path NVARCHAR(500) NULL"
                );
            } catch (e) {}
            try {
                await prisma.$executeRawUnsafe(
                    "IF NOT EXISTS(SELECT * FROM sys.columns WHERE Name = N'cctv_available' AND Object_ID = OBJECT_ID(N'org_users')) ALTER TABLE org_users ADD cctv_available BIT DEFAULT 0"
                );
            } catch (e) {}
            try {
                await prisma.$executeRawUnsafe(
                    "IF NOT EXISTS(SELECT * FROM sys.columns WHERE Name = N'trade_license' AND Object_ID = OBJECT_ID(N'org_users')) ALTER TABLE org_users ADD trade_license BIT DEFAULT 0"
                );
            } catch (e) {}
            try {
                await prisma.$executeRawUnsafe(
                    "IF NOT EXISTS(SELECT * FROM sys.columns WHERE Name = N'zoning_clearance' AND Object_ID = OBJECT_ID(N'org_users')) ALTER TABLE org_users ADD zoning_clearance BIT DEFAULT 0"
                );
            } catch (e) {}
            try {
                await prisma.$executeRawUnsafe(
                    "IF NOT EXISTS(SELECT * FROM sys.columns WHERE Name = N'shops_establishment_license' AND Object_ID = OBJECT_ID(N'org_users')) ALTER TABLE org_users ADD shops_establishment_license BIT DEFAULT 0"
                );
            } catch (e) {}
            try {
                await prisma.$executeRawUnsafe(
                    "IF NOT EXISTS(SELECT * FROM sys.columns WHERE Name = N'gst_registration' AND Object_ID = OBJECT_ID(N'org_users')) ALTER TABLE org_users ADD gst_registration BIT DEFAULT 0"
                );
            } catch (e) {}
            try {
                await prisma.$executeRawUnsafe(
                    "IF NOT EXISTS(SELECT * FROM sys.columns WHERE Name = N'two_wheeler_rate' AND Object_ID = OBJECT_ID(N'org_users')) ALTER TABLE org_users ADD two_wheeler_rate DECIMAL(10, 2) DEFAULT 20.00"
                );
            } catch (e) {}
            try {
                await prisma.$executeRawUnsafe(
                    "IF NOT EXISTS(SELECT * FROM sys.columns WHERE Name = N'three_wheeler_rate' AND Object_ID = OBJECT_ID(N'org_users')) ALTER TABLE org_users ADD three_wheeler_rate DECIMAL(10, 2) DEFAULT 30.00"
                );
            } catch (e) {}
            try {
                await prisma.$executeRawUnsafe(
                    "IF NOT EXISTS(SELECT * FROM sys.columns WHERE Name = N'car_rate' AND Object_ID = OBJECT_ID(N'org_users')) ALTER TABLE org_users ADD car_rate DECIMAL(10, 2) DEFAULT 40.00"
                );
            } catch (e) {}
            try {
                await prisma.$executeRawUnsafe(
                    "IF NOT EXISTS(SELECT * FROM sys.columns WHERE Name = N'suv_rate' AND Object_ID = OBJECT_ID(N'org_users')) ALTER TABLE org_users ADD suv_rate DECIMAL(10, 2) DEFAULT 50.00"
                );
            } catch (e) {}
            try {
                await prisma.$executeRawUnsafe(
                    "IF NOT EXISTS(SELECT * FROM sys.columns WHERE Name = N'van_rate' AND Object_ID = OBJECT_ID(N'org_users')) ALTER TABLE org_users ADD van_rate DECIMAL(10, 2) DEFAULT 50.00"
                );
            } catch (e) {}
            try {
                await prisma.$executeRawUnsafe(
                    "IF NOT EXISTS(SELECT * FROM sys.columns WHERE Name = N'pickup_rate' AND Object_ID = OBJECT_ID(N'org_users')) ALTER TABLE org_users ADD pickup_rate DECIMAL(10, 2) DEFAULT 50.00"
                );
            } catch (e) {}
            try {
                await prisma.$executeRawUnsafe(
                    "IF NOT EXISTS(SELECT * FROM sys.columns WHERE Name = N'ev_rate' AND Object_ID = OBJECT_ID(N'org_users')) ALTER TABLE org_users ADD ev_rate DECIMAL(10, 2) DEFAULT 60.00"
                );
            } catch (e) {}
            try {
                await prisma.$executeRawUnsafe(
                    "IF NOT EXISTS(SELECT * FROM sys.columns WHERE Name = N'cancellation_policy' AND Object_ID = OBJECT_ID(N'org_users')) ALTER TABLE org_users ADD cancellation_policy NVARCHAR(MAX) NULL"
                );
            } catch (e) {}
            try {
                await prisma.$executeRawUnsafe(
                    "IF NOT EXISTS(SELECT * FROM sys.columns WHERE Name = N'commission_percentage' AND Object_ID = OBJECT_ID(N'org_users')) ALTER TABLE org_users ADD commission_percentage DECIMAL(5, 2) DEFAULT 0.00"
                );
            } catch (e) {}
            try {
                await prisma.$executeRawUnsafe(
                    "IF NOT EXISTS(SELECT * FROM sys.columns WHERE Name = N'wallet_balance' AND Object_ID = OBJECT_ID(N'org_users')) ALTER TABLE org_users ADD wallet_balance DECIMAL(10, 2) DEFAULT 0.00"
                );
            } catch (e) {}
            try {
                await prisma.$executeRawUnsafe(
                    "IF NOT EXISTS(SELECT * FROM sys.columns WHERE Name = N'booking_start_time' AND Object_ID = OBJECT_ID(N'bookings')) ALTER TABLE bookings ADD booking_start_time DATETIME NULL"
                );
            } catch (e) {}
            try {
                await prisma.$executeRawUnsafe(
                    "IF NOT EXISTS(SELECT * FROM sys.columns WHERE Name = N'booking_end_time' AND Object_ID = OBJECT_ID(N'bookings')) ALTER TABLE bookings ADD booking_end_time DATETIME NULL"
                );
            } catch (e) {}
            try {
                await prisma.$executeRawUnsafe(
                    "IF NOT EXISTS(SELECT * FROM sys.columns WHERE Name = N'checkin_time' AND Object_ID = OBJECT_ID(N'bookings')) ALTER TABLE bookings ADD checkin_time DATETIME NULL"
                );
            } catch (e) {}
            try {
                await prisma.$executeRawUnsafe(
                    "IF NOT EXISTS(SELECT * FROM sys.columns WHERE Name = N'checkout_time' AND Object_ID = OBJECT_ID(N'bookings')) ALTER TABLE bookings ADD checkout_time DATETIME NULL"
                );
            } catch (e) {}
            try {
                await prisma.$executeRawUnsafe(
                    "IF NOT EXISTS(SELECT * FROM sys.columns WHERE Name = N'otp' AND Object_ID = OBJECT_ID(N'bookings')) ALTER TABLE bookings ADD otp NVARCHAR(6) NULL"
                );
            } catch (e) {}
            try {
                await prisma.$executeRawUnsafe(
                    "IF NOT EXISTS(SELECT * FROM sys.columns WHERE Name = N'is_force_cancelled' AND Object_ID = OBJECT_ID(N'bookings')) ALTER TABLE bookings ADD is_force_cancelled BIT DEFAULT 0"
                );
            } catch (e) {}
            try {
                await prisma.$executeRawUnsafe(
                    "IF NOT EXISTS(SELECT * FROM sys.columns WHERE Name = N'cancelled_by' AND Object_ID = OBJECT_ID(N'bookings')) ALTER TABLE bookings ADD cancelled_by NVARCHAR(50) NULL"
                );
            } catch (e) {}
            try {
                await prisma.$executeRawUnsafe(
                    "IF NOT EXISTS(SELECT * FROM sys.columns WHERE Name = N'cancellation_reason' AND Object_ID = OBJECT_ID(N'bookings')) ALTER TABLE bookings ADD cancellation_reason NVARCHAR(MAX) NULL"
                );
            } catch (e) {}
            try {
                await prisma.$executeRawUnsafe(
                    "IF NOT EXISTS(SELECT * FROM sys.columns WHERE Name = N'require_booking_approval' AND Object_ID = OBJECT_ID(N'org_users')) ALTER TABLE org_users ADD require_booking_approval BIT DEFAULT 0"
                );
            } catch (e) {}
            try {
                await prisma.$executeRawUnsafe(
                    "IF NOT EXISTS(SELECT * FROM sys.columns WHERE Name = N'approved_by' AND Object_ID = OBJECT_ID(N'bookings')) ALTER TABLE bookings ADD approved_by INT NULL"
                );
            } catch (e) {}
            try {
                await prisma.$executeRawUnsafe(
                    "IF NOT EXISTS(SELECT * FROM sys.columns WHERE Name = N'approved_at' AND Object_ID = OBJECT_ID(N'bookings')) ALTER TABLE bookings ADD approved_at DATETIME NULL"
                );
            } catch (e) {}
            try {
                await prisma.$executeRawUnsafe(
                    "IF NOT EXISTS(SELECT * FROM sys.columns WHERE Name = N'rejected_by' AND Object_ID = OBJECT_ID(N'bookings')) ALTER TABLE bookings ADD rejected_by INT NULL"
                );
            } catch (e) {}
            try {
                await prisma.$executeRawUnsafe(
                    "IF NOT EXISTS(SELECT * FROM sys.columns WHERE Name = N'rejected_at' AND Object_ID = OBJECT_ID(N'bookings')) ALTER TABLE bookings ADD rejected_at DATETIME NULL"
                );
            } catch (e) {}
            try {
                await prisma.$executeRawUnsafe(
                    "IF NOT EXISTS(SELECT * FROM sys.columns WHERE Name = N'rejection_reason' AND Object_ID = OBJECT_ID(N'bookings')) ALTER TABLE bookings ADD rejection_reason NVARCHAR(MAX) NULL"
                );
            } catch (e) {}
            try {
                await prisma.$executeRawUnsafe(
                    "IF NOT EXISTS(SELECT * FROM sys.columns WHERE Name = N'status' AND Object_ID = OBJECT_ID(N'agency_transactions')) ALTER TABLE agency_transactions ADD status NVARCHAR(50) NOT NULL DEFAULT 'pending'"
                );
            } catch (e) {}
            try {
                await prisma.$executeRawUnsafe(
                    "IF NOT EXISTS(SELECT * FROM sys.columns WHERE Name = N'approved_amount' AND Object_ID = OBJECT_ID(N'agency_transactions')) ALTER TABLE agency_transactions ADD approved_amount DECIMAL(10, 2) NULL"
                );
            } catch (e) {}
            try {
                await prisma.$executeRawUnsafe(
                    "IF NOT EXISTS(SELECT * FROM sys.columns WHERE Name = N'rejection_reason' AND Object_ID = OBJECT_ID(N'agency_transactions')) ALTER TABLE agency_transactions ADD rejection_reason NVARCHAR(MAX) NULL"
                );
            } catch (e) {}
            try {
                await prisma.$executeRawUnsafe(
                    "IF NOT EXISTS(SELECT * FROM sys.columns WHERE Name = N'approved_by' AND Object_ID = OBJECT_ID(N'agency_transactions')) ALTER TABLE agency_transactions ADD approved_by INT NULL"
                );
            } catch (e) {}
            try {
                await prisma.$executeRawUnsafe(
                    "IF NOT EXISTS(SELECT * FROM sys.columns WHERE Name = N'approved_at' AND Object_ID = OBJECT_ID(N'agency_transactions')) ALTER TABLE agency_transactions ADD approved_at DATETIME NULL"
                );
            } catch (e) {}

            console.log("MSSQL database schema check/creation completed.");
        }

        // Seed Super Admin if not exists
        const adminExists = await prisma.user.findFirst({
            where: { username: "sa" },
        });

        if (!adminExists) {
            console.log("Seeding default Super Admin user (sa/sa)...");
            const adminPasswordHash = await bcrypt.hash("sa", 10);
            await prisma.user.create({
                data: {
                    full_name: "Sougata Talukdar (Admin)",
                    username: "sa",
                    email: "admin@parklocator.com",
                    password_hash: adminPasswordHash,
                    role: "super_admin",
                    status: "active",
                },
            });
            console.log("Super Admin seeded successfully!");
        }

        // Seed default UPI ID config if not exists
        const upiConfigExists = await prisma.configuration.findUnique({
            where: { config_key: "upi_id" },
        });
        if (!upiConfigExists) {
            console.log("Seeding default UPI ID config (gbt@upi)...");
            await prisma.configuration.create({
                data: {
                    config_key: "upi_id",
                    config_value: "7797454561@upi",
                },
            });
            console.log("Default UPI ID config seeded successfully!");
        }
    } catch (err) {
        console.error("Error creating tables or seeding:", err);
    }
}

module.exports = {
    createTables,
};
