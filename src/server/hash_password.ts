// Adds a user to the accounts file X_NIX_PASSWORD_HASH_FILE points at, or changes their password. Asks for the password
// at a terminal, or reads it from stdin, so it never lands in argv or shell history.

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { text } from "node:stream/consumers";
import { account_name_pattern, default_account_name, hash_password } from "./passwords.ts";

const name = process.argv[2] ?? "";
const file_path = process.argv[3] ?? "password.hash";

if (!account_name_pattern.test(name)) {
  console.error("Usage: npm run hash-password -- <name> [file], the name of lowercase letters, digits, '.', '_' and '-'.");
  process.exit(1);
}

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

// The user's own line goes, whether it carries their name or, for the default user, only a hash.
function names_user(line: string): boolean {
  const trimmed = line.trim();
  if (trimmed.startsWith(`${name}:`)) return true;
  return name === default_account_name && trimmed.startsWith("scrypt$");
}

const kept_lines = existsSync(file_path) ? readFileSync(file_path, "utf8").split("\n").filter((line) => line.trim() !== "" && !names_user(line)) : [];
const lines = [...kept_lines, `${name}:${hash_password(password)}`];
writeFileSync(file_path, lines.join("\n") + "\n", { mode: 0o600 });
console.error(`Set ${name}'s password in ${file_path}; point X_NIX_PASSWORD_HASH_FILE at it.`);
