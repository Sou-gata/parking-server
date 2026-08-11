const util = require("util");

let chalk;
try {
    chalk = require("chalk");
    chalk = chalk.default || chalk;
} catch {
    const ansi = (code) => (str) => `\x1b[${code}m${str}\x1b[39m`;
    const bold = (str) => `\x1b[1m${str}\x1b[22m`;
    const wrap = (code) =>
        Object.assign(ansi(code), { bold: (str) => bold(ansi(code)(str)) });
    chalk = {
        cyan: wrap(36),
        green: wrap(32),
        yellow: wrap(33),
        red: wrap(31),
        magenta: wrap(35),
        white: ansi(37),
    };
}

const LEVEL_COLORS = {
    info: chalk.cyan,
    success: chalk.green,
    warn: chalk.yellow,
    error: chalk.red,
    debug: chalk.magenta,
    log: chalk.white,
};

function formatArgs(args) {
    return args
        .map((arg) => {
            if (arg instanceof Error) return arg.stack || arg.message;
            if (typeof arg === "object" && arg !== null) {
                return util.inspect(arg, {
                    depth: 5,
                    colors: true,
                    breakLength: 80,
                });
            }
            return String(arg);
        })
        .join(" ");
}

function print(level, message, context) {
    const color = LEVEL_COLORS[level] || LEVEL_COLORS.info;
    const contextTag = context ? chalk.cyan(`[${context}] `) : "";
    console.log(`${contextTag}${color(message)}`);
}

class Logger {
    constructor(context) {
        this.context = context;
    }
}

for (const level of Object.keys(LEVEL_COLORS)) {
    Logger[level] = (...args) => print(level, formatArgs(args));
    Logger.prototype[level] = function (...args) {
        print(level, formatArgs(args), this.context);
    };
}

module.exports = Logger;
