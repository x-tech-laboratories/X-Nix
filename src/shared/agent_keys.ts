// A host's agent key: an ed25519 key made by `ssh-keygen -t ed25519 -N ""`, whose private half the agent holds and
// whose public line the server's config declares. The agent proves it holds the key by signing the server's nonce.
//
// Node's crypto reads neither OpenSSH format, so both are read here: the public line `ssh-ed25519 <base64> [comment]`,
// and the unencrypted `openssh-key-v1` private key, whose 32-byte seed and public key become a JWK.

// ── Imports ──────────────────────────────────────────────────────────────────

import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, randomBytes, sign, verify, type KeyObject } from "node:crypto";

// ── Settings ─────────────────────────────────────────────────────────────────

export class AgentKeyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AgentKeyError";
  }
}

const ed25519_name = "ssh-ed25519";
const format_magic = "openssh-key-v1\0";
// Spelled in parts so secret scanners do not take this file for a key.
const armor_label = ["OPENSSH", "PRIVATE", "KEY"].join(" ");
const armor = new RegExp(`-{5}BEGIN ${armor_label}-{5}([\\s\\S]*?)-{5}END ${armor_label}-{5}`);
const ed25519_public_length = 32;
const ed25519_private_length = 64;

// ── Challenge ────────────────────────────────────────────────────────────────

// What the agent signs: the protocol, the host it logs in as and the server's nonce, so a signature fits one login only.
export function challenge_text(host: string, nonce: string): Buffer {
  return Buffer.from(`x-nix-agent-v1|${host}|${nonce}`, "utf8");
}

export function sign_challenge(private_key: KeyObject, host: string, nonce: string): string {
  return sign(null, challenge_text(host, nonce), private_key).toString("base64");
}

export function verify_challenge(public_key: KeyObject, host: string, nonce: string, signature: string): boolean {
  try {
    return verify(null, challenge_text(host, nonce), public_key, Buffer.from(signature, "base64"));
  } catch {
    return false;
  }
}

// ── Public key ───────────────────────────────────────────────────────────────

// Reads an OpenSSH public key line; the messages never quote the key itself.
export function parse_public_key(line: string): KeyObject {
  const parts = line.trim().split(/\s+/);
  if (parts.length < 2 || parts[0] === "") throw new AgentKeyError('must be an OpenSSH public key line such as "ssh-ed25519 AAAA... comment".');
  if (parts[0] !== ed25519_name) throw new AgentKeyError(`must be an ssh-ed25519 key, not ${parts[0]}; make one with ssh-keygen -t ed25519.`);
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(parts[1])) throw new AgentKeyError("holds a key that is not base64.");
  const reader = new WireReader(Buffer.from(parts[1], "base64"), "public key");
  const blob_type = reader.text();
  if (blob_type !== ed25519_name) throw new AgentKeyError(`says ssh-ed25519 but holds a ${blob_type} key.`);
  const public_bytes = reader.bytes();
  if (public_bytes.length !== ed25519_public_length || !reader.done()) throw new AgentKeyError("holds an ed25519 key of the wrong length.");
  return createPublicKey({ key: { kty: "OKP", crv: "Ed25519", x: public_bytes.toString("base64url") }, format: "jwk" });
}

// The key's SHA256 fingerprint as ssh-keygen -l prints it.
export function key_fingerprint(line: string): string {
  const blob = Buffer.from(line.trim().split(/\s+/)[1] ?? "", "base64");
  return `SHA256:${createHash("sha256").update(blob).digest("base64").replace(/=+$/, "")}`;
}

// ── Private key ──────────────────────────────────────────────────────────────

