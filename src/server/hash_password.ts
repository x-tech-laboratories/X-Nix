// Adds a user to the accounts file X_NIX_PASSWORD_HASH_FILE points at, or changes their password, through X-Libs'
// hash-password command, which asks at a terminal or reads stdin so the password never lands in argv or shell history.

import { hash_password_command } from "@x-tech-laboratories/x-libs/server/hash_password";

import { accounts_variable } from "./auth.ts";

await hash_password_command(accounts_variable);
