"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const fs_1 = require("fs");
const puppeteer_1 = require("puppeteer");
const interfaces_1 = require("./interfaces");
const MAX_SOURCE_SIZE = 16 * 1024 * 1024;
const UPDATE_INTERVAL = 1000;
const config = JSON.parse(fs_1.readFileSync("config.json").toString());
let browser = null;
const isLoggedIn = async () => {
    if (!browser) {
        return false;
    }
    const page = await browser.newPage();
    try {
        const res = await page.goto("http://poj.org/mail");
        const failed = (res.status() !== 200) || !(/Mail of/.test(await res.text()));
        await page.close();
        return !failed;
    }
    catch (e) {
        await page.close();
        return false;
    }
};
const initRequest = async () => {
    console.log("[INFO] [POJ] Puppeteer is initializing");
    browser = await puppeteer_1.launch({ headless: false });
    const page = await browser.newPage();
    try {
        await page.goto("http://poj.org");
        await page.evaluate((username, password) => {
            const usr = document.querySelector("body > table:nth-child(2) > tbody > tr:nth-child(3) > td:nth-child(5) > form > table > tbody > tr:nth-child(1) > td:nth-child(2) > input[type=\"text\"]");
            const pwd = document.querySelector("body > table:nth-child(2) > tbody > tr:nth-child(3) > td:nth-child(5) > form > table > tbody > tr:nth-child(2) > td:nth-child(2) > input[type=\"password\"]");
            usr.value = username;
            pwd.value = password;
            const btn = document.querySelector("body > table:nth-child(2) > tbody > tr:nth-child(3) > td:nth-child(5) > form > input[type=\"Submit\"]:nth-child(2)");
            btn.click();
        }, config.username, config.password);
        await page.waitForNavigation();
        if (!await isLoggedIn()) {
            throw new Error("Login failed");
        }
        await page.close();
        console.log("[INFO] [POJ] Puppeteer is initialized");
    }
    catch (e) {
        await page.close();
        throw e;
    }
};
const submit = async (id, code, langcode) => {
    const page = await browser.newPage();
    try {
        await page.goto("http://poj.org/submit?problem_id=" + id);
        await page.evaluate((lang, sourcecode) => {
            const langEle = document.querySelector("body > table:nth-child(4) > tbody > tr > td > form > div > select");
            const codeEle = document.querySelector("#source");
            langEle.value = lang;
            codeEle.value = sourcecode;
            const btn = document.querySelector("body > table:nth-child(4) > tbody > tr > td > form > div > input[type=\"submit\"]:nth-child(13)");
            btn.click();
        }, langcode, code);
        await page.waitForNavigation();
        const unparsedID = await page.evaluate((username) => {
            const tbody = document.querySelector("body > table.a > tbody");
            for (let i = 1; i < tbody.children.length; i++) {
                const tr = tbody.children[i];
                const user = tr.children[1].textContent.trim();
                if (user === username) {
                    return tr.children[0].textContent.trim();
                }
            }
            return null;
        }, config.username);
        if (unparsedID === null) {
            throw new Error("Submit failed");
        }
        await page.close();
        return parseInt(unparsedID, 10);
    }
    catch (e) {
        await page.close();
        throw e;
    }
};
const updateMap = new Map();
const convertStatus = (status) => {
    switch (status) {
        case "Queuing":
        case "Waiting":
            return interfaces_1.SolutionResult.WaitingJudge;
        case "Compiling":
        case "Running":
            return interfaces_1.SolutionResult.Judging;
        case "Accepted":
            return interfaces_1.SolutionResult.Accepted;
        case "Presentation Error":
            return interfaces_1.SolutionResult.PresentationError;
        case "Time Limit Exceeded":
            return interfaces_1.SolutionResult.TimeLimitExceeded;
        case "Memory Limit Exceeded":
            return interfaces_1.SolutionResult.MemoryLimitExceeded;
        case "Wrong Answer":
            return interfaces_1.SolutionResult.WrongAnswer;
        case "Runtime Error":
            return interfaces_1.SolutionResult.RuntimeError;
        case "Compile Error":
            return interfaces_1.SolutionResult.CompileError;
    }
    return interfaces_1.SolutionResult.OtherError;
};
const fetch = async (runID) => {
    const page = await browser.newPage();
    try {
        await page.goto("http://poj.org/showsource?solution_id=" + runID);
        const { memory, time, statusText } = await page.evaluate(() => {
            const mEle = document.querySelector("body > table > tbody > tr:nth-child(2) > td:nth-child(1)");
            const tEle = document.querySelector("body > table > tbody > tr:nth-child(2) > td:nth-child(3)");
            const sEle = document.querySelector("body > table > tbody > tr:nth-child(3) > td:nth-child(3) > font");
            return {
                memory: mEle.textContent.trim().substr(8),
                time: tEle.textContent.trim().substr(6),
                statusText: sEle.textContent.trim(),
            };
        });
        const status = convertStatus(statusText);
        const score = status === interfaces_1.SolutionResult.Accepted ? 100 : 0;
        const result = {
            status,
            score,
            details: {
                time,
                memory,
            },
        };
        await page.close();
        return result;
    }
    catch (e) {
        await page.close();
        throw e;
    }
};
const updateSolutionResults = async () => {
    for (const [runid, cb] of updateMap) {
        try {
            const result = await fetch(runid);
            cb(result);
            if (result.status !== interfaces_1.SolutionResult.Judging && result.status !== interfaces_1.SolutionResult.WaitingJudge) {
                updateMap.delete(runid);
            }
        }
        catch (e) {
            cb({ status: interfaces_1.SolutionResult.JudgementFailed, score: 0, details: { error: e.message } });
        }
    }
    setTimeout(updateSolutionResults, UPDATE_INTERVAL);
};
const main = async (problem, solution, resolve, update) => {
    if (interfaces_1.Problem.guard(problem)) {
        if (interfaces_1.Solution.guard(solution)) {
            if (!browser) {
                try {
                    await initRequest();
                }
                catch (e) {
                    browser = null;
                    return update({ status: interfaces_1.SolutionResult.JudgementFailed, score: 0, details: { error: e.message } });
                }
            }
            try {
                let langcode = null;
                if (solution.language === "c") {
                    langcode = 1;
                }
                else if (solution.language === "cpp98") {
                    langcode = 0;
                }
                else if (solution.language === "java") {
                    langcode = 2;
                }
                if (langcode === null) {
                    return update({ status: interfaces_1.SolutionResult.JudgementFailed, score: 0, details: { error: "Language rejected" } });
                }
                const source = await resolve(solution.file);
                const stat = fs_1.statSync(source.path);
                if (stat.size > MAX_SOURCE_SIZE) {
                    return update({ status: interfaces_1.SolutionResult.JudgementFailed, score: 0, details: { error: "File is too big" } });
                }
                const content = fs_1.readFileSync(source.path).toString();
                const runID = await submit(problem.id, content, langcode);
                updateMap.set(runID, update);
            }
            catch (e) {
                return update({ status: interfaces_1.SolutionResult.JudgementFailed, score: 0, details: { error: "Invalid solution" } });
            }
        }
        else {
            return update({ status: interfaces_1.SolutionResult.JudgementFailed, score: 0, details: { error: "Invalid solution" } });
        }
    }
    else {
        return update({ status: interfaces_1.SolutionResult.JudgementFailed, score: 0, details: { error: "Invalid problem" } });
    }
};
module.exports = main;
updateSolutionResults();
//# sourceMappingURL=index.js.map