// Terminal questions for the setup scripts (create-admin, reset-admin-password).
// A password is read without showing it when typed in a real terminal, and is never printed or logged.
// Piped input (e.g. answers in a file) works too: one answer per line.

const readline = require("node:readline");

function createPrompt({ input = process.stdin, output = process.stdout } = {}) {
  const pendingLines = [];
  let lineWaiter = null;
  let inputClosed = false; // no more input (e.g. piped answers ran out) -> stop instead of waiting forever
  const rl = readline.createInterface({ input, terminal: false });
  rl.on("line", (line) => {
    if (lineWaiter) {
      const resolve = lineWaiter;
      lineWaiter = null;
      resolve(line);
    } else {
      pendingLines.push(line);
    }
  });
  rl.on("close", () => {
    inputClosed = true;
    if (lineWaiter) lineWaiter(null);
  });

  function readLine() {
    if (pendingLines.length) return Promise.resolve(pendingLines.shift());
    if (inputClosed) return Promise.resolve(null);
    return new Promise((resolve) => (lineWaiter = resolve));
  }

  async function ask(question) {
    output.write(question);
    const answer = await readLine();
    if (answer === null) throw new Error("No input (cancelled)");
    return answer.trim();
  }

  // Hidden input: when typed in a real terminal, characters are not shown
  async function askHidden(question) {
    output.write(question);
    if (!input.isTTY) {
      const answer = await readLine();
      output.write("\n");
      if (answer === null) throw new Error("No input (cancelled)");
      return answer;
    }
    return new Promise((resolve, reject) => {
      rl.pause();
      input.setRawMode(true);
      input.resume();
      let typed = "";
      const onData = (chunk) => {
        for (const char of chunk.toString("utf8")) {
          if (char === "\r" || char === "\n") {
            input.setRawMode(false);
            input.removeListener("data", onData);
            output.write("\n");
            rl.resume();
            return resolve(typed);
          }
          if (char === "\u0003") { // Ctrl+C
            input.setRawMode(false);
            return reject(new Error("Cancelled"));
          }
          if (char === "\u007f" || char === "\b") typed = typed.slice(0, -1);
          else typed += char;
        }
      };
      input.on("data", onData);
    });
  }

  return { ask, askHidden, close: () => rl.close() };
}

module.exports = { createPrompt };
