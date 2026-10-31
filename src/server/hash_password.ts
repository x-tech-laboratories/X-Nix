// Writes the hash file X_NIX_PASSWORD_HASH_FILE points at. Asks for the password at a terminal, or reads it from stdin,
// so it never lands in argv or shell history.

import { writeFileSync } from "node:fs";
import { text } from "node:stream/consumers";
import { hash_password } from "./passwords.ts";

const file_path = process.argv[2] ?? "password.hash";

// Reads one line without echoing it.
function ask_hidden(question: string): Promise<string> {
  return new Promise((resolve) => {
    process.stderr.write(question);
    process.stdin.setRawMode(true);
    process.stdin.setEncoding("utf8");
    let answer = "";
    const on_data = (chunk: string) => {
      for (const character of chunk) {
        if (character === "\r" || character === "\n") {
          process.stdin.setRawMode(false);
          process.stdin.pause();
          process.stdin.off("data", on_data);
          process.stderr.write("\n");
          resolve(answer);
          return;
        }
        if (character === "\u0003") process.exit(130);
        if (character === "\u007f") answer = answer.slice(0, -1);
        else answer += character;
      }
    };
    process.stdin.on("data", on_data);
    process.stdin.resume();
  });
}

let password: string;
if (process.stdin.isTTY) {
  password = await ask_hidden("Password: ");
  if (password !== (await ask_hidden("Again: "))) {
    console.error("The passwords differ.");
    process.exit(1);
  }
} else {
  password = (await text(process.stdin)).replace(/\r?\n$/, "");
}
if (!password) {
  console.error("The password is empty.");
  process.exit(1);
}

writeFileSync(file_path, hash_password(password) + "\n", { mode: 0o600 });
console.error(`Wrote ${file_path}; point X_NIX_PASSWORD_HASH_FILE at it.`);
