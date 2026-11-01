// End-to-end sealing for mirror rows: the brain only ever holds ciphertext.
// Each Fleet has an X25519 key pair (private key in its own plugin data
// folder, public key in its snapshot and in its watch rows). A row is sealed
// to the watcher's public key with an ephemeral X25519 key, HKDF-SHA256 and
// AES-256-GCM; the row's identity (server, thread, recipient, generation, seq)
// is the associated data, so a row cannot be replayed under another identity.
import {
  createCipheriv,
  createDecipheriv,
  createPrivateKey,
  createPublicKey,
  diffieHellman,
  generateKeyPairSync,
  hkdfSync,
  randomBytes,
  type KeyObject,
} from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { deflateRawSync, inflateRawSync } from "node:zlib";

const INFO = Buffer.from("navaigate fleet mirror v1", "utf8");
/** Largest plaintext a row may open to (guards against a deflate bomb). */
const MAX_PLAINTEXT_BYTES = 64 * 1024 * 1024;

export interface MirrorKeyPair {
  /** base64url of the raw 32-byte X25519 public key (the JWK `x`). */
  publicKey: string;
  privateKey: KeyObject;
}

interface StoredKey {
  v: 1;
  kty: "OKP";
  crv: "X25519";
  x: string;
  d: string;
  createdAt: number;
}

export function generateMirrorKeyPair(): MirrorKeyPair {
  const { publicKey, privateKey } = generateKeyPairSync("x25519");
  const jwk = publicKey.export({ format: "jwk" }) as { x?: string };
  if (typeof jwk.x !== "string") throw new Error("X25519 key export failed");
  return { publicKey: jwk.x, privateKey };
}

/**
 * The key pair stored at `path` (a 0600 JSON file), made on first use. The
 * folder is created 0700. Never logged, never sent anywhere but the public half.
 */
export function loadOrCreateMirrorKey(path: string, now = Date.now()): MirrorKeyPair {
  if (existsSync(path)) {
    const stored = JSON.parse(readFileSync(path, "utf8")) as Partial<StoredKey>;
    if (stored.kty !== "OKP" || stored.crv !== "X25519" || typeof stored.x !== "string" || typeof stored.d !== "string") {
      throw new Error(`Mirror key file ${path} is not an X25519 key`);
    }
    const privateKey = createPrivateKey({ key: { kty: "OKP", crv: "X25519", x: stored.x, d: stored.d }, format: "jwk" });
    return { publicKey: stored.x, privateKey };
  }
  const pair = generateMirrorKeyPair();
  const jwk = pair.privateKey.export({ format: "jwk" }) as { x?: string; d?: string };
  if (typeof jwk.d !== "string" || typeof jwk.x !== "string") throw new Error("X25519 key export failed");
  const stored: StoredKey = { v: 1, kty: "OKP", crv: "X25519", x: jwk.x, d: jwk.d, createdAt: now };
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(stored), { mode: 0o600 });
  chmodSync(tmp, 0o600);
  renameSync(tmp, path);
  return pair;
}

function publicKeyFrom(x: string): KeyObject {
  if (!/^[A-Za-z0-9_-]{43}$/.test(x)) throw new Error("Not an X25519 public key");
  return createPublicKey({ key: { kty: "OKP", crv: "X25519", x }, format: "jwk" });
}

function rawPublic(x: string): Buffer {
  return Buffer.from(x, "base64url");
}

function deriveKey(shared: Buffer, ephemeral: string, recipient: string): Buffer {
  const salt = Buffer.concat([rawPublic(ephemeral), rawPublic(recipient)]);
  return Buffer.from(hkdfSync("sha256", shared, salt, INFO, 32));
}

export interface SealedPayload {
  v: 1;
  /** ephemeral public key, base64url */
  epk: string;
  iv: string;
  ct: string;
  tag: string;
}

/** Compress and seal `plaintext` so only the holder of `recipientPublicKey` can read it. */
export function seal(plaintext: string, recipientPublicKey: string, aad: string): string {
  const recipient = publicKeyFrom(recipientPublicKey);
  const eph = generateMirrorKeyPair();
  const shared = diffieHellman({ privateKey: eph.privateKey, publicKey: recipient });
  const key = deriveKey(shared, eph.publicKey, recipientPublicKey);
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(Buffer.from(aad, "utf8"));
  const body = deflateRawSync(Buffer.from(plaintext, "utf8"));
  const ct = Buffer.concat([cipher.update(body), cipher.final()]);
  const sealed: SealedPayload = {
    v: 1,
    epk: eph.publicKey,
    iv: iv.toString("base64"),
    ct: ct.toString("base64"),
    tag: cipher.getAuthTag().toString("base64"),
  };
  return JSON.stringify(sealed);
}

/** Open a sealed payload with this Fleet's key pair; throws on any tampering or a wrong key. */
export function open(payload: string, own: MirrorKeyPair, aad: string): string {
  const sealed = JSON.parse(payload) as Partial<SealedPayload>;
  if (sealed.v !== 1 || typeof sealed.epk !== "string" || typeof sealed.iv !== "string" || typeof sealed.ct !== "string" || typeof sealed.tag !== "string") {
    throw new Error("Not a sealed mirror payload");
  }
  const shared = diffieHellman({ privateKey: own.privateKey, publicKey: publicKeyFrom(sealed.epk) });
  const key = deriveKey(shared, sealed.epk, own.publicKey);
  const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(sealed.iv, "base64"));
  decipher.setAAD(Buffer.from(aad, "utf8"));
  decipher.setAuthTag(Buffer.from(sealed.tag, "base64"));
  const body = Buffer.concat([decipher.update(Buffer.from(sealed.ct, "base64")), decipher.final()]);
  return inflateRawSync(body, { maxOutputLength: MAX_PLAINTEXT_BYTES }).toString("utf8");
}

/** The associated data that binds a sealed row to its place in fleet_mirror_events. */
export function rowAad(row: { serverId: string; threadId: string; recipient: string; generation: string; seq: number }): string {
  return ["fleet-mirror-row", row.serverId, row.threadId, row.recipient, row.generation, String(row.seq)].join("\n");
}
