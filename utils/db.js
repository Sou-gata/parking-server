const Logger = require("./log");

require("dotenv").config();

const dbType = process.env.DB_TYPE || "mssql"; // "mysql" or "mssql"
let prisma;

if (dbType === "mysql") {
    const { PrismaClient } = require("../prisma_client_mysql");
    const { PrismaMariaDb } = require("@prisma/adapter-mariadb");

    Logger.log("Initializing Prisma with MySQL (MariaDB adapter)...");
    const adapter = new PrismaMariaDb(process.env.DATABASE_URL);
    prisma = new PrismaClient({ adapter });
} else {
    const { PrismaClient } = require("../prisma_client_mssql");
    const { PrismaMssql } = require("@prisma/adapter-mssql");

    console.log("Initializing Prisma with MS SQL Server adapter...");
    const adapter = new PrismaMssql(process.env.DATABASE_URL);
    prisma = new PrismaClient({ adapter });
}

module.exports = {
    prisma,
};
