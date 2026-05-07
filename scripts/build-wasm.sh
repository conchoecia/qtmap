#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BUILD="${ROOT}/build-wasm"
DIST="${ROOT}/packages/mapper-wasm/dist"

if ! command -v emcmake >/dev/null 2>&1; then
    echo "emcmake not found. Install Emscripten first." >&2
    echo "  git clone https://github.com/emscripten-core/emsdk" >&2
    echo "  cd emsdk && ./emsdk install latest && ./emsdk activate latest" >&2
    echo "  source ./emsdk_env.sh" >&2
    exit 1
fi

emcmake cmake -S "${ROOT}" -B "${BUILD}" -DCMAKE_BUILD_TYPE=Release "$@"
emmake cmake --build "${BUILD}" -j

mkdir -p "${DIST}"
cp "${BUILD}/packages/seed-core/seed_core.js"   "${DIST}/seed_core.js"
cp "${BUILD}/packages/seed-core/seed_core.wasm" "${DIST}/seed_core.wasm"

echo
echo "[build-wasm] OK. Output: ${DIST}/seed_core.{js,wasm}"
