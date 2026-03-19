import { spawn } from "node:child_process";
import process from "node:process";

const npmCommand = process.platform === "win32" ? "npm.cmd" : "npm";
const processes = [];

const startProcess = (command, args) => {
  const child = spawn(command, args, {
    stdio: "inherit",
    env: process.env,
  });

  processes.push(child);
  return child;
};

const stopAllProcesses = () => {
  processes.forEach((child) => {
    if (!child.killed) {
      child.kill("SIGTERM");
    }
  });
};

startProcess(npmCommand, ["run", "api"]);
startProcess(npmCommand, ["run", "dev:web"]);

process.on("SIGINT", () => {
  stopAllProcesses();
  process.exit(0);
});

process.on("SIGTERM", () => {
  stopAllProcesses();
  process.exit(0);
});
