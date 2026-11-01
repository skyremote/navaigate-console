"""Make the keys and tokens that protect your database server (sqld).

    python scripts/mint.py init                    first time: make the key pair, a read-write token and a read-only token
    python scripts/mint.py extra NAME --access ro  one more token for one machine or tool (ro = read only, rw = read and write)
    python scripts/mint.py rotate                  new key pair: every old token stops working (restart sqld afterwards)

What you get, in $BRAIN_HOME/keys (default ./state/keys):
    jwt-private.pem   signs tokens. Keep it here, never share it.
    jwt-public.pem    the server uses this to check tokens.
    rw.jwt            read and write. For you and your own tools (the aios CLI, scripts/brain.py).
    ro.jwt            read only. For the connector. The server itself refuses writes with this one.
    NAME.jwt          from "extra".

Tokens are written to files and never printed. Needs:  pip install cryptography
"""
import argparse
import base64
import json
import os
import re
import sys
import time
from pathlib import Path

from cryptography.hazmat.primitives import serialization as ser
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey

KEYS = Path(os.environ.get("BRAIN_HOME", "./state")).expanduser() / "keys"


def b64(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).rstrip(b"=").decode()


def write_secret(path: Path, data: bytes | str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    old = os.umask(0o077)
    try:
        path.write_bytes(data if isinstance(data, bytes) else data.encode())
    finally:
        os.umask(old)
    try:
        os.chmod(path, 0o600)
    except OSError:
        pass  # Windows


def make_key() -> Ed25519PrivateKey:
    key = Ed25519PrivateKey.generate()
    write_secret(KEYS / "jwt-private.pem", key.private_bytes(ser.Encoding.PEM, ser.PrivateFormat.PKCS8, ser.NoEncryption()))
    write_secret(KEYS / "jwt-public.pem", key.public_key().public_bytes(ser.Encoding.PEM, ser.PublicFormat.SubjectPublicKeyInfo))
    return key


def load_key() -> Ed25519PrivateKey:
    path = KEYS / "jwt-private.pem"
    if not path.is_file():
        sys.exit(f"No key at {path}. Run: python scripts/mint.py init")
    return ser.load_pem_private_key(path.read_bytes(), None)


def mint(key: Ed25519PrivateKey, access: str, subject: str, days: int) -> str:
    now = int(time.time())
    head = b64(json.dumps({"alg": "EdDSA", "typ": "JWT"}).encode())
    body = b64(json.dumps({"iat": now, "exp": now + days * 86400, "a": access, "sub": subject}).encode())
    return f"{head}.{body}.{b64(key.sign(f'{head}.{body}'.encode()))}"


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("action", choices=["init", "extra", "rotate"])
    ap.add_argument("name", nargs="?", help="for 'extra': a short name such as laptop or cursor")
    ap.add_argument("--access", choices=["ro", "rw"], default="ro")
    ap.add_argument("--days", type=int, default=3650, help="how long the token lasts (default 3650 = about ten years)")
    args = ap.parse_args()

    if args.action == "init":
        if (KEYS / "jwt-private.pem").is_file():
            sys.exit(f"A key already exists in {KEYS}. Use 'rotate' only if you want to cancel every token.")
        key = make_key()
        for sub in ("connector", "sqld", "backups"):  # made now, as you, so Docker does not create them as root later
            (KEYS.parent / sub).mkdir(parents=True, exist_ok=True)
        write_secret(KEYS / "rw.jwt", mint(key, "rw", "brain-rw", args.days))
        write_secret(KEYS / "ro.jwt", mint(key, "ro", "brain-connector", args.days))
        print(f"Made the key pair, rw.jwt and ro.jwt in {KEYS}")
    elif args.action == "rotate":
        key = make_key()
        for f in KEYS.glob("*.jwt"):
            access = "rw" if f.stem == "rw" else "ro" if f.stem == "ro" else None
            if access is None:
                print(f"Left out {f.name}: it was signed by the old key. Mint it again with 'extra'.")
                f.unlink()
                continue
            write_secret(f, mint(key, access, f"brain-{f.stem}", args.days))
        print("New key pair. Old tokens are dead once sqld restarts. Update every client that used rw.jwt.")
    else:
        if not args.name or not re.fullmatch(r"[a-z0-9][a-z0-9_-]{0,40}", args.name):
            sys.exit("Give a short lower-case name, for example: python scripts/mint.py extra laptop --access rw")
        write_secret(KEYS / f"{args.name}.jwt", mint(load_key(), args.access, args.name, args.days))
        print(f"Wrote {KEYS / (args.name + '.jwt')} ({args.access})")


if __name__ == "__main__":
    main()
