#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BUILD="${ROOT}/build"

cmake -S "${ROOT}" -B "${BUILD}" -DCMAKE_BUILD_TYPE=Release "$@"
cmake --build "${BUILD}" -j

echo
echo "[build-native] OK. Binary: ${BUILD}/packages/seed-core/qtqc-mm2-index"
echo "[build-native] Run tests: cd ${BUILD} && ctest --output-on-failure"