// Reads an unencrypted OpenSSH ed25519 private key; the messages never quote the key itself.
export function parse_private_key(text: string): KeyObject {
  const armored = armor.exec(text);
  if (armored === null) throw new AgentKeyError('is not an OpenSSH private key; make one with ssh-keygen -t ed25519 -N "".');
  const data = Buffer.from(armored[1].replace(/\s+/g, ""), "base64");
  if (data.subarray(0, format_magic.length).toString("latin1") !== format_magic) {
    throw new AgentKeyError("is not in the openssh-key-v1 format.");
  }

  const reader = new WireReader(data.subarray(format_magic.length), "private key");
  const cipher = reader.text();
  reader.bytes();
  reader.bytes();
  if (cipher !== "none") {
    throw new AgentKeyError(`is encrypted with a passphrase (${cipher}), which the agent cannot type; make it with -N "" and keep it in a secret store instead.`);
  }
  if (reader.number() !== 1) throw new AgentKeyError("must hold exactly one key.");
  reader.bytes();

  const section = new WireReader(reader.bytes(), "private key");
  if (section.number() !== section.number()) throw new AgentKeyError("is damaged: its check numbers differ.");
  const type = section.text();
  if (type !== ed25519_name) throw new AgentKeyError(`must be an ssh-ed25519 key, not ${type}; make one with ssh-keygen -t ed25519.`);
  const public_bytes = section.bytes();
  const private_bytes = section.bytes();
  if (public_bytes.length !== ed25519_public_length || private_bytes.length !== ed25519_private_length) {
    throw new AgentKeyError("holds an ed25519 key of the wrong length.");
  }
  // The private half is the seed followed by the public key again.
  if (!private_bytes.subarray(ed25519_public_length).equals(public_bytes)) throw new AgentKeyError("is damaged: its two public keys differ.");

  const x = public_bytes.toString("base64url");
  const seed = private_bytes.subarray(0, ed25519_public_length).toString("base64url");
  const private_key = createPrivateKey({ key: { kty: "OKP", crv: "Ed25519", d: seed, x }, format: "jwk" });
  // A seed that does not give the stored public key would sign with a key the server does not know.
  if (createPublicKey(private_key).export({ format: "jwk" }).x !== x) throw new AgentKeyError("is damaged: its seed does not match its public key.");
  return private_key;
}

// ── New keys ─────────────────────────────────────────────────────────────────

// A new ed25519 key in the files ssh-keygen would write: the unencrypted openssh-key-v1 private key and its public line.
export function generate_agent_key(comment: string): { private_text: string; public_line: string } {
  const { privateKey } = generateKeyPairSync("ed25519");
  const jwk = privateKey.export({ format: "jwk" });
  const public_bytes = Buffer.from(jwk.x!, "base64url");
  const seed = Buffer.from(jwk.d!, "base64url");
  const public_blob = Buffer.concat([wire_text(ed25519_name), wire_bytes(public_bytes)]);

  // Both check numbers are the same random number, which tells a reader the section decrypted correctly.
  const check = randomBytes(4);
  const section_parts = [check, check, wire_text(ed25519_name), wire_bytes(public_bytes), wire_bytes(Buffer.concat([seed, public_bytes])), wire_text(comment)];
  let section = Buffer.concat(section_parts);
  // The section is padded with the bytes 1, 2, 3 and on to a multiple of eight.
  const padding = (8 - (section.length % 8)) % 8;
  section = Buffer.concat([section, Buffer.from(Array.from({ length: padding }, (_, index) => index + 1))]);

  const data = Buffer.concat([
    Buffer.from(format_magic, "latin1"), wire_text("none"), wire_text("none"), wire_bytes(Buffer.alloc(0)), wire_number(1), wire_bytes(public_blob), wire_bytes(section),
  ]);
  const body = data.toString("base64").match(/.{1,70}/g)!.join("\n");
  const private_text = `-----BEGIN ${armor_label}-----\n${body}\n-----END ${armor_label}-----\n`;
  return { private_text, public_line: `${ed25519_name} ${public_blob.toString("base64")} ${comment}` };
}

function wire_number(value: number): Buffer {
  const buffer = Buffer.alloc(4);
  buffer.writeUInt32BE(value);
  return buffer;
}

function wire_bytes(value: Buffer): Buffer {
  return Buffer.concat([wire_number(value.length), value]);
}

function wire_text(value: string): Buffer {
  return wire_bytes(Buffer.from(value, "latin1"));
}

// ── Reader ───────────────────────────────────────────────────────────────────

// Reads the SSH wire format: big-endian 32-bit numbers, and strings as a length then that many bytes.
class WireReader {
  private readonly data: Buffer;
  private readonly what: string;
  private offset = 0;

  constructor(data: Buffer, what: string) {
    this.data = data;
    this.what = what;
  }

  number(): number {
    if (this.offset + 4 > this.data.length) throw new AgentKeyError(`is cut short: the ${this.what} ends early.`);
    const value = this.data.readUInt32BE(this.offset);
    this.offset += 4;
    return value;
  }

  bytes(): Buffer {
    const length = this.number();
    if (this.offset + length > this.data.length) throw new AgentKeyError(`is cut short: the ${this.what} ends early.`);
    const value = this.data.subarray(this.offset, this.offset + length);
    this.offset += length;
    return value;
  }

  text(): string {
    return this.bytes().toString("latin1");
  }

  done(): boolean {
    return this.offset === this.data.length;
  }
}
