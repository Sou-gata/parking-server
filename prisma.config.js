require("dotenv").config();
const { defineConfig } = require("prisma/config");

const dbType = process.env.DB_TYPE || "mssql"; // "mysql" or "mssql"

module.exports = defineConfig({
  schema: dbType === "mysql" ? "prisma/schema.mysql.prisma" : "prisma/schema.mssql.prisma",
  datasource: {
    url: process.env.DATABASE_URL,
  },
});
