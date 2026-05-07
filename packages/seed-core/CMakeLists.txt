cmake_minimum_required(VERSION 3.20)

set(SEED_CORE_SRC
    src/hash.c
    src/minimizer.c
    src/shard_codec.c
    src/sha256.c
    src/fasta.c
)

set(SEED_CORE_HDR
    include/qtqc/hash.h
    include/qtqc/minimizer.h
    include/qtqc/shard.h
    include/qtqc/sha256.h
    include/qtqc/fasta.h
)

# Static library used by both the native CLI and the WASM build.
add_library(seed_core STATIC ${SEED_CORE_SRC} ${SEED_CORE_HDR})
target_include_directories(seed_core
    PUBLIC
        ${CMAKE_CURRENT_SOURCE_DIR}/include
    PRIVATE
        ${CMAKE_CURRENT_SOURCE_DIR}/vendor
)

# Native CLI: qtmap-index
if(NOT EMSCRIPTEN)
    add_executable(qtmap-index src/cli/index_build.c)
    target_link_libraries(qtmap-index PRIVATE seed_core)
endif()

# WASM module: seed_core.{js,wasm}
if(EMSCRIPTEN)
    add_executable(seed_core_wasm src/wasm/exports.c)
    set_target_properties(seed_core_wasm PROPERTIES OUTPUT_NAME "seed_core")
    target_link_libraries(seed_core_wasm PRIVATE seed_core)
    target_link_options(seed_core_wasm PRIVATE
        "-sMODULARIZE=1"
        "-sEXPORT_ES6=1"
        "-sENVIRONMENT=web,worker"
        "-sALLOW_MEMORY_GROWTH=1"
        "-sMAXIMUM_MEMORY=4GB"
        "-sFILESYSTEM=0"
        "-sEXPORTED_RUNTIME_METHODS=['ccall','cwrap','HEAPU8','HEAPU32','HEAPF64']"
        "--no-entry"
        "-O3"
        "-flto"
    )
endif()

# Tests
add_subdirectory(tests)
