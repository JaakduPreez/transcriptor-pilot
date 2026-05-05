#!/usr/bin/env python3
"""
Transcriptor V7.0 — encrypt the org API keys for embedding in the .app bundle.

Usage:
    cd transcriptor-pilot-control/keys/
    cp keys_plaintext.example.json keys_plaintext.json
    # Edit keys_plaintext.json — paste your real OpenAI / Anthropic / AssemblyAI keys
    python3 encrypt_keys.py \
        --in    keys_plaintext.json \
        --out   ../../"Current Working File"/TranscriptorV7.0.app/Contents/Resources/encrypted_keys.bin \
        --passphrase "$(printf %s 'Pilot2026Spring!ChangeThisToSomethingLong')"

The passphrase MUST match the `key_passphrase` cell on the Pilot tab of the Sheet.
The desktop app retrieves the passphrase from Apps Script /login (only for active users)
and uses it to decrypt this file in memory at runtime.

After running:
  - Delete keys_plaintext.json (or keep it locally; never commit)
  - The encrypted_keys.bin lands inside the .app bundle ready for distribution
"""

import argparse, json, os, sys, base64
from cryptography.hazmat.primitives.ciphers.aead import AESGCM
from cryptography.hazmat.primitives.kdf.pbkdf2 import PBKDF2HMAC
from cryptography.hazmat.primitives import hashes
from cryptography.hazmat.backends import default_backend

# Derivation parameters (DO NOT change without coordinating with the runtime
# decryptor in transcript_app.py — both ends must agree).
PBKDF2_ITERATIONS = 600_000   # OWASP 2023 recommendation for SHA-256
KEY_LEN_BYTES     = 32        # AES-256
SALT_LEN_BYTES    = 16
NONCE_LEN_BYTES   = 12
MAGIC             = b'TXEK'   # "Transcriptor Encrypted Keys" — header magic
VERSION           = 1


def derive_key(passphrase: str, salt: bytes) -> bytes:
    """PBKDF2-HMAC-SHA256(passphrase, salt) → 32 bytes for AES-256."""
    kdf = PBKDF2HMAC(
        algorithm=hashes.SHA256(),
        length=KEY_LEN_BYTES,
        salt=salt,
        iterations=PBKDF2_ITERATIONS,
        backend=default_backend(),
    )
    return kdf.derive(passphrase.encode('utf-8'))


def encrypt(plaintext: bytes, passphrase: str) -> bytes:
    """Returns: MAGIC | VERSION (1B) | iter (4B) | salt (16B) | nonce (12B) | ciphertext+tag."""
    salt  = os.urandom(SALT_LEN_BYTES)
    nonce = os.urandom(NONCE_LEN_BYTES)
    key   = derive_key(passphrase, salt)
    aes   = AESGCM(key)
    ct    = aes.encrypt(nonce, plaintext, associated_data=MAGIC)
    header = (
        MAGIC
        + bytes([VERSION])
        + PBKDF2_ITERATIONS.to_bytes(4, 'big')
        + salt
        + nonce
    )
    return header + ct


def main():
    ap = argparse.ArgumentParser(description=__doc__,
        formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('--in',  dest='inp', required=True, help='Path to keys_plaintext.json')
    ap.add_argument('--out', required=True, help='Path to write encrypted_keys.bin')
    ap.add_argument('--passphrase', required=True, help='AES-GCM key passphrase (must match Sheet)')
    args = ap.parse_args()

    if len(args.passphrase) < 16:
        print('REFUSING: passphrase must be at least 16 characters.', file=sys.stderr)
        sys.exit(1)

    with open(args.inp, 'rb') as f:
        plaintext = f.read()
    # Validate it's valid JSON with the expected shape
    try:
        d = json.loads(plaintext)
        for k in ('openai', 'anthropic', 'assemblyai'):
            if k not in d:
                print(f'WARNING: keys_plaintext.json missing key "{k}"', file=sys.stderr)
    except json.JSONDecodeError as e:
        print(f'ERROR: input is not valid JSON: {e}', file=sys.stderr)
        sys.exit(1)

    blob = encrypt(plaintext, args.passphrase)
    os.makedirs(os.path.dirname(os.path.abspath(args.out)) or '.', exist_ok=True)
    with open(args.out, 'wb') as f:
        f.write(blob)

    print(f'✓ Encrypted {len(plaintext)} B plaintext → {len(blob)} B ciphertext')
    print(f'✓ Wrote: {args.out}')
    print(f'  PBKDF2 iterations: {PBKDF2_ITERATIONS:,}')
    print(f'  Algorithm: AES-256-GCM')
    print(f'  Header magic: {MAGIC.decode()}, version: {VERSION}')
    print()
    print('Next steps:')
    print('  1. Verify the .bin landed in the .app bundle:')
    print(f'     ls -lh {args.out!r}')
    print('  2. Make sure the Sheet\'s Pilot tab has key_passphrase set to the SAME value')
    print('     you passed via --passphrase')
    print('  3. Build the .app.zip and update the Version tab in the Sheet')


if __name__ == '__main__':
    main()
